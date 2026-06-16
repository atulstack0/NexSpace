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

const PORT = process.env.PORT || 8787;
const TICK_HZ = 15;
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

// ---------- Authoritative world (hardcoded here; loaded from DB in apps/api) ----------
const WORLD = { w: 2200, h: 1500 };
let obstacles = [
  { x: 0, y: 0, w: WORLD.w, h: 16 }, { x: 0, y: WORLD.h - 16, w: WORLD.w, h: 16 },
  { x: 0, y: 0, w: 16, h: WORLD.h }, { x: WORLD.w - 16, y: 0, w: 16, h: WORLD.h },
  { x: 520, y: 120, w: 16, h: 300 }, { x: 520, y: 520, w: 16, h: 240 }, { x: 120, y: 760, w: 430, h: 16 },
  { x: 1500, y: 120, w: 16, h: 560 }, { x: 1516, y: 120, w: 300, h: 16 }, { x: 1516, y: 666, w: 300, h: 16 },
  { x: 1800, y: 120, w: 16, h: 236 }, { x: 1800, y: 452, w: 16, h: 230 },
  { x: 980, y: 560, w: 240, h: 120, r: 14 }, { x: 300, y: 300, w: 150, h: 80, r: 12 },
  { x: 1600, y: 330, w: 170, h: 90, r: 12 }, { x: 900, y: 1150, w: 120, h: 120, r: 60 },
  { x: 1750, y: 1150, w: 150, h: 80, r: 12 }, { x: 250, y: 1150, w: 90, h: 90, r: 10 },
];
let rooms = [
  { id: "focus", name: "Focus Room", color: "#7c6bff",
    bounds: { x: 140, y: 130, w: 380, h: 630 }, door: { x: 512, y: 418, w: 18, h: 104, state: "closed", knocking: false } },
  { id: "board", name: "Boardroom", color: "#39d3a6",
    bounds: { x: 1516, y: 136, w: 300, h: 546 }, door: { x: 1796, y: 356, w: 18, h: 96, state: "locked", knocking: false } },
];
let mediaWall = { x: 1180, y: 980, w: 300, base: 16, screenH: 150,
  title: "Lo-fi Beats — Focus Radio", playing: true, pos: 74, dur: 213 };
obstacles.push({ x: mediaWall.x, y: mediaWall.y, w: mediaWall.w, h: mediaWall.base });

function inRoom(p, room) {
  const b = room.bounds;
  return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
}
function worldForClient() {
  return {
    w: WORLD.w, h: WORLD.h, obstacles,
    rooms: rooms.map(r => ({ id: r.id, name: r.name, color: r.color, bounds: r.bounds, door: { x: r.door.x, y: r.door.y, w: r.door.w, h: r.door.h, state: r.door.state } })),
    mediaWall: { x: mediaWall.x, y: mediaWall.y, w: mediaWall.w, base: mediaWall.base, screenH: mediaWall.screenH, title: mediaWall.title, dur: mediaWall.dur },
  };
}

// ---------- Clients ----------
const clients = new Map(); // ws -> player
let nextId = 1;
let recording = { on: false, by: null, egressId: null }; // shared recording indicator (spec 6.17)

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".ico": "image/x-icon" };
const server = http.createServer((req, res) => {
  const urlPath = (req.url === "/" || !req.url) ? "/index.html" : req.url.split("?")[0];
  const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
  const file = path.join(WEB_DIR, safe);
  if (!file.startsWith(WEB_DIR)) { res.writeHead(403); res.end("Forbidden"); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "text/plain" });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    const p = clients.get(ws);

    if (m.t === "join") {
      const id = "u" + (nextId++);
      const claims = verifyJWT(m.token);
      const role = claims?.role || "guest";
      const name = claims?.name || String(m.name || "Guest").slice(0, 16) || "Guest";
      const player = { id, name, role,
        x: 820 + Math.random() * 140, y: 860 + Math.random() * 120, facing: 0,
        status: "available", talking: m.talking !== false, bcast: false };
      clients.set(ws, player);
      send(ws, { t: "welcome", id, world: worldForClient(), you: { ...player } });
      console.log(`+ ${player.name} (${id}) [${role}] — ${clients.size} online`);
      return;
    }
    if (!p) return;

    if (m.t === "move") {
      if (Number.isFinite(m.x)) p.x = clamp(m.x, 16, WORLD.w - 16);
      if (Number.isFinite(m.y)) p.y = clamp(m.y, 16, WORLD.h - 16);
      if (Number.isFinite(m.facing)) p.facing = m.facing;
    } else if (m.t === "state") {
      if (m.status) p.status = m.status;
      if ("talking" in m) p.talking = !!m.talking;
    } else if (m.t === "broadcast") {
      if (m.on && rank(p.role) < RANK.member) return deny(ws, "broadcast", "member");
      p.bcast = !!m.on;
    } else if (m.t === "media") {
      mediaWall.playing = !!m.playing;
    } else if (m.t === "door") {
      if (rank(p.role) < RANK.member) return deny(ws, "change doors", "member");
      if (m.state === "locked" && rank(p.role) < RANK.admin) return deny(ws, "lock doors", "admin");
      const room = rooms.find(r => r.id === m.roomId);
      if (room && ["open", "closed", "locked"].includes(m.state)) room.door.state = m.state;
    } else if (m.t === "knock") {
      const room = rooms.find(r => r.id === m.roomId);
      if (!room) return;
      const d = room.door;
      if (d.state === "open" || d.knocking) return;
      if (d.state === "locked" && rank(p.role) < RANK.member) return deny(ws, "enter the locked room", "member");
      d.knocking = true;
      const occupied = [...clients.values()].some(q => inRoom(q, room));
      setTimeout(() => { d.knocking = false; if (occupied) d.state = "open"; }, 1300);
    } else if (m.t === "recording") {
      if (rank(p.role) < RANK.admin) return deny(ws, "record", "admin");
      recording = m.on ? { on: true, by: p.name, egressId: m.egressId || null } : { on: false, by: null, egressId: null };
    }
  });

  ws.on("close", () => {
    const p = clients.get(ws);
    clients.delete(ws);
    if (p) console.log(`- ${p.name} (${p.id}) — ${clients.size} online`);
  });
});

// Authoritative tick: advance media clock + broadcast snapshot of all dynamic state.
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now(), dt = (now - lastTick) / 1000; lastTick = now;
  if (mediaWall.playing) { mediaWall.pos += dt; if (mediaWall.pos > mediaWall.dur) mediaWall.pos = 0; }
  if (clients.size === 0) return;
  const players = [...clients.values()].map(p => ({ id: p.id, name: p.name, x: p.x, y: p.y, facing: p.facing, status: p.status, talking: p.talking, bcast: p.bcast, role: p.role }));
  const doors = {}; for (const r of rooms) doors[r.id] = r.door.state;
  const snap = JSON.stringify({ t: "snapshot", players, doors, media: { playing: mediaWall.playing, pos: Math.round(mediaWall.pos) }, recording });
  for (const ws of clients.keys()) if (ws.readyState === 1) ws.send(snap);
}, 1000 / TICK_HZ);

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function deny(ws, action, need) { send(ws, { t: "denied", action, need }); } // RBAC refusal feedback
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Optionally load the authoritative world from the API (apps/api). Falls back
// to the built-in geometry above if WORLD_API is unset or unreachable.
function applyWorld(w) {
  WORLD.w = w.w; WORLD.h = w.h;
  obstacles = w.obstacles.slice();
  rooms = w.rooms.map((r) => ({ id: r.id, name: r.name, color: r.color, bounds: r.bounds,
    door: { x: r.door.x, y: r.door.y, w: r.door.w, h: r.door.h, state: r.door.state || "closed", knocking: false } }));
  mediaWall = { x: w.mediaWall.x, y: w.mediaWall.y, w: w.mediaWall.w, base: w.mediaWall.base,
    screenH: w.mediaWall.screenH, title: w.mediaWall.title, playing: true, pos: 0, dur: w.mediaWall.dur };
}
async function loadWorld() {
  if (!process.env.WORLD_API) return;
  const url = process.env.WORLD_API.replace(/\/$/, "") + "/floors/default/world";
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    applyWorld(await res.json());
    console.log("Loaded world from API:", url);
  } catch (e) {
    console.warn(`WORLD_API unavailable (${e.message}) — using built-in geometry`);
  }
}
loadWorld().finally(() => {
  server.listen(PORT, () => console.log(`NexSpace realtime + web: http://localhost:${PORT}  (open two tabs)`));
});
