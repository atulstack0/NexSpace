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
  req.on("end", () => { hooks.push({ event: req.headers["x-nexspace-event"], sig: req.headers["x-nexspace-signature"], body: b }); res.writeHead(200); res.end("ok"); });
});
await new Promise((r) => hookServer.listen(WHPORT, r));

const server = spawn(process.execPath, ["apps/realtime/server.js"], {
  env: { ...process.env, PORT: String(PORT), WEBHOOK_URL: `http://localhost:${WHPORT}/hook`, PUBLIC_API_KEY: API_KEY },
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
    const st = { ws, name, id: null, role: null, last: null, denied: [] };
    ws.on("open", () => ws.send(JSON.stringify({ t: "join", name, token })));
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.t === "welcome") { st.id = m.id; st.role = m.you.role; resolve(st); }
      if (m.t === "snapshot") st.last = m;
      if (m.t === "denied") st.denied.push(m.action);
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

  admin.ws.send(JSON.stringify({ t: "move", x: 500, y: 500, facing: 0 }));
  await wait(450);
  (guest.last?.players?.some((p) => p.id === admin.id && Math.abs(p.x - 500) < 5)) ? ok("position syncs between clients") : bad("position not synced");

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

  admin.ws.close(); guest.ws.close(); await wait(250);
} catch (e) {
  bad("exception: " + e.message);
} finally {
  server.kill(); hookServer.close();
}

console.log("\n" + (fails ? `SMOKE FAILED — ${fails} assertion(s)` : "SMOKE PASSED ✓"));
process.exit(fails ? 1 : 0);
