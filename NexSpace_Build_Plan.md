# NexSpace — Master Build Plan & Sequenced Roadmap

*A Kumospace-style spatial virtual office (2D + toggleable 3D), planned from the master build prompt and market research.*

**Version:** 1.0 · **Date:** June 15, 2026 · **Status:** Planning baseline
**Companion files:** `NexSpace_Task_Backlog.csv` (109-task backlog) · `NexSpace_Roadmap_Timeline.csv` (phase-by-month Gantt)

---

## 1. Executive Summary

NexSpace is a persistent, browser-based virtual office where remote teams "show up" daily as avatars carrying live video, and hear only the people near them (proximity/spatial audio). The product targets both **daily collaboration** (small persistent teams) and **large events** (1,000+ attendees), with a deliberate differentiator set the incumbent (Kumospace) never shipped: a **toggleable 3D view of the same office**, a **shared media wall** (YouTube/HLS/DASH/live streams), **outdoor social zones** (the chai stall), a **public API + webhooks + Zapier**, **multiple concurrent recordings**, and a **first-class AI layer**.

The single most important architectural commitment is **decoupling simulation from rendering** (Section 4): the authoritative world lives in view-agnostic `(x, y, z)` state, and the 2D (Phaser) renderer, 3D (Three.js) renderer, and Web Audio engine are interchangeable consumers of it. This is what makes "same office, flip 2D↔3D live" achievable instead of two products to maintain — and it must be enforced from Phase 1, not retrofitted.

The plan sequences work into **eight phases** (0, 1, 2, 3, 4, 5, 5.5, 6) totalling roughly **790 engineering person-days** of estimated effort. With a focused cross-functional team of ~7–9, a **walk-and-talk alpha lands around month 5**, a **collaboration private beta around month 7**, a **2D GA candidate around month 11**, and **3D + AI** completing the vision around **months 14–15**.

The biggest non-code risk is the **3D glTF asset pipeline** (an art problem, not an engineering one); the biggest technical risk is **spatial/room audio correctness and media scaling**. Both are called out as isolated, test-first modules below.

---

## 2. Market Context & Strategic Bets

Drawn from the competitive research on Kumospace ($24M raised, ~4.7/5 on G2, but in apparent maintenance mode by late 2025 with headcount down to ~11 and both founders refocused on an AI-recruiting startup). The lessons directly shape this plan:

| Lesson from the market | How NexSpace responds in this plan |
|---|---|
| **Spatial presence is a retention play, not an events play.** Kumospace nearly died when events churn hit ~40%/month. | Anchor the product in persistent daily workflows (presence, status, doors, drop-ins) — Phases 1–3 — *before* chasing event scale (Phase 6). |
| **The hard problems are real-time media scaling and "office table-stakes," not the avatar gimmick.** | Phase 2 (spatial audio) and Phase 3 (rooms/doors/broadcast) are the longest, highest-risk, test-first phases. Don't compete on "prettier avatars." |
| **Don't build media infrastructure yourself.** Kumospace runs lean by outsourcing media (Daily/Agora). | Use **LiveKit** (self-hostable SFU) — buy the hard media parts; spend engineering on the presence/spatial layer and office features. |
| **Thin integrations were a real weakness.** No Zapier, no public API. | Ship a **public REST API + webhooks + Zapier** in Phase 5 (Appendix A fix #1). |
| **Single concurrent recording was a weakness.** | Support **multiple concurrent recordings** (Phase 5, fix #2). |
| **Performance on low-end devices / Chrome dependency hurt them.** | Aggressive media culling, adaptive quality, cross-browser QA, and 3D auto-fallback to 2D (Phases 2, 5.5, 6, fix #3). |
| **Learning curve vs. Zoom.** | First-run onboarding, sensible defaults, one-click guest join (Phase 6, fix #4). |
| **No AI — the clearest current market gap.** Competitors (Roam, SoWork) differentiate here; Kumospace's own founders left to build AI. | Make AI meeting intelligence a **first-class differentiator** (Phase 6 / Section 6.21, fix #5). |
| **Buyer is top-down (manager/exec) even though adoption looks bottom-up.** | Low-friction viral guest join (visual product demos well) + admin/analytics/SSO for the purchaser. Reflected in Phase 5 priorities. |

**Wedge strategy:** differentiate on (a) the 2D⇄3D experience, (b) a real integration ecosystem + API, and (c) AI meeting intelligence — not on environment polish alone.

---

## 3. Product Scope

**In scope (v1 vision):** persistent 2D spatial office; proximity + room + broadcast audio; live video; simultaneous screenshare; whiteboards; multi-scope chat + DMs; drag-and-drop builder; interactive objects; shared media wall; multi-floor; outdoor social zones (chai stall); roles/permissions; invites & guest access; access controls (password/domain/SSO); recording; integrations (Slack/Calendar/Teams) + public API/webhooks/Zapier; analytics; a **toggleable, styled 3D view** of the same office with a **PUBG-style camera (camera & controls only)**; and an **AI layer** (note-taker/assistant).

**Explicitly out of scope (v1):**

- Photorealistic / AAA 3D and VR/headset support. 3D is a **styled, performance-budgeted** render, not a photoreal engine.
- **Combat, weapons, or any harm mechanics.** The "PUBG-style" feature is **camera and controls only** — no shooting.
- Native AI features *at launch* — AI is a Phase 6 differentiator layered on a working product, not an MVP gate.

---

## 4. Architecture

### 4.1 System topology

Three independent server concerns plus a layered client. **Never let the realtime/state server and the media SFU be collapsed into one service.**

```
CLIENT (browser): React UI shell │ Phaser 2D canvas / Three.js 3D canvas │ Web Audio engine
        REST/HTTPS            WebSocket (state)            WebRTC (media)
            │                       │                          │
      API server            Realtime/State server         Media SFU
      (NestJS)              (Colyseus / Socket.IO)        (LiveKit + Egress)
            │                       │                          │
      PostgreSQL                  Redis                    S3 / R2 storage
   (persistent CRUD)     (presence, position, pub/sub)   (recordings, assets)
```

- **API server (NestJS):** auth, CRUD for spaces/floors/objects, memberships, invites, billing, integrations, public API.
- **Realtime/state server (Colyseus or Socket.IO + Redis pub/sub):** authoritative position sync, presence, room membership, door state, chat fan-out. Tick-based (10–20 Hz) broadcasts to clients on the same floor.
- **Media SFU (LiveKit):** routes audio/video/screenshare; clients subscribe/unsubscribe to tracks by proximity; LiveKit Egress handles recording. One LiveKit room per floor (or per audio-room for very large events).

### 4.2 The single most important decision: decouple simulation from rendering

Because the office must render in **both 2D and 3D, toggleable live**, the client is split into three layers that share one state and must never be merged:

```
            SHARED WORLD STATE  (Zustand store)
   positions (x,y,z) · presence · rooms · door state · placed objects · media tracks
                    — identical regardless of view —
        │                       │                         │
   2D RENDERER             3D RENDERER               AUDIO ENGINE
   Phaser/Pixi             Three.js (R3F)            Web Audio
   top-down sprites        + PUBG camera + glTF      PannerNode(x,y,z)
                    └──── only ONE renderer active ────┘   (view-agnostic)
```

Non-negotiables that this plan enforces from **Phase 1**:

1. **World state is the single source of truth** and knows nothing about which renderer is active.
2. **2D and 3D renderers are interchangeable adapters.** Toggling = unmount one, mount the other, with **no touch to state, media, or audio**. Same `(x,y)`, same people, same conversation continues.
3. **The audio engine is driven by coordinates, not pixels** — identical in both views; `PannerNode` uses the `z` axis for true 3D audio in 3D mode.
4. **Asset registry is the parity contract:** every object/avatar type maps to BOTH a 2D asset and a 3D model: `objectType → { sprite2D, model3D (glTF), collider }`.
5. **All movement (2D click-to-move and 3D WASD) writes to one movement-intent path** that updates shared `(x,y,z)`.

### 4.3 Recommended stack

**Frontend:** React 18 + TypeScript; Phaser 3 (2D); Three.js via react-three-fiber + drei (3D), PointerLockControls for FPS look, glTF/GLB models; Zustand (shared state); Tailwind + Radix/shadcn; Web Audio API (spatial audio); hls.js / dash.js (media wall streams).
**Media:** LiveKit (self-hostable SFU + Egress); Daily.co / Agora as managed alternatives for >1,000-person calls.
**Realtime state:** Colyseus *or* Socket.IO + Redis pub/sub.
**Backend:** Node.js + NestJS; PostgreSQL; Redis; S3-compatible storage (S3 / R2 / MinIO).
**Auth:** Clerk / Auth0 / custom JWT; SAML 2.0 + OIDC for enterprise SSO; SCIM for provisioning.
**Infra/ops:** Docker + Kubernetes (or Fly.io / Render / GCP); PostHog/Statsig (flags + analytics); Sentry (errors).
**Security:** DTLS-SRTP encrypted media; TLS everywhere; sandboxed iframes + CSP; build toward SOC 2 / GDPR / HIPAA.

---

## 5. Data Model Reference

The authoritative world is stored in **2.5D `(x, y, z)`** and is rendering-independent. Persistent entities live in PostgreSQL; ephemeral live state lives in Redis.

**Identity & org hierarchy**

- **User** — `id, email, displayName, avatarConfig(json), isGuest, ssoProvider?, timestamps`.
- **Space** (a company workspace) — `id, name, slug (custom URL), ownerId, branding(json), plan(free|business|enterprise), accessControl(json), timestamps`.
- **Floor** (a map/level, indoor or outdoor) — `id, spaceId, name, width, height, environment(indoor|outdoor), background(2D), scene3d?(3D), ambientAudioUrl?, supports3d(bool), templateId?, order`.
- **Room** (private audio zone) — `id, floorId, name, bounds(json polygon/rect), height?(for 3D walls), hasDoor, doorState(open|closed|locked), audioMode(room|broadcast), maxOccupancy?`.
- **PlacedObject** (furniture, interactive items, portals, media walls) — `id, floorId, type, position{x,y,z}, rotation{x,y,z}, scale, model3d?, config(json), collidable`. Types include `chair, table, plant, tv, spotify, whiteboard, game, sign, linkTablet, bar, mediaWall, portal, chaiStall, npc`.
- **Membership** — `id, spaceId, userId, role(owner|admin|floorManager|member|guest), status(active|invited|suspended), timestamps`.

**Type-specific `config` examples**

- `mediaWall` → `{ sourceType: youtube|hls|dash|twitch|directVideo|audioStream, url, submittedBy, queue[], whoCanChange: anyone|hosts, visibility: nearby|floor, playbackState{playing, positionSec, updatedAt} }`
- `portal` → `{ targetFloorId, targetSpawn{x,y}, label }` (e.g., office door → chai stall)
- `chaiStall` → `{ vendorNpc(bool), emotes['sipChai'], seatAnchors[{x,y}] }`

**Live / ephemeral (Redis)**

- **PresenceState** — `userId, floorId, position{x,y,z}, roomId?, status(available|away|busy|dnd|inMeeting), mediaState{camOn,micOn,screenSharing}, audioRadius(quiet|normal|megaphone), viewMode(2d|3d local-only), cameraMode?(thirdPerson|firstPerson), facing?(radians)`.

**Chat / ops**

- **Channel** — `id, spaceId, name, type(channel|dm|group), memberIds[]`.
- **Message** — `id, channelId?, scope?(nearby|floor|allFloors), senderId, body, attachments[], createdAt`.
- **Recording** — `id, floorId, startedBy, url, durationSec, createdAt`.
- **AnalyticsEvent** — `id, spaceId, userId, type, metadata, ts`.
- **Integration** — `id, spaceId, provider(slack|googleCalendar|outlook|teams), config(json)`.

---

## 6. Phased Roadmap (overview)

| Phase | Name | Focus | Est. (person-days) | Key exit criteria |
|---|---|---|---:|---|
| **0** | Scaffold | Monorepo, CI, Docker, auth, Postgres/Redis, shared types | ~60 | Local dev env up; auth works; migrations apply; shared `(x,y,z)` types defined |
| **1** | World & Movement (MVP core) | Shared state store, 2D renderer, movement, position sync, minimap | ~74 | Two users see each other move <150 ms; collisions respected; **state is view-agnostic** |
| **2** | Media & Spatial Audio ⭐ | LiveKit, video bubbles, proximity audio (PannerNode), subscription culling | ~76 | Walk toward someone → audio fades in & pans; out-of-range tracks not consuming bandwidth |
| **3** | Rooms, Doors, Broadcast, Screenshare, Chat, Media Wall | Audio isolation, doors/knock, broadcast, simul-screenshare, chat/DMs, media wall | ~129 | Room audio isolates; broadcast overrides proximity; synced media wall works in both views |
| **4** | Customization, Multi-floor, Outdoor | DnD editor, asset library, templates, interactive objects, portals, chai stall, branding | ~78 | Admin builds a floor + rooms that persists; portal to outdoor chai stall works |
| **5** | Org, Access, Recording, Integrations | RBAC, invites/guests, access controls/SSO, recording, Slack/Calendar/Teams, API/webhooks/Zapier, analytics | ~122 | Server-enforced permissions; guest join; recording retrievable; Slack/Calendar auto-status |
| **5.5** | 3D View & PUBG Camera ⭐ | glTF registry + models, Three.js adapter, 3D audio, 2D⇄3D toggle, third/first-person camera | ~108 | Flip 2D→3D keeps same positions/people/audio; camera never clips; weak devices auto-served 2D |
| **6** | Polish, Scale, Apps, AI | Large-event scaling, cross-browser/low-end, desktop/mobile apps, onboarding, a11y, AI layer, compliance | ~144 | 1,000+ event stable; AI transcript+summary+actions; SOC2/GDPR/HIPAA posture |
| | **Total** | | **~791** | |

> **Estimates are engineering-only** (design, PM, QA coordination, hiring ramp, and unknowns are excluded). Apply a 25–40% calendar buffer. Per-task detail and dependencies are in `NexSpace_Task_Backlog.csv`.

### Per-phase detail

**Phase 0 — Scaffold (~60 pd).** Monorepo (pnpm/Turborepo: `apps/web`, `apps/api`, `apps/realtime`, `packages/shared`), shared TS/lint config, Docker Compose (Postgres + Redis + MinIO), CI (lint/typecheck/test/build), Postgres schema + migrations for all §5 entities, Redis presence conventions, auth + sessions, NestJS API skeleton with guards, realtime server skeleton, shared types package, S3/R2 storage abstraction, Sentry + PostHog. *Risk:* low. *Gate:* nothing renders yet, but the foundation — including the view-agnostic types — is in place.

**Phase 1 — World & Movement (~74 pd).** Build the **Zustand view-agnostic world-state store first** and route all movement through it (this is what makes 3D possible later). Phaser canvas in the React shell, tilemap/floor + PlacedObject rendering, avatar sprites with labels/status, WASD + click-to-move (A* pathfinding), collision detection, camera pan/zoom + follow, mini-map, authoritative 10–20 Hz position sync, remote-avatar interpolation, presence/roster. *Risk:* medium (the §4.2 discipline). *Gate:* two-tab movement under 150 ms, no walking through walls.

**Phase 2 — Media & Spatial Audio ⭐ (~76 pd, highest technical risk).** LiveKit deploy + token service, client media manager (publish cam/mic), video bubble on avatar (fallback to initials/photo), **Web Audio engine** (`MediaStreamSource → PannerNode → destination`, fed 3D `(x,y,z)` from day one), distance attenuation + stereo pan updated per tick, audio-radius model (quiet/normal/megaphone), **proximity-based track subscribe/unsubscribe (bandwidth culling)**, device selection + mute, gallery view, simulcast/adaptive quality, reaction emojis, and a **two-tab spatial-audio test harness**. *Build and test this in isolation before integrating.* *Gate:* the proximity-audio acceptance test passes and out-of-range media consumes no bandwidth.

**Phase 3 — Rooms, Doors, Broadcast, Screenshare, Chat, Media Wall (~129 pd, largest phase).** Room zones + point-in-bounds, room audio isolation, door state machine (open/closed/locked) + knock/admit, broadcast mode + stage + multiple simultaneous broadcasts, simultaneous screenshare surfaces + focus + remote-control request/approve, whiteboard (tldraw/Excalidraw) with persistence, multi-scope chat (nearby/floor/all-floors) + channels/group DMs/1:1 + history + mentions/attachments/unread, nudge, and the **shared media wall** (offscreen `<video>`→texture pipeline shared by both renderers; YouTube/Vimeo/Twitch embeds; HLS/DASH + direct video + audio-stream routed through proximity audio; synced `playbackState` + late-joiner snap; submission queue + `whoCanChange` + visibility; and **mandatory safety**: allow/denylist, rate limit, host mute/clear, audit log, sandboxed iframes). *Risk:* high (audio modes + abuse surface). *Gate:* collaboration acceptance criteria all pass.

**Phase 4 — Customization, Multi-floor, Outdoor (~78 pd).** Drag-and-drop editor (place/move/rotate/scale/delete) with grid snap, undo/redo, multi-select; room drawing + door/audio assignment; asset library + image/GIF uploads; templates (office, lounge, conference hall, classroom, event hall); save/duplicate/version; interactive objects (YouTube TV, Spotify, games, bar, link tablet, signs); multi-floor model + floor switcher; **portal objects**; **outdoor floor** (sky + ambient audio attenuation) and the **chai stall** (seat anchors, optional vendor NPC, sip-chai emote) as the reference "themed social space"; branding/white-label/custom domain. *Risk:* medium. *Gate:* an admin builds and persists a custom floor; walking through a portal to the outdoor chai stall works.

**Phase 5 — Org, Access, Recording, Integrations, Analytics (~122 pd).** Role hierarchy + configurable permission matrix **enforced server-side** (never trust the client) + UI gating; invites (space/floor/room links + email); **guest URL join** with time cap (default 4 h/week) + limited perms; CSV guest import (≤1,000); access controls (password, domain/email allowlist, public/private); **SSO (SAML/OIDC) + SCIM**; moderation (mute/block/remove/report); **recording via LiveKit Egress → S3** with shareable link/download, recording indicator, and **multiple concurrent recordings**; **Slack** (presence/status, notifications, slash command), **Google + Outlook Calendar** (in-app calendar, reminders, auto-status, one-click join), **Teams** auto-status; embeds + embeddable NexSpace iframe; **public REST API + webhooks + Zapier**; analytics dashboard (active users, time-in-office, room usage, peak concurrency, attendance) + CSV export. *Risk:* medium-high (SSO/SCIM, recording infra). *Gate:* GA-candidate (2D) — security and admin acceptance criteria pass.

**Phase 5.5 — 3D View & PUBG Camera ⭐ (~108 pd; do NOT start before Phases 1–2 are solid).** The Three.js renderer is a **second adapter over the existing shared state** — not a rewrite. glTF asset registry; **low-poly glTF models per object/avatar (the real cost — an art pipeline, ship one template floor first)**; R3F renderer; ground plane + wall extrusion from room `bounds × height`; 3D avatars with billboarded live-video planes; media walls/screenshare as `VideoTexture`; 3D `PannerNode` (z-axis + HRTF); **2D⇄3D live toggle** (unmount/mount, no media restart, persist `viewMode`); third-person camera rig (spring follow + mouse-look orbit); first-person + `V` toggle (PointerLockControls); camera-relative WASD + `facing` sync to others; camera-collision raycast; performance (GPU instancing, LOD, frustum + proximity culling, cap visible avatars); **graceful fallback** to 2D on `supports3d=false` or weak GPU. *Risk:* high (assets + perf). *Gate:* flip 2D→3D in a populated floor keeps the same layout/colleagues/positions/audio; flip back is instant.

**Phase 6 — Polish, Scale, Apps, AI (~144 pd, partly ongoing).** Large-event scaling (SFU sharding, audio/video culling, 1,000+); cross-browser QA (Firefox/Safari WebRTC) + low-end-device optimization; desktop app (Electron/Tauri); mobile apps (React Native) reusing the core; first-run onboarding + tooltips + sensible defaults; accessibility (keyboard nav, captions, screen-reader labels); **AI note-taker/transcription/summaries** (Whisper/Deepgram + Claude), **AI assistant** (in-space Q&A, "what did I miss?", scheduling), optional AI NPC/greeter; compliance (SOC 2 Type II, GDPR, HIPAA + BAA); zero-downtime deploys + autoscaling + ≥99.9% SLA. *Risk:* medium, sustained. *Gate:* the AI and large-event acceptance criteria pass; compliance posture established.

---

## 7. Timeline & Sequencing

Assumes a focused cross-functional team of ~7–9 (see Section 8), starting **July 2026**. Phases overlap where dependencies allow (e.g., the 3D **art pipeline** P55-02 starts in parallel ~month 9; integrations in Phase 5 parallelize across backend engineers). Full month-by-month grid is in `NexSpace_Roadmap_Timeline.csv`.

| Milestone | Target (month) | Approx. date | Meaning |
|---|---|---|---|
| **M0 — Scaffold complete** | End M1 | Jul 2026 | Foundations + view-agnostic types |
| **M1 — Walkable world** | End M3 | Sep 2026 | Movement + presence MVP (no media) |
| **M2 — Spatial-audio alpha ⭐** | End M5 | Nov 2026 | "Walk and talk" — the killer feature live |
| **M3 — Collaboration private beta** | End M7 | Jan 2027 | Rooms/doors/broadcast/screenshare/chat/media wall |
| **M4 — Customizable spaces** | End M9 | Mar 2027 | Builder + multi-floor + outdoor chai stall |
| **M5 — 2D GA candidate** | End M11 | May 2027 | Org/access/recording/integrations/analytics |
| **M6 — 3D + PUBG camera ⭐** | End M14 | Aug 2027 | Toggleable 3D on a template floor, then expand |
| **M7 — AI + apps + scale** | M15+ | Sep 2027+ | AI layer, desktop/mobile apps, compliance, large-event hardening |

**Critical path:** shared state (P1-01) → spatial audio (P2-04/05/07) → room/broadcast audio (P3-02/05) → 3D adapter (P55-03) → 2D⇄3D toggle (P55-08). The audio modules and the 3D adapter sit on the critical path; protect them with senior ownership and early spikes.

---

## 8. Team & Resourcing

| Role | Count | Heaviest phases | Notes |
|---|---:|---|---|
| Frontend / game-client eng (Phaser, React) | 2 | 1, 3, 4 | Owns the 2D renderer, editor, UI shell |
| Realtime / backend eng (Node, NestJS, Colyseus, Redis) | 2 | 0, 1, 3, 5 | Owns state server, sync, RBAC, API |
| Media / WebRTC eng (LiveKit, Web Audio) | 1–2 | 2, 3, 5, 6 | Owns spatial audio + SFU — critical path |
| 3D / graphics eng (Three.js, R3F) | 1 | 5.5 | Joins ~month 8–9; pairs on §4.2 earlier |
| 3D artist (glTF/GLB low-poly) | 1 (part-time/contract) | 4, 5.5 | Asset pipeline is the hidden cost |
| DevOps / SRE | 1 | 0, 5, 6 | CI/CD, scaling, deploys, compliance infra |
| Product designer | 1 | 4, 6 | Builder UX, onboarding, a11y |
| PM / TPM | 1 | all | Sequencing, acceptance sign-off |
| QA (can be shared) | 1 | 2, 3, 6 | Two-tab harness, cross-browser, low-end |
| Security (fractional) | 0.5 | 3, 5, 6 | Media-wall abuse surface, SSO/SCIM, SOC2/HIPAA |

**Hiring note:** the 3D eng and artist are not needed until ~month 8 — hire/contract on that schedule rather than at kickoff. The market research shows Kumospace ran the *whole* business on ~11–16 people by outsourcing media and infra; this plan follows the same "buy the hard parts" posture so the team can stay lean.

---

## 9. Risk Register (summary)

Full register with likelihood/impact/owner is in the backlog companion. The top risks:

| # | Risk | Sev | Mitigation |
|---|---|---|---|
| R1 | **Spatial/room audio correctness** (the core mechanic) is subtle and easy to get wrong. | High | Build in isolation with a two-tab test harness (P2-12); feed `(x,y,z)` to PannerNode from day one; senior media owner. |
| R2 | **3D asset pipeline** (a glTF model per object/avatar) is an art cost, not code; can balloon. | High | Ship 3D for **one template floor first**; budget contract art; instancing/LOD; auto-fallback to 2D. |
| R3 | **Media scaling / cost** for large events and many camera-on users. | High | LiveKit simulcast + proximity subscription culling; Agora/Daily fallback for >1,000; load-test in Phase 6. |
| R4 | **§4.2 decoupling violated** — renderers entangle state, making the 2D⇄3D toggle a rewrite. | High | Enforce the view-agnostic store from Phase 1; code-review gate; one movement-intent path. |
| R5 | **Media-wall abuse** (anyone can post a URL). | Med-High | Mandatory allow/denylist, rate limit, host mute/clear, audit log, sandboxed iframes (P3-19) — ship with the feature, not after. |
| R6 | **Performance on low-end devices / Chrome dependency** (a known incumbent weakness). | Med | Adaptive quality, culling, cross-browser QA, 3D fallback (Phase 6). |
| R7 | **Scope creep** turning v1 into photoreal 3D / VR / game mechanics. | Med | Hold the non-goals in Section 3; 3D stays styled & budgeted; camera-only, no combat. |
| R8 | **Episodic ("events") usage** instead of daily retention — what nearly killed Kumospace. | Med | Sequence daily-workflow features (presence/status/doors) before event scale; track DAU/MAU and churn early. |
| R9 | **SSO/SCIM + compliance** (SOC2/HIPAA) underestimated. | Med | Treat as dedicated Phase 5/6 workstreams with security owner; don't bolt on late. |

---

## 10. Definition of Done & Quality Gates

**Global DoD (from the spec):**

- Every Section-6 feature is implemented with its stated acceptance criteria.
- A new user can: receive a link → join as guest → walk around → have proximity conversations → enter a room → join a broadcast → chat → and (if a member) edit the space.
- Server-enforced permissions, encrypted media, persistent spaces, and graceful performance on a mid-range device under a **30-person floor** are all verified.
- Automated tests cover: position sync, audio subscription logic, room/door state transitions, permission gating, and integration webhooks.

**Per-phase quality gate:** no phase is "done" until its acceptance criteria pass in a **two-browser (or N-browser) live test**, server-side permission enforcement is verified independently of the client, and the relevant automated tests are green. Audio modules (Phases 2–3) and the 2D⇄3D toggle (Phase 5.5) additionally require a recorded demo against their exact acceptance scripts.

---

## 11. Companion Files

- **`NexSpace_Task_Backlog.csv`** — 109 tasks across all phases: `ID, Phase, Epic, Task, Spec Ref, Priority, Est (person-days), Owner Role, Dependencies, Acceptance / Notes`. Opens directly in Excel/Google Sheets; sort/filter by phase, owner, or priority to build sprint plans.
- **`NexSpace_Roadmap_Timeline.csv`** — phase-by-month grid (Jul 2026 → Sep 2027) with milestone markers for quick Gantt visualization.

---

## Appendix — Build-order rules (non-negotiables)

1. **Enforce the §4.2 split from Phase 1.** World state is view-agnostic; the 2D and 3D renderers are interchangeable adapters over one Zustand store. *Do not duplicate state.*
2. **Keep the realtime/state server and the media SFU separate** — different scaling profiles, different failure modes.
3. **Treat spatial audio (6.3) and room/door audio (6.4) as the highest-risk modules** — build and test in isolation with two browser tabs before integrating.
4. **Build 2D fully first.** 3D is a rendering layer added on top of working, view-agnostic state — not a Phase-1 concern. The hidden cost of 3D is the glTF asset pipeline, so plan art work, not just code.
5. **Ship the media wall's safety controls with the feature**, never after — it is an abuse vector by design.
