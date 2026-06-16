import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors(); // realtime server + web client call this in dev
  const port = process.env.PORT || 3001;
  await app.listen(port);
  console.log(`NexSpace API on http://localhost:${port}  (try GET /floors/default/world)`);
}
bootstrap();
