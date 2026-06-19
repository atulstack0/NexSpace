import { Injectable, UnauthorizedException } from "@nestjs/common";
import * as crypto from "node:crypto";

/**
 * Lightweight auth (spec §6.14). Dependency-free HMAC-SHA256 JWT so the API and
 * the realtime server can verify the same token with just node:crypto.
 * Demo users are hardcoded; production swaps in a User table + bcrypt + a real IdP.
 */
const SECRET = process.env.JWT_SECRET || "nexspace-dev-secret-change-me";
const RANK: Record<string, number> = { guest: 0, member: 1, admin: 2, owner: 3 };
const DEMO: Record<string, { id: string; name: string; role: string; password: string }> = {
  "admin@nexspace.dev": { id: "u-admin", name: "Admin Ada", role: "admin", password: "admin1234" },
  "member@nexspace.dev": { id: "u-member", name: "Member Mo", role: "member", password: "member1234" },
};
const b64u = (s: string | Buffer) => Buffer.from(s).toString("base64url");

@Injectable()
export class AuthService {
  sign(payload: object) {
    const h = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const now = Math.floor(Date.now() / 1000);
    const p = b64u(JSON.stringify({ ...payload, iat: now, exp: now + 7200 }));
    const data = `${h}.${p}`;
    return `${data}.${crypto.createHmac("sha256", SECRET).update(data).digest("base64url")}`;
  }

  verify(token?: string): { sub: string; name: string; role: string } | null {
    if (!token) return null;
    const t = token.startsWith("Bearer ") ? token.slice(7) : token;
    const parts = t.split(".");
    if (parts.length !== 3) return null;
    const data = `${parts[0]}.${parts[1]}`;
    const expected = crypto.createHmac("sha256", SECRET).update(data).digest("base64url");
    if (parts[2].length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(parts[2]), Buffer.from(expected))) return null;
    try {
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
      if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
      return payload;
    } catch {
      return null;
    }
  }

  rank(role: string) { return RANK[role] ?? 0; }

  login(email: string, password: string) {
    const u = DEMO[(email || "").toLowerCase().trim()];
    if (!u || u.password !== password) throw new UnauthorizedException("Invalid email or password");
    return { token: this.sign({ sub: u.id, name: u.name, role: u.role }), user: { id: u.id, name: u.name, role: u.role } };
  }

  // ---- SSO / OIDC (spec §6.16). Real provider when configured; built-in mock otherwise. ----
  ssoConfigured() {
    return !!(process.env.OIDC_ISSUER && process.env.OIDC_CLIENT_ID && process.env.OIDC_CLIENT_SECRET && process.env.OIDC_REDIRECT_URI);
  }
  mapRole(email: string) {
    const admins = (process.env.OIDC_ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    return admins.includes((email || "").toLowerCase()) ? "admin" : "member";
  }
  mockUser() { return { sub: "sso|mock", email: "sso.user@example.com", name: "SSO User" }; }
  async exchangeCode(code: string) {
    const body = new URLSearchParams({
      grant_type: "authorization_code", code,
      client_id: process.env.OIDC_CLIENT_ID, client_secret: process.env.OIDC_CLIENT_SECRET, redirect_uri: process.env.OIDC_REDIRECT_URI,
    } as any);
    const res = await fetch(process.env.OIDC_ISSUER.replace(/\/$/, "") + "/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    const json: any = await res.json();
    const payload = (json.id_token || "").split(".")[1];
    const claims = payload ? JSON.parse(Buffer.from(payload, "base64").toString()) : {};
    return { sub: claims.sub || "sso", email: claims.email || "", name: claims.name || claims.email || "SSO User" };
  }
}
