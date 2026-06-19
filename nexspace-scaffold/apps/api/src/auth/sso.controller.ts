import { Controller, Get, Query, Res } from "@nestjs/common";
import { AuthService } from "./auth.service";

/**
 * OIDC Authorization-Code SSO (spec §6.16).
 * With OIDC_* configured it talks to a real provider; otherwise it uses a built-in
 * mock IdP so the whole flow is testable end-to-end with no external accounts.
 *
 *   /auth/sso/login → provider /authorize (or mock) → /auth/sso/callback → app JWT
 *   → redirect back to the office with ?sso=<token>, which the client uses to join.
 */
@Controller("auth/sso")
export class SsoController {
  constructor(private auth: AuthService) {}

  @Get("login")
  login(@Query("redirect") redirect: string, @Res() res: any) {
    const appRedirect = redirect || "http://localhost:8787/";
    const state = this.auth.sign({ r: appRedirect, sso: true }); // signed, short-lived
    if (this.auth.ssoConfigured()) {
      const u = new URL(process.env.OIDC_ISSUER.replace(/\/$/, "") + "/authorize");
      u.searchParams.set("response_type", "code");
      u.searchParams.set("client_id", process.env.OIDC_CLIENT_ID);
      u.searchParams.set("redirect_uri", process.env.OIDC_REDIRECT_URI);
      u.searchParams.set("scope", "openid email profile");
      u.searchParams.set("state", state);
      return res.redirect(u.toString());
    }
    return res.redirect("/auth/sso/mock/authorize?state=" + encodeURIComponent(state));
  }

  // Built-in mock identity provider — only used when OIDC isn't configured.
  @Get("mock/authorize")
  mockAuthorize(@Query("state") state: string, @Res() res: any) {
    return res.redirect("/auth/sso/callback?code=mock-code&state=" + encodeURIComponent(state || ""));
  }

  @Get("callback")
  async callback(@Query("code") code: string, @Query("state") state: string, @Res() res: any) {
    const claims: any = this.auth.verify(state);
    if (!claims || !claims.r) return res.status(400).send("Invalid SSO state");
    let user;
    try { user = this.auth.ssoConfigured() ? await this.auth.exchangeCode(code) : this.auth.mockUser(); }
    catch { return res.status(502).send("SSO token exchange failed"); }
    const role = this.auth.mapRole(user.email);
    const token = this.auth.sign({ sub: user.sub, name: user.name, role });
    const sep = String(claims.r).includes("?") ? "&" : "?";
    return res.redirect(claims.r + sep + "sso=" + encodeURIComponent(token));
  }
}
