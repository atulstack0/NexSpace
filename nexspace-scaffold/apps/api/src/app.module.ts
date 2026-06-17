import { Module } from "@nestjs/common";
import { PrismaService } from "./prisma.service";
import { AppController } from "./app.controller";
import { WorldModule } from "./world/world.module";
import { LivekitModule } from "./livekit/livekit.module";
import { AuthModule } from "./auth/auth.module";

@Module({
  imports: [WorldModule, LivekitModule, AuthModule],
  controllers: [AppController],
  providers: [PrismaService],
})
export class AppModule {}
