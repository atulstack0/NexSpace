# NexSpace — spatial virtual office

[![CI](https://github.com/atulstack0/NexSpace/actions/workflows/ci.yml/badge.svg)](https://github.com/atulstack0/NexSpace/actions/workflows/ci.yml)

> Every push runs `npm run check` (syntax + API type-check + realtime smoke test) automatically via GitHub Actions — see the badge above.

NexSpace is a Kumospace-style **spatial virtual office**: everyone shares the same office in real time, walks around as an avatar, and hears each other with **proximity (spatial) audio** — closer people are louder, step into a room for a private conversation, hit broadcast to address the whole floor. It runs in 2D **and** real 3D (Three.js), and ships as a **single Node service** that's free to host (e.g. on Render).

Most advanced features are **optional and environment-gated** — the app works out of the box and lights each one up when you add the matching key (voice/video, AI, recording, etc.). See `../HANDOFF.md` for the full enablement guide and `../STATE.md` for the detailed, feature-by-feature status.

## Run it (2 minutes)

Requires **Node 18+**.

```bash
cd nexspace-scaffold
npm install
npm start              # serves the realtime server + web client on http://localhost:8787
```

Open **http://localhost:8787 in two tabs** (or two devices on your LAN), enter a name in each, and:

- move with **WASD / arrow keys**, or **click the floor** to walk there (A\* routes around furniture and walls);
- each tab hears the others with **distance-based spatial audio**; step into a **room** for private room audio, or **📢 Broadcast** to the whole floor;
- **doors** are shared state — knock on a closed room and an occupant lets you in;
- click the **📺 TV** to start a synced **watch-party**; open **💬 chat** (Nearby / Floor / #channels / DMs) and type **@ai** for the in-office assistant;
- toggle **🗺️ 2D / 🧊 3D** anytime (your choice is remembered); in 3D, use mouse-look + WASD with a third/first-person camera.

🎧 Headphones recommended. Without LiveKit configured, the per-peer voice is a synthesized tone that demonstrates the spatial-audio pipeline; real mic/camera is the opt-in LiveKit integration below.

## Demo logins

Leave the email/password blank on the join screen to enter as a **guest**, or sign in with one of the built-in role accounts to see RBAC in action (no Google needed):

| Role | Email | Password |
|---|---|---|
| Owner | `owner@nexspace.dev` | `owner1234` |
| Admin | `admin@nexspace.dev` | `admin1234` |
| Member | `member@nexspace.dev` | `member1234` |

> These are **demo defaults**. Override them for any real deployment by setting `OWNER_PASSWORD`, `ADMIN_PASSWORD`, and `MEMBER_PASSWORD` in your environment (and set a strong `JWT_SECRET`). Owner/Admin can edit the floor, moderate, record, and view analytics; Member and Guest have progressively fewer permissions.

## Features

**World & movement** — shared 2D/3D office, avatars, A\* click-to-move, collisions, camera pan/zoom/follow, minimap, authoritative 15 Hz sync with interpolation.

**Audio & media** — proximity + room + broadcast audio; **LiveKit** voice/video (opt-in) with a **gallery/grid view**, **mic/cam device picker**, screen share + **present-to-room**, and **recording** (egress to S3-compatible storage).

**Collaboration** — multi-scope **chat** (nearby/floor/#channels/DMs) + @mentions + unread badges, collaborative **whiteboard**, **reactions/emotes** (incl. ☕ sip‑chai), nudge, moderation (mute/kick), a shared **YouTube watch-party** TV.

**Games (🎮)** — **❄️ Freeze Tag** (floor-wide proximity chase: a random "It" freezes runners on contact, free runners thaw frozen teammates, frozen players can't move; win = everyone frozen or a 90s timer; live It/frozen markers in 2D + 3D) and shared **tic-tac-toe**.

**AI layer** — in-office **assistant** (`@ai` — answers, summaries, `who's here` / `schedule` / `help`), **auto meeting-notes** when a booking ends, and an **AI greeter** that welcomes new joiners. Free via Google Gemini; Anthropic/OpenAI/Groq/OpenRouter also supported.

**Build & customise** — in-office **floor editor**: add/select/move/**rotate** furniture, **draw/move/resize/rename/delete rooms**, **draw/move/delete walls**, multi-select, undo/redo, one-click **layout templates** (office/lounge/classroom/event); interactive objects (notes, embeds, timers); a rooftop **☕ chai stall**; avatar customization (suit/tie/skin + your own GLB URL); branding/white-label.

**3D** — real Three.js renderer with a **GLB character avatar** (`MODEL_URL`, with a sculpted styled fallback), three-point lighting + gradient sky, detailed furniture props, PUBG-style third/first-person camera + jump, 2D⇄3D toggle with no media restart.

**Org & access** — JWT auth + Google OAuth, server-enforced **RBAC**, SSO (OIDC + mock IdP), invites / guest links / CSV import + a **guest weekly time-cap**, presence & status.

**Integrations & ops** — public REST API (`/api/v1`) + HMAC **webhooks** + **Slack** notifications, **analytics** dashboard + CSV, **multi-floor** + portals, Redis multi-node fan-out, anti-teleport / rate-limit / connection-cap hardening, **live debug logs** (server + browser events streamed to `/logs.html`, written to a dated file, admin 📜 button), and CI.

**UI/UX** — game-style HUD with vertical side rails that **auto-hide** (📌) on desktop and collapse on mobile, a unified dark-glass theme across all panels, first-run onboarding tour, and an accessibility pass (keyboard focus, ARIA labels, live region).

## Optional features — turn on with env keys

Set these in your host's environment (or `apps/api/.env` for local dev). Everything is optional; unset = that feature stays off with a safe fallback.

| Set… | To enable |
|---|---|
| `GEMINI_API_KEY` | AI assistant / summaries / greeter (free — aistudio.google.com) |
| `LIVEKIT_URL` + `LIVEKIT_API_KEY` + `LIVEKIT_API_SECRET` | real voice/video + screen share |
| `S3_BUCKET` + `S3_ACCESS_KEY` + `S3_SECRET` (+ `S3_REGION`/`S3_ENDPOINT`) | recording (LiveKit Egress) |
| `YOUTUBE_API_KEY` | in-world TV search |
| `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` (+ `GOOGLE_REDIRECT_URI`) | Google sign-in |
| `SLACK_WEBHOOK_URL` | Slack notifications |
| `PUBLIC_API_KEY` / `WEBHOOK_URL` | public REST API / outbound webhooks |
| `REDIS_URL` | multi-node fan-out + floor persistence |
| `LOGS_TOKEN` | gate `/logs.html` in production (`/logs.html?key=…`); admins can open it via the 📜 button regardless |

Full table and step-by-step enablement (Calendar, Teams, SSO/SCIM, transcription, native apps, etc.) are in **`../HANDOFF.md`**.

## Repo layout

```
nexspace-scaffold/
├─ package.json                 # workspaces root + scripts (start / dev / check)
├─ scripts/                     # verify.mjs + realtime/redis/api smoke tests
├─ packages/shared/types.ts     # canonical world-state + wire-protocol types (the (x,y,z) contract)
└─ apps/
   ├─ realtime/server.js        # single Node http+ws service: authoritative world, chat, media,
   │                            #   editor, AI, RBAC, public API + webhooks; serves the web client
   ├─ web/
   │  ├─ index.html             # the full client (2D canvas / Three.js 3D / Web Audio / LiveKit)
   │  ├─ editor.html            # standalone drag-and-drop floor editor
   │  └─ analytics.html         # admin analytics dashboard
   └─ api/                      # NestJS + Prisma persistence (SQLite default, Postgres-ready)
docs/                           # PUBLIC_API.md · INTEGRATIONS.md · SCALING.md
CHARACTER.md · AI_ASSISTANT.md  # how to swap in a GLB character · how to enable the AI
```

The realtime server runs standalone with built-in floors, **or** loads the world from the API when started with `WORLD_API=http://localhost:3001` (see `apps/api/README.md`).

## Verify & deploy

```bash
cd nexspace-scaffold
npm run check          # prints "ALL CHECKS PASSED ✓" then "SMOKE PASSED ✓"
git add -A && git commit -m "…" && git push     # CI runs check; host auto-deploys
```

The client logs a build tag to the browser console on load (e.g. `NexSpace client build: …`) — handy for confirming the deployed version matches your latest change.

## What's not built yet

Everything achievable as plain code in this single-service setup is built. The remaining spec items need external services, art assets, or infrastructure/compliance work — Google/Outlook **Calendar** + **Teams** auto-status, **SAML/SCIM**, a **Zapier** app, recording **transcription**, native **desktop/mobile** apps, a full **glTF art** pipeline, managed **Postgres/Redis** + Docker, **observability** (Sentry/PostHog), **1,000+** load testing, and **SOC2/GDPR/HIPAA** compliance. Each has concrete enablement steps in **`../HANDOFF.md`**.

See `../NexSpace_Build_Plan.md` and `../NexSpace_Task_Backlog.csv` for the original roadmap.
