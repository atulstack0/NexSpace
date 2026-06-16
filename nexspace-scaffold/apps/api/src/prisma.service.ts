import { Injectable, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  async onModuleInit() {
    // Don't crash the whole API if the DB isn't ready — LiveKit token minting
    // and the realtime server (built-in geometry fallback) keep working.
    try {
      await this.$connect();
    } catch (e: any) {
      console.error(
        "[prisma] Could not connect to the database — /floors endpoints will error until it's ready.\n" +
        "         Run `npm run migrate` then `npm run seed`. (LiveKit + realtime still work.)\n" +
        "         Details: " + (e?.message || e),
      );
    }
  }
}
