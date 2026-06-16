# Running the full NexSpace stack (Postgres + LiveKit + API + realtime)

This brings up real voice/video and persistent layouts. You'll use **3 terminals**
plus Docker. Run everything from `nexspace-scaffold/`.

> Prereqs: **Docker**, **Node 18+**. In WSL, open your browser tabs on Windows at
> **http://localhost:...** — `localhost` is a "secure context", so the browser will
> allow camera/mic over plain http. (Accessing via a raw WSL IP will block mic/cam.)

---

## 1. Backing services — Postgres + LiveKit (Docker)

```bash
cd nexspace-scaffold
docker compose up -d
docker compose ps          # both nexspace-pg and nexspace-livekit should be "running"
```

This starts:
- **Postgres** on `localhost:5432` (db `nexspace`, user `postgres`, password `nexspace`)
- **LiveKit dev SFU** on `ws://localhost:7880` (api key `devkey`, secret `secret`)

## 2. API — migrate, seed, run (Terminal A)

```bash
cd nexspace-scaffold/apps/api
cp .env.example .env          # defaults already match docker-compose
npm install
npm run prisma:generate
npm run migrate               # creates tables (also runs the seed)
npm run seed                  # (safe to run again; idempotent)
npm run dev                   # API on http://localhost:3001
```

Verify: open **http://localhost:3001/floors/default/world** → JSON world.
The `.env` already has `LIVEKIT_URL/KEY/SECRET` set to the docker LiveKit, so the
token endpoint is live.

## 3. Realtime + web (Terminal B)

```bash
cd nexspace-scaffold/apps/realtime
npm install
WORLD_API=http://localhost:3001 npm start    # serves web on http://localhost:8787, loads world from the API
```

You should see `Loaded world from API: http://localhost:3001/floors/default/world`.

## 4. Verify real voice/video

1. Open **http://localhost:8787** in **two tabs** (or two devices/browsers). Enter a name in each.
2. The browser will prompt for **camera + microphone** — Allow.
3. You should now see, in each tab:
   - the toolbar gains **🎤 / 🎥** toggles and a toast "🎙️ LiveKit connected";
   - the other person's **live video inside their avatar bubble** (yours too);
   - real **voice that pans and fades with distance** — walk apart and it quiets, walk together and it's full; step into a room for full-room audio.
4. Toggle 🎥/🎤 to confirm publish control; toggle a colleague far away and confirm their track unsubscribes (proximity culling).

## 5. Editor (optional) — persist a layout

Open **http://localhost:8787/editor.html**, drag furniture / move a room, **Save to API**
(writes to Postgres), then restart Terminal B (the realtime server) — the new layout is
what everyone joins.

---

## Troubleshooting

**No 🎤/🎥 toggles / "LiveKit connect failed" / still hearing synth tones**
- Confirm the API is up and `POST http://localhost:3001/livekit/token` returns `{url, token}` (not 503). 503 = LiveKit env not set → check `apps/api/.env`.
- Confirm `nexspace-livekit` is running: `docker compose logs livekit`.

**Connected but no audio/video flowing (black bubbles / silence)** — this is almost always WebRTC networking, not the code:
- Make sure you opened **http://localhost:8787** (not an IP). getUserMedia needs a secure context; `localhost` qualifies, a raw IP does not.
- WSL2 / Docker Desktop can mangle WebRTC media. The most reliable fix is to use **LiveKit Cloud** instead of the local SFU:
  1. Create a free project at https://cloud.livekit.io → copy the **ws URL**, **API key**, **secret**.
  2. Put them in `apps/api/.env` (`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`) and restart the API.
  3. No Docker LiveKit needed — `docker compose up -d postgres` for just the DB.
- Local UDP blocked? LiveKit falls back to TCP (port 7881) automatically; make sure that port is mapped (it is, in the compose file).

**Port already in use** — stop whatever holds 5432/7880/7881/7882/3001/8787, or change the port mappings in `docker-compose.yml` and `.env`.

**Prisma can't reach the DB** — wait a few seconds after `docker compose up` for Postgres to accept connections, then re-run `npm run migrate`.

**Mic/cam permission blocked** — check the browser's site permissions for `localhost:8787`; reset to "Allow" and reload.

---

## What "full stack" looks like when it's working

```
 Browser tab A ─┐                        ┌─ Browser tab B
   WS positions  │   ws://localhost:8787  │   WS positions
   LiveKit media │                        │   LiveKit media
        │        ▼                        ▼        │
        │   realtime server (8787) ──WORLD_API──▶ API (3001) ──▶ Postgres (5432)
        └────────── LiveKit SFU (7880/1/2) ◀───── token ─────────┘
```
