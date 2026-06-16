import { Module } from "@nestjs/common";
import { PrismaService } from "./prisma.service";
import { WorldModule } from "./world/world.module";
import { LivekitModule } from "./livekit/livekit.module";

@Module({
  imports: [WorldModule, LivekitModule],
  providers: [PrismaService],
})
export class AppModule {}
