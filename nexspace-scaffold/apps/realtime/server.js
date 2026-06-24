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
  const want = /^(LIVEKIT_|S3_|GOOGLE_|YOUTUBE_|JWT_SECRET|OWNER_PASSWORD|ADMIN_PASSWORD|MEMBER_PASSWORD|ANTHROPIC_API_KEY|OPENAI_API_KEY|OPENAI_BASE_URL|GEMINI_API_KEY|AI_MODEL|LOGS_TOKEN)/;
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

// ---------- Live logging (debug tracing) — ring buffer + Server-Sent-Events fan-out to /logs.html ----------
// Every console.log/warn/error is mirrored into a bounded buffer and streamed to connected log viewers,
// so existing flow logs (join/leave/login/edits/errors) show up live with no extra call-site changes.
const LOG_MAX = 500, LOG_BUF = [], logClients = new Set();
const _safe = (a) => { try { return typeof a === "string" ? a : JSON.stringify(a); } catch { return String(a); } };
function pushLog(level, args) {
  const e = { t: Date.now(), level, msg: args.map(_safe).join(" ") };
  LOG_BUF.push(e); if (LOG_BUF.length > LOG_MAX) LOG_BUF.shift();
  const line = "data: " + JSON.stringify(e) + "\n\n";
  for (const res of logClients) { try { res.write(line); } catch { /* dead client */ } }
}
(function patchConsole() {
  const o = { log: console.log.bind(console), warn: console.warn.bind(console), error: console.error.bind(console), debug: (console.debug || console.log).bind(console) };
  console.log = (...a) => { pushLog("info", a); o.log(...a); };
  console.warn = (...a) => { pushLog("warn", a); o.warn(...a); };
  console.error = (...a) => { pushLog("error", a); o.error(...a); };
  console.debug = (...a) => { pushLog("debug", a); o.debug(...a); };
})();
// Logs are sensitive (names, emails, chat). Require ?key=LOGS_TOKEN in production; allow localhost in dev when unset.
function logsAuthorized(req, u) {
  const key = u.searchParams.get("key") || "";
  if (process.env.LOGS_TOKEN) return key === process.env.LOGS_TOKEN;
  const ra = req.socket.remoteAddress || "";
  return ra.includes("127.0.0.1") || ra.includes("::1");
}

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
// Email+password login for the single-service deploy (no separate API/DB). Demo defaults below; override
// passwords with OWNER_PASSWORD / ADMIN_PASSWORD / MEMBER_PASSWORD env vars (recommended for any real use).
const PASSWORD_USERS = [
  { email: "owner@nexspace.dev",  password: process.env.OWNER_PASSWORD  || "owner1234",  role: "owner",  name: "Owner"  },
  { email: "admin@nexspace.dev",  password: process.env.ADMIN_PASSWORD  || "admin1234",  role: "admin",  name: "Admin"  },
  { email: "member@nexspace.dev", password: process.env.MEMBER_PASSWORD || "member1234", role: "member", name: "Member" },
];
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

// ---------- Shared YouTube TV (§6.22) — one screen everyone watches; a queue anyone can add to. ----------
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || process.env.GOOGLE_API_KEY || "";
const validVideoId = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{6,20}$/.test(v);
let tv = { videoId: "e5D5h4W7P98", title: "NexSpace TV", by: "", queue: [], playing: false, position: 0, updatedAt: Date.now() }; // off by default — press ⏯ to start for everyone
const tvLivePos = () => tv.playing ? tv.position + (Date.now() - tv.updatedAt) / 1000 : tv.position; // current second, server-authoritative
function tvState() { return { t: "tv", videoId: tv.videoId, title: tv.title, by: tv.by, queue: tv.queue, playing: tv.playing, position: tvLivePos() }; }
function tvSetVideo(videoId, title, by) { tv.videoId = videoId; tv.title = title; tv.by = by; tv.position = 0; tv.playing = true; tv.updatedAt = Date.now(); }

// ---------- Authoritative world(s) — multi-floor (spec §6: multiple maps + portals) ----------
// Each floor is an independent world; a player belongs to exactly one floor at a time, and
// portals teleport between them. Built-in geometry below is the fallback when WORLD_API is unset;
// otherwise every floor is loaded from the API (apps/api) in loadWorld().
const DEFAULT_FLOOR = "default";
const floors = new Map(); // slug -> floor state { slug, name, w, h, obstacles, rooms, mediaWall, portals, branding, spawn }

function makeDefaultFloor() {
  const W = 2200, H = 1500;
  const walls = [ // structural (not editable)
    { x: 0, y: 0, w: W, h: 16 }, { x: 0, y: H - 16, w: W, h: 16 },
    { x: 0, y: 0, w: 16, h: H }, { x: W - 16, y: 0, w: 16, h: H },
    { x: 520, y: 120, w: 16, h: 300 }, { x: 520, y: 520, w: 16, h: 240 }, { x: 120, y: 760, w: 430, h: 16 },
    { x: 1500, y: 120, w: 16, h: 560 }, { x: 1516, y: 120, w: 300, h: 16 }, { x: 1516, y: 666, w: 300, h: 16 },
    { x: 1800, y: 120, w: 16, h: 236 }, { x: 1800, y: 452, w: 16, h: 230 },
  ];
  const furniture = [ // editable (owner can move/add/delete). kind drives the 3D prop model.
    { id: "f-d1", x: 980, y: 560, w: 240, h: 120, r: 14, kind: "table" }, { id: "f-d2", x: 300, y: 300, w: 150, h: 80, r: 12, kind: "desk" },
    { id: "f-d3", x: 1600, y: 330, w: 170, h: 90, r: 12, kind: "desk" }, { id: "f-d4", x: 900, y: 1150, w: 120, h: 120, r: 60, kind: "plant" },
    { id: "f-d5", x: 1750, y: 1150, w: 150, h: 90, r: 12, kind: "couch" }, { id: "f-d6", x: 250, y: 1150, w: 90, h: 90, r: 10, kind: "plant" },
    // ☕ lounge zone near the spawn — a rug with sofas, a coffee table and a plant for casual hangouts
    { id: "f-lg-rug", x: 560, y: 1180, w: 320, h: 220, r: 0, kind: "rug" },
    { id: "f-lg-c1", x: 580, y: 1190, w: 150, h: 70, r: 12, kind: "couch" }, { id: "f-lg-c2", x: 740, y: 1190, w: 150, h: 70, r: 12, kind: "couch" },
    { id: "f-lg-tbl", x: 650, y: 1300, w: 120, h: 70, r: 14, kind: "table" }, { id: "f-lg-plant", x: 840, y: 1300, w: 80, h: 80, r: 40, kind: "plant" },
  ];
  const rooms = [
    { id: "focus", name: "Focus Room", color: "#7c6bff",
      bounds: { x: 140, y: 130, w: 380, h: 630 }, door: { x: 512, y: 418, w: 18, h: 104, state: "closed", knocking: false } },
    { id: "board", name: "Boardroom", color: "#39d3a6",
      bounds: { x: 1516, y: 136, w: 300, h: 546 }, door: { x: 1796, y: 356, w: 18, h: 96, state: "locked", knocking: false } },
  ];
  // mounted on the top wall (screen flush against the wall at y0-16; base ledge just below)
  const mediaWall = { x: 940, y: 212, w: 320, base: 16, screenH: 196,
    title: "📺 NexSpace TV — click to watch", playing: true, pos: 74, dur: 213 };
  const portals = [{ id: "to-rooftop", x: 2030, y: 1290, w: 96, h: 96, to: "rooftop", label: "Rooftop ↑", color: "#ffb454" }];
  const widgets = [
    { id: "w-note", type: "note", x: 360, y: 980, w: 190, h: 130, text: "Welcome to NexSpace! Click the 📺 TV to watch & queue songs together, or pop up to the rooftop 🌇", color: "#ffd166" },
    { id: "w-timer", type: "timer", x: 980, y: 300, w: 180, h: 96, label: "Standup ends", endsAt: Date.now() + 30 * 60000 },
  ];
  return { slug: "default", name: "HQ — Ground Floor", w: W, h: H, walls, furniture, rooms, mediaWall, portals, widgets,
    branding: { name: "NexSpace", color: "#5b8cff", logo: "", whiteLabel: false }, spawn: { x: 890, y: 920 } };
}

function makeRooftopFloor() {
  const W = 1600, H = 1100;
  const walls = [
    { x: 0, y: 0, w: W, h: 16 }, { x: 0, y: H - 16, w: W, h: 16 },
    { x: 0, y: 0, w: 16, h: H }, { x: W - 16, y: 0, w: 16, h: H },
  ];
  const furniture = [
    { id: "f-r1", x: 700, y: 300, w: 200, h: 120, r: 18, kind: "table" },
    { id: "f-r2", x: 220, y: 760, w: 140, h: 90, r: 12, kind: "couch" }, { id: "f-r3", x: 1240, y: 760, w: 140, h: 90, r: 12, kind: "couch" },
  ];
  const rooms = [
    { id: "cabana", name: "Cabana", color: "#39d3a6",
      bounds: { x: 120, y: 130, w: 360, h: 360 }, door: { x: 472, y: 290, w: 18, h: 90, state: "open", knocking: false } },
  ];
  const mediaWall = { x: 660, y: 720, w: 280, base: 16, screenH: 140,
    title: "📺 Rooftop TV — click to watch", playing: true, pos: 12, dur: 240 };
  const portals = [{ id: "to-default", x: 90, y: 960, w: 96, h: 96, to: "default", label: "Ground ↓", color: "#5b8cff" }];
  const widgets = [
    { id: "w-rnote", type: "note", x: 1180, y: 250, w: 190, h: 120, text: "Rooftop vibes ☕ — grab a seat by the cabana", color: "#39d3a6" },
  ];
  return { slug: "rooftop", name: "Rooftop Garden", w: W, h: H, walls, furniture, rooms, mediaWall, portals, widgets,
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
function ensureWallIds(f) { if (f && f.walls) for (const o of f.walls) if (!o.id) o.id = "k-" + crypto.randomBytes(3).toString("hex"); }  // walls need stable ids to be editable
function worldForClient(slug) {
  const f = floors.get(slug) || anyFloor();
  ensureWallIds(f);
  const obstacles = (f.walls || []).map(o => ({ ...o }));   // include the id so the editor can target a wall
  if (f.mediaWall) obstacles.push({ x: f.mediaWall.x, y: f.mediaWall.y, w: f.mediaWall.w, h: f.mediaWall.base }); // TV base is a wall (derived, no id → not editable)
  return {
    slug: f.slug, name: f.name, w: f.w, h: f.h, obstacles,
    furniture: (f.furniture || []).map(o => ({ ...o })),
    rooms: f.rooms.map(r => ({ id: r.id, name: r.name, color: r.color, bounds: r.bounds, door: { x: r.door.x, y: r.door.y, w: r.door.w, h: r.door.h, state: r.door.state }, booking: activeBooking(r), bookings: r.bookings || [] })),
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
  return [...clients.values()].map((p) => ({ id: p.id, name: p.name, x: p.x, y: p.y, facing: p.facing, status: p.status, talking: p.talking, bcast: p.bcast, role: p.role, floor: p.floor, avatar: p.avatar, appear: p.appear || null }));
}
// validate a user-chosen avatar appearance (hex colours + optional https GLB url)
function sanitizeAppear(a) {
  if (!a || typeof a !== "object") return null;
  const hex = (v, d) => (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v)) ? v.toLowerCase() : d;
  const model = (typeof a.model === "string" && /^https:\/\//.test(a.model)) ? a.model.slice(0, 300) : "";
  return { suit: hex(a.suit, "#24272f"), tie: hex(a.tie, "#5b8cff"), skin: hex(a.skin, "#f1c9a5"), model };
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
  else if (event === "emote") { broadcastLocal({ t: "emote", from: data.from, emote: data.emote }); }
  else if (event === "nudge") { for (const [ws2, q] of clients) if (q.id === data.to) send(ws2, { t: "nudge", from: data.from, name: data.name }); }
  else if (event === "moderate") { applyModerate(data.action, data.target); }
  else if (event === "tv") { tv = data; broadcastLocal(tvState()); }
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

// Dedicated, LOW-FREQUENCY Redis for durable persistence only (no 250ms fan-out) — fits a free Upstash
// quota easily. Set PERSIST_REDIS_URL to an Upstash rediss:// URL to survive Render redeploys.
let persistRedis = null;
if (process.env.PERSIST_REDIS_URL) {
  try {
    const Redis = require("ioredis"); const u = process.env.PERSIST_REDIS_URL;
    const opts = { maxRetriesPerRequest: 2 };
    if (/^rediss:/i.test(u) || /upstash\.io/i.test(u)) opts.tls = {}; // Upstash needs TLS even if the URL says redis://
    persistRedis = new Redis(u, opts);
    persistRedis.on("error", (e) => console.warn("persist redis:", e.message));
    persistRedis.on("connect", () => console.log("Durable edit persistence connected (PERSIST_REDIS_URL)"));
    console.log("Durable edit persistence enabled via PERSIST_REDIS_URL");
  } catch (e) { console.warn("persist redis init:", e.message); }
}
const persistClient = () => persistRedis || pub; // prefer the dedicated client; fall back to the fan-out client

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".ico": "image/x-icon" };
// ---- Floor furniture templates (spec 6.10 / P4-05) ----
function furnDim(fk) { return fk === "plant" ? { w: 80, h: 80, r: 40 } : fk === "chair" ? { w: 70, h: 70, r: 30 } : fk === "couch" ? { w: 150, h: 90, r: 12 } : fk === "table" ? { w: 200, h: 120, r: 16 } : fk === "rug" ? { w: 260, h: 180, r: 0 } : { w: 150, h: 80, r: 12 }; }
function sanitizeFurniture(o) {
  if (!o || typeof o !== "object") return null;
  const kind = ["desk", "table", "couch", "plant", "chair", "rug"].includes(o.kind) ? o.kind : "desk";
  const w = Math.max(10, Math.min(600, Number(o.w) || 80)), h = Math.max(10, Math.min(600, Number(o.h) || 80));
  const id = (typeof o.id === "string" && /^f-[a-z0-9]{2,40}$/i.test(o.id)) ? o.id : "f-" + crypto.randomBytes(3).toString("hex");
  return { id, x: Math.round(Number(o.x) || 0), y: Math.round(Number(o.y) || 0), w, h, r: Math.max(0, Math.min(60, Number(o.r) || 12)), kind };
}
function floorTemplate(name, W, H) {
  const items = [], add = (kind, x, y) => { const d = furnDim(kind); items.push({ kind, x, y, ...d }); };
  const mx = 200, my = 250;
  if (name === "lounge") {
    for (let i = 0; i < 3; i++) { const cx = mx + i * ((W - 2 * mx) / 3) + 120, cy = my + 200; add("rug", cx - 30, cy - 20); add("couch", cx, cy); add("couch", cx, cy + 120); add("table", cx + 170, cy + 40); add("plant", cx + 330, cy); }
  } else if (name === "classroom") {
    add("table", W / 2 - 100, my);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 5; c++) add("desk", mx + c * 230, my + 230 + r * 150);
    add("plant", mx - 60, my); add("plant", W - mx - 20, my);
  } else if (name === "event") {
    add("table", W / 2 - 100, my);
    for (let r = 0; r < 5; r++) for (let c = 0; c < 7; c++) add("chair", mx + c * 150, my + 230 + r * 120);
    add("plant", mx - 80, my + 220); add("plant", W - mx, my + 220);
  } else {
    for (let r = 0; r < 3; r++) for (let c = 0; c < 5; c++) add("desk", mx + c * 230, my + r * 230);
    add("table", W / 2 - 100, H - my - 160); add("couch", mx, H - my - 120); add("couch", W - mx - 160, H - my - 120);
    add("plant", mx - 40, my); add("plant", W - mx - 100, my);
  }
  return items.map((o) => ({ id: "f-" + crypto.randomBytes(3).toString("hex"), x: Math.max(20, Math.min(W - o.w - 20, Math.round(o.x))), y: Math.max(20, Math.min(H - o.h - 20, Math.round(o.y))), w: o.w, h: o.h, r: o.r, kind: o.kind }));
}
const server = http.createServer((req, res) => {
  let urlPath = (req.url || "/").split("?")[0];   // strip query first, so "/?sso=…" still serves the app
  if (urlPath === "/" || urlPath === "") urlPath = "/index.html";
  if (urlPath === "/logs/recent" || urlPath === "/logs/stream") {   // live debug logs for /logs.html (token-gated)
    const u = new URL(req.url, "http://x");
    if (!logsAuthorized(req, u)) { res.writeHead(403, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "logs locked — open /logs.html?key=<LOGS_TOKEN>" })); return; }
    if (urlPath === "/logs/recent") return json(res, { logs: LOG_BUF.slice(-LOG_MAX) });
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
    res.write("retry: 3000\n\n");
    for (const e of LOG_BUF.slice(-200)) res.write("data: " + JSON.stringify(e) + "\n\n");   // backfill recent history
    logClients.add(res); console.log("logs viewer connected (" + logClients.size + " watching)");
    req.on("close", () => { logClients.delete(res); });
    return;
  }
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
  if (urlPath === "/youtube/search") { // proxy YouTube search so the API key stays server-side
    if (!YOUTUBE_API_KEY) return json(res, { error: "search not configured (set YOUTUBE_API_KEY)" }, 503);
    const q = new URL(req.url, "http://x").searchParams.get("q") || "";
    if (!q.trim()) return json(res, { items: [] });
    (async () => {
      try {
        const u = "https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true&maxResults=10&q=" + encodeURIComponent(q) + "&key=" + YOUTUBE_API_KEY;
        const r = await fetch(u); const j = await r.json();
        if (j.error) throw new Error(j.error.message || "youtube error");
        const items = (j.items || []).map((it) => ({ videoId: it.id && it.id.videoId, title: it.snippet && it.snippet.title })).filter((x) => x.videoId);
        json(res, { items });
      } catch (e) { json(res, { error: "search failed: " + (e && e.message || e) }, 502); }
    })();
    return;
  }
  if (urlPath === "/auth/login" && req.method === "POST") { // email+password login (single-service, no DB) → mints the same HS256 JWT the join handler verifies
    return readJsonBody(req, (b) => {
      const email = String(b.email || "").trim().toLowerCase(), password = String(b.password || "");
      const u = PASSWORD_USERS.find((x) => x.email === email && x.password === password);
      if (!u) return json(res, { error: "invalid email or password" }, 401);
      const token = mintAppToken({ sub: "pw-" + u.email, name: u.name, role: u.role, email: u.email });
      json(res, { token, user: { name: u.name, role: u.role, email: u.email } });
      console.log(`✓ Password login: ${u.email} → ${u.role}`);
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
    if (urlPath === "/api/v1/floor") { const f = anyFloor(); return json(res, { slug: f.slug, name: f.name, width: f.w, height: f.h, rooms: f.rooms.map((r) => ({ id: r.id, name: r.name })), objects: (f.walls || []).length + (f.furniture || []).length, portals: f.portals.length, mediaWall: f.mediaWall ? { title: f.mediaWall.title, playing: f.mediaWall.playing } : null }); }
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
        status: "available", talking: m.talking !== false, bcast: false, appear: sanitizeAppear(m.appear) };
      clients.set(ws, player);
      A.sessions++; if (clients.size > A.peak) A.peak = clients.size;
      fireWebhook("user.joined", { id, name, role });
      notifySlack("👋 " + name + " entered the office");
      send(ws, { t: "welcome", id, world: worldForClient(player.floor), you: { ...player }, whiteboard: whiteboard.strokes, tv: tvState(), presentation: f0.presentation || null, game: f0.game || null });
      broadcastActivity(player.floor, "join", player.name, ws);   // tell the floor someone arrived
      setTimeout(() => { if (clients.has(ws)) postGuide(player); }, 1500); // AI greeter welcomes the new joiner (§6.21)
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
    } else if (m.t === "appearance") {                         // avatar customization: colours + display name (+ optional GLB url)
      if (typeof m.name === "string" && m.name.trim()) p.name = m.name.trim().slice(0, 16);
      if (m.appear) p.appear = sanitizeAppear(m.appear);        // broadcast to others via the next presence snapshot
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
      const room = floorOf(p).rooms.find(r => r.id === m.roomId);
      if (!room || !["open", "closed", "locked"].includes(m.state)) return;
      const cur = room.door.state;
      if (m.state === "locked" && rank(p.role) < RANK.admin) return deny(ws, "lock doors", "admin");      // only admins can lock
      if (cur === "locked" && rank(p.role) < RANK.member) return deny(ws, "unlock the door", "member");   // unlocking a locked door needs member+
      room.door.state = m.state; publishEvent("door", { floor: p.floor, roomId: m.roomId, state: m.state }); // anyone may open/close an unlocked door
    } else if (m.t === "knock") {
      const room = floorOf(p).rooms.find(r => r.id === m.roomId);
      if (!room) return;
      const d = room.door;
      if (d.state === "open" || d.knocking) return;
      if (d.state === "locked" && rank(p.role) < RANK.member) return deny(ws, "enter the locked room", "member");
      d.knocking = true;
      const occupied = [...clients.values()].some(q => q.floor === p.floor && inRoom(q, room));
      setTimeout(() => { d.knocking = false; if (occupied) { d.state = "open"; publishEvent("door", { floor: p.floor, roomId: room.id, state: "open" }); } }, 1300);
    } else if (m.t === "bookRoom") {
      if (rank(p.role) < RANK.member) return deny(ws, "book a room", "member");
      const f = floorOf(p); const room = f.rooms.find((r) => r.id === m.roomId); if (!room) return;
      const now = Date.now();
      const mins = Math.max(5, Math.min(240, Math.round(Number(m.minutes) || 30)));
      let startsAt = Number(m.startsAt) || now;                 // absolute ms; clamp to a sane window (now-1min .. +14 days)
      startsAt = Math.max(now - 60000, Math.min(now + 14 * 864e5, startsAt));
      const endsAt = startsAt + mins * 60000;
      if (!room.bookings) room.bookings = [];
      if (room.bookings.some((b) => startsAt < b.endsAt && endsAt > b.startsAt))      // overlap → reject (tell the booker)
        return send(ws, { t: "booking", roomId: room.id, bookings: room.bookings, booking: activeBooking(room), error: "That time overlaps an existing booking." });
      room.bookings.push({ id: "bk-" + crypto.randomBytes(3).toString("hex"), title: String(m.title || "Meeting").slice(0, 60), by: p.name, byId: p.id, startsAt, endsAt });
      room.bookings.sort((a, b) => a.startsAt - b.startsAt);
      refreshRoomActive(f, room, now);                          // activates immediately if it starts now (flips presence + broadcasts)
      broadcastBooking(f, room);
    } else if (m.t === "cancelBooking") {
      const f = floorOf(p); const room = f.rooms.find((r) => r.id === m.roomId); if (!room || !room.bookings) return;
      const bk = room.bookings.find((b) => b.id === m.bookingId); if (!bk) return;
      if (bk.byId !== p.id && rank(p.role) < RANK.admin) return deny(ws, "cancel this booking", "admin"); // only the booker or an admin
      room.bookings = room.bookings.filter((b) => b.id !== m.bookingId);
      refreshRoomActive(f, room, Date.now()); broadcastBooking(f, room);
    } else if (m.t === "gameJoin") {                           // tic-tac-toe: claim an open seat (else spectate)
      const f = floorOf(p); if (!f.game) f.game = newGame();
      const g = f.game;
      if (g.seats.X !== p.id && g.seats.O !== p.id) { if (!g.seats.X) { g.seats.X = p.id; g.names.X = p.name; } else if (!g.seats.O) { g.seats.O = p.id; g.names.O = p.name; } }
      broadcastGame(f);
    } else if (m.t === "gameMove") {
      const f = floorOf(p), g = f.game; if (!g || g.winner || g.draw) return;
      const mark = g.seats.X === p.id ? "X" : g.seats.O === p.id ? "O" : null;
      if (!mark || mark !== g.turn) return;                     // not your seat, or not your turn
      const c = Number(m.cell); if (!Number.isInteger(c) || c < 0 || c > 8 || g.board[c]) return;
      g.board[c] = mark;
      if (winLine(g.board)) g.winner = mark; else if (g.board.every(Boolean)) g.draw = true; else g.turn = mark === "X" ? "O" : "X";
      broadcastGame(f);
    } else if (m.t === "gameReset") {
      const f = floorOf(p); const old = f.game || newGame();
      f.game = { board: Array(9).fill(null), turn: "X", seats: old.seats, names: old.names, winner: null, draw: false }; // keep seats, fresh board
      broadcastGame(f);
    } else if (m.t === "present") {                            // start presenting your screen to the room/floor
      if (rank(p.role) < RANK.member) return deny(ws, "present", "member");
      const f = floorOf(p); const r = f.rooms.find((rm) => inRoom(p, rm));
      f.presentation = { byId: p.id, byName: p.name, roomId: r ? r.id : null };
      broadcastPresentation(f);
    } else if (m.t === "unpresent") {                          // stop presenting (presenter or admin)
      const f = floorOf(p);
      if (f.presentation && (f.presentation.byId === p.id || rank(p.role) >= RANK.admin)) { f.presentation = null; broadcastPresentation(f); }
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
      rememberChat(payload);
      const aiM = body.trim().match(/^(?:@ai|\/ai)\b\s*([\s\S]*)$/i);   // ask the in-office assistant
      if (aiM) askAssistant(p, aiM[1] || "", { scope, channel, to, floor: p.floor, askerId: p.id, x: p.x, y: p.y, roomId: payload.roomId });
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
    } else if (m.t === "emote") {                              // avatar emotes (wave/clap/sit/dance)
      if (mutedIds.has(p.id)) return;
      const e = ["wave", "clap", "sit", "dance"].includes(m.emote) ? m.emote : null; if (!e) return;
      broadcastLocal({ t: "emote", from: p.id, emote: e }); publishEvent("emote", { from: p.id, emote: e });
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
      const old = floors.get(p.floor); if (old && old.presentation && old.presentation.byId === p.id) { old.presentation = null; broadcastPresentation(old); } // stop presenting on the floor you left
      p.floor = dest.slug;
      // arrive at the floor's known-safe interior spawn (NOT beside the return portal — small floors clamp
      // that into a wall, leaving the player stuck inside the collision radius). Small jitter avoids stacking.
      const sp = dest.spawn || { x: dest.w / 2, y: dest.h / 2 };
      p.x = clamp(sp.x + (Math.random() - 0.5) * 80, 60, dest.w - 60);
      p.y = clamp(sp.y + (Math.random() - 0.5) * 80, 60, dest.h - 60);
      p.lastMoveAt = Date.now();
      send(ws, { t: "floor", world: worldForClient(dest.slug), you: { id: p.id, x: Math.round(p.x), y: Math.round(p.y), floor: p.floor }, presentation: dest.presentation || null, game: dest.game || null });
      console.log(`~ ${p.name} (${p.id}) → floor '${dest.slug}'`);
    } else if (m.t === "tvPlay") {            // shared TV: play a video now (everyone's screen switches)
      if (!validVideoId(m.videoId)) return;
      tvSetVideo(m.videoId, String(m.title || "").slice(0, 140), p.name);
      broadcastLocal(tvState()); publishEvent("tv", tv);
    } else if (m.t === "tvCtrl") {            // shared play/pause + seek — anyone can drive the watch-party
      tv.playing = !!m.playing; tv.position = Math.max(0, Number(m.position) || 0); tv.updatedAt = Date.now();
      broadcastLocal(tvState()); publishEvent("tv", tv);
    } else if (m.t === "tvQueue") {           // add to the shared queue
      if (!validVideoId(m.videoId) || tv.queue.length >= 50) return;
      tv.queue.push({ videoId: m.videoId, title: String(m.title || "").slice(0, 140), by: p.name });
      broadcastLocal(tvState()); publishEvent("tv", tv);
    } else if (m.t === "tvNext") {            // skip to the next queued video
      if (!tv.queue.length) return;
      const n = tv.queue.shift(); tvSetVideo(n.videoId, n.title, n.by);
      broadcastLocal(tvState()); publishEvent("tv", tv);
    } else if (m.t === "tvRemove") {
      const i = Number(m.index); if (Number.isInteger(i) && i >= 0 && i < tv.queue.length) { tv.queue.splice(i, 1); broadcastLocal(tvState()); publishEvent("tv", tv); }
    } else if (m.t === "editFloor") {           // owner/admin live-edit: move / add / remove placeable elements
      if (rank(p.role) < RANK.admin) return deny(ws, "edit the floor", "admin");
      const f = floorOf(p), op = m.op; let changed = false;
      const cx = (v, max) => clamp(Number(v), 0, max), grid = (v) => Math.round(v / 10) * 10;
      const arrFor = (kind) => kind === "portal" ? f.portals : kind === "furniture" ? f.furniture : kind === "wall" ? f.walls : f.widgets;
      if (op === "move") {
        const o = arrFor(m.kind).find((x) => x.id === m.id);
        if (o) { o.x = grid(cx(m.x, f.w - (o.w || 40))); o.y = grid(cx(m.y, f.h - (o.h || 40))); changed = true; }
      } else if (op === "add" && m.kind === "furniture") {
        const fk = ["desk", "table", "couch", "plant", "chair", "rug"].includes(m.furnitureKind) ? m.furnitureKind : "desk";
        const dim = fk === "plant" ? { w: 80, h: 80, r: 40 } : fk === "chair" ? { w: 70, h: 70, r: 30 } : fk === "couch" ? { w: 150, h: 90, r: 12 } : fk === "table" ? { w: 200, h: 120, r: 16 } : fk === "rug" ? { w: 260, h: 180, r: 0 } : { w: 150, h: 80, r: 12 };
        const fid = (typeof m.id === "string" && /^f-[a-z0-9]{4,32}$/.test(m.id) && !f.furniture.some((x) => x.id === m.id)) ? m.id : "f-" + crypto.randomBytes(3).toString("hex");
        f.furniture.push({ id: fid, x: grid(cx(m.x, f.w - dim.w)), y: grid(cx(m.y, f.h - dim.h)), ...dim, kind: fk });
        changed = true;
      } else if (op === "add") {
        const id = (typeof m.id === "string" && /^w-[a-z0-9]{4,32}$/.test(m.id) && !f.widgets.some((x) => x.id === m.id)) ? m.id : "w-" + crypto.randomBytes(3).toString("hex");
        const type = ["note", "timer", "embed"].includes(m.wtype) ? m.wtype : "note";
        const wd = { id, type, x: grid(cx(m.x, f.w - 180)), y: grid(cx(m.y, f.h - 120)), w: type === "embed" ? 280 : 180, h: type === "embed" ? 160 : 120 };
        if (type === "note") { wd.text = String(m.text || "New note").slice(0, 300); wd.color = "#ffd166"; }
        else if (type === "timer") { wd.label = String(m.label || "Timer").slice(0, 40); wd.endsAt = Date.now() + 10 * 60000; }
        else { wd.kind = "web"; wd.url = String(m.url || "").slice(0, 400); wd.title = String(m.title || "Embed").slice(0, 80); }
        f.widgets.push(wd); changed = true;
      } else if (op === "template") {                       // replace floor furniture with a themed layout (P4-05)
        const name = ["office", "lounge", "classroom", "event"].includes(m.name) ? m.name : "office";
        f.furniture = floorTemplate(name, f.w, f.h); changed = true;
      } else if (op === "setFurniture" && Array.isArray(m.items)) {  // replace whole furniture set (powers template undo)
        f.furniture = m.items.slice(0, 200).map(sanitizeFurniture).filter(Boolean).map((o) => ({ ...o, x: Math.max(0, Math.min(f.w - o.w, o.x)), y: Math.max(0, Math.min(f.h - o.h, o.y)) }));
        changed = true;
      } else if (op === "addRoom" && m.bounds && typeof m.bounds === "object" && f.rooms.length < 24) {  // draw a new room zone (P4-03)
        const w = Math.max(120, Math.min(f.w - 40, Number(m.bounds.w) || 300)), h = Math.max(120, Math.min(f.h - 40, Number(m.bounds.h) || 220));
        const x = grid(cx(m.bounds.x, f.w - w)), y = grid(cx(m.bounds.y, f.h - h));
        const id = (typeof m.id === "string" && /^r-[a-z0-9]{4,32}$/.test(m.id) && !f.rooms.some((r) => r.id === m.id)) ? m.id : "r-" + crypto.randomBytes(3).toString("hex");
        const name = String(m.name || "Room").slice(0, 30);
        const color = (typeof m.color === "string" && /^#[0-9a-f]{3,8}$/i.test(m.color)) ? m.color : "#5b8cff";
        const door = { x: Math.round(x + w / 2 - 9), y: Math.round(y + h - 9), w: 18, h: 18, state: "open", knocking: false };
        f.rooms.push({ id, name, color, bounds: { x, y, w, h }, door, bookings: [] });
        changed = true;
      } else if (op === "renameRoom") {                     // double-click a room to rename it
        const r = f.rooms.find((rm) => rm.id === m.id); if (r) { r.name = String(m.name || "Room").slice(0, 30); changed = true; }
      } else if (op === "removeRoom") {
        const i = f.rooms.findIndex((r) => r.id === m.id); if (i >= 0) { f.rooms.splice(i, 1); changed = true; }
      } else if (op === "moveRoom") {                       // drag an existing room zone (door moves with it)
        const r = f.rooms.find((rm) => rm.id === m.id);
        if (r) { const nx = grid(cx(m.x, f.w - r.bounds.w)), ny = grid(cx(m.y, f.h - r.bounds.h));
          const dxp = nx - r.bounds.x, dyp = ny - r.bounds.y; r.bounds.x = nx; r.bounds.y = ny;
          if (r.door) { r.door.x += dxp; r.door.y += dyp; } changed = true; }
      } else if (op === "resizeRoom" && m.bounds && typeof m.bounds === "object") {  // drag a corner/edge handle to resize a room
        const r = f.rooms.find((rm) => rm.id === m.id);
        if (r) {
          const W = grid(Math.max(120, Math.min(f.w, Number(m.bounds.w) || r.bounds.w))), H = grid(Math.max(120, Math.min(f.h, Number(m.bounds.h) || r.bounds.h)));
          const X = grid(cx(m.bounds.x, f.w - W)), Y = grid(cx(m.bounds.y, f.h - H));
          r.bounds = { x: X, y: Y, w: W, h: H };
          if (r.door) { r.door.x = Math.max(X, Math.min(X + W - r.door.w, r.door.x)); r.door.y = Math.max(Y, Math.min(Y + H - r.door.h, r.door.y)); }
          changed = true;
        }
      } else if (op === "remove") {
        const arr = arrFor(m.kind);
        const i = arr.findIndex((x) => x.id === m.id); if (i >= 0) { arr.splice(i, 1); changed = true; }
      } else if (op === "restore" && m.obj && typeof m.obj === "object") {  // re-insert a deleted element verbatim (undo) — sanitized
        const arr = arrFor(m.kind), src = m.obj;
        const id = (typeof src.id === "string" && /^[fwpk]-[a-z0-9]{2,40}$/i.test(src.id) && !arr.some((x) => x.id === src.id)) ? src.id : ((m.kind === "furniture" ? "f-" : m.kind === "wall" ? "k-" : "w-") + crypto.randomBytes(3).toString("hex"));
        const W = Math.max(8, Math.min(2000, Number(src.w) || 80)), H = Math.max(8, Math.min(2000, Number(src.h) || 80));
        const o = { id, x: grid(cx(src.x, f.w - W)), y: grid(cx(src.y, f.h - H)), w: W, h: H };
        if (m.kind === "wall") {
          (f.walls = f.walls || []).push(o); changed = true;
        } else if (m.kind === "furniture") {
          o.kind = ["desk", "table", "couch", "plant", "chair", "rug"].includes(src.kind) ? src.kind : "desk";
          o.r = Math.max(0, Math.min(60, Number(src.r) || 12)); f.furniture.push(o); changed = true;
        } else if (m.kind === "portal") {
          o.to = String(src.to || "").slice(0, 40); o.label = String(src.label || "Portal").slice(0, 40);
          if (src.spawn && typeof src.spawn === "object") o.spawn = { x: Number(src.spawn.x) || 0, y: Number(src.spawn.y) || 0 };
          f.portals.push(o); changed = true;
        } else {
          const type = ["note", "timer", "embed"].includes(src.type) ? src.type : "note"; o.type = type;
          if (type === "note") { o.text = String(src.text || "Note").slice(0, 300); o.color = /^#[0-9a-f]{3,8}$/i.test(src.color || "") ? src.color : "#ffd166"; }
          else if (type === "timer") { o.label = String(src.label || "Timer").slice(0, 40); o.endsAt = Number(src.endsAt) || (Date.now() + 10 * 60000); }
          else { o.kind = "web"; o.url = String(src.url || "").slice(0, 400); o.title = String(src.title || "Embed").slice(0, 80); }
          f.widgets.push(o); changed = true;
        }
      }
      if (changed) { console.log(`editFloor '${op}'${m.kind ? " (" + m.kind + ")" : ""} by ${p.name} on '${f.slug}'`); const wmsg = JSON.stringify({ t: "world", world: worldForClient(f.slug) }); for (const [ws2, q] of clients) if (q.floor === f.slug && ws2.readyState === 1) ws2.send(wmsg); persistFloors(); }
    }
  });

  ws.on("close", () => {
    const p = clients.get(ws);
    if (p && p.joinedAt) { A.totalMs += Date.now() - p.joinedAt; A.closed++; }
    clients.delete(ws);
    if (p) {
      const f = floors.get(p.floor); if (f && f.presentation && f.presentation.byId === p.id) { f.presentation = null; broadcastPresentation(f); } // presenter left → stop
      if (f && f.game) { const g = f.game; let ch = false; if (g.seats.X === p.id) { g.seats.X = null; g.names.X = ""; ch = true; } if (g.seats.O === p.id) { g.seats.O = null; g.names.O = ""; ch = true; } if (ch) broadcastGame(f); } // free their game seat
      broadcastActivity(p.floor, "leave", p.name, ws);
      fireWebhook("user.left", { id: p.id, name: p.name }); notifySlack("👋 " + p.name + " left the office"); console.log(`- ${p.name} (${p.id}) — ${clients.size} online`);
    }
  });
});

// Authoritative tick: advance media clock + broadcast snapshot of all dynamic state.
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now(), dt = (now - lastTick) / 1000; lastTick = now;
  for (const f of floors.values()) if (f.mediaWall && f.mediaWall.playing) { f.mediaWall.pos += dt; if (f.mediaWall.pos > f.mediaWall.dur) f.mediaWall.pos = 0; }
  for (const f of floors.values()) for (const r of f.rooms) {   // schedule: drop finished bookings, activate ones whose start arrived
    if (!r.bookings || !r.bookings.length) { if (r._activeId) { refreshRoomActive(f, r, now); broadcastBooking(f, r); } continue; }
    const before = r.bookings.length;
    const justEnded = r.bookings.filter((b) => b.endsAt <= now);
    r.bookings = r.bookings.filter((b) => b.endsAt > now);
    for (const b of justEnded) postMeetingNotes(f, r, b);     // auto meeting-notes (no-op without a key/chat)
    const changed = refreshRoomActive(f, r, now);
    if (changed || r.bookings.length !== before) broadcastBooking(f, r);
  }
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

// keep the shared TV aligned for everyone — re-broadcast the live playback position periodically
setInterval(() => { if (clients.size && tv.playing) broadcastLocal(tvState()); }, 15000);

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
function activeBooking(room) { if (!room.bookings) return null; const now = Date.now(); return room.bookings.find((b) => b.startsAt <= now && b.endsAt > now) || null; }
// Recompute the active booking; on a transition flip the booker's presence (→inMeeting on start, →available on end). Returns true if it changed.
function refreshRoomActive(f, room, now) {
  const active = (room.bookings || []).find((b) => b.startsAt <= now && b.endsAt > now) || null;
  const id = active ? active.id : null;
  if (id === (room._activeId || null)) { room.booking = active; return false; }
  if (active) { const o = [...clients.values()].find((q) => q.id === active.byId); if (o && o.status !== "inMeeting") o.status = "inMeeting"; }            // meeting started → in a meeting
  else { const o = room._activeBy && [...clients.values()].find((q) => q.id === room._activeBy); if (o && o.status === "inMeeting") o.status = "available"; } // meeting ended → free again
  room._activeId = id; room._activeBy = active ? active.byId : null; room.booking = active; return true;
}
function broadcastBooking(f, room) { const msg = JSON.stringify({ t: "booking", floor: f.slug, roomId: room.id, bookings: room.bookings || [], booking: activeBooking(room) }); for (const [ws, q] of clients) if (q.floor === f.slug && ws.readyState === 1) ws.send(msg); }
function broadcastPresentation(f) { const msg = JSON.stringify({ t: "present", floor: f.slug, presentation: f.presentation || null }); for (const [ws, q] of clients) if (q.floor === f.slug && ws.readyState === 1) ws.send(msg); }
function broadcastActivity(floorSlug, kind, name, exceptWs) { const msg = JSON.stringify({ t: "activity", kind, name, ts: Date.now() }); for (const [ws, q] of clients) if (q.floor === floorSlug && ws !== exceptWs && ws.readyState === 1) ws.send(msg); }
function newGame() { return { board: Array(9).fill(null), turn: "X", seats: { X: null, O: null }, names: { X: "", O: "" }, winner: null, draw: false }; }
const WIN_LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
function winLine(b) { return WIN_LINES.some(([a, c, d]) => b[a] && b[a] === b[c] && b[a] === b[d]); }
function broadcastGame(f) { const msg = JSON.stringify({ t: "game", floor: f.slug, game: f.game || null }); for (const [ws, q] of clients) if (q.floor === f.slug && ws.readyState === 1) ws.send(msg); }
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
    if (target) send(ws, { t: "chat", from: d.from, name: d.name, scope: d.scope, channel: d.channel, to: d.to, body: d.body, ts: d.ts, ai: d.ai || false });
  }
}
// ---------- In-office AI assistant (optional). Set ANTHROPIC_API_KEY or OPENAI_API_KEY (see AI_ASSISTANT.md). ----------
function aiProvider() { return process.env.ANTHROPIC_API_KEY ? "anthropic" : process.env.OPENAI_API_KEY ? "openai" : process.env.GEMINI_API_KEY ? "gemini" : null; }
function aiConfigured() { return !!aiProvider(); }
function aiModel() { if (process.env.AI_MODEL) return process.env.AI_MODEL; const p = aiProvider(); return p === "anthropic" ? "claude-3-5-haiku-latest" : p === "openai" ? "gpt-4o-mini" : "gemini-2.5-flash"; }
const recentByFloor = new Map();   // floor -> recent chat messages (for "summarize" context)
function rememberChat(d) { if (d.from === "assistant") return; const k = d.floor || DEFAULT_FLOOR; let a = recentByFloor.get(k); if (!a) { a = []; recentByFloor.set(k, a); } a.push({ name: d.name, body: d.body }); if (a.length > 40) a.shift(); }
async function callLLM(system, userText) {
  const provider = aiProvider(), model = aiModel();
  if (provider === "anthropic") {
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
      headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 600, system, messages: [{ role: "user", content: userText }] }) });
    const j = await r.json(); if (j.error) throw new Error(j.error.message || "anthropic error");
    return (j.content && j.content[0] && j.content[0].text) || "(no response)";
  }
  if (provider === "openai") {
    const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com").replace(/\/$/, ""); // OpenAI-compatible (Groq, OpenRouter, Together…)
    const r = await fetch(base + "/v1/chat/completions", { method: "POST",
      headers: { "Authorization": "Bearer " + process.env.OPENAI_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 600, messages: [{ role: "system", content: system }, { role: "user", content: userText }] }) });
    const j = await r.json(); if (j.error) throw new Error(j.error.message || "openai error");
    return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "(no response)";
  }
  // Google Gemini (free tier — generous, no card). https://aistudio.google.com → "Get API key"
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent", { method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify({ system_instruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: userText }] }], generationConfig: { maxOutputTokens: 600 } }) });
  const j = await r.json(); if (j.error) throw new Error((j.error && j.error.message) || "gemini error");
  const c = j.candidates && j.candidates[0];
  return (c && c.content && c.content.parts && c.content.parts.map((x) => x.text || "").join("")) || "(no response)";
}
function postAssistant(text, ctx, fromName) {
  const payload = { from: "assistant", name: fromName || "🤖 Assistant", scope: ctx.scope, channel: ctx.channel,
    to: ctx.scope === "dm" ? ctx.askerId : ctx.to, body: String(text || "").slice(0, 1500),
    floor: ctx.floor, x: ctx.x, y: ctx.y, roomId: ctx.roomId, ts: Date.now(), ai: true };
  deliverChat(payload); publishEvent("chat", payload);
}
// AI greeter NPC (§6.21 / P6-09) — DMs a contextual welcome to each new joiner (set GUIDE_OFF=1 to disable)
function postGuide(p) {
  if (process.env.GUIDE_OFF === "1") return;
  const f = floorOf(p);
  const others = Math.max(0, [...clients.values()].filter((c) => c.floor === f.slug).length - 1);
  const who = others === 0 ? "You're the first one here" : others === 1 ? "1 other person is here" : others + " others are here";
  const body = "👋 Welcome to " + f.name + ", " + p.name + "! " + who + ". Tips: walk with WASD or click the floor, you hear people nearby (spatial audio), click the 📺 TV for a watch-party, and type \"@ai help\" anytime. Have fun!";
  postAssistant(body, { scope: "dm", askerId: p.id, channel: null, to: p.id, floor: p.floor, x: p.x, y: p.y, roomId: null }, "🤖 Guide");
}
function hhmm(ts) { const d = new Date(ts); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); }
// Built-in commands answered from server state — no LLM, so they work even without an API key. Returns text or null.
function localAnswer(p, q) {
  const f = floorOf(p);
  const s = String(q || "").toLowerCase().trim();
  if (s === "help" || s === "commands" || s === "?" || s.startsWith("what can you do")) return "Try: \"@ai who's here\", \"@ai schedule\", or \"@ai summarize\". Ask me anything else too" + (aiConfigured() ? "." : " — though free-form answers need an API key (see AI_ASSISTANT.md).");
  if (s.startsWith("who")) {   // "who's here" / "who is here" / "who is around" …
    const here = [...clients.values()].filter((c) => c.floor === f.slug).map((c) => c.name);
    return "👥 On " + f.name + " right now (" + here.length + "): " + (here.join(", ") || "just you");
  }
  if (s.includes("schedule") || s.includes("booked") || s.includes("booking") || s.includes("agenda") || s.includes("what's on") || s.includes("whats on") || s.includes("meetings")) {
    const lines = [];
    for (const r of f.rooms) for (const b of (r.bookings || []).slice().sort((a, c) => a.startsAt - c.startsAt)) lines.push("• " + r.name + ": " + b.title + " (" + hhmm(b.startsAt) + "–" + hhmm(b.endsAt) + ") · " + b.by);
    return lines.length ? "📅 Today on " + f.name + ":\n" + lines.join("\n") : "📅 Nothing booked yet on " + f.name + ".";
  }
  return null;
}
async function askAssistant(p, prompt, ctx) {
  const q = (prompt || "").trim();
  const local = localAnswer(p, q); if (local !== null) { postAssistant(local, ctx); return; }   // who / schedule / help — no LLM, no cooldown
  if (!aiConfigured()) { postAssistant("I'm not enabled for free-form questions yet — an admin can turn me on with a free Google Gemini key (set GEMINI_API_KEY). I can still do “@ai who's here” and “@ai schedule”. See AI_ASSISTANT.md.", ctx); return; }
  if (Date.now() - (p.lastAiAt || 0) < 3000) return; p.lastAiAt = Date.now();   // rate-limit only the (paid) LLM calls
  const sys = "You are NexSpace's friendly in-office assistant inside a virtual office. Keep replies concise (a few sentences) and useful. You can answer questions, summarize the recent room chat, and draft short meeting notes. Reply in plain text.";
  const recent = recentByFloor.get(ctx.floor || DEFAULT_FLOOR) || [];
  const ctxText = recent.length ? ("Recent room chat:\n" + recent.slice(-25).map((c) => c.name + ": " + c.body).join("\n") + "\n\n") : "";
  const ask = (prompt || "").trim() || "Summarize the recent room chat.";
  console.log(`ai assistant query by ${p.name} via ${aiProvider()}: "${ask.slice(0, 80)}"`);
  try { const text = await callLLM(sys, ctxText + "Request from " + p.name + ": " + ask); console.log(`ai assistant replied to ${p.name} (${(text || "").length} chars)`); postAssistant(text, ctx); }
  catch (e) { console.error("ai assistant call failed for " + p.name + ": " + (e && e.message || e)); postAssistant("⚠️ I couldn't reach the AI service (" + (e && e.message || e) + ").", ctx); }
}
// When a booked meeting ends, post brief AI meeting-notes to the floor (only if a key is set + there was chat).
async function postMeetingNotes(f, r, b) {
  if (!aiConfigured()) return;
  const recent = recentByFloor.get(f.slug) || []; if (recent.length < 3) return;
  try {
    const sys = "You are NexSpace's assistant. Write 2-4 short bullet meeting notes from the room chat. Be concise; if nothing substantive was discussed, just say the meeting wrapped up.";
    const text = await callLLM(sys, "The meeting \"" + b.title + "\" in " + r.name + " just ended.\nRecent room chat:\n" + recent.slice(-25).map((c) => c.name + ": " + c.body).join("\n"));
    postAssistant("📝 Notes — " + b.title + " (" + r.name + "):\n" + text, { scope: "floor", channel: null, to: null, floor: f.slug, x: 0, y: 0, roomId: null });
  } catch (_) {}
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
  return { slug, name: w.name || slug, w: w.w, h: w.h, walls: (w.obstacles || []).slice(), furniture: (w.furniture || []).map((o) => ({ ...o })), rooms, mediaWall, portals, widgets,
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
// ---------- Persist owner edits (§6.10) — survive restarts without the API. Saves the editable parts of each
// floor to Redis (if PERSIST_REDIS_URL/REDIS_URL) else a JSON file; loads them on boot over the built-in floors. Off when WORLD_API is set. ----------
const PERSIST_FILE = path.join(process.env.DATA_DIR || __dirname, "floors-data.json");
let persistTimer = null;
function snapshotFloors() {
  const out = {};
  for (const [slug, f] of floors) out[slug] = { furniture: f.furniture, widgets: f.widgets, portals: f.portals, mediaWall: f.mediaWall ? { x: f.mediaWall.x, y: f.mediaWall.y } : null };
  return out;
}
function persistFloors() {
  if (process.env.WORLD_API || process.env.NO_PERSIST) return; // API/DB is the source of truth when configured
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const data = JSON.stringify(snapshotFloors()), rc = persistClient();
    if (rc) { try { rc.set("nexspace:floors", data); } catch {} }
    else fs.writeFile(PERSIST_FILE, data, () => {});
  }, 800);
}
async function loadPersisted() {
  if (process.env.WORLD_API || process.env.NO_PERSIST) return;
  let data = null; const rc = persistClient();
  try { if (rc) data = await rc.get("nexspace:floors"); else if (fs.existsSync(PERSIST_FILE)) data = fs.readFileSync(PERSIST_FILE, "utf8"); } catch {}
  let saved; try { saved = data ? JSON.parse(data) : null; } catch { saved = null; }
  if (!saved) return;
  for (const slug in saved) {
    const f = floors.get(slug); if (!f) continue; const s = saved[slug];
    if (Array.isArray(s.furniture)) f.furniture = s.furniture;
    if (Array.isArray(s.widgets)) f.widgets = s.widgets;
    if (Array.isArray(s.portals)) f.portals = s.portals;
    if (s.mediaWall && f.mediaWall) { f.mediaWall.x = s.mediaWall.x; f.mediaWall.y = s.mediaWall.y; }
  }
  console.log("Restored persisted floor edits (" + Object.keys(saved).length + " floor[s])");
}
loadWorld().then(loadPersisted).finally(() => {
  server.listen(PORT, () => console.log(`NexSpace realtime + web: http://localhost:${PORT}  (open two tabs)`));
});

// graceful shutdown (§8)
function shutdown() { clearInterval(heartbeat); try { wss.close(); } catch {} try { server.close(); } catch {} console.log("NexSpace realtime shutting down…"); process.exit(0); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
