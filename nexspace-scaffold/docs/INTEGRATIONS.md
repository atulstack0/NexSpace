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

## Follow-ups (need OAuth + accounts)

- **Google / Outlook Calendar** — auto-status "In a meeting" from calendar events, one-click join. Requires OAuth and a token store, so it's a larger piece than the Slack webhook.
- **Microsoft Teams** — presence/auto-status on Teams calls (Graph API + OAuth).
- **Slack two-way** — slash command to get a join link, presence sync (needs a Slack app with a request URL, not just an incoming webhook).
