# Running the full NexSpace stack (Windows-friendly, no Docker needed)

The dev database is **SQLite** (a local file) — **no Docker, no Postgres server**.
You need only **Node 18+** (you have it). Two terminals.

> Run commands in **Windows CMD** (or PowerShell). Notes for CMD:
> use `copy` (not `cp`), backslash paths, and `set VAR=val && cmd` for env vars.

---

## 1. API — SQLite, migrate, seed, run  (Terminal A)

```cmd
cd C:\Users\chat360it1\Claude\Projects\NexSpace\nexspace-scaffold\apps\api
npm install
npm run prisma:generate
npm run migrate
npm run seed
npm run dev
```

- `.env` is already present (`DATABASE_URL="file:./dev.db"`), so nothing to copy.
- `npm run migrate` creates `prisma\dev.db`; `npm run seed` fills the office floor.
- API runs on **http://localhost:3001**. Verify: open **http://localhost:3001/floors/default/world** → JSON.

> The API now boots even if the DB isn't ready — it just logs a warning. So if something
> is off with migrate/seed, LiveKit and the realtime server still work.

## 2. Realtime + web  (Terminal B)

```cmd
cd C:\Users\chat360it1\Claude\Projects\NexSpace\nexspace-scaffold\apps\realtime
npm install
npm start
```

- Serves the office at **http://localhost:8787**. Open it in **two tabs**.
- It uses built-in geometry by default. To load the **DB-backed** world (so editor changes show up):
  ```cmd
  set WORLD_API=http://localhost:3001 && npm start
  ```

At this point the two-tab office works with **synth audio** (what you already saw). For **real voice/video**, do step 3.

## 3. Real voice/video with LiveKit (optional)

On Windows the simplest, most reliable option is **LiveKit Cloud** (free) — no Docker:

1. Create a free project at **https://cloud.livekit.io** → copy the **ws URL**, **API Key**, **API Secret**.
2. Edit **`apps\api\.env`**, uncomment and set the three lines:
   ```
   LIVEKIT_URL="wss://YOUR-PROJECT.livekit.cloud"
   LIVEKIT_API_KEY="API..."
   LIVEKIT_API_SECRET="..."
   ```
3. Restart the API (Ctrl-C in Terminal A, `npm run dev` again).
4. Reload both tabs at **http://localhost:8787**, click **Allow** for camera + mic.

You should see live video in the avatar bubbles and hear real voice that pans/fades with distance, plus 🎤/🎥 toggles in the toolbar.

**Alternatives to Cloud:**
- **Native binary:** download `livekit-server` for Windows from the LiveKit releases, run `livekit-server --dev` (ws://localhost:7880, key `devkey`, secret `secret` — these are the commented defaults in `.env.example`).
- **Docker:** start Docker Desktop, then `docker compose up -d livekit` from the scaffold root.

## 3b. Recording (optional)

Click **⏺ Rec** in the toolbar. Everyone instantly sees a 🔴 **REC** indicator (consent/transparency).
For the actual MP4 to be written, recording uses **LiveKit Egress**, which needs storage:
add `S3_*` (S3 / Cloudflare R2 / MinIO) to `apps\api\.env` — on **LiveKit Cloud** egress is built-in, so the bucket is all that's missing. Without it, the indicator still works but no file is saved (you'll get a toast). Details in `apps/api/README.md`.

## 4. Editor (optional)

Open **http://localhost:8787/editor.html**, drag furniture / move rooms, **Save to API** (writes to SQLite).
Restart the realtime server with `set WORLD_API=http://localhost:3001 && npm start` to load the new layout.

---

## Troubleshooting

**`Environment variable not found: DATABASE_URL`** — fixed: SQLite is the default and `.env` is created. If you still see it, make sure you're in `apps\api` and ran `npm run prisma:generate` then `npm run migrate`.

**`cp` is not recognized** — that's a Unix command. In CMD use `copy`. (You don't need to copy anything now — `.env` already exists.)

**Docker errors (`npipe ... docker_engine`)** — Docker is **no longer required**. It's only for the optional local Postgres/LiveKit. Ignore unless you choose the Docker LiveKit path (then start Docker Desktop first).

**Wrong directory (`cannot find the path`)** — use full backslash paths as shown; don't prefix with `nexspace-scaffold/` if you're already inside it.

**Setting env in CMD** — `set WORLD_API=http://localhost:3001 && npm start` (not `WORLD_API=... npm start`).

**Camera/mic blocked** — open **http://localhost:8787** exactly (localhost is a secure context; a raw IP is not). Check the browser's site permissions.

**LiveKit connects but video/audio won't flow** — almost always WebRTC NAT. Use **LiveKit Cloud** (step 3) — it sidesteps local networking entirely.

**Reset the database** — delete `apps\api\prisma\dev.db`, then `npm run migrate` and `npm run seed` again.

**Port already in use** — change `PORT` in `apps\api\.env` (API) or the port in `apps\realtime\server.js` (`8787`).
