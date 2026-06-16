# @nexspace/api — Persistence layer (NestJS + Prisma + PostgreSQL)

Stores the world (floors, rooms, placed objects — spec §5) and serves it to the realtime server, so geometry is **persisted and editable** instead of hardcoded.

## Run

Requires **Node 18+** only — the dev DB is **SQLite** (a local file), so **no Docker / no Postgres**.

```cmd
:: from apps\api  (Windows CMD)
npm install
npm run prisma:generate
npm run migrate          :: creates prisma\dev.db
npm run seed             :: inserts the "default" office floor
npm run dev              :: API on http://localhost:3001
```

`.env` is already present (`DATABASE_URL="file:./dev.db"`) so there's nothing to copy. The API also defaults `DATABASE_URL` and won't crash if the DB isn't ready.

Verify: open **http://localhost:3001/floors/default/world** — you should get the `WorldBlob` JSON (obstacles, rooms+doors, media wall).

### Using Postgres instead (optional)

Set `provider = "postgresql"` in `prisma/schema.prisma`, put a Postgres `DATABASE_URL` in `.env`
(the scaffold's `docker-compose.yml` starts one), then re-run `npm run migrate`.

## Wire it to the realtime server

The realtime server loads the world from this API when `WORLD_API` is set, otherwise it falls back to built-in geometry:

```bash
# from apps/realtime
WORLD_API=http://localhost:3001 npm start
```

Now editing the DB (or the seed) changes the office every client sees — no code change.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/floors/:slug/world` | `WorldBlob` — composed geometry for the realtime server + clients |
| GET | `/floors/:slug` | raw floor (rooms + typed objects) for the editor to load |
| PUT | `/floors/:slug/layout` | persist an edited layout — transactional replace of objects + room updates (spec §6.10) |
| POST | `/livekit/token` | mint a LiveKit access token `{room, identity, name} → {url, token}` (503 if unconfigured) |

## LiveKit (real voice/video)

Set `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` in `.env`. A local dev SFU:

```bash
# one-time: install livekit-server (https://docs.livekit.io), then
livekit-server --dev      # url ws://localhost:7880, key "devkey", secret "secret"
```

With those set, the multiplayer web client automatically connects, publishes mic+cam, routes remote audio through the spatial-audio engine, and shows live video in the avatar bubbles. **Without** them, the client silently falls back to the synth-tone audio — everything else still works.

## The editor

`apps/web/editor.html` (served by the realtime server at **http://localhost:8787/editor.html**) loads `GET /floors/default`, lets you drag/add/delete furniture and move rooms, and **Save** does `PUT /floors/default/layout`. Restart the realtime server (with `WORLD_API` set) to load the new layout for everyone.

## What's deliberately omitted (next phases)

- Auth/RBAC, memberships, invites (Phase 5) — every endpoint is currently open.
- Live hot-reload of the world into the realtime server (today: restart to pick up edits).
- Presence/recordings/analytics tables — schema covers the world; those are added per the build plan.
