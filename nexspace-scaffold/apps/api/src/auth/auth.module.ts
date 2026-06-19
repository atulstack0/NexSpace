import { Module } from "@nestjs/common";
import { AuthController } from "./auth.controller";
import { SsoController } from "./sso.controller";
import { AuthService } from "./auth.service";

@Module({
  controllers: [AuthController, SsoController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
