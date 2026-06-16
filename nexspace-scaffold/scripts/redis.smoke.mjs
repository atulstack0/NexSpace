// NexSpace multi-node Redis test — run from the scaffold root:  npm run test:redis
// Spawns TWO realtime server instances sharing one Redis, and verifies cross-node
// presence (a client on node A sees a client on node B) and cross-node state events
// (a door opened on node A propagates to node B). Skips cleanly if REDIS_URL is unset
// so the normal `npm run check` (no Redis) is unaffected.
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import crypto from "node:crypto";

const REDIS_URL = process.env.REDIS_URL || "";
if (!REDIS_URL) { console.log("REDIS_URL not set — skipping multi-node Redis test (CI sets it via a Redis service)."); process.exit(0); }

const P1 = 8901, P2 = 8902;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (m) => console.log("  ✓ " + m);
const bad = (m) => { fails++; console.log("  ✗ " + m); };

function sign(p) {
  const b = (s) => Buffer.from(s).toString("base64url");
  const h = b(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const pl = b(JSON.stringify({ ...p, iat: now, exp: now + 7200 }));
  const d = `${h}.${pl}`;
  return `${d}.${crypto.createHmac("sha256", "nexspace-dev-secret-change-me").update(d).digest("base64url")}`;
}
const adminToken = sign({ sub: "u-admin", name: "Admin Ada", role: "admin" });

function startNode(port) {
  const s = spawn(process.execPath, ["apps/realtime/server.js"], {
    env: { ...process.env, PORT: String(port), REDIS_URL }, stdio: ["ignore", "pipe", "pipe"],
  });
  s.stderr.on("data", (d) => process.stderr.write(d));
  return s;
}
function waitListen(s) {
  return new Promise((res, rej) => { let b = ""; const to = setTimeout(() => rej(new Error("node did not start")), 9000); s.stdout.on("data", (d) => { b += d.toString(); if (b.includes("realtime")) { clearTimeout(to); res(); } }); });
}
function join(port, name, token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${port}`); const st = { ws, id: null, last: null };
    ws.on("open", () => ws.send(JSON.stringify({ t: "join", name, token })));
    ws.on("message", (d) => { const m = JSON.parse(d.toString()); if (m.t === "welcome") { st.id = m.id; resolve(st); } if (m.t === "snapshot") st.last = m; });
    ws.on("error", (e) => bad("ws error: " + e.message));
  });
}

const n1 = startNode(P1), n2 = startNode(P2);
try {
  await waitListen(n1); await waitListen(n2);
  const a = await join(P1, "Admin Ada", adminToken); // node 1
  const b = await join(P2, "Bob", undefined);        // node 2
  await wait(900); // let presence pub/sub propagate (published every 250ms)

  (b.last?.players?.some((p) => p.id === a.id)) ? ok("node-2 client sees node-1 client (cross-node presence)") : bad("cross-node presence missing on node-2");
  (a.last?.players?.some((p) => p.id === b.id)) ? ok("node-1 client sees node-2 client") : bad("cross-node presence missing on node-1");

  // cross-node state event: admin on node-1 opens the Boardroom door → node-2 sees it
  a.ws.send(JSON.stringify({ t: "door", roomId: "board", state: "open" }));
  await wait(800);
  (b.last?.doors?.board === "open") ? ok("door change on node-1 propagates to node-2 (Redis event)") : bad("door change did not propagate cross-node");

  a.ws.close(); b.ws.close(); await wait(300);
} catch (e) {
  bad("exception: " + e.message);
} finally {
  n1.kill(); n2.kill();
}

console.log("\n" + (fails ? `REDIS SMOKE FAILED — ${fails} assertion(s)` : "REDIS SMOKE PASSED ✓"));
process.exit(fails ? 1 : 0);
