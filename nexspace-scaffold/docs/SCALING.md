# NexSpace Scaling — Multi-node fan-out (spec §4 / §8)

The realtime server runs **single-process by default**. Set `REDIS_URL` and you can run
**many instances behind a load balancer**, sharing state over Redis pub/sub.

## How it works

Each node:
- owns its own WebSocket connections + local player state;
- **publishes** its local players to `nexspace:presence` every 250 ms and **subscribes** to it,
  keeping a map of *remote* players from other nodes (expired after 3 s of silence);
- builds each client snapshot as **local players + remote players**, so a user on node A
  sees and hears users on node B;
- **publishes** shared-state changes (door open/close/lock, media play/pause, recording
  on/off, admin world-reload) to `nexspace:event`; every node applies them, so the office
  stays consistent across instances.

```
   Browser ─┐                       ┌─ Browser
   (node A) │   load balancer (WS)  │  (node B)
            ▼                       ▼
        node A  ◀── Redis pub/sub ──▶  node B
        presence: nexspace:presence
        events:   nexspace:event
```

## Run two nodes locally (no Docker required)

You **don't have to** run this locally — the `redis-multinode` CI job starts Redis and verifies
multi-node behavior on every push. But to see it on your machine, you just need a Redis server.
Pick one:

**A. Redis in WSL (recommended — no Docker):**
```bash
# in WSL/Ubuntu
sudo apt-get update && sudo apt-get install -y redis-server
sudo service redis-server start      # or: redis-server --daemonize yes
redis-cli ping                       # → PONG
```
A `redis-server` in WSL is reachable from Windows at `localhost:6379` (WSL2 localhost forwarding).

**B. Hosted Redis (zero install):** create a free DB at https://upstash.com (or any Redis host) and use its URL.

**C. Memurai (native Windows Redis):** https://www.memurai.com

Then start two instances pointing at it (PowerShell):
```powershell
# REDIS_URL = redis://localhost:6379 (A/C) or your hosted rediss://… URL (B)
cd nexspace-scaffold\apps\realtime; $env:REDIS_URL="redis://localhost:6379"; $env:PORT="8901"; npm start
# new window:
cd nexspace-scaffold\apps\realtime; $env:REDIS_URL="redis://localhost:6379"; $env:PORT="8902"; npm start
```

Open one office tab on `:8901` and another on `:8902` — you'll see each other across nodes.

> If `docker run … redis` fails with `docker_engine ... cannot find the file`, Docker Desktop just
> isn't running — use option A or B instead; Docker is not required.

## Tested in CI

The **`redis-multinode`** GitHub Actions job starts a Redis service and runs
`npm run test:redis`, which spawns two nodes and asserts cross-node presence and that a
door opened on one node propagates to the other. (`npm run check` stays Redis-free.)

## Deliberate limits / follow-ups

- **Shared state is sync-on-change**, not persisted: a node that boots mid-session learns
  door/media state only from the next change. Next step: keep authoritative shared state in
  Redis keys and load it on boot.
- **Interest management**: snapshots currently include everyone on the floor. For very large
  floors (1,000+), add spatial-hash interest management so each client only receives nearby
  peers (the world model already supports it — it's a filtering layer on the snapshot).
- **Sticky sessions**: WebSocket load balancing should be sticky per connection; cross-node
  state is handled by Redis, but each socket stays on one node.
- LiveKit (media) is already multi-node by design — one SFU room per floor regardless of which
  realtime node a client is on.
