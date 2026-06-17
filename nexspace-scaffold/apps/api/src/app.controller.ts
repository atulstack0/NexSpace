import { Controller, Get } from "@nestjs/common";

// Friendly index so hitting the API root isn't a bare 404.
// (The office UI is the realtime server at http://localhost:8787 — this is just the API.)
@Controller()
export class AppController {
  @Get()
  index() {
    return {
      name: "NexSpace API",
      status: "ok",
      note: "This is the API (port 3001). The office UI is the realtime server at http://localhost:8787",
      endpoints: [
        "GET  /health",
        "GET  /floors/default/world",
        "GET  /floors/:slug",
        "PUT  /floors/:slug/layout   (admin token required)",
        "POST /auth/login",
        "POST /livekit/token",
        "POST /livekit/egress/start | /livekit/egress/stop",
      ],
    };
  }

  @Get("health")
  health() {
    return { ok: true };
  }
}
