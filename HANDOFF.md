# NexSpace — Handoff & Enablement Guide

_Last updated: 2026-06-24_

This document explains **what is built**, and for everything **not** built, the exact steps, services, and environment variables needed to finish it. It's written so a developer (or you, with a dev's help) can pick up any remaining item and turn it on.

For the live, feature-by-feature status, see `STATE.md`. For the original specification, see `prompt.txt`; for the itemized backlog, `NexSpace_Task_Backlog.csv`.

---

## 1. How NexSpace is wired (read this first)

NexSpace ships as a **single Render web service** running `apps/realtime/server.js` (Node, raw `http` + `ws`). That one process:

- serves the client (`apps/web/index.html`, read fresh from disk per request, `Cache-Control: no-store`),
- runs the authoritative realtime state (positions, rooms, doors, chat, media, editor),
- mints LiveKit tokens, proxies YouTube search, exposes the public REST API + webhooks.

The design pattern for every integration is **environment-gated and graceful**: a feature is off until its env keys are set, and the app never breaks when they're absent (it falls back — e.g. synth audio instead of LiveKit, "assistant not enabled" instead of an LLM call). So **enabling a remaining feature is usually: add env vars in the Render dashboard → it redeploys → the feature lights up.** No code change needed for anything already wired.

> Do **not** commit secrets. Set them in **Render → your service → Environment**. `apps/api/.env` is git-ignored and only for local dev.

### Local dev
```
cd nexspace-scaffold
npm install
npm run dev      # starts the realtime server on http://localhost:8787
npm run check    # verify (syntax + types) + smoke test; run before every push
```

---

## 2. What's already built (summary)

Spatial 2D/3D world, avatars, movement (incl. A* click‑to‑move), collisions, camera, minimap · proximity + room + broadcast audio · LiveKit voice/video (opt‑in) with gallery view + device picker · rooms/doors/knock · meeting rooms & scheduling · shared YouTube watch‑party TV · multi‑scope chat + DMs + channels · in‑office AI assistant + auto meeting‑notes + greeter NPC · screen share + present‑to‑room · whiteboard · reactions/emotes/nudge/moderation · full in‑office editor (drag, multi‑select, undo/redo, **layout templates**, **room‑drawing**) · 2D⇄3D with PUBG‑style camera · auth (JWT + Google OAuth) + RBAC · invites/guest links/CSV + **guest weekly time‑cap** · recording (egress) · analytics · public API + webhooks + Slack · multi‑floor + portals · branding/white‑label · game‑style side‑rail HUD (desktop) with mobile collapse · accessibility pass · CI.

**Optional features you can switch on today with just env keys:** LiveKit voice/video + recording, the AI assistant/greeter (free Gemini), YouTube search, Google sign‑in, Slack notifications, the public API + webhooks, and Redis multi‑node fan‑out. See the env table in §4.

---

## 3. Remaining items — what they need and how to enable

Each item below is **not** finished in this build because it requires an external account, paid service, art assets, or infrastructure/compliance work that can't be produced as plain code here. Effort is a rough order of magnitude for one developer.

### 3.1 Google / Outlook Calendar integration — auto‑status, reminders, one‑click join (spec 6.18 / P5‑12)
- **Why not here:** needs OAuth apps + per‑user token storage (a database).
- **Effort:** ~1–2 weeks.
- **Enable:**
  1. Create a **Google Cloud** project → OAuth consent screen → OAuth client (Web). Enable the **Google Calendar API**. (For Outlook: register an **Azure AD app**, add Microsoft Graph `Calendars.Read`.)
  2. Add scopes `calendar.readonly` (+ `calendar.events` if you want NexSpace to create events).
  3. Store each user's **refresh token** server‑side (this is the main new piece — use the `apps/api` Postgres/Prisma layer, see §3.9).
  4. Add a poller (or webhook/push subscription) that reads upcoming events and: flips presence to **In a meeting** at start time (reuse the existing `status` flip used by room bookings), posts a reminder (reuse the activity‑feed reminder you already have), and renders a "Join" button that deep‑links into the matching room.
- **Touchpoints:** `apps/realtime/server.js` (presence/status, activity reminders already exist); new OAuth routes + token store in `apps/api`.

### 3.2 Microsoft Teams auto‑status (spec 6.18 / P5‑13)
- **Why not here:** needs a Microsoft Graph app + the user's Teams presence subscription.
- **Effort:** ~3–5 days (after 3.1's Azure app exists).
- **Enable:** subscribe to Graph **presence** change notifications; when Teams reports "InACall/Busy", call the existing status setter to flip the NexSpace avatar to **In a meeting**.

### 3.3 Enterprise SSO: SAML 2.0 + SCIM provisioning (spec 3, 6.16 / P5‑07)
- **Why not here:** the app has a **working OIDC** path (with a built‑in mock IdP) and Google OAuth, but SAML/SCIM need a real IdP and a provisioning endpoint.
- **Effort:** ~2 weeks.
- **Enable:**
  - **OIDC (fastest):** point the existing OIDC config at a real provider (Okta/Auth0/Entra) — issuer, client id/secret, redirect URI. Largely env + config.
  - **SAML:** add a SAML SP (e.g. `@node-saml/passport-saml`) and your IdP metadata.
  - **SCIM:** expose a SCIM 2.0 `/Users` + `/Groups` endpoint (bearer‑token protected) so the IdP can auto‑provision/deprovision members into the `apps/api` user store.

### 3.4 Zapier app (spec 6.18 / P5‑15 remainder)
- **Why not here:** the **public REST API + HMAC webhooks already exist** (`/api/v1/*`, `WEBHOOK_URL`); a Zapier *app* must be authored and published on Zapier's platform.
- **Effort:** ~3–5 days.
- **Enable:** in the **Zapier Platform**, create an app with **Triggers** backed by your webhooks (`user.joined`, `user.left`, etc.) and **Actions** that call `/api/v1/*` with the `X-API-Key`. Publish (or keep private/shared by link).

### 3.5 AI transcription of recordings → searchable notes (spec 6.21 / P6‑07)
- **Why not here:** needs a speech‑to‑text service; the **text** AI (assistant, summaries, auto meeting‑notes, greeter) is already built.
- **Effort:** ~1 week.
- **Enable:**
  1. Recording already lands in S3‑compatible storage via LiveKit Egress (set `S3_*`, see §4).
  2. Add a worker that, on egress completion, sends the audio to **Deepgram** or **OpenAI Whisper** (`OPENAI_API_KEY`), then feeds the transcript to the existing assistant (`GEMINI_API_KEY`/etc.) to produce summary + action items.
  3. Post the result to the floor (reuse `postAssistant` / the auto‑notes path) and/or store it.

### 3.6 Native desktop app — Electron/Tauri, with pop‑out window (spec 7 / P6‑03)
- **Why not here:** a packaged binary + signing/distribution is a separate build target.
- **Effort:** ~2 weeks.
- **Enable:** wrap the existing web client in **Tauri** (light) or **Electron**; load the deployed URL or bundle `apps/web`. Add a "pop‑out" `BrowserWindow`/webview for video. Code‑sign for macOS/Windows and set up auto‑update.

### 3.7 Native mobile apps — iOS/Android (spec 7 / P6‑04)
- **Why not here:** native build + app‑store distribution; the web client is already mobile‑responsive with a touch joystick.
- **Effort:** ~3–4 weeks.
- **Enable:** **React Native** (or Expo) shell reusing the shared state/logic; integrate the LiveKit React Native SDK for mobile WebRTC. Ship via TestFlight / Play Console.

### 3.8 Full glTF art pipeline — modeled furniture & avatars (spec 6.23 / P55‑02)
- **Why not here:** needs produced 3D art; today 3D uses primitives + an optional GLB character (`apps/web/models/eric.glb`, see `CHARACTER.md`).
- **Effort:** ~3+ weeks (mostly art).
- **Enable:** commission/buy low‑poly GLB models per `furniture.kind`; load them in the Three.js renderer the way the optional Eric character already loads (GLTFLoader). Keep the primitive fallback for weak GPUs.

### 3.9 Production data layer — Postgres + Redis + Docker (spec 3, 4, 5 / P0‑03/05)
- **Why not here:** the realtime server persists floors to Redis **or** a JSON file, and `apps/api` uses **Prisma with SQLite** by default; production wants managed Postgres + Redis and a Docker dev env.
- **Effort:** ~3–5 days.
- **Enable:** provision managed **Postgres** (point Prisma `DATABASE_URL` at it; run `npm run api:setup`) and **Redis** (set `REDIS_URL` / `PERSIST_REDIS_URL`). Add a `docker-compose.yml` (Postgres + Redis + MinIO) for parity local dev.

### 3.10 Observability — Sentry + product analytics (spec 3 / P0‑12)
- **Why not here:** custom analytics exist (`/analytics` dashboard), but no Sentry/PostHog wiring.
- **Effort:** ~1–2 days.
- **Enable:** add the **Sentry** SDK (DSN env) to client + server for error tracking; add **PostHog**/Statsig for product events + feature flags.

### 3.11 Scale to 1,000+ concurrent — SFU sharding + interest management (spec 8 / P6‑01) and reliability/SLA (P6‑11)
- **Why not here:** needs load infra and multi‑instance orchestration; Redis fan‑out is in place but untested at that scale.
- **Effort:** ~2–3 weeks.
- **Enable:** add **spatial‑hash interest management** (only sync nearby peers), shard LiveKit, run multiple realtime instances behind a sticky‑session‑aware load balancer with Redis pub/sub (already supported), and load‑test (k6/Artillery) to ≥1,000.

### 3.12 Compliance — SOC 2, GDPR, HIPAA (spec 3, 8 / P6‑10)
- **Why not here:** organizational/legal program, not code.
- **Effort:** months (ongoing).
- **Enable:** engage a compliance platform (Vanta/Drata), sign DPAs/BAAs with subprocessors (LiveKit, hosting, LLM provider), implement data‑retention/export/delete, audit logging, and access reviews.

---

## 4. Environment variable reference

Set these in **Render → Environment** (or `apps/api/.env` for local dev). Everything is optional; unset = that feature stays off with a safe fallback.

| Variable | Enables | Notes |
|---|---|---|
| `GEMINI_API_KEY` | AI assistant / summaries / greeter | **Free** — aistudio.google.com (~1,500 req/day). Recommended. |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | AI (alternatives to Gemini) | Paid. `OPENAI_BASE_URL` lets you point at Groq/OpenRouter. |
| `AI_MODEL` | Override default model | e.g. `gemini-2.5-flash`. |
| `GUIDE_OFF=1` | Disables the greeter NPC | Greeter is on by default. |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | Real voice/video + screen share | From a LiveKit Cloud project. Without these, audio uses a synth fallback. |
| `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET`, `S3_REGION`, `S3_ENDPOINT` | Recording (LiveKit Egress) storage | Any S3‑compatible store (e.g. Backblaze B2). |
| `YOUTUBE_API_KEY` (or `GOOGLE_API_KEY`) | In‑world TV search | YouTube Data API v3 key. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | Google sign‑in | OAuth client. `GOOGLE_OWNER_EMAILS` / `GOOGLE_ADMIN_EMAILS` map roles. |
| `OWNER_PASSWORD`, `ADMIN_PASSWORD`, `MEMBER_PASSWORD` | Demo email+password logins | For quick role testing without Google. |
| `JWT_SECRET` | Signs auth tokens | Set a strong random value in production. |
| `PUBLIC_API_KEY` | Public REST API (`/api/v1/*`) | Sent by clients as `X-API-Key`. |
| `WEBHOOK_URL` | Outbound webhooks (HMAC‑signed) | Fires `user.joined`, `user.left`, etc. → Zapier/your endpoint. |
| `SLACK_WEBHOOK_URL` | Slack notifications | Incoming‑webhook URL. |
| `REDIS_URL` / `PERSIST_REDIS_URL` | Multi‑node fan‑out + floor persistence | Without it, floors persist to a JSON file. |
| `DATA_DIR` | Where the JSON persistence file lives | Defaults next to the server. `NO_PERSIST=1` disables saving. |
| `WORLD_API` | Load world/floor data from the API service | Unset = built‑in floors. |
| `PORT`, `MAX_CLIENTS` | Server port / connection cap | Defaults are sensible. |

---

## 5. Suggested order to finish out

1. **Free wins first (env only):** `GEMINI_API_KEY`, `LIVEKIT_*` (+ `S3_*` for recording), `YOUTUBE_API_KEY`, Google sign‑in, `SLACK_WEBHOOK_URL`, `REDIS_URL`.
2. **Production data layer (§3.9):** Postgres + Redis + Docker — unblocks Calendar, SCIM, transcription storage.
3. **Calendar (§3.1)** then **Teams (§3.2)** — highest user value.
4. **Enterprise access (§3.3)** — OIDC config first (fast), then SAML/SCIM if needed.
5. **Transcription (§3.5)**, **Zapier (§3.4)**, **Observability (§3.10)**.
6. **Native apps (§3.6/3.7)**, **glTF art (§3.8)**, **scale (§3.11)**, **compliance (§3.12)** as the product matures.

---

## 6. Verifying & deploying changes

```
cd nexspace-scaffold
npm run check        # must print "ALL CHECKS PASSED ✓" then "SMOKE PASSED ✓"
git add -A
git commit -m "your message"
git pull --rebase
git push             # Render auto‑deploys
```

The client logs a build tag to the browser console on load (e.g. `NexSpace client build: 2026-06-24g …`) — use it to confirm the deployed version matches your latest change.
