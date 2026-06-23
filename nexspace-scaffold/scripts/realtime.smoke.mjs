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
  env: { ...process.env, WORLD_API: "", REDIS_URL: "", NO_PERSIST: "1", JWT_SECRET: SECRET, PORT: String(PORT), WEBHOOK_URL: `http://localhost:${WHPORT}/hook`, SLACK_WEBHOOK_URL: `http://localhost:${WHPORT}/slack`, PUBLIC_API_KEY: API_KEY, MAX_CLIENTS: "2" },
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
    const st = { ws, name, id: null, role: null, world: null, floorMsg: null, tv: null, last: null, denied: [], rateLimited: false, chats: [], draws: [], cleared: false, reacts: [], nudged: false, kicked: false, bookings: {}, sched: {}, activity: [] };
    ws.on("open", () => ws.send(JSON.stringify({ t: "join", name, token })));
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.t === "welcome") { st.id = m.id; st.role = m.you.role; st.world = m.world; st.tv = m.tv; resolve(st); }
      if (m.t === "floor") { st.floorMsg = m; st.world = m.world; } // arrived on a new floor via portal
      if (m.t === "world") st.world = m.world; // live layout reload / owner edit
      if (m.t === "tv") st.tv = m;
      if (m.t === "snapshot") st.last = m;
      if (m.t === "booking") { st.bookings[m.roomId] = m.booking; if (m.bookings) st.sched[m.roomId] = m.bookings; }
      if (m.t === "present") st.presentation = m.presentation;
      if (m.t === "activity") st.activity.push(m);
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
  (admin.world?.widgets?.some((wd) => wd.type === "note") && admin.world?.widgets?.some((wd) => wd.type === "timer")) ? ok("welcome carries interactive widgets (note+timer)") : bad("interactive widgets missing from world");
  (admin.world?.furniture?.length > 0 && admin.world?.furniture[0].id && admin.world?.furniture.every((o) => o.kind)) ? ok("welcome carries editable furniture (with ids + kinds)") : bad("furniture missing from world or lacks kinds");
  (admin.tv && typeof admin.tv.videoId === "string" && admin.tv.videoId) ? ok("welcome carries shared TV state") : bad("TV state missing from welcome");
  (admin.activity.some((a) => a.kind === "join" && a.name === guest.name)) ? ok("a peer joining is announced as an activity event") : bad("join activity not broadcast");

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

  // a guest CAN open a closed (unlocked) door and enter an empty room
  guest.ws.send(JSON.stringify({ t: "door", roomId: "focus", state: "open" }));
  await wait(350);
  (guest.last?.doors?.focus === "open") ? ok("guest can open a closed (unlocked) door → enter empty room") : bad("guest could NOT open a closed door");

  // RBAC — guest cannot unlock the locked Boardroom door
  guest.ws.send(JSON.stringify({ t: "door", roomId: "board", state: "open" }));
  await wait(350);
  (guest.last?.doors?.board === "locked" && guest.denied.includes("unlock the door")) ? ok("guest denied unlocking the locked door") : bad("guest unlock was NOT blocked");

  // RBAC — admin can open (unlock) it
  admin.ws.send(JSON.stringify({ t: "door", roomId: "board", state: "open" }));
  await wait(350);
  (guest.last?.doors?.board === "open") ? ok("admin opened the locked Boardroom door") : bad("admin could not open door");

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

  // email+password login (single-service, no DB) — valid owner creds mint an owner JWT; bad creds 401
  const lRes = await fetch(`http://localhost:${PORT}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "owner@nexspace.dev", password: "owner1234" }) });
  const lJson = lRes.ok ? await lRes.json() : {};
  (lRes.status === 200 && lJson.user?.role === "owner" && typeof lJson.token === "string") ? ok("/auth/login returns owner token for valid creds") : bad("/auth/login owner login failed");
  // the minted token must be a valid HS256 JWT (same secret the join handler verifies) carrying role=owner
  if (lJson.token) {
    const [h, p, sig] = lJson.token.split(".");
    const expSig = crypto.createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url");
    let payload = {}; try { payload = JSON.parse(Buffer.from(p, "base64url").toString()); } catch {}
    (sig === expSig && payload.role === "owner") ? ok("login token is a valid owner JWT (signature + role)") : bad("login token invalid or not owner");
  }
  const lBad = await fetch(`http://localhost:${PORT}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "owner@nexspace.dev", password: "wrong" }) });
  (lBad.status === 401) ? ok("/auth/login rejects wrong password (401)") : bad("/auth/login accepted wrong password");

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

  // shared TV (§6.22) — tvPlay broadcasts the new video to everyone, tvQueue appends
  admin.ws.send(JSON.stringify({ t: "tvPlay", videoId: "dQw4w9WgXcQ", title: "Test Video" }));
  await wait(250);
  (guest.tv?.videoId === "dQw4w9WgXcQ") ? ok("tvPlay broadcasts the new video to everyone") : bad("tvPlay did not broadcast");
  admin.ws.send(JSON.stringify({ t: "tvQueue", videoId: "abc123XYZ_-", title: "Queued" }));
  await wait(200);
  (guest.tv?.queue?.some((q) => q.videoId === "abc123XYZ_-")) ? ok("tvQueue appends to the shared queue") : bad("tvQueue did not propagate");
  admin.ws.send(JSON.stringify({ t: "tvCtrl", playing: false, position: 42 }));
  await wait(200);
  (guest.tv?.playing === false && Math.abs((guest.tv?.position || 0) - 42) < 2) ? ok("tvCtrl syncs pause + position to everyone (watch-party)") : bad("tvCtrl did not sync playback");

  // owner/admin floor editor (live add / move / remove, broadcast to everyone)
  const wBefore = guest.world?.widgets?.length || 0;
  admin.ws.send(JSON.stringify({ t: "editFloor", op: "add", wtype: "note", x: 640, y: 640 }));
  await wait(250);
  ((guest.world?.widgets?.length || 0) === wBefore + 1) ? ok("owner editFloor add broadcasts a new element") : bad("editFloor add did not broadcast");
  const fBefore = guest.world?.furniture?.length || 0;
  admin.ws.send(JSON.stringify({ t: "editFloor", op: "add", kind: "furniture", furnitureKind: "plant", x: 700, y: 700 }));
  await wait(220);
  ((guest.world?.furniture?.length || 0) === fBefore + 1) ? ok("owner editFloor add furniture broadcasts") : bad("furniture add did not broadcast");
  (guest.world?.furniture?.some((o) => o.kind === "plant")) ? ok("furniture carries its kind (plant) through the world state") : bad("furniture kind not round-tripped");
  guest.ws.send(JSON.stringify({ t: "editFloor", op: "add", wtype: "note", x: 100, y: 100 }));
  await wait(200);
  (guest.denied.includes("edit the floor")) ? ok("guest denied floor editing (RBAC)") : bad("guest floor edit was NOT blocked");

  // meeting rooms (scheduled) — book now (active + presence flip), schedule a future slot, reject overlap, guest denied, cancel by id
  admin.ws.send(JSON.stringify({ t: "bookRoom", roomId: "focus", title: "Standup", minutes: 30 }));
  await wait(320);
  (guest.bookings.focus && guest.bookings.focus.title === "Standup") ? ok("booking that starts now broadcasts + is active") : bad("now-booking not broadcast/active");
  (admin.last?.players?.find((p) => p.id === admin.id)?.status === "inMeeting") ? ok("booker presence auto-flips to inMeeting") : bad("booker status did not flip");
  admin.ws.send(JSON.stringify({ t: "bookRoom", roomId: "focus", title: "Later", startsAt: Date.now() + 3600000, minutes: 15 }));
  await wait(250);
  ((guest.sched.focus || []).some((b) => b.title === "Later") && guest.bookings.focus?.title === "Standup") ? ok("future booking is scheduled but not yet active") : bad("future booking activated early or missing");
  admin.ws.send(JSON.stringify({ t: "bookRoom", roomId: "focus", title: "Clash", minutes: 30 }));   // overlaps the active now-slot
  await wait(220);
  (!(guest.sched.focus || []).some((b) => b.title === "Clash")) ? ok("overlapping booking is rejected") : bad("overlap was not rejected");
  guest.ws.send(JSON.stringify({ t: "bookRoom", roomId: "board", title: "x", minutes: 15 }));
  await wait(200);
  (guest.denied.includes("book a room")) ? ok("guest denied booking a room (RBAC member+)") : bad("guest booking was NOT blocked");
  const activeId = guest.bookings.focus?.id;
  admin.ws.send(JSON.stringify({ t: "cancelBooking", roomId: "focus", bookingId: activeId }));
  await wait(220);
  (guest.bookings.focus === null) ? ok("cancelling the active booking by id clears it for everyone") : bad("cancel did not clear the active booking");

  // avatar customization — appearance (colours + name) syncs to others via presence; invalid colours sanitized
  admin.ws.send(JSON.stringify({ t: "appearance", name: "Ada A", appear: { suit: "#112233", tie: "#aabbcc", skin: "#ddccbb" } }));
  await wait(320);
  const ap = guest.last?.players?.find((p) => p.id === admin.id);
  (ap && ap.appear && ap.appear.suit === "#112233" && ap.name === "Ada A") ? ok("avatar appearance + display name sync to others") : bad("appearance did not sync");
  admin.ws.send(JSON.stringify({ t: "appearance", appear: { suit: "not-a-color", tie: "#00ff00", skin: "x" } }));
  await wait(300);
  const ap2 = guest.last?.players?.find((p) => p.id === admin.id);
  (ap2 && ap2.appear && ap2.appear.suit === "#24272f" && ap2.appear.tie === "#00ff00") ? ok("invalid appearance colours are sanitized to defaults") : bad("appearance not sanitized");

  // AI assistant — @ai triggers an assistant reply (graceful "not enabled" when no API key is set, as in this test env)
  admin.ws.send(JSON.stringify({ t: "chat", scope: "floor", body: "@ai hello" }));
  await wait(350);
  (admin.chats.some((c) => c.from === "assistant" && c.ai)) ? ok("@ai triggers an assistant reply") : bad("assistant did not reply to @ai");
  const aiBefore = admin.chats.filter((c) => c.from === "assistant").length;
  admin.ws.send(JSON.stringify({ t: "chat", scope: "floor", body: "just a normal message" }));
  await wait(250);
  (admin.chats.filter((c) => c.from === "assistant").length === aiBefore) ? ok("a normal chat does not trigger the assistant") : bad("assistant triggered on a non-@ai chat");

  // present-to-room — present broadcasts the presenter; guest can't present; unpresent clears it
  admin.ws.send(JSON.stringify({ t: "present" }));
  await wait(250);
  (guest.presentation && guest.presentation.byId === admin.id) ? ok("present broadcasts the presenter to the floor") : bad("present did not broadcast");
  guest.ws.send(JSON.stringify({ t: "present" }));
  await wait(200);
  (guest.denied.includes("present")) ? ok("guest denied presenting (RBAC member+)") : bad("guest present was NOT blocked");
  admin.ws.send(JSON.stringify({ t: "unpresent" }));
  await wait(220);
  (guest.presentation === null) ? ok("unpresent clears the presentation for everyone") : bad("unpresent did not clear");

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
