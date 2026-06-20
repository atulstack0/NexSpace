# Deploying NexSpace live (free)

The realtime server (`apps/realtime/server.js`) serves the web client **and** the multiplayer
WebSocket office. The whole office — multi-floor, portals, interactive widgets, chat, proximity
audio, 2D/3D — is built into that server, so you can go live with **one free web service and no
database**. Guests just open the URL, type a name, and they're in.

---

## Option A — Fastest free live demo (recommended)

One free web service on **Render**. ~5 minutes, no credit card.

1. **Push the repo** (already on GitHub at `atulstack0/NexSpace`), including `render.yaml`.
2. Go to **https://render.com** → sign up with GitHub (free).
3. **New ▸ Blueprint** → select the **NexSpace** repo → Render reads `render.yaml` → **Apply**.
   *Manual alternative:* New ▸ Web Service → pick the repo →
   - **Root Directory:** `nexspace-scaffold`
   - **Build Command:** `npm install`
   - **Start Command:** `node apps/realtime/server.js`
   - **Instance Type:** Free → **Create Web Service**
4. Wait ~2–3 min for the build. You'll get a URL like `https://nexspace-xxxx.onrender.com`.
5. **Share that URL.** Anyone can open it, enter a name, and join. Open it in two tabs or on two
   devices to see avatars move, chat, portals, and the rooftop floor in real time.

### What works in Option A
Movement, 2D/3D, proximity + room + broadcast **synth** audio, rooms/doors/knock, media wall,
multi-floor + portals, interactive widgets (notes / YouTube embed / timer), reactions, nudge,
whiteboard, chat (nearby/floor/#channels/DMs), minimap, analytics endpoint.

### Known free-tier caveats (tell your client up front)
- **Cold start:** the free service sleeps after ~15 min idle; the next visit takes ~1 min to wake.
  Open the URL a minute before a demo to pre-warm it.
- **Single instance:** presence is in-memory (no Redis) — perfect for a demo group; fine up to the
  connection cap (`MAX_CLIENTS`, default 200).
- **Voice/video is synthesized** (no real mic/cam) unless you configure LiveKit (see README).
- **Guest-only / no login:** roles (admin/member/owner) need the API — that's Option B.

---

## Option B — Full stack (adds real logins, the editor's Save, persistence)

Adds the NestJS API + a database. More setup, and it needs one small code change because the web
client currently hardcodes the API origin (`location.hostname:3001`).

1. Make `API_BASE` in `apps/web/index.html` / `editor.html` configurable (env-injected or same-origin
   path) instead of `:3001`. *(Ask and I'll implement this.)*
2. Deploy a **second** Render web service for the API:
   - Root Directory `nexspace-scaffold`
   - Build: `npm install && npm --workspace @nexspace/api run build`
   - Start: `node apps/api/dist/main.js`
   - Add a database: Render free **PostgreSQL** (set `DATABASE_URL`, switch Prisma provider to
     `postgresql`), or keep SQLite (note: the file resets on each deploy).
   - Run the migration + seed once (Render Shell or a one-off job).
3. On the realtime service, set `WORLD_API` to the API service's URL so it loads floors from the DB.

---

## Other free hosts (if Render's limits don't suit you)
- **Koyeb** — free "nano" instance, supports WebSockets, tends not to sleep. Same build/start commands.
- **Fly.io** — supports WebSockets but **no free tier for new accounts** (credit card required).
- **Vercel / Netlify** — *not suitable*: they run serverless functions and don't support the
  persistent WebSocket connection this app needs.

A pre-warm trick for any sleeping free tier: a free uptime monitor that pings the URL every ~10 min.
