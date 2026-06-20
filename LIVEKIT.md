# Setting up LiveKit (real voice / video / screen share / recording)

LiveKit is already integrated: the API mints access tokens (`POST /livekit/token` via
`livekit-server-sdk`) and the web client connects to the LiveKit server URL the API returns. You
only need to give the **API** three credentials. Until then, the app falls back to synthesized audio
("LiveKit not configured (LIVEKIT_URL unset)" in the API log).

How it flows: client → `API_BASE/livekit/token {room, identity}` → `{ url, token }` → the client
calls `room.connect(url, token)`. Proximity track culling subscribes only to nearby peers.

---

## Option 1 — LiveKit Cloud (recommended, free)

The free **Build** plan covers demos (≈5,000 WebRTC min + 50 GB egress / month).

1. Sign up at **https://cloud.livekit.io** and create a project.
2. In the project's **Settings → Keys**, copy three values:
   - **Project URL** → `wss://YOUR-PROJECT.livekit.cloud`
   - **API Key** → `API...`
   - **API Secret** → the long secret
3. Put them in `nexspace-scaffold/apps/api/.env` (uncomment the lines that are already there):

   ```env
   LIVEKIT_URL="wss://YOUR-PROJECT.livekit.cloud"
   LIVEKIT_API_KEY="APIxxxxxxxx"
   LIVEKIT_API_SECRET="your-secret"
   ```
4. Restart the API (`npm run dev` in `apps/api`). The log should no longer say "LiveKit not configured".
5. In the office, click **🎤 / 🎥 / 🖥️ Share**. Allow the browser's mic/cam permission. Open a second
   tab/device to see and hear each other (volume follows proximity).

---

## Option 2 — Self-host a dev server (fully local, no account)

1. Install LiveKit server (see https://docs.livekit.io/home/self-hosting/local/), then run:

   ```bash
   livekit-server --dev
   ```

   Dev mode uses fixed credentials: key `devkey`, secret `secret`, URL `ws://localhost:7880`.
2. Put those in `apps/api/.env`:

   ```env
   LIVEKIT_URL="ws://localhost:7880"
   LIVEKIT_API_KEY="devkey"
   LIVEKIT_API_SECRET="secret"
   ```
3. Restart the API. (Note: `ws://` works only over `http://localhost`; a deployed HTTPS site needs a
   `wss://` server — use Option 1 for anything public.)

---

## Recording (LiveKit Egress → file)

The 🔴 **Rec** button always shows the shared recording indicator. To actually capture an `.mp4`:

- **LiveKit Cloud** already runs the egress worker — you only need an **S3-compatible bucket** for the
  output (AWS S3, Cloudflare R2, Backblaze B2, MinIO…). Fill the `S3_*` lines in `.env` and restart.
- **Self-hosted** additionally needs a running egress worker container.

Without storage, recording still lights the indicator for everyone but won't save a file.

---

## Using LiveKit on a deployed (live) site

Real media needs the **API reachable from the browser over HTTPS**, and the LiveKit URL must be
`wss://` (so use LiveKit Cloud). That means the public deploy must include the API — i.e. "Option B"
in `DEPLOY.md` (deploy the API + make the client's `API_BASE` configurable instead of hardcoded
`:3001`). The realtime-only free deploy can't do real voice/video because the browser can't reach an
API. Ask and I'll wire `API_BASE` up so the full stack (with LiveKit) can go live.
