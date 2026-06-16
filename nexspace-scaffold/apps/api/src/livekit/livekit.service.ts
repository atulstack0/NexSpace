import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { AccessToken } from "livekit-server-sdk";

/**
 * Mints short-lived LiveKit access tokens (spec §3 "Media SFU").
 * Configure via env: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET.
 * Run a local SFU with:  livekit-server --dev   (key/secret: devkey / secret)
 * or use LiveKit Cloud.
 */
@Injectable()
export class LivekitService {
  isConfigured() {
    return !!(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);
  }

  async mintToken(room: string, identity: string, name?: string) {
    if (!this.isConfigured()) throw new ServiceUnavailableException("LiveKit not configured");
    const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
      identity,
      name: name || identity,
      ttl: "2h",
    });
    at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true });
    return { url: process.env.LIVEKIT_URL, token: await at.toJwt() };
  }
}
