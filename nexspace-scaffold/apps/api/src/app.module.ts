import { Module } from "@nestjs/common";
import { PrismaService } from "./prisma.service";
import { WorldModule } from "./world/world.module";
import { LivekitModule } from "./livekit/livekit.module";
import { AuthModule } from "./auth/auth.module";

@Module({
  imports: [WorldModule, LivekitModule, AuthModule],
  providers: [PrismaService],
})
export class AppModule {}
