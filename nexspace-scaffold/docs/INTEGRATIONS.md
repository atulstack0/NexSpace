# NexSpace Integrations (spec §6.18)

## Slack — "X entered the office" notifications

Uses a **Slack incoming webhook** (no OAuth, no app review — just a URL).

1. In Slack: create an app → **Incoming Webhooks** → enable → **Add New Webhook to Workspace** → pick a channel → copy the URL (looks like `https://hooks.slack.com/services/T.../B.../xxxx`).
2. Start the realtime server with it set:
   ```powershell
   # apps/realtime (PowerShell)
   $env:SLACK_WEBHOOK_URL="https://hooks.slack.com/services/T.../B.../xxxx"; npm start
   ```
3. Now when anyone joins/leaves the office, the channel gets:
   > 👋 Ada entered the office

That's it. The server POSTs Slack's expected `{"text": "..."}` payload. If `SLACK_WEBHOOK_URL` is unset, nothing is sent.

**Tested in CI:** the smoke test points `SLACK_WEBHOOK_URL` at a local receiver and asserts a correctly-formatted join notification is posted.

## Generic webhooks

For your own systems (not Slack), use the HMAC-signed generic webhooks instead — see [PUBLIC_API.md](./PUBLIC_API.md). `user.joined` / `user.left` with an `X-NexSpace-Signature` you can verify.

## SSO (OIDC)

NexSpace supports OIDC Authorization-Code SSO. With no provider configured it uses a
**built-in mock IdP**, so the flow works (and is CI-tested) out of the box.

Flow: the office **Sign in with SSO** button → `GET /auth/sso/login` → provider `/authorize`
(or the mock) → `GET /auth/sso/callback` → the API issues an app JWT and redirects back to the
office with `?sso=<token>`, which the client uses to join.

Connect a real provider (Okta, Auth0, Entra ID, Google, …) via `apps/api/.env`:

```
OIDC_ISSUER="https://your-tenant/oauth2/default"
OIDC_CLIENT_ID="..."
OIDC_CLIENT_SECRET="..."
OIDC_REDIRECT_URI="http://localhost:3001/auth/sso/callback"
OIDC_ADMIN_EMAILS="you@company.com"   # these SSO users get the admin role
```

Register `OIDC_REDIRECT_URI` as an allowed redirect in your provider. SSO users default to the
**member** role (admins via `OIDC_ADMIN_EMAILS`).

**Tested in CI:** the `api-smoke` job boots the API and walks the mock SSO flow, asserting a
valid app JWT is issued. (SCIM auto-provisioning is a follow-up.)

## Follow-ups (need OAuth + accounts)

- **Google / Outlook Calendar** — auto-status "In a meeting" from calendar events, one-click join. Requires OAuth and a token store, so it's a larger piece than the Slack webhook.
- **Microsoft Teams** — presence/auto-status on Teams calls (Graph API + OAuth).
- **Slack two-way** — slash command to get a join link, presence sync (needs a Slack app with a request URL, not just an incoming webhook).
