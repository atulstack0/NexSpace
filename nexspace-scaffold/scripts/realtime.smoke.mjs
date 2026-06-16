// NexSpace realtime smoke test — run from the scaffold root:  npm test
// Spawns the realtime server on a test port and connects two WebSocket clients to
// verify the core multiplayer contract: join/welcome, position sync, recording sync,
// and door-knock. No browser needed. Exits non-zero on failure.
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const PORT = 8799;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (m) => console.log("  ✓ " + m);
const bad = (m) => { fails++; console.log("  ✗ " + m); };

const server = spawn(process.execPath, ["apps/realtime/server.js"], {
  env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"],
});
server.stderr.on("data", (d) => process.stderr.write(d));

// wait for the listen log
await new Promise((res, rej) => {
  let buf = ""; const to = setTimeout(() => rej(new Error("server did not start in time")), 8000);
  server.stdout.on("data", (d) => { buf += d.toString(); if (buf.includes("realtime")) { clearTimeout(to); res(); } });
}).catch((e) => { console.error(e.message); server.kill(); process.exit(1); });

function join(name) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const st = { ws, name, id: null, last: null };
    ws.on("open", () => ws.send(JSON.stringify({ t: "join", name })));
    ws.on("message", (d) => { const m = JSON.parse(d.toString()); if (m.t === "welcome") { st.id = m.id; resolve(st); } if (m.t === "snapshot") st.last = m; });
    ws.on("error", (e) => { bad("ws error: " + e.message); });
  });
}

try {
  const a = await join("Alice");
  const b = await join("Bob");
  (a.id && b.id) ? ok("two clients joined and received welcome+id") : bad("welcome/id missing");

  a.ws.send(JSON.stringify({ t: "move", x: 500, y: 500, facing: 0 })); // 500,500 is inside the Focus Room
  await wait(450);
  (b.last?.players?.some((p) => p.id === a.id && Math.abs(p.x - 500) < 5)) ? ok("Bob sees Alice's synced position") : bad("position not synced");

  a.ws.send(JSON.stringify({ t: "recording", on: true }));
  await wait(350);
  (b.last?.recording?.on === true) ? ok("recording flag syncs to Bob") : bad("recording not synced");

  b.ws.send(JSON.stringify({ t: "knock", roomId: "focus" })); // Alice is inside Focus → occupant admits
  await wait(1700);
  (b.last?.doors?.focus === "open") ? ok("knock opened Focus door (occupant present)") : bad("door knock did not open");

  a.ws.close(); b.ws.close();
  await wait(250);
} catch (e) {
  bad("exception: " + e.message);
} finally {
  server.kill();
}

console.log("\n" + (fails ? `SMOKE FAILED — ${fails} assertion(s)` : "SMOKE PASSED ✓"));
process.exit(fails ? 1 : 0);
