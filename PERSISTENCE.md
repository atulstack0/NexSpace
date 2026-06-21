# Persisting owner floor edits (free, durable)

Owner/admin edits in the in-office editor (move/add/delete furniture, notes, timers, portals, TV
position) are saved automatically. Where they're saved depends on configuration:

- **Locally** → a JSON file (`apps/realtime/floors-data.json`). Just works, survives process restarts.
- **On Render free** → the filesystem resets on every redeploy/spin-down, so the file isn't durable
  there. To survive redeploys, point the server at a free **Upstash Redis** via `PERSIST_REDIS_URL`.
- **If `WORLD_API` is set** → persistence is off (the API's database is the source of truth instead).

> ⚠️ Use **`PERSIST_REDIS_URL`**, not `REDIS_URL`. `REDIS_URL` enables the multi-node presence fan-out,
> which publishes every 250 ms (~10M commands/month) and would blow Upstash's free quota in hours.
> `PERSIST_REDIS_URL` only does a couple of writes per edit + one read on boot — easily within free limits.

---

## Set up Upstash Redis (free, no credit card)

Free tier: 256 MB, **500K commands/month** — far more than edit persistence needs. Works with the
standard Redis protocol (the server uses `ioredis`).

1. Sign up at **https://upstash.com** (GitHub login, no card).
2. **Console → Redis → Create Database**. Give it a name, pick a **region near your Render service**,
   leave it on the free plan → Create.
3. On the database page, open the **Connect** panel and copy the **Node / `ioredis`** connection string.
   It looks like:
   ```
   rediss://default:<LONG_TOKEN>@<your-db>.upstash.io:6379
   ```
   (You can also build it from the **Endpoint** + **Password** shown on the page — note the double-s `rediss://` for TLS.)
4. On **Render → your `nexspace` service → Environment**, add:
   ```
   PERSIST_REDIS_URL=rediss://default:<LONG_TOKEN>@<your-db>.upstash.io:6379
   ```
   Leave `REDIS_URL` **unset**. Save → it redeploys.
5. After it boots, the log shows **"Durable edit persistence via PERSIST_REDIS_URL"**.

Now make some edits as owner — they'll survive redeploys and spin-downs. To verify: edit the floor,
trigger a redeploy (or wait for a spin-down + revisit), and your changes are still there.

## Resetting
To wipe saved edits back to the built-in layout, delete the `nexspace:floors` key in the Upstash
console (Data Browser), or remove `PERSIST_REDIS_URL` and redeploy.
