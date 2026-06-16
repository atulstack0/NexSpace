import { Module } from "@nestjs/common";
import { WorldController } from "./world.controller";
import { WorldService } from "./world.service";
import { PrismaService } from "../prisma.service";

@Module({
  controllers: [WorldController],
  providers: [WorldService, PrismaService],
})
export class WorldModule {}
