# NexSpace Public API + Webhooks (spec §6.18)

Served by the **realtime server** (it owns live presence and the join/leave events).
Base URL in dev: `http://localhost:8787`.

> In production this would sit behind the API gateway with presence shared via Redis;
> here it lives on the realtime process so it's fully local and CI-testable.

## Auth

All `/api/v1/*` endpoints require an API key header:

```
X-API-Key: <PUBLIC_API_KEY>
```

Dev default: `nexspace-demo-key` (override with the `PUBLIC_API_KEY` env var on the realtime server).
Missing/invalid key → `401`.

## Endpoints

| Method | Path | Returns |
|---|---|---|
| GET | `/api/v1/health` | `{ ok, online }` |
| GET | `/api/v1/presence` | `{ online, users: [{ id, name, role, status, x, y, room }] }` |
| GET | `/api/v1/floor` | `{ width, height, rooms:[{id,name}], objects, mediaWall:{title,playing} }` |

Example:

```bash
curl -H "X-API-Key: nexspace-demo-key" http://localhost:8787/api/v1/presence
```

## Webhooks

Set `WEBHOOK_URL` on the realtime server (e.g. `$env:WEBHOOK_URL="https://example.com/hook"`).
The server POSTs JSON on events:

```jsonc
// POST <WEBHOOK_URL>
{ "event": "user.joined", "data": { "id": "u3", "name": "Ada", "role": "admin" }, "ts": 1718550000000 }
{ "event": "user.left",   "data": { "id": "u3", "name": "Ada" },                  "ts": 1718550012000 }
```

Headers:

```
X-NexSpace-Event: user.joined
X-NexSpace-Signature: <hex HMAC-SHA256(rawBody, PUBLIC_API_KEY)>
```

**Verify the signature** (Node):

```js
import crypto from "node:crypto";
const expected = crypto.createHmac("sha256", PUBLIC_API_KEY).update(rawBody).digest("hex");
const valid = expected === req.headers["x-nexspace-signature"];
```

## Run with the public API + webhooks enabled

```cmd
:: apps/realtime  (PowerShell)
$env:WORLD_API="http://localhost:3001"; $env:WEBHOOK_URL="http://localhost:9000/hook"; npm start
```

## Tested in CI

`npm run check` asserts: presence requires the key (200 with, 401 without) and a
`user.joined` webhook fires with a valid HMAC signature.

## Production follow-ups

- Per-tenant API keys + scopes/rate limits; rotate via the API.
- Multiple webhook subscriptions with retries/backoff and a delivery log.
- More events (`room.entered`, `recording.started`, `door.locked`), and OpenAPI docs.
