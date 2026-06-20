// NexSpace API smoke test — run from the scaffold root:  npm run test:api
// Boots the NestJS API and walks the SSO (OIDC) flow against the built-in MOCK provider
// end-to-end: /auth/sso/login → mock /authorize → /auth/sso/callback → app JWT.
// No external IdP or DB needed. Heavier than the realtime smoke (it compiles + boots Nest).
import { spawn } from "node:child_process";
import crypto from "node:crypto";

const PORT = 3011;
const BASE = `http://localhost:${PORT}`;
const SECRET = "nexspace-dev-secret-change-me";
let fails = 0;
const ok = (m) => console.log("  ✓ " + m);
const bad = (m) => { fails++; console.log("  ✗ " + m); };

function verifyJWT(token) {
  const p = (token || "").split("."); if (p.length !== 3) return null;
  const exp = crypto.createHmac("sha256", SECRET).update(p[0] + "." + p[1]).digest("base64url");
  if (p[2] !== exp) return null;
  try { return JSON.parse(Buffer.from(p[1], "base64url").toString()); } catch { return null; }
}
function sign(payload) {
  const b = (s) => Buffer.from(s).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const d = b(JSON.stringify({ alg: "HS256", typ: "JWT" })) + "." + b(JSON.stringify({ ...payload, iat: now, exp: now + 7200 }));
  return d + "." + crypto.createHmac("sha256", SECRET).update(d).digest("base64url");
}

const api = spawn("npm", ["start"], {
  cwd: "apps/api", shell: true,
  env: { ...process.env, PORT: String(PORT), DATABASE_URL: "file:./dev.db", JWT_SECRET: SECRET },
  stdio: ["ignore", "pipe", "pipe"],
});
api.stderr.on("data", (d) => process.stderr.write(d));
await new Promise((res, rej) => {
  let b = ""; const to = setTimeout(() => rej(new Error("API did not start in time")), 60000);
  api.stdout.on("data", (d) => { b += d.toString(); process.stdout.write(d); if (b.includes("NexSpace API on")) { clearTimeout(to); res(); } });
}).catch((e) => { console.error(e.message); api.kill(); process.exit(1); });

const abs = (loc) => (loc.startsWith("http") ? loc : BASE + loc);
try {
  const r1 = await fetch(`${BASE}/auth/sso/login?redirect=${encodeURIComponent("http://localhost:8787/")}`, { redirect: "manual" });
  const loc1 = r1.headers.get("location") || "";
  (r1.status >= 300 && r1.status < 400 && loc1.includes("/auth/sso/mock/authorize")) ? ok("login redirects to the (mock) IdP authorize") : bad("login redirect wrong: " + r1.status + " " + loc1);

  const r2 = await fetch(abs(loc1), { redirect: "manual" });
  const loc2 = r2.headers.get("location") || "";
  (loc2.includes("/auth/sso/callback") && loc2.includes("code=")) ? ok("mock IdP returns an auth code to the callback") : bad("mock authorize wrong: " + loc2);

  const r3 = await fetch(abs(loc2), { redirect: "manual" });
  const loc3 = r3.headers.get("location") || "";
  const tok = new URL(loc3, "http://x").searchParams.get("sso");
  const claims = verifyJWT(tok);
  (loc3.startsWith("http://localhost:8787/") && claims && claims.role === "member")
    ? ok("callback issues a valid app JWT (role=member) and redirects to the office")
    : bad("callback wrong: " + loc3 + " token=" + (claims ? JSON.stringify(claims) : "invalid"));

  // invites + CSV (6.15) — admin-gated
  const adminToken = sign({ sub: "u-admin", name: "Admin Ada", role: "admin" });
  const inv = await (await fetch(`${BASE}/auth/invite`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + adminToken }, body: JSON.stringify({ name: "Guest1" }) })).json();
  const ic = verifyJWT(inv.token);
  (ic && ic.role === "guest" && inv.url && inv.url.includes("invite=")) ? ok("admin mints a guest invite token + link") : bad("invite mint failed");
  const noAuth = await fetch(`${BASE}/auth/invite`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
  (noAuth.status === 403) ? ok("invite requires admin (403 without token)") : bad("invite not admin-gated: " + noAuth.status);
  const csv = await (await fetch(`${BASE}/auth/invite/csv`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + adminToken }, body: JSON.stringify({ csv: "a@x.com\nb@x.com, c@x.com" }) })).json();
  (csv.count === 3 && csv.invites.length === 3) ? ok("CSV import mints an invite per email") : bad("CSV import wrong count: " + csv.count);
} catch (e) {
  bad("exception: " + e.message);
} finally {
  try { api.kill(); } catch {}
}

console.log("\n" + (fails ? `API SMOKE FAILED — ${fails} assertion(s)` : "API SMOKE PASSED ✓"));
process.exit(fails ? 1 : 0);
