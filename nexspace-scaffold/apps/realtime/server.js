/**
 * NexSpace — realtime/state server (spec §4 "Realtime/State Server").
 *
 * Now authoritative over the shared OFFICE, not just positions:
 *   - world geometry (obstacles, rooms, doors, media wall) sent in `welcome`
 *   - dynamic state synced every tick: door states, media playback, per-player
 *     talking/broadcast flags, presence
 *   - handles knock / door / media / broadcast messages
 *
 * In production: Colyseus or Socket.IO + Redis pub/sub, server-side movement
 * simulation, and the world loaded from PostgreSQL via the API (see apps/api).
 *
 * Run:  npm install   then   npm start      Open http://localhost:8787 in 2 tabs.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");

// Local convenience: pull LiveKit/S3 creds from a .env file if they aren't already in the
// environment (whitelisted so a stray PORT/DATABASE_URL in apps/api/.env can't hijack this server).
// In production (Render etc.) these come from the dashboard and the file reads simply no-op.
(function loadEnv() {
  const want = /^(LIVEKIT_|S3_|GOOGLE_|JWT_SECRET)/;
  for (const f of [path.join(__dirname, ".env"), path.join(__dirname, "..", "api", ".env")]) {
    try {
      for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && want.test(m[1]) && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    } catch {}
  }
})();

const PORT = process.env.PORT || 8787;
const TICK_HZ = 15;
const MAX_SPEED = 520;   // px/s — server-authoritative movement cap (> client sprint; anti-teleport, §8)
const RATE_LIMIT = 80;   // max messages/sec per connection (abuse protection, §8)
const MAX_CLIENTS = Number(process.env.MAX_CLIENTS) || 200; // connection cap per node (§8)
const CHAT_NEARBY = 350; // px radius for 'nearby' chat on the open floor (§6.9)
const WEB_DIR = path.join(__dirname, "..", "web");

// ---------- Auth (RBAC) — verifies the dependency-free JWT minted by the API ----------
const JWT_SECRET = process.env.JWT_SECRET || "nexspace-dev-secret-change-me";
const RANK = { guest: 0, member: 1, admin: 2, owner: 3 };
const rank = (r) => RANK[r] || 0;
function verifyJWT(token) {
  if (!token) return null;
  const t = token.startsWith("Bearer ") ? token.slice(7) : token;
  const parts = t.split("."); if (parts.length !== 3) return null;
  const data = parts[0] + "." + parts[1];
  const exp = crypto.createHmac("sha256", JWT_SECRET).update(data).digest("base64url");
  if (parts[2].length !== exp.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(parts[2]), Buffer.from(exp))) return null;
  try { const p = JSON.parse(Buffer.from(parts[1], "base64url").toString()); if (p.exp && p.exp < Date.now() / 1000) return null; return p; } catch { return null; }
}

// ---------- Public API + webhooks (spec 6.18) ----------
const PUBLIC_API_KEY = process.env.PUBLIC_API_KEY || "nexspace-demo-key";
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";
function fireWebhook(event, data) {
  if (!WEBHOOK_URL) return;
  const body = JSON.stringify({ event, data, ts: Date.now() });
  const signature = crypto.createHmac("sha256", PUBLIC_API_KEY).update(body).digest("hex"); // verify with HMAC-SHA256(body, key)
  fetch(WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json", "X-NexSpace-Event": event, "X-NexSpace-Signature": signature }, body }).catch(() => {});
}

// Slack notifications via an incoming webhook (spec 6.18). Paste a Slack incoming-webhook URL.
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";
function notifySlack(text) {
  if (!SLACK_WEBHOOK_URL) return;
  fetch(SLACK_WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) }).catch(() => {});
}

// ---------- LiveKit token minting (spec §3) — lets this single server hand out real voice/video
// tokens with no separate API. A LiveKit access token is just an HS256 JWT signed with the API
// secret, so we mint it with node:crypto (no extra dependency). Set LIVEKIT_URL/KEY/SECRET in env. ----------
const LIVEKIT_URL = process.env.LIVEKIT_URL || "";
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || "";
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || "";
const livekitConfigured = () => !!(LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET);
function mintLivekitToken(room, identity, name) {
  const now = Math.floor(Date.now() / 1000);
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const header = b64u({ alg: "HS256", typ: "JWT" });
  const payload = b64u({
    exp: now + 7200, iat: now, nbf: now, iss: LIVEKIT_API_KEY, sub: identity, name: name || identity,
    video: { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true },
  });
  const data = header + "." + payload;
  return data + "." + crypto.createHmac("sha256", LIVEKIT_API_SECRET).update(data).digest("base64url");
}

// ---------- Google sign-in (OIDC) — real login with no separate API/DB. The server runs the OAuth
// code flow and mints an app JWT (same HS256/JWT_SECRET the join handler verifies). Configure with
// GOOGLE_CLIENT_ID/SECRET; map roles with GOOGLE_OWNER_EMAILS / GOOGLE_ADMIN_EMAILS (comma-separated). ----------
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const googleConfigured = () => !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
const emailList = (s) => (s || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
const OWNER_EMAILS = emailList(process.env.GOOGLE_OWNER_EMAILS);
const ADMIN_EMAILS = emailList(process.env.GOOGLE_ADMIN_EMAILS);
function googleRole(email) { const e = (email || "").toLowerCase(); if (OWNER_EMAILS.includes(e)) return "owner"; if (ADMIN_EMAILS.includes(e)) return "admin"; return "member"; }
function mintAppToken(payload, ttlSec = 7200) {
  const now = Math.floor(Date.now() / 1000);
  const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const data = b({ alg: "HS256", typ: "JWT" }) + "." + b({ ...payload, iat: now, exp: now + ttlSec });
  return data + "." + crypto.createHmac("sha256", JWT_SECRET).update(data).digest("base64url");
}
const fwdBase = (req) => ((req.headers["x-forwarded-proto"] || "https").split(",")[0]) + "://" + req.headers.host;
const googleRedirectUri = (req) => process.env.GOOGLE_REDIRECT_URI || (fwdBase(req) + "/auth/google/callback");
// Stateless CSRF state: a nonce signed with JWT_SECRET — no cookie needed (cookies are flaky across the OAuth redirect).
function signState() { const n = crypto.randomBytes(12).toString("hex"); return n + "." + crypto.createHmac("sha256", JWT_SECRET).update(n).digest("base64url"); }
function verifyState(s) { if (!s || s.indexOf(".") < 0) return false; const n = s.slice(0, s.indexOf(".")), sig = s.slice(s.indexOf(".") + 1); const exp = crypto.createHmac("sha256", JWT_SECRET).update(n).digest("base64url"); try { return sig.length === exp.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp)); } catch { return false; } }

// ---------- Authoritative world(s) — multi-floor (spec §6: multiple maps + portals) ----------
// Each floor is an independent world; a player belongs to exactly one floor at a time, and
// portals teleport between them. Built-in geometry below is the fallback when WORLD_API is unset;
// otherwise every floor is loaded from the API (apps/api) in loadWorld().
const DEFAULT_FLOOR = "default";
const floors = new Map(); // slug -> floor state { slug, name, w, h, obstacles, rooms, mediaWall, portals, branding, spawn }

function makeDefaultFloor() {
  const W = 2200, H = 1500;
  const obstacles = [
    { x: 0, y: 0, w: W, h: 16 }, { x: 0, y: H - 16, w: W, h: 16 },
    { x: 0, y: 0, w: 16, h: H }, { x: W - 16, y: 0, w: 16, h: H },
    { x: 520, y: 120, w: 16, h: 300 }, { x: 520, y: 520, w: 16, h: 240 }, { x: 120, y: 760, w: 430, h: 16 },
    { x: 1500, y: 120, w: 16, h: 560 }, { x: 1516, y: 120, w: 300, h: 16 }, { x: 1516, y: 666, w: 300, h: 16 },
    { x: 1800, y: 120, w: 16, h: 236 }, { x: 1800, y: 452, w: 16, h: 230 },
    { x: 980, y: 560, w: 240, h: 120, r: 14 }, { x: 300, y: 300, w: 150, h: 80, r: 12 },
    { x: 1600, y: 330, w: 170, h: 90, r: 12 }, { x: 900, y: 1150, w: 120, h: 120, r: 60 },
    { x: 1750, y: 1150, w: 150, h: 80, r: 12 }, { x: 250, y: 1150, w: 90, h: 90, r: 10 },
  ];
  const rooms = [
    { id: "focus", name: "Focus Room", color: "#7c6bff",
      bounds: { x: 140, y: 130, w: 380, h: 630 }, door: { x: 512, y: 418, w: 18, h: 104, state: "closed", knocking: false } },
    { id: "board", name: "Boardroom", color: "#39d3a6",
      bounds: { x: 1516, y: 136, w: 300, h: 546 }, door: { x: 1796, y: 356, w: 18, h: 96, state: "locked", knocking: false } },
  ];
  const mediaWall = { x: 1180, y: 980, w: 300, base: 16, screenH: 150,
    title: "Lo-fi Beats — Focus Radio", playing: true, pos: 74, dur: 213 };
  obstacles.push({ x: mediaWall.x, y: mediaWall.y, w: mediaWall.w, h: mediaWall.base });
  const portals = [{ id: "to-rooftop", x: 2030, y: 1290, w: 96, h: 96, to: "rooftop", label: "Rooftop ↑", color: "#ffb454" }];
  const widgets = [
    { id: "w-tv", type: "embed", x: 1180, y: 700, w: 300, h: 170, kind: "youtube", url: "https://www.youtube.com/embed/jfKfPfyJRdk", title: "Lofi TV" },
    { id: "w-note", type: "note", x: 360, y: 980, w: 190, h: 130, text: "Welcome to NexSpace! Click the TV ▶ or pop up to the rooftop 🌇", color: "#ffd166" },
    { id: "w-timer", type: "timer", x: 980, y: 300, w: 180, h: 96, label: "Standup ends", endsAt: Date.now() + 30 * 60000 },
  ];
  return { slug: "default", name: "HQ — Ground Floor", w: W, h: H, obstacles, rooms, mediaWall, portals, widgets,
    branding: { name: "NexSpace", color: "#5b8cff", logo: "", whiteLabel: false }, spawn: { x: 890, y: 920 } };
}

function makeRooftopFloor() {
  const W = 1600, H = 1100;
  const obstacles = [
    { x: 0, y: 0, w: W, h: 16 }, { x: 0, y: H - 16, w: W, h: 16 },
    { x: 0, y: 0, w: 16, h: H }, { x: W - 16, y: 0, w: 16, h: H },
    { x: 700, y: 300, w: 200, h: 120, r: 18 },
    { x: 220, y: 760, w: 140, h: 90, r: 12 }, { x: 1240, y: 760, w: 140, h: 90, r: 12 },
  ];
  const rooms = [
    { id: "cabana", name: "Cabana", color: "#39d3a6",
      bounds: { x: 120, y: 130, w: 360, h: 360 }, door: { x: 472, y: 290, w: 18, h: 90, state: "open", knocking: false } },
  ];
  const mediaWall = { x: 660, y: 720, w: 280, base: 16, screenH: 140,
    title: "Sunset Set — Rooftop Radio", playing: true, pos: 12, dur: 240 };
  obstacles.push({ x: mediaWall.x, y: mediaWall.y, w: mediaWall.w, h: mediaWall.base });
  const portals = [{ id: "to-default", x: 90, y: 960, w: 96, h: 96, to: "default", label: "Ground ↓", color: "#5b8cff" }];
  const widgets = [
    { id: "w-rnote", type: "note", x: 1180, y: 250, w: 190, h: 120, text: "Rooftop vibes ☕ — grab a seat by the cabana", color: "#39d3a6" },
  ];
  return { slug: "rooftop", name: "Rooftop Garden", w: W, h: H, obstacles, rooms, mediaWall, portals, widgets,
    branding: { name: "NexSpace", color: "#39d3a6", logo: "", whiteLabel: false }, spawn: { x: 800, y: 600 } };
}

floors.set("default", makeDefaultFloor());
floors.set("rooftop", makeRooftopFloor());

const anyFloor = () => floors.get(DEFAULT_FLOOR) || [...floors.values()][0];
const floorOf = (p) => floors.get(p && p.floor) || anyFloor();
const floorsList = () => [...floors.values()].map((f) => ({ slug: f.slug, name: f.name }));

function inRoom(p, room) {
  const b = room.bounds;
  return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
}
function worldForClient(slug) {
  const f = floors.get(slug) || anyFloor();
  return {
    slug: f.slug, name: f.name, w: f.w, h: f.h, obstacles: f.obstacles,
    rooms: f.rooms.map(r => ({ id: r.id, name: r.name, color: r.color, bounds: r.bounds, door: { x: r.door.x, y: r.door.y, w: r.door.w, h: r.door.h, state: r.door.state } })),
    mediaWall: f.mediaWall ? { x: f.mediaWall.x, y: f.mediaWall.y, w: f.mediaWall.w, base: f.mediaWall.base, screenH: f.mediaWall.screenH, title: f.mediaWall.title, dur: f.mediaWall.dur } : null,
    portals: f.portals.map(pt => ({ id: pt.id, x: pt.x, y: pt.y, w: pt.w, h: pt.h, to: pt.to, label: pt.label, color: pt.color })),
    widgets: (f.widgets || []).map(wd => ({ ...wd })),
    branding: f.branding,
    floors: floorsList(),
  };
}

// ---------- Clients ----------
const clients = new Map(); // ws -> player
let nextId = 1;
let recording = { on: false, by: null, egressId: null }; // shared recording indicator (spec 6.17)
const whiteboard = { strokes: [] }; // collaborative whiteboard (spec 6.8)
const mutedIds = new Set(); // moderation: muted user ids (spec 6.16)
function applyModerate(action, target) {
  if (action === "mute") mutedIds.add(target);
  else if (action === "unmute") mutedIds.delete(target);
  else if (action === "kick") { for (const [ws2, q] of clients) if (q.id === target) { send(ws2, { t: "kicked" }); setTimeout(() => { try { ws2.close(); } catch {} }, 50); } }
}

// ---------- Analytics (spec 6.20) ----------
const A = { startedAt: Date.now(), sessions: 0, peak: 0, totalMs: 0, closed: 0 };
const roomSeconds = {}; // keyed "floorSlug:roomId" (and "floorSlug:open") across all floors
for (const f of floors.values()) { roomSeconds[f.slug + ":open"] = 0; for (const r of f.rooms) roomSeconds[f.slug + ":" + r.id] = 0; }
function analyticsSnapshot() {
  const occ = {}; for (const k in roomSeconds) occ[k] = 0;
  for (const p of clients.values()) { const f = floorOf(p); const r = f.rooms.find((rm) => inRoom(p, rm)); const k = f.slug + ":" + (r ? r.id : "open"); occ[k] = (occ[k] || 0) + 1; }
  const roomUsageMin = {}; for (const k in roomSeconds) roomUsageMin[k] = +(roomSeconds[k] / 60).toFixed(1);
  return {
    online: clients.size,
    sessionsTotal: A.sessions,
    peakConcurrency: A.peak,
    avgSessionMin: A.closed ? +(A.totalMs / A.closed / 60000).toFixed(1) : 0,
    uptimeMin: +((Date.now() - A.startedAt) / 60000).toFixed(1),
    roomUsageMin,
    currentOccupancy: occ,
    generatedAt: Date.now(),
  };
}

// ---------- Multi-node fan-out via Redis (spec §4/§8) — optional, behind REDIS_URL ----------
const REDIS_URL = process.env.REDIS_URL || "";
const NODE_ID = crypto.randomBytes(4).toString("hex");
const remoteByNode = new Map(); // nodeId -> { players, ts }
let pub = null;
function localPlayers() {
  return [...clients.values()].map((p) => ({ id: p.id, name: p.name, x: p.x, y: p.y, facing: p.facing, status: p.status, talking: p.talking, bcast: p.bcast, role: p.role, floor: p.floor, avatar: p.avatar }));
}
function remotePlayers() {
  const out = [], now = Date.now();
  for (const [nid, e] of remoteByNode) { if (now - e.ts > 3000) { remoteByNode.delete(nid); continue; } for (const p of e.players) out.push(p); }
  return out;
}
function publishEvent(event, data) { if (pub) pub.publish("nexspace:event", JSON.stringify({ nodeId: NODE_ID, event, data })); }
function applyEvent(event, data) {
  if (event === "door") { const f = floors.get(data.floor) || anyFloor(); const r = f.rooms.find((x) => x.id === data.roomId); if (r && ["open", "closed", "locked"].includes(data.state)) r.door.state = data.state; }
  else if (event === "media") { const f = floors.get(data.floor) || anyFloor(); if (f.mediaWall) f.mediaWall.playing = !!data.playing; }
  else if (event === "recording") { recording = data.on ? { on: true, by: data.by, egressId: data.egressId || null } : { on: false, by: null, egressId: null }; }
  else if (event === "worldReload") { reloadAndBroadcast(); }
  else if (event === "chat") { deliverChat(data); }
  else if (event === "draw") { whiteboard.strokes.push(data); if (whiteboard.strokes.length > 3000) whiteboard.strokes.shift(); broadcastLocal({ t: "draw", stroke: data }); }
  else if (event === "wbclear") { whiteboard.strokes = []; broadcastLocal({ t: "wbclear" }); }
  else if (event === "react") { broadcastLocal({ t: "react", from: data.from, emoji: data.emoji }); }
  else if (event === "nudge") { for (const [ws2, q] of clients) if (q.id === data.to) send(ws2, { t: "nudge", from: data.from, name: data.name }); }
  else if (event === "moderate") { applyModerate(data.action, data.target); }
}
if (REDIS_URL) {
  const Redis = require("ioredis");
  pub = new Redis(REDIS_URL);
  const sub = new Redis(REDIS_URL);
  pub.on("error", (e) => console.warn("redis pub:", e.message));
  sub.on("error", (e) => console.warn("redis sub:", e.message));
  sub.subscribe("nexspace:presence", "nexspace:event");
  sub.on("message", (channel, raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.nodeId === NODE_ID) return; // ignore our own messages
    if (channel === "nexspace:presence") remoteByNode.set(msg.nodeId, { players: msg.players, ts: Date.now() });
    else if (channel === "nexspace:event") applyEvent(msg.event, msg.data);
  });
  setInterval(() => { try { pub.publish("nexspace:presence", JSON.stringify({ nodeId: NODE_ID, players: localPlayers() })); } catch {} }, 250);
  console.log("Redis fan-out enabled (node " + NODE_ID + ")");
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".ico": "image/x-icon" };
const server = http.createServer((req, res) => {
  let urlPath = (req.url || "/").split("?")[0];   // strip query first, so "/?sso=…" still serves the app
  if (urlPath === "/" || urlPath === "") urlPath = "/index.html";
  if (urlPath === "/livekit/token" && req.method === "POST") { // real voice/video, no separate API needed
    if (!livekitConfigured()) return json(res, { error: "LiveKit not configured" }, 503);
    return readJsonBody(req, (b) => {
      const room = String(b.room || "floor:default").slice(0, 80);
      const identity = String(b.identity || ("u" + Date.now())).slice(0, 64);
      const name = String(b.name || identity).slice(0, 40);
      json(res, { url: LIVEKIT_URL, token: mintLivekitToken(room, identity, name) });
    });
  }
  if (urlPath === "/livekit/egress/start" && req.method === "POST") { // record the room → S3-compatible storage (e.g. Backblaze B2)
    if (!livekitConfigured()) return json(res, { error: "LiveKit not configured" }, 503);
    return readJsonBody(req, async (b) => {
      try { json(res, await startEgress(String(b.room || "floor:default").slice(0, 80))); }
      catch (e) { json(res, { error: "egress start failed — check S3_* storage env. " + (e && e.message || e) }, 503); }
    });
  }
  if (urlPath === "/livekit/egress/stop" && req.method === "POST") {
    return readJsonBody(req, async (b) => {
      try { json(res, await stopEgress(String(b.egressId || ""))); }
      catch (e) { json(res, { error: "egress stop failed: " + (e && e.message || e) }, 503); }
    });
  }
  if (urlPath === "/auth/google/login") { // step 1: bounce to Google's consent screen
    if (!googleConfigured()) { res.writeHead(503, { "Content-Type": "text/plain" }); res.end("Google login not configured (set GOOGLE_CLIENT_ID/SECRET)"); return; }
    const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    u.searchParams.set("client_id", GOOGLE_CLIENT_ID);
    u.searchParams.set("redirect_uri", googleRedirectUri(req));
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", "openid email profile");
    u.searchParams.set("state", signState());
    u.searchParams.set("prompt", "select_account");
    res.writeHead(302, { Location: u.toString() });
    res.end(); return;
  }
  if (urlPath === "/auth/google/callback") { // step 2: exchange code, mint app JWT, bounce back with ?sso=
    const q = new URL(req.url, "http://x").searchParams, code = q.get("code"), state = q.get("state");
    if (!code || !verifyState(state)) { res.writeHead(400, { "Content-Type": "text/plain" }); res.end("Login failed (bad state) — start again from the Sign in button."); return; }
    (async () => {
      try {
        const body = new URLSearchParams({ code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, redirect_uri: googleRedirectUri(req), grant_type: "authorization_code" });
        const tr = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
        const tj = await tr.json();
        if (!tj.id_token) throw new Error(tj.error_description || tj.error || "no id_token");
        const claims = JSON.parse(Buffer.from(tj.id_token.split(".")[1], "base64url").toString());
        const email = claims.email || "", name = claims.name || email.split("@")[0] || "User";
        const token = mintAppToken({ sub: claims.sub || ("g-" + email), name, role: googleRole(email), email, avatar: claims.picture || "" });
        res.writeHead(302, { Location: "/?sso=" + encodeURIComponent(token) });
        res.end();
        console.log(`✓ Google login: ${name} <${email}> → ${googleRole(email)}`);
      } catch (e) { res.writeHead(502, { "Content-Type": "text/plain" }); res.end("Google login failed: " + (e && e.message || e)); }
    })();
    return;
  }
  if (urlPath === "/analytics") { // admin-gated metrics JSON (spec 6.20)
    const token = (req.headers.authorization || "").replace(/^Bearer /, "") || (new URL(req.url, "http://x").searchParams.get("token") || "");
    const claims = verifyJWT(token);
    if (!claims || rank(claims.role) < RANK.admin) { res.writeHead(403, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "admin required" })); return; }
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(analyticsSnapshot())); return;
  }
  if (urlPath.startsWith("/api/v1/")) { // public REST API (spec 6.18) — X-API-Key gated
    if ((req.headers["x-api-key"] || "") !== PUBLIC_API_KEY) return json(res, { error: "invalid or missing X-API-Key" }, 401);
    if (urlPath === "/api/v1/health") return json(res, { ok: true, online: clients.size });
    if (urlPath === "/api/v1/presence") {
      const users = [...clients.values()].map((p) => { const f = floorOf(p); const r = f.rooms.find((rm) => inRoom(p, rm)); return { id: p.id, name: p.name, role: p.role, status: p.status, x: Math.round(p.x), y: Math.round(p.y), floor: p.floor, room: r ? r.id : null }; });
      return json(res, { online: users.length, users });
    }
    if (urlPath === "/api/v1/floors") return json(res, { floors: floorsList() });
    if (urlPath === "/api/v1/floor") { const f = anyFloor(); return json(res, { slug: f.slug, name: f.name, width: f.w, height: f.h, rooms: f.rooms.map((r) => ({ id: r.id, name: r.name })), objects: f.obstacles.length, portals: f.portals.length, mediaWall: f.mediaWall ? { title: f.mediaWall.title, playing: f.mediaWall.playing } : null }); }
    return json(res, { error: "not found" }, 404);
  }
  const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
  const file = path.join(WEB_DIR, safe);
  if (!file.startsWith(WEB_DIR)) { res.writeHead(403); res.end("Forbidden"); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    // no-store so the browser always picks up the latest client build (dev: avoids stale cached UI)
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "text/plain", "Cache-Control": "no-store, must-revalidate" });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    const p = clients.get(ws);

    if (m.t === "adminReload") {
      // admin-only: re-pull the world from the API and push it to everyone live (no restart)
      const claims = verifyJWT(m.token);
      if (!claims || rank(claims.role) < RANK.admin) return deny(ws, "reload the world", "admin");
      reloadAndBroadcast();
      publishEvent("worldReload", {});
      return;
    }

    if (m.t === "join") {
      if (clients.size >= MAX_CLIENTS) { send(ws, { t: "full" }); setTimeout(() => { try { ws.close(); } catch {} }, 50); return; }
      const id = "u" + (nextId++);
      const claims = verifyJWT(m.token);
      const role = claims?.role || "guest";
      const name = claims?.name || String(m.name || "Guest").slice(0, 16) || "Guest";
      const avatar = (claims?.avatar && /^https:\/\//.test(claims.avatar)) ? claims.avatar : ""; // Google profile pic (https only)
      const f0 = anyFloor();
      const player = { id, name, role, avatar, floor: f0.slug, joinedAt: Date.now(), lastMoveAt: Date.now(),
        x: f0.spawn.x + (Math.random() - 0.5) * 120, y: f0.spawn.y + (Math.random() - 0.5) * 100, facing: 0,
        status: "available", talking: m.talking !== false, bcast: false };
      clients.set(ws, player);
      A.sessions++; if (clients.size > A.peak) A.peak = clients.size;
      fireWebhook("user.joined", { id, name, role });
      notifySlack("👋 " + name + " entered the office");
      send(ws, { t: "welcome", id, world: worldForClient(player.floor), you: { ...player }, whiteboard: whiteboard.strokes });
      console.log(`+ ${player.name} (${id}) [${role}] — ${clients.size} online`);
      return;
    }
    if (!p) return;

    // per-connection rate limit (abuse protection, §8)
    const _now = Date.now();
    if (_now - (p.rlStart || 0) > 1000) { p.rlStart = _now; p.rlCount = 0; p.rlNotified = false; }
    p.rlCount = (p.rlCount || 0) + 1;
    if (p.rlCount > RATE_LIMIT) { if (!p.rlNotified) { p.rlNotified = true; send(ws, { t: "rateLimited" }); } return; }

    if (m.t === "move") {
      // server-authoritative: clamp to MAX_SPEED since this client's last update (anti-teleport)
      const dt = Math.min(1, (_now - (p.lastMoveAt || _now)) / 1000);
      p.lastMoveAt = _now;
      const fdim = floorOf(p);
      let nx = Number.isFinite(m.x) ? clamp(m.x, 16, fdim.w - 16) : p.x;
      let ny = Number.isFinite(m.y) ? clamp(m.y, 16, fdim.h - 16) : p.y;
      const dx = nx - p.x, dy = ny - p.y, dist = Math.hypot(dx, dy), maxDist = MAX_SPEED * dt + 8;
      if (dist > maxDist) { const s = maxDist / dist; nx = p.x + dx * s; ny = p.y + dy * s; }
      p.x = nx; p.y = ny;
      if (Number.isFinite(m.facing)) p.facing = m.facing;
    } else if (m.t === "state") {
      if (m.status && ["available", "away", "busy", "dnd", "inMeeting"].includes(m.status)) p.status = m.status;
      if ("talking" in m) p.talking = !!m.talking;
    } else if (m.t === "broadcast") {
      if (m.on && rank(p.role) < RANK.member) return deny(ws, "broadcast", "member");
      if (m.on && mutedIds.has(p.id)) return deny(ws, "broadcast", "unmuted");
      p.bcast = !!m.on;
    } else if (m.t === "media") {
      const f = floorOf(p); if (f.mediaWall) { f.mediaWall.playing = !!m.playing; publishEvent("media", { floor: f.slug, playing: f.mediaWall.playing }); }
    } else if (m.t === "door") {
      if (rank(p.role) < RANK.member) return deny(ws, "change doors", "member");
      if (m.state === "locked" && rank(p.role) < RANK.admin) return deny(ws, "lock doors", "admin");
      const room = floorOf(p).rooms.find(r => r.id === m.roomId);
      if (room && ["open", "closed", "locked"].includes(m.state)) { room.door.state = m.state; publishEvent("door", { floor: p.floor, roomId: m.roomId, state: m.state }); }
    } else if (m.t === "knock") {
      const room = floorOf(p).rooms.find(r => r.id === m.roomId);
      if (!room) return;
      const d = room.door;
      if (d.state === "open" || d.knocking) return;
      if (d.state === "locked" && rank(p.role) < RANK.member) return deny(ws, "enter the locked room", "member");
      d.knocking = true;
      const occupied = [...clients.values()].some(q => q.floor === p.floor && inRoom(q, room));
      setTimeout(() => { d.knocking = false; if (occupied) { d.state = "open"; publishEvent("door", { floor: p.floor, roomId: room.id, state: "open" }); } }, 1300);
    } else if (m.t === "recording") {
      if (rank(p.role) < RANK.admin) return deny(ws, "record", "admin");
      recording = m.on ? { on: true, by: p.name, egressId: m.egressId || null } : { on: false, by: null, egressId: null };
      publishEvent("recording", recording);
    } else if (m.t === "chat") {
      const body = String(m.body || "").slice(0, 500); if (!body.trim()) return;
      if (mutedIds.has(p.id)) return deny(ws, "chat", "unmuted");
      let scope = ["nearby", "floor", "channel", "dm"].includes(m.scope) ? m.scope : "nearby";
      let channel = null, to = null;
      if (scope === "channel") channel = String(m.channel || "general").slice(0, 32);
      else if (scope === "dm") { to = String(m.to || ""); if (!to) return; }
      const r = floorOf(p).rooms.find((rm) => inRoom(p, rm));
      const payload = { from: p.id, name: p.name, scope, channel, to, body, floor: p.floor, x: p.x, y: p.y, roomId: r ? r.id : null, ts: Date.now() };
      deliverChat(payload); publishEvent("chat", payload); // local + cross-node
    } else if (m.t === "draw") {
      const stroke = m.stroke; if (!stroke || !Array.isArray(stroke.pts) || stroke.pts.length > 2000) return;
      whiteboard.strokes.push(stroke); if (whiteboard.strokes.length > 3000) whiteboard.strokes.shift();
      broadcastLocal({ t: "draw", stroke }); publishEvent("draw", stroke);
    } else if (m.t === "wbclear") {
      whiteboard.strokes = []; broadcastLocal({ t: "wbclear" }); publishEvent("wbclear", {});
    } else if (m.t === "react") {
      if (mutedIds.has(p.id)) return deny(ws, "react", "unmuted");
      const emoji = String(m.emoji || "").slice(0, 8); if (!emoji) return;
      broadcastLocal({ t: "react", from: p.id, emoji }); publishEvent("react", { from: p.id, emoji });
    } else if (m.t === "nudge") {
      const to = String(m.to || ""); for (const [ws2, q] of clients) if (q.id === to) send(ws2, { t: "nudge", from: p.id, name: p.name });
      publishEvent("nudge", { from: p.id, name: p.name, to });
    } else if (m.t === "moderate") {
      if (rank(p.role) < RANK.admin) return deny(ws, "moderate", "admin");
      const action = m.action, target = String(m.target || "");
      applyModerate(action, target); publishEvent("moderate", { action, target });
    } else if (m.t === "portal") {
      // teleport to another floor (physical portal step-through or floor-switcher); any joined client may travel
      const dest = floors.get(String(m.to || ""));
      if (!dest || dest.slug === p.floor) return;
      p.floor = dest.slug;
      // arrive at the floor's known-safe interior spawn (NOT beside the return portal — small floors clamp
      // that into a wall, leaving the player stuck inside the collision radius). Small jitter avoids stacking.
      const sp = dest.spawn || { x: dest.w / 2, y: dest.h / 2 };
      p.x = clamp(sp.x + (Math.random() - 0.5) * 80, 60, dest.w - 60);
      p.y = clamp(sp.y + (Math.random() - 0.5) * 80, 60, dest.h - 60);
      p.lastMoveAt = Date.now();
      send(ws, { t: "floor", world: worldForClient(dest.slug), you: { id: p.id, x: Math.round(p.x), y: Math.round(p.y), floor: p.floor } });
      console.log(`~ ${p.name} (${p.id}) → floor '${dest.slug}'`);
    }
  });

  ws.on("close", () => {
    const p = clients.get(ws);
    if (p && p.joinedAt) { A.totalMs += Date.now() - p.joinedAt; A.closed++; }
    clients.delete(ws);
    if (p) { fireWebhook("user.left", { id: p.id, name: p.name }); notifySlack("👋 " + p.name + " left the office"); console.log(`- ${p.name} (${p.id}) — ${clients.size} online`); }
  });
});

// Authoritative tick: advance media clock + broadcast snapshot of all dynamic state.
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now(), dt = (now - lastTick) / 1000; lastTick = now;
  for (const f of floors.values()) if (f.mediaWall && f.mediaWall.playing) { f.mediaWall.pos += dt; if (f.mediaWall.pos > f.mediaWall.dur) f.mediaWall.pos = 0; }
  if (clients.size === 0) return;
  // group all presence (local + cross-node) by floor, then send each client only its own floor's snapshot
  const all = localPlayers().concat(remotePlayers());
  const byFloor = new Map();
  for (const pl of all) { const fl = pl.floor || DEFAULT_FLOOR; let arr = byFloor.get(fl); if (!arr) { arr = []; byFloor.set(fl, arr); } arr.push(pl); }
  const snapByFloor = new Map();
  for (const [slug, plist] of byFloor) {
    const f = floors.get(slug) || anyFloor();
    const doors = {}; for (const r of f.rooms) doors[r.id] = r.door.state;
    const media = f.mediaWall ? { playing: f.mediaWall.playing, pos: Math.round(f.mediaWall.pos) } : null;
    snapByFloor.set(slug, JSON.stringify({ t: "snapshot", floor: slug, players: plist, doors, media, recording }));
  }
  for (const [ws, p] of clients) { if (ws.readyState !== 1) continue; const s = snapByFloor.get(p.floor); if (s) ws.send(s); }
}, 1000 / TICK_HZ);

// analytics sampler — accumulate occupant-seconds per zone every 5s (spec 6.20), keyed by floor
setInterval(() => {
  for (const p of clients.values()) { const f = floorOf(p); const r = f.rooms.find((rm) => inRoom(p, rm)); const k = f.slug + ":" + (r ? r.id : "open"); roomSeconds[k] = (roomSeconds[k] || 0) + 5; }
}, 5000);

// heartbeat — terminate sockets that stop responding so presence/analytics stay accurate (§8)
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => { if (ws.isAlive === false) return ws.terminate(); ws.isAlive = false; try { ws.ping(); } catch {} });
}, 30000);

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function json(res, obj, code = 200) { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); }
function readJsonBody(req, cb) { let body = ""; req.on("data", (c) => { body += c; if (body.length > 8192) req.destroy(); }); req.on("end", () => { let b = {}; try { b = JSON.parse(body || "{}"); } catch {} cb(b); }); }

// ---- Recording via LiveKit Egress → S3-compatible storage (spec 6.17). Lazy-require the SDK so the
// server still boots if it isn't installed; configure with S3_* env (Backblaze B2, Cloudflare R2, …). ----
let _egress = null;
function egressClient() {
  if (_egress) return _egress;
  const { EgressClient } = require("livekit-server-sdk");
  const host = LIVEKIT_URL.replace("wss://", "https://").replace("ws://", "http://");
  _egress = new EgressClient(host, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
  return _egress;
}
async function startEgress(room) {
  const { EncodedFileOutput, EncodedFileType, S3Upload } = require("livekit-server-sdk");
  const filepath = room.replace(/[^a-zA-Z0-9_-]/g, "_") + "-" + Date.now() + ".mp4";
  const file = new EncodedFileOutput({ fileType: EncodedFileType.MP4, filepath });
  if (process.env.S3_BUCKET) {
    file.output = { case: "s3", value: new S3Upload({
      accessKey: process.env.S3_ACCESS_KEY, secret: process.env.S3_SECRET, bucket: process.env.S3_BUCKET,
      region: process.env.S3_REGION || "auto", endpoint: process.env.S3_ENDPOINT, forcePathStyle: true,
    }) };
  }
  const info = await egressClient().startRoomCompositeEgress(room, { file }, { layout: "grid" });
  return { egressId: info.egressId, filepath };
}
async function stopEgress(egressId) { const info = await egressClient().stopEgress(egressId); return { egressId, status: info.status }; }
function broadcastLocal(msg) { const s = JSON.stringify(msg); for (const ws of clients.keys()) if (ws.readyState === 1) ws.send(s); }
// chat routing (§6.9): channels are org-wide (cross-floor); floor + nearby are local to the sender's floor
function deliverChat(d) {
  const dfloor = d.floor || DEFAULT_FLOOR;
  for (const [ws, p] of clients) {
    const pfloor = p.floor || DEFAULT_FLOOR;
    let target;
    if (d.scope === "channel") target = true;                              // #channels span every floor
    else if (d.scope === "dm") target = (p.id === d.from || p.id === d.to); // DM: sender + recipient only
    else if (pfloor !== dfloor) target = false;                            // floor + nearby never cross floors
    else if (d.scope === "floor") target = true;                          // whole (same) floor
    else { // nearby: same room, or within radius on the open floor
      const pr = floorOf(p).rooms.find((r) => inRoom(p, r)), prId = pr ? pr.id : null;
      target = d.roomId ? (prId === d.roomId) : (!prId && Math.hypot(p.x - d.x, p.y - d.y) < CHAT_NEARBY);
    }
    if (target) send(ws, { t: "chat", from: d.from, name: d.name, scope: d.scope, channel: d.channel, to: d.to, body: d.body, ts: d.ts });
  }
}
function deny(ws, action, need) { send(ws, { t: "denied", action, need }); } // RBAC refusal feedback
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Build a floor's mutable runtime state from an API WorldBlob (see apps/api world.service).
function buildFloorFromBlob(slug, w) {
  const rooms = (w.rooms || []).map((r) => ({ id: r.id, name: r.name, color: r.color, bounds: r.bounds,
    door: { x: r.door.x, y: r.door.y, w: r.door.w, h: r.door.h, state: r.door.state || "closed", knocking: false } }));
  const mediaWall = w.mediaWall ? { x: w.mediaWall.x, y: w.mediaWall.y, w: w.mediaWall.w, base: w.mediaWall.base,
    screenH: w.mediaWall.screenH, title: w.mediaWall.title, playing: true, pos: 0, dur: w.mediaWall.dur } : null;
  const portals = (w.portals || []).map((pt) => ({ id: pt.id, x: pt.x, y: pt.y, w: pt.w, h: pt.h, to: pt.to, label: pt.label, color: pt.color }));
  const widgets = (w.widgets || []).map((wd) => ({ ...wd }));
  return { slug, name: w.name || slug, w: w.w, h: w.h, obstacles: (w.obstacles || []).slice(), rooms, mediaWall, portals, widgets,
    branding: w.branding || { name: "NexSpace", color: "#5b8cff", logo: "", whiteLabel: false },
    spawn: w.spawn || { x: Math.round((w.w || 2000) * 0.4), y: Math.round((w.h || 1400) * 0.6) } };
}
async function reloadAndBroadcast() {
  await loadWorld();                               // re-fetch from WORLD_API if configured
  for (const [ws, p] of clients) {
    if (!floors.has(p.floor)) p.floor = anyFloor().slug; // floor may have been removed on reload
    if (ws.readyState === 1) ws.send(JSON.stringify({ t: "world", world: worldForClient(p.floor) }));
  }
  console.log("World reloaded and broadcast to " + clients.size + " client(s)");
}
// Load EVERY floor from the API (apps/api). Falls back to the built-in floors if WORLD_API is unset/unreachable.
async function loadWorld() {
  if (!process.env.WORLD_API) return; // keep built-in floors (default + rooftop)
  const base = process.env.WORLD_API.replace(/\/$/, "");
  try {
    let list = null;
    try { const r = await fetch(base + "/floors"); if (r.ok) list = await r.json(); } catch {}
    if (!Array.isArray(list) || !list.length) list = [{ slug: "default" }];
    const loaded = new Map();
    for (const item of list) {
      try { const r = await fetch(base + "/floors/" + item.slug + "/world"); if (!r.ok) continue; loaded.set(item.slug, buildFloorFromBlob(item.slug, await r.json())); } catch {}
    }
    if (loaded.size) { floors.clear(); for (const [k, v] of loaded) floors.set(k, v); console.log("Loaded " + loaded.size + " floor(s) from API: " + [...loaded.keys()].join(", ")); }
    else console.warn("WORLD_API returned no usable floors — using built-in floors");
  } catch (e) {
    console.warn(`WORLD_API unavailable (${e.message}) — using built-in floors`);
  }
}
loadWorld().finally(() => {
  server.listen(PORT, () => console.log(`NexSpace realtime + web: http://localhost:${PORT}  (open two tabs)`));
});

// graceful shutdown (§8)
function shutdown() { clearInterval(heartbeat); try { wss.close(); } catch {} try { server.close(); } catch {} console.log("NexSpace realtime shutting down…"); process.exit(0); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
