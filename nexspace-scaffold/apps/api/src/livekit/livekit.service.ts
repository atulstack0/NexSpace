import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { AccessToken, EgressClient, EncodedFileOutput, EncodedFileType, S3Upload } from "livekit-server-sdk";

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

  // ---- Recording via LiveKit Egress (spec 6.17) ----
  private egress() {
    const host = (process.env.LIVEKIT_URL || "").replace("wss://", "https://").replace("ws://", "http://");
    return new EgressClient(host, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
  }

  async startRecording(room: string) {
    if (!this.isConfigured()) throw new ServiceUnavailableException("LiveKit not configured");
    const filepath = `${room.replace(/[^a-zA-Z0-9_-]/g, "_")}-${Date.now()}.mp4`;
    const file = new EncodedFileOutput({ fileType: EncodedFileType.MP4, filepath });
    // Where the file lands: S3-compatible storage if configured (required for LiveKit Cloud);
    // otherwise the egress worker's local/mounted disk (self-hosted egress).
    if (process.env.S3_BUCKET) {
      file.output = {
        case: "s3",
        value: new S3Upload({
          accessKey: process.env.S3_ACCESS_KEY,
          secret: process.env.S3_SECRET,
          bucket: process.env.S3_BUCKET,
          region: process.env.S3_REGION || "auto",
          endpoint: process.env.S3_ENDPOINT,
          forcePathStyle: true,
        }),
      };
    }
    try {
      const info = await this.egress().startRoomCompositeEgress(room, { file }, { layout: "grid" });
      return { egressId: info.egressId, filepath };
    } catch (e: any) {
      throw new ServiceUnavailableException(
        "Egress start failed — needs a running egress backend + storage (LiveKit Cloud has egress built-in; configure S3_* for output). " + (e?.message || e),
      );
    }
  }

  async stopRecording(egressId: string) {
    try {
      const info = await this.egress().stopEgress(egressId);
      return { egressId, status: info.status };
    } catch (e: any) {
      throw new ServiceUnavailableException("Egress stop failed: " + (e?.message || e));
    }
  }
}
