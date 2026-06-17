# NexSpace — State of the Project

*A spatial virtual office (Kumospace-style): walk a 2D/3D floor as an avatar, hear people by proximity, meet in rooms.*

**Repo:** https://github.com/atulstack0/NexSpace · **CI:** GitHub Actions (`check` + `redis-multinode`)
**Last updated:** June 2026

---

## TL;DR

NexSpace is a **working prototype / early MVP**, built on the real production stack and verified end-to-end by CI. Two browser tabs share one office with real-time movement, proximity/room/broadcast spatial audio (real LiveKit voice/video optional), rooms with lockable doors, a synced media wall, a 2D⇄3D view (pseudo-3D + real Three.js WebGL with a PUBG-style camera), presence/status, auth + server-enforced RBAC, recording, a drag-and-drop editor with live reload, analytics, a public API + webhooks + Slack, anti-cheat/rate-limit/connection hardening, and optional Redis multi-node fan-out.

It is **not** a finished SaaS — see "What's not built yet."

---

## How to run it

Full steps: [`nexspace-scaffold/RUNNING.md`](nexspace-scaffold/RUNNING.md). Quickest path (Windows, no Docker):

```powershell
# API (terminal A) — SQLite, zero external services
cd nexspace-scaffold\apps\api;  npm install; npm run prisma:generate; npm run migrate; npm run seed; npm run dev
# realtime + web (terminal B)
cd nexspace-scaffold\apps\realtime;  npm install; $env:WORLD_API="http://localhost:3001"; npm start
```

Open **http://localhost:8787** in two tabs. Optional: LiveKit Cloud creds in `apps\api\.env` for real voice/video; `SLACK_WEBHOOK_URL` for Slack; `REDIS_URL` for multi-node.

Verify any change: `cd nexspace-scaffold; npm run check` (also runs in CI on every push).

---

## What's built (mapped to the plan)

| Area | Status | Where |
|---|---|---|
| 2D world, avatars, WASD + click move, collisions, camera, minimap | ✅ | `apps/web/index.html` |
| Proximity + room + broadcast spatial audio (Web Audio PannerNode) | ✅ | `apps/web/index.html` |
| Real voice/video (LiveKit) — video-in-bubble, proximity track culling, mic/cam toggles | ✅ opt-in | `apps/api` (token/egress) + `apps/web` |
| Rooms, doors (open/closed/locked) + knock-to-enter | ✅ | realtime + web |
| Broadcast mode | ✅ | realtime + web |
| Media wall — synced play/pause, distance-faded audio | ✅ | realtime + web |
| Text chat — multi-scope (nearby/floor), room-aware, cross-node, XSS-safe | ✅ | realtime + web |
| Screen sharing (LiveKit) — publish + multi-share focus viewer | ✅ opt-in | `apps/web` |
| 2D ⇄ 3D toggle — pseudo-3D **and** real Three.js WebGL | ✅ | `apps/web/index.html` |
| PUBG-style 3D camera — third/first person, mouse-look, sprint, jump, camera collision | ✅ | `apps/web/index.html` |
| Presence & status (5 states) + idle auto-away | ✅ | realtime + web |
| Auth (JWT login) + server-enforced RBAC | ✅ | `apps/api/src/auth`, realtime |
| Recording — 🔴 indicator + LiveKit Egress start/stop | ✅ (egress needs storage) | `apps/api/src/livekit`, realtime, web |
| Drag-and-drop floor editor → persists to API → live reload to everyone | ✅ | `apps/web/editor.html`, `apps/api`, realtime |
| Analytics — admin dashboard + CSV | ✅ | realtime `/analytics`, `apps/web/analytics.html` |
| Public API (`/api/v1`) + HMAC webhooks + Slack notifications | ✅ | realtime; `docs/PUBLIC_API.md`, `docs/INTEGRATIONS.md` |
| Persistence — NestJS API + Prisma (SQLite default, Postgres-ready) | ✅ | `apps/api` |
| Hardening — anti-teleport, rate limit, connection cap, heartbeat, graceful shutdown | ✅ | realtime |
| Multi-node fan-out (Redis pub/sub) | ✅ opt-in | realtime; `docs/SCALING.md` |
| CI — GitHub Actions (`check` + `redis-multinode`) | ✅ | `.github/workflows/ci.yml` |

## What's not built yet (the honest list)

- **Chat channels & private DMs** (multi-scope nearby/floor chat *is* built; named channels and 1:1 DMs aren't), **whiteboards**, **remote screen control** — not in the build.
- **glTF art** — 3D uses primitives (boxes/cylinders/billboards), not modeled assets.
- **Multi-floor / portals / outdoor "chai stall"**, extra interactive objects (games, Spotify, YouTube TV beyond the media wall).
- **Calendar / Teams / SSO+SCIM** (need OAuth + accounts); invites/guest links/CSV import; branding/white-label; moderation tooling.
- **AI layer** (note-taker/assistant), **mobile/desktop apps**, **SOC2/GDPR/HIPAA** compliance.
- **Scale follow-ups**: spatial-hash interest management, Redis-persisted boot state.

---

## Architecture (as built)

```
Browser (React-free single-file client: 2D canvas / Three.js WebGL / Web Audio)
   │ REST                │ WebSocket                  │ WebRTC
   ▼                     ▼                            ▼
NestJS API (3001)   Realtime server (8787)        LiveKit SFU (optional)
 Prisma/SQLite      authoritative state, RBAC,
 auth, world,       presence, rooms/doors, media,
 layout, egress,    analytics, public API+webhooks,
 livekit tokens     hardening, Redis fan-out (opt)
```

- **View-agnostic state**: the same `(x,y)` world drives the 2D, pseudo-3D, and Three.js renderers — flipping views never touches state, audio, or media.
- **Server-authoritative**: positions are speed-clamped; permissions enforced server-side; clients can't be trusted.

## What CI proves (`npm run check` + jobs)

- **verify**: syntax of the realtime server + both client pages, and the API TypeScript build.
- **smoke** (single process, 21 assertions): join/roles, position sync, status sync + validation, RBAC (recording/doors/reload), live world reload, analytics gating, public API key gating, HMAC webhook + Slack, anti-teleport clamp, rate limiting, connection cap.
- **redis-multinode** (Redis service + 2 nodes): cross-node presence + cross-node door propagation.

> Not covered by CI: the **WebGL/Three.js visuals** (need a real browser) and **real LiveKit media** (need a server). Verify those by eye in the browser.

---

## Roadmap (suggested order)

1. **glTF asset pipeline** for the 3D view (biggest visual upgrade; needs art).
2. **Text chat + screenshare** in the multiplayer client (LiveKit already supports screenshare).
3. **Calendar/Teams/SSO** (OAuth) — needs accounts; CI can cover wiring only.
4. **Scale**: interest management + Redis-persisted shared state on boot.
5. **AI layer**, mobile/desktop apps, compliance — later phases.

See [`NexSpace_Build_Plan.md`](NexSpace_Build_Plan.md), [`NexSpace_Task_Backlog.csv`](NexSpace_Task_Backlog.csv), and `nexspace-scaffold/docs/` for detail.
