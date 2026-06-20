// NexSpace realtime smoke test — run from the scaffold root:  npm test
// Spawns the realtime server and connects two WebSocket clients (an admin with a
// signed token, and a guest) to verify the core contract AND server-side RBAC:
// join/welcome, role assignment, position sync, recording sync, and door rules.
// No browser/DB needed. Exits non-zero on failure.
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import crypto from "node:crypto";
import http from "node:http";

const PORT = 8799;
const SECRET = "nexspace-dev-secret-change-me"; // matches the realtime server's dev default
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (m) => console.log("  ✓ " + m);
const bad = (m) => { fails++; console.log("  ✗ " + m); };

// mint a JWT the same dependency-free way the API does
function sign(payload) {
  const b = (s) => Buffer.from(s).toString("base64url");
  const h = b(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const p = b(JSON.stringify({ ...payload, iat: now, exp: now + 7200 }));
  const data = `${h}.${p}`;
  return `${data}.${crypto.createHmac("sha256", SECRET).update(data).digest("base64url")}`;
}
const adminToken = sign({ sub: "u-admin", name: "Admin Ada", role: "admin" });

// webhook receiver — captures outbound events from the realtime server
const WHPORT = 8798;
const API_KEY = "nexspace-demo-key";
const hooks = [];
const hookServer = http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => (b += d));
  req.on("end", () => { hooks.push({ url: req.url, event: req.headers["x-nexspace-event"], sig: req.headers["x-nexspace-signature"], body: b }); res.writeHead(200); res.end("ok"); });
});
await new Promise((r) => hookServer.listen(WHPORT, r));

const server = spawn(process.execPath, ["apps/realtime/server.js"], {
  // WORLD_API/REDIS_URL cleared so the test is hermetic — it always exercises the built-in floors,
  // never a stray API/Redis from the shell env (e.g. $env:WORLD_API left set in the same terminal).
  env: { ...process.env, WORLD_API: "", REDIS_URL: "", JWT_SECRET: SECRET, PORT: String(PORT), WEBHOOK_URL: `http://localhost:${WHPORT}/hook`, SLACK_WEBHOOK_URL: `http://localhost:${WHPORT}/slack`, PUBLIC_API_KEY: API_KEY, MAX_CLIENTS: "2" },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stderr.on("data", (d) => process.stderr.write(d));
await new Promise((res, rej) => {
  let buf = ""; const to = setTimeout(() => rej(new Error("server did not start in time")), 8000);
  server.stdout.on("data", (d) => { buf += d.toString(); if (buf.includes("realtime")) { clearTimeout(to); res(); } });
}).catch((e) => { console.error(e.message); server.kill(); process.exit(1); });

function join(name, token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const st = { ws, name, id: null, role: null, world: null, floorMsg: null, last: null, denied: [], rateLimited: false, chats: [], draws: [], cleared: false, reacts: [], nudged: false, kicked: false };
    ws.on("open", () => ws.send(JSON.stringify({ t: "join", name, token })));
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.t === "welcome") { st.id = m.id; st.role = m.you.role; st.world = m.world; resolve(st); }
      if (m.t === "floor") { st.floorMsg = m; st.world = m.world; } // arrived on a new floor via portal
      if (m.t === "snapshot") st.last = m;
      if (m.t === "denied") st.denied.push(m.action);
      if (m.t === "rateLimited") st.rateLimited = true;
      if (m.t === "chat") st.chats.push(m);
      if (m.t === "draw") st.draws.push(m.stroke);
      if (m.t === "wbclear") st.cleared = true;
      if (m.t === "react") st.reacts.push(m);
      if (m.t === "nudge") st.nudged = true;
      if (m.t === "kicked") st.kicked = true;
    });
    ws.on("error", (e) => bad("ws error: " + e.message));
  });
}

try {
  const admin = await join("Admin Ada", adminToken);
  const guest = await join("Bob", undefined);
  (admin.id && guest.id) ? ok("two clients joined (welcome+id)") : bad("welcome/id missing");
  (admin.role === "admin") ? ok("admin token → admin role") : bad("admin role not applied (got " + admin.role + ")");
  (guest.role === "guest") ? ok("no token → guest role") : bad("guest role not applied");
  (admin.world?.branding && typeof admin.world.branding.name === "string" && typeof admin.world.branding.color === "string") ? ok("welcome carries branding (name+color)") : bad("welcome world.branding missing/malformed");
  (admin.world?.floors?.length >= 2 && admin.world?.portals?.some((p) => p.to === "rooftop")) ? ok("welcome lists floors + portals (multi-floor)") : bad("multi-floor world blob missing floors/portals");
  (admin.world?.widgets?.some((wd) => wd.type === "embed") && admin.world?.widgets?.some((wd) => wd.type === "note") && admin.world?.widgets?.some((wd) => wd.type === "timer")) ? ok("welcome carries interactive widgets (embed+note+timer)") : bad("interactive widgets missing from world");

  // walk into the Focus Room at (500,500). The server-authoritative speed cap (MAX_SPEED) only
  // allows ~one step of travel per update since this client's last move, and spawn is ~570-665px
  // away — so prime the first step with a wait (dt≈1) and take three steps to converge exactly.
  // (A single jump from spawn would, correctly, be clamped — see the anti-teleport assertion below.)
  await wait(1100);
  admin.ws.send(JSON.stringify({ t: "move", x: 500, y: 500, facing: 0 }));
  await wait(1100);
  admin.ws.send(JSON.stringify({ t: "move", x: 500, y: 500, facing: 0 }));
  await wait(1100);
  admin.ws.send(JSON.stringify({ t: "move", x: 500, y: 500, facing: 0 }));
  await wait(450);
  (guest.last?.players?.some((p) => p.id === admin.id && Math.abs(p.x - 500) < 5)) ? ok("position syncs between clients") : bad("position not synced");

  // chat (6.9) — admin is now inside the Focus Room at 500,500; guest is far at spawn
  admin.ws.send(JSON.stringify({ t: "chat", scope: "floor", body: "hello-floor" }));
  await wait(300);
  (guest.chats.some((c) => c.body === "hello-floor")) ? ok("floor chat reaches other clients") : bad("floor chat not delivered");
  admin.ws.send(JSON.stringify({ t: "chat", scope: "nearby", body: "hello-near" }));
  await wait(300);
  (admin.chats.some((c) => c.body === "hello-near") && !guest.chats.some((c) => c.body === "hello-near")) ? ok("nearby chat delivered in-range only") : bad("nearby chat routing wrong");
  // channel chat reaches everyone (open channels)
  admin.ws.send(JSON.stringify({ t: "chat", scope: "channel", channel: "general", body: "chan-hi" }));
  await wait(300);
  (guest.chats.some((c) => c.body === "chan-hi" && c.channel === "general")) ? ok("channel chat reaches all clients") : bad("channel chat not delivered");
  // DM reaches the recipient, and excludes non-recipients
  admin.ws.send(JSON.stringify({ t: "chat", scope: "dm", to: guest.id, body: "dm-hi" }));
  await wait(300);
  (guest.chats.some((c) => c.body === "dm-hi")) ? ok("DM reaches the recipient") : bad("DM not delivered to recipient");
  admin.ws.send(JSON.stringify({ t: "chat", scope: "dm", to: "nobody", body: "dm-secret" }));
  await wait(300);
  (!guest.chats.some((c) => c.body === "dm-secret")) ? ok("DM excludes non-recipients") : bad("DM leaked to a non-recipient");

  // whiteboard (6.8) — strokes broadcast to peers; clear propagates
  admin.ws.send(JSON.stringify({ t: "draw", stroke: { color: "#fff", width: 3, pts: [[10, 10], [20, 20]] } }));
  await wait(300);
  (guest.draws.some((s) => s.pts && s.pts.length === 2)) ? ok("whiteboard stroke broadcasts to peers") : bad("whiteboard draw not synced");
  admin.ws.send(JSON.stringify({ t: "wbclear" }));
  await wait(300);
  (guest.cleared === true) ? ok("whiteboard clear propagates") : bad("whiteboard clear not synced");

  // presence/status sync (6.19) — valid status applies, invalid is ignored
  admin.ws.send(JSON.stringify({ t: "state", status: "busy" }));
  await wait(300);
  (guest.last?.players?.find((p) => p.id === admin.id)?.status === "busy") ? ok("status (busy) syncs to other clients") : bad("status not synced");
  admin.ws.send(JSON.stringify({ t: "state", status: "bogus" }));
  await wait(300);
  (guest.last?.players?.find((p) => p.id === admin.id)?.status === "busy") ? ok("invalid status is rejected (stays busy)") : bad("invalid status was accepted");

  // RBAC — guest cannot record
  guest.ws.send(JSON.stringify({ t: "recording", on: true }));
  await wait(350);
  (guest.last?.recording?.on === false && guest.denied.includes("record")) ? ok("guest denied recording (server-enforced)") : bad("guest recording was NOT blocked");

  // RBAC — admin can record
  admin.ws.send(JSON.stringify({ t: "recording", on: true }));
  await wait(350);
  (guest.last?.recording?.on === true) ? ok("admin recording starts → indicator syncs to guest") : bad("admin recording did not start");
  admin.ws.send(JSON.stringify({ t: "recording", on: false }));

  // RBAC — guest cannot open the locked Boardroom door
  guest.ws.send(JSON.stringify({ t: "door", roomId: "board", state: "open" }));
  await wait(350);
  (guest.last?.doors?.board === "locked" && guest.denied.includes("change doors")) ? ok("guest denied changing the locked door") : bad("guest door change was NOT blocked");

  // RBAC — admin can open it
  admin.ws.send(JSON.stringify({ t: "door", roomId: "board", state: "open" }));
  await wait(350);
  (guest.last?.doors?.board === "open") ? ok("admin opened the Boardroom door") : bad("admin could not open door");

  // Live reload — admin push broadcasts a {world} to everyone; a guest cannot trigger it
  let worldMsgs = 0;
  guest.ws.on("message", (d) => { if (JSON.parse(d.toString()).t === "world") worldMsgs++; });
  admin.ws.send(JSON.stringify({ t: "adminReload", token: adminToken }));
  await wait(450);
  (worldMsgs > 0) ? ok("admin reload broadcasts {world} to everyone") : bad("world not broadcast on admin reload");
  const before = worldMsgs;
  guest.ws.send(JSON.stringify({ t: "adminReload" }));
  await wait(450);
  (worldMsgs === before && guest.denied.includes("reload the world")) ? ok("guest denied world reload") : bad("guest reload was NOT blocked");

  // analytics (6.20) — admin gets metrics, guest is denied
  const aRes = await fetch(`http://localhost:${PORT}/analytics?token=${adminToken}`);
  const aJson = aRes.ok ? await aRes.json() : {};
  (aRes.status === 200 && aJson.sessionsTotal >= 2 && aJson.peakConcurrency >= 2) ? ok("admin /analytics returns metrics") : bad("admin /analytics failed");
  const gRes = await fetch(`http://localhost:${PORT}/analytics`);
  (gRes.status === 403) ? ok("guest /analytics denied (403)") : bad("guest /analytics not denied");

  // public API (6.18) — key required
  const pRes = await fetch(`http://localhost:${PORT}/api/v1/presence`, { headers: { "x-api-key": API_KEY } });
  const pJson = pRes.ok ? await pRes.json() : {};
  (pRes.status === 200 && Array.isArray(pJson.users) && pJson.online >= 1) ? ok("public API /presence returns users (with key)") : bad("public API /presence failed");
  const nRes = await fetch(`http://localhost:${PORT}/api/v1/presence`);
  (nRes.status === 401) ? ok("public API rejects missing X-API-Key (401)") : bad("public API not gated");

  // webhooks (6.18) — user.joined fired with a valid HMAC signature
  const joined = hooks.find((h) => h.event === "user.joined");
  if (joined) {
    const expected = crypto.createHmac("sha256", API_KEY).update(joined.body).digest("hex");
    (joined.sig === expected) ? ok("webhook user.joined fired with valid HMAC signature") : bad("webhook signature mismatch");
  } else bad("no user.joined webhook received");

  // Slack notification (6.18) — Slack-formatted {text} posted on join
  const slack = hooks.find((h) => h.url && h.url.includes("/slack"));
  let slackOk = false;
  if (slack) { try { const j = JSON.parse(slack.body); slackOk = typeof j.text === "string" && /entered the office/.test(j.text); } catch {} }
  slackOk ? ok("Slack notification posted on join") : bad("Slack notification missing/wrong format");

  // server-authoritative movement (§8) — an instant teleport is clamped to max speed
  admin.ws.send(JSON.stringify({ t: "move", x: 600, y: 600 }));
  admin.ws.send(JSON.stringify({ t: "move", x: 2000, y: 1400 })); // immediate → dt≈0 → clamped
  await wait(300);
  const ax = guest.last?.players?.find((p) => p.id === admin.id)?.x ?? 0;
  (ax < 900) ? ok("server clamps teleport (anti-cheat), x=" + Math.round(ax)) : bad("teleport NOT clamped (x=" + Math.round(ax) + ")");

  // rate limiting (§8) — a burst triggers a rateLimited notice
  for (let i = 0; i < 200; i++) guest.ws.send(JSON.stringify({ t: "state", status: "available" }));
  await wait(400);
  (guest.rateLimited === true) ? ok("message flood is rate-limited") : bad("rate limit not enforced");

  // connection cap (§8) — a 3rd client is rejected when MAX_CLIENTS=2
  const third = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`); const r = { full: false, welcomed: false };
    ws.on("open", () => ws.send(JSON.stringify({ t: "join", name: "Carol" })));
    ws.on("message", (d) => { const m = JSON.parse(d.toString()); if (m.t === "full") r.full = true; if (m.t === "welcome") r.welcomed = true; });
    ws.on("close", () => resolve(r));
    setTimeout(() => { try { ws.close(); } catch {} resolve(r); }, 900);
  });
  (third.full && !third.welcomed) ? ok("connection cap rejects 3rd client (MAX_CLIENTS=2)") : bad("connection cap not enforced");

  // multi-floor + portals (§6) — admin travels to the rooftop; guest stays on the ground floor
  admin.ws.send(JSON.stringify({ t: "portal", to: "rooftop" }));
  await wait(300);
  (admin.floorMsg?.world?.slug === "rooftop" && admin.floorMsg?.you?.floor === "rooftop") ? ok("portal moves player to the rooftop floor") : bad("portal did not switch floors");
  (guest.last?.floor === "default" && !guest.last?.players?.some((p) => p.id === admin.id)) ? ok("snapshots are floor-scoped (rooftop traveler hidden from ground)") : bad("snapshot leaked a player across floors");
  // floor chat must not cross floors
  admin.ws.send(JSON.stringify({ t: "chat", scope: "floor", body: "rooftop-only" }));
  await wait(300);
  (!guest.chats.some((c) => c.body === "rooftop-only")) ? ok("floor chat does not cross floors") : bad("floor chat leaked across floors");
  // travel back — the ground floor sees the admin again
  admin.ws.send(JSON.stringify({ t: "portal", to: "default" }));
  await wait(300);
  (admin.floorMsg?.world?.slug === "default" && guest.last?.players?.some((p) => p.id === admin.id)) ? ok("portal back to ground floor re-syncs presence") : bad("return portal did not re-sync");

  // reactions (6.6)
  admin.ws.send(JSON.stringify({ t: "react", emoji: "🎉" }));
  await wait(300);
  (guest.reacts.some((r) => r.emoji === "🎉" && r.from === admin.id)) ? ok("reaction broadcasts to peers") : bad("reaction not broadcast");
  // nudge (6.9)
  admin.ws.send(JSON.stringify({ t: "nudge", to: guest.id }));
  await wait(300);
  (guest.nudged === true) ? ok("nudge reaches the target") : bad("nudge not delivered");
  // moderation (6.16) — mute blocks the muted user's chat
  admin.ws.send(JSON.stringify({ t: "moderate", action: "mute", target: guest.id }));
  await wait(200);
  guest.ws.send(JSON.stringify({ t: "chat", scope: "floor", body: "after-mute" }));
  await wait(300);
  (!admin.chats.some((c) => c.body === "after-mute")) ? ok("muted user's chat is blocked") : bad("mute not enforced");
  // moderation (6.16) — kick removes the user
  admin.ws.send(JSON.stringify({ t: "moderate", action: "kick", target: guest.id }));
  await wait(300);
  (guest.kicked === true) ? ok("admin kick removes the user") : bad("kick not delivered");

  admin.ws.close(); guest.ws.close(); await wait(250);
} catch (e) {
  bad("exception: " + e.message);
} finally {
  server.kill(); hookServer.close();
}

console.log("\n" + (fails ? `SMOKE FAILED — ${fails} assertion(s)` : "SMOKE PASSED ✓"));
process.exit(fails ? 1 : 0);
