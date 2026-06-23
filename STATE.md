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
| Rooms, doors (open/closed/locked) + knock-to-enter — closed (unlocked) doors open from outside so empty rooms are enterable; **3D walls have a real door opening** + a state-coloured door panel (hidden when open) | ✅ | realtime + web |
| Meeting rooms & schedule — book a **start time + duration** (per-room schedule, overlap-rejected), today's agenda list per room, nameplate in 2D/3D, meetings **auto-activate at start** + presence flips to **In a meeting**, auto-expire; booker/admin cancel by id | ✅ | realtime `bookRoom`/`cancelBooking`, web `📅 Rooms` |
| Broadcast mode | ✅ | realtime + web |
| Shared YouTube TV (watch-party) — one screen, search/paste, shared queue, **playback synced to the same second** + shared play/pause (YouTube IFrame API), thumbnail on the wall in 2D/3D | ✅ | realtime `/youtube/search` + `tv*`/`tvCtrl`, web |
| Text chat — nearby / floor / #channels / private DMs, room-aware, cross-node, XSS-safe | ✅ | realtime + web |
| In-office AI assistant — `@ai <q>` in chat (or 🤖 button): answers, summarizes recent room chat, drafts notes; **free Google Gemini** / Anthropic / OpenAI (or OpenAI-compatible Groq/OpenRouter) via env key, graceful when unset, per-user cooldown | ✅ opt-in | realtime `askAssistant`, web; `AI_ASSISTANT.md` |
| Screen sharing (LiveKit) — publish + multi-share focus viewer; **present-to-room** mode: one presenter's screen auto-enlarges for everyone in their room with a "X is presenting" banner (synced, RBAC member+, auto-stops on leave) | ✅ opt-in | realtime `present`/`unpresent`, `apps/web` |
| Collaborative whiteboard — synced strokes + clear, late-joiner state, cross-node | ✅ | realtime + web |
| Reactions (floating emoji), nudge, moderation (admin mute / kick) | ✅ | realtime + web |
| Notifications — browser notification + tab-title flash + 💬 unread badge for DMs, @-mentions, and nudges when the tab is unfocused; permission requested on opening chat | ✅ | `apps/web/index.html` |
| Activity feed (📋) — joins/leaves, new bookings, presentations logged with timestamps; **meeting reminders** nudge you ~5 min before a booking you made starts (toast + notification) | ✅ | realtime `activity` event, web |
| Mini-game (🎮) — shared tic-tac-toe: two players take X/O seats, turn-enforced moves, win/draw detection, reset; synced live so others spectate; seats freed on leave | ✅ | realtime `gameJoin`/`gameMove`/`gameReset`, web |
| 2D ⇄ 3D toggle — pseudo-3D **and** real Three.js WebGL | ✅ | `apps/web/index.html` |
| 3D office props — desks (monitor + chair), meeting tables, sofas, plants, chairs, rugs by `furniture.kind`; styled businessman avatars (vest/shirt/tie-by-person/trousers/shoes) that turn to face their walk direction with floating name tags; TV overlay perspective-sized + wall-occluded | ✅ | `apps/web/index.html` (Three3D) |
| Real character model — optional GLB (Renderpeople "Eric" or a Mixamo business character); loads `apps/web/models/eric.glb` via GLTFLoader, auto-fits + tints per person, **falls back to the styled avatar** if absent | ✅ opt-in | `apps/web/index.html`, `CHARACTER.md` |
| Walk animation — procedural leg/arm swing on the styled avatar when moving; GLB models play embedded **Walk/Idle** clips (AnimationMixer), blended by movement | ✅ | `apps/web/index.html` (Three3D) |
| 3D TV — live video **matrix3d-skewed onto the wall screen** (perspective-correct, wall-mounted, occluded by walls); the poster shows only while paused/out-of-view, hidden while playing (no double) | ✅ | `apps/web/index.html` |
| Mobile/touch — on-screen joystick to walk, drag-to-look in 3D (no pointer-lock needed), tap to move/interact in 2D; no-zoom viewport, larger touch targets, compact panels/minimap | ✅ | `apps/web/index.html` |
| Avatar customization — 🎨 panel to pick suit/tie/skin colour + display name (+ optional own GLB url); synced to everyone via presence, saved on device, applied in 2D + 3D | ✅ | realtime `appearance`, web |
| PUBG-style 3D camera — third/first person, mouse-look, sprint, jump, camera collision | ✅ | `apps/web/index.html` |
| Presence & status (5 states) + idle auto-away | ✅ | realtime + web |
| Auth (JWT login) + server-enforced RBAC | ✅ | `apps/api/src/auth`, realtime |
| SSO (OIDC authorization-code) with built-in mock IdP; real provider via env | ✅ | `apps/api/src/auth/sso`, web |
| Google sign-in — real OAuth run by the realtime server (single-service, no DB); role mapping via env | ✅ | realtime `/auth/google/*`, web |
| Invites & guest links + CSV bulk import (admin-minted, time-boxed) | ✅ | `apps/api/src/auth`, web |
| Recording — 🔴 indicator + LiveKit Egress start/stop | ✅ (egress needs storage) | `apps/api/src/livekit`, realtime, web |
| Drag-and-drop floor editor → persists to API → live reload to everyone | ✅ | `apps/web/editor.html`, `apps/api`, realtime |
| Analytics — admin dashboard + CSV | ✅ | realtime `/analytics`, `apps/web/analytics.html` |
| Public API (`/api/v1`) + HMAC webhooks + Slack notifications | ✅ | realtime; `docs/PUBLIC_API.md`, `docs/INTEGRATIONS.md` |
| Persistence — NestJS API + Prisma (SQLite default, Postgres-ready) | ✅ | `apps/api` |
| Hardening — anti-teleport, rate limit, connection cap, heartbeat, graceful shutdown | ✅ | realtime |
| Multi-node fan-out (Redis pub/sub) | ✅ opt-in | realtime; `docs/SCALING.md` |
| Multi-floor + portals — independent floors, floor-scoped presence/chat/snapshots, portal travel + floor switcher | ✅ | `apps/api` (Floor/portal objects), realtime, web |
| Interactive objects — sticky notes, embeds (YouTube/Spotify/web → iframe), shared countdown timers; placed in the editor, synced live | ✅ | `apps/api` (widget objects), realtime, web, editor |
| Responsive UI — collapsible toolbar (hamburger), mobile-friendly overlays | ✅ | `apps/web/index.html` |
| In-office floor editor — owner/admin drag-move, add, delete furniture + notes/timers/portals live; RBAC-gated; **persists** across restarts (Redis or JSON file) | ✅ | realtime `editFloor` + persist, web |
| Branding / white-label — per-space name, accent color, logo; served in world + applied live | ✅ | `apps/api` (Floor.branding), realtime, web |
| CI — GitHub Actions (`check` + `redis-multinode` + `api-smoke`) | ✅ | `.github/workflows/ci.yml` |

## What's not built yet (the honest list)

- **Remote screen control** — not in the build. (Chat covers nearby / floor / #channels / DMs; whiteboard is collaborative.)
- **glTF art** — 3D uses primitives (boxes/cylinders/billboards), not modeled assets.
- **Outdoor "chai stall"** environment + in-world mini-games. (Multi-floor + portals, and interactive objects — notes, YouTube/Spotify/web embeds, shared timers — are now built.)
- **Calendar / Teams** (need OAuth + accounts) and **SCIM** auto-provisioning.
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
