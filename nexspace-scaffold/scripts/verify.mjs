// NexSpace build verifier — run from the scaffold root:  npm run verify
// Syntax-checks the realtime server and the (inline) client JS, and type-checks the API.
// No browser / DB needed. Exits non-zero on any failure.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let fails = 0;
const ok = (m) => console.log("  ✓ " + m);
const bad = (m, e) => { fails++; console.log("  ✗ " + m + "\n      " + String(e || "").trim().split("\n").slice(0, 8).join("\n      ")); };

function checkJs(label, file) {
  try { execSync(`node --check "${file}"`, { stdio: "pipe" }); ok(label); }
  catch (e) { bad(label, e.stderr?.toString() || e.message); }
}

// node --check only parses (never executes), so browser globals are irrelevant.
function checkInline(label, htmlFile) {
  try {
    const html = readFileSync(htmlFile, "utf8");
    const m = html.match(/<script>([\s\S]*?)<\/script>/); // the inline app script (CDN <script src> is skipped)
    if (!m) return bad(label, "no inline <script> found");
    const tmp = join(tmpdir(), "nexspace_" + Math.random().toString(36).slice(2) + ".js");
    writeFileSync(tmp, m[1]);
    execSync(`node --check "${tmp}"`, { stdio: "pipe" });
    ok(label);
  } catch (e) { bad(label, e.stderr?.toString() || e.message); }
}

console.log("Syntax — realtime server");
checkJs("apps/realtime/server.js", "apps/realtime/server.js");

console.log("Syntax — client inline JS");
checkInline("apps/web/index.html", "apps/web/index.html");
checkInline("apps/web/editor.html", "apps/web/editor.html");
checkInline("apps/web/logs.html", "apps/web/logs.html");

console.log("Types — API (tsc --noEmit)");
// Regenerate the Prisma client first so the typecheck always matches the current schema.prisma
// (otherwise adding a column leaves the generated @prisma/client types stale → false TS errors).
// Best-effort: if generation fails (e.g. offline), fall through and let tsc report the real state.
try { execSync("npx prisma generate --schema prisma/schema.prisma", { cwd: "apps/api", stdio: "pipe" }); } catch {}
try { execSync("npx tsc --noEmit", { cwd: "apps/api", stdio: "pipe" }); ok("apps/api typecheck"); }
catch (e) { bad("apps/api typecheck", (e.stdout?.toString() || "") + (e.stderr?.toString() || "")); }

console.log("\n" + (fails ? `FAILED — ${fails} check(s) need fixing` : "ALL CHECKS PASSED ✓"));
process.exit(fails ? 1 : 0);
