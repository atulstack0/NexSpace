import { Body, Controller, ForbiddenException, Headers, Post } from "@nestjs/common";
import { AuthService } from "./auth.service";

@Controller("auth")
export class AuthController {
  constructor(private auth: AuthService) {}

  // POST /auth/login  { email, password }  ->  { token, user:{id,name,role} }
  // Demo logins: admin@nexspace.dev / admin1234  ·  member@nexspace.dev / member1234
  @Post("login")
  login(@Body() body: { email: string; password: string }) {
    return this.auth.login(body.email, body.password);
  }

  private requireAdmin(authz?: string) {
    const u = this.auth.verify(authz);
    if (!u || this.auth.rank(u.role) < this.auth.rank("admin")) throw new ForbiddenException("Admin role required");
    return u;
  }
  private link(base: string, token: string) {
    base = base || "http://localhost:8787/";
    return base + (base.includes("?") ? "&" : "?") + "invite=" + encodeURIComponent(token);
  }

  // POST /auth/invite  { name?, ttlHours?, baseUrl? }  ->  { token, url }   (admin) — spec §6.15
  @Post("invite")
  invite(@Body() body: { name?: string; ttlHours?: number; baseUrl?: string }, @Headers("authorization") authz?: string) {
    this.requireAdmin(authz);
    const token = this.auth.makeInvite(body.name || "Guest", body.ttlHours || 4);
    return { token, url: this.link(body.baseUrl, token) };
  }

  // POST /auth/invite/csv  { csv, ttlHours?, baseUrl? }  ->  { count, invites:[{email,token,url}] }  (admin)
  @Post("invite/csv")
  inviteCsv(@Body() body: { csv: string; ttlHours?: number; baseUrl?: string }, @Headers("authorization") authz?: string) {
    this.requireAdmin(authz);
    const invites = this.auth.parseEmails(body.csv).map((email) => {
      const token = this.auth.makeInvite(email.split("@")[0], body.ttlHours || 4);
      return { email, token, url: this.link(body.baseUrl, token) };
    });
    return { count: invites.length, invites };
  }
}
