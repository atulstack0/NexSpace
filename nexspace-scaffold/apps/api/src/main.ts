import "dotenv/config";                 // load apps/api/.env if present
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

// Sensible default so the API never crashes on a missing DATABASE_URL.
// SQLite file lives next to the Prisma schema (apps/api/prisma/dev.db).
if (!process.env.DATABASE_URL) process.env.DATABASE_URL = "file:./dev.db";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors(); // realtime server + web client call this in dev
  const port = process.env.PORT || 3001;
  await app.listen(port);
  console.log(`NexSpace API on http://localhost:${port}  (try GET /floors/default/world)`);
  if (!process.env.LIVEKIT_URL) {
    console.log("LiveKit not configured (LIVEKIT_URL unset) — clients fall back to synth audio. See apps/api/README.md for real voice/video.");
  }
}
bootstrap();
