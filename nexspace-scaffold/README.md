# NexSpace — Monorepo Scaffold (Phase 0 + Realtime Sync Slice)

A runnable foundation for the spatial virtual office. Two browser tabs now share the **same full office** — rooms, doors, a media wall, collisions, and presence — synced through an authoritative server, with distance-based **proximity + room + broadcast spatial audio**. It's the multiplayer version of the single-file prototype.

> Status: scaffold. It implements the realtime/state server and a thin web client. The full stack (API + Postgres + Redis + LiveKit SFU + 2D/3D renderers) is laid out in the build plan and is added in later phases.

## Run it (2 minutes)

Requires **Node 18+**.

```bash
cd nexspace-scaffold
npm install            # installs the one dependency (ws) in apps/realtime
npm start              # starts the realtime + web server on :8787
```

Then open **http://localhost:8787 in two browser tabs** (or two devices on your LAN). Enter a name in each, walk around with **WASD / click**, and:

- each tab sees the other avatar move in real time (snapshots at 15 Hz, interpolated);
- each tab **hears** the other as a soft synth "voice" that **fades and pans with distance** (Web Audio `PannerNode`), now driven by real peers over the network;
- step into a **room** and you hear everyone inside it at full volume and no one outside (room-override audio);
- **doors** are shared state — knock on a closed/locked room and an occupant's client opening it updates for everyone; close the door behind you for privacy;
- the **media wall** has one synced playback state — pause it in one tab and it pauses in the other, and its audio fades with distance;
- hit **📢 Broadcast** to override proximity and be heard by every tab on the floor.

🎧 Headphones recommended. No microphone is used and nothing is recorded; the per-peer tone is synthesized locally to demonstrate the spatial-audio pipeline. Real voice/video is the LiveKit (SFU) integration in **Phase 2**.

## What's here

```
nexspace-scaffold/
├─ package.json                 # workspaces root
├─ packages/
│  └─ shared/
│     └─ types.ts               # canonical world-state + wire-protocol types (spec §5) — the (x,y,z) contract
└─ apps/
   ├─ realtime/
   │  ├─ server.js              # Node http+ws: authoritative world (rooms/doors/media/broadcast), tick loop, snapshots; serves the web client
   │  └─ package.json           # dep: ws
   ├─ web/
   │  ├─ index.html             # client: full shared office — rooms, doors, media wall, collisions, proximity/room/broadcast audio + optional LiveKit voice/video
   │  └─ editor.html            # drag-and-drop floor editor — moves/adds furniture, saves layouts to the API
   └─ api/                       # NestJS + Prisma + PostgreSQL persistence (spec §5) + LiveKit token endpoint
      ├─ prisma/schema.prisma   # Floor / Room / PlacedObject
      ├─ prisma/seed.ts         # seeds the "default" office floor
      ├─ src/world/             # GET /floors/:slug/world -> WorldBlob
      └─ README.md              # run + wire-to-realtime instructions
```

The realtime server runs standalone with built-in geometry, **or** loads the world from the API when started with `WORLD_API=http://localhost:3001` (see `apps/api/README.md`).

## How it maps to the architecture (spec §4 / §4.2)

| Concern | This scaffold | Production (per build plan) |
|---|---|---|
| State sync | `apps/realtime/server.js` — full snapshots @15 Hz | Colyseus **or** Socket.IO + **Redis** pub/sub for cross-node fan-out; interest-managed deltas for large events |
| Authority | server clamps positions to floor bounds | server-side movement simulation + validation (anti-cheat) |
| World contract | `packages/shared/types.ts` (TS schema) | same types imported by API, realtime, and both renderers |
| Rendering | one 2D canvas in `web/index.html` | **view-agnostic Zustand store** + interchangeable **Phaser (2D)** and **Three.js (3D)** adapters — never duplicate state |
| Media (voice/video) | **LiveKit** integrated (opt-in via env) with proximity track culling + video-in-bubble; synth-tone fallback when unconfigured | same, plus simulcast/recording/egress |
| Persistence / auth / CRUD | not in this slice | NestJS API + PostgreSQL + Clerk/JWT |

## Wire protocol (see `packages/shared/types.ts`)

- **Client → Server:** `join {name}`, `move {x,y,facing}`, `state {status,talking}`, `broadcast {on}`, `media {playing}`, `door {roomId,state}`, `knock {roomId}`
- **Server → Client:**
  - `welcome {id, world, you}` — `world` carries the authoritative geometry (obstacles, rooms+doors, media wall)
  - `snapshot {players[], doors{roomId:state}, media{playing,pos}}` — broadcast each tick (15 Hz)

## Deliberate scaffold simplifications (hardening backlog)

- Client-authored positions (server only clamps) — move to server-authoritative simulation + anti-cheat.
- Full snapshots to everyone — add interest management / spatial hashing for 1,000+ events (spec §8).
- World geometry is hardcoded in `server.js` — load it from PostgreSQL via `apps/api` (see below) so floors/objects persist and are editable.
- No auth or per-room permissions yet (anyone can open any door) — Phases 5 (RBAC) and locked-door role checks.
- Synth tone stands in for voice/video — real media is the LiveKit SFU integration (Phase 2).
- Single process / no Redis — add Redis pub/sub + sticky-session load balancing for horizontal scale.

## Done so far / next steps

Done: full shared office (rooms/doors/media wall/collisions/spatial audio), `apps/api` persistence (Postgres), optional **LiveKit** voice/video, and a **drag-and-drop editor** writing layouts back to the API.

Next:

1. **2D↔3D in multiplayer** — port the prototype's Three.js-style renderer into `apps/web` as a second adapter over the same state.
2. **Auth + RBAC** (Phase 5) — gate the API and per-room permissions (e.g., only members open locked doors); add invites/guest links.
3. **Live world reload** — push DB edits to the realtime server without a restart (e.g., an admin "publish" event over WS).
4. **Recording** via LiveKit Egress; **interest-managed** snapshots for 1,000+ attendee events.

See `../NexSpace_Build_Plan.md` and `../NexSpace_Task_Backlog.csv` for the full roadmap.
