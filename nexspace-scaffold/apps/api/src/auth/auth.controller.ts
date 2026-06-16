import { Body, Controller, Post } from "@nestjs/common";
import { AuthService } from "./auth.service";

@Controller("auth")
export class AuthController {
  constructor(private auth: AuthService) {}

  // POST /auth/login  { email, password }  ->  { token, user:{id,name,role} }
  // Demo logins: admin@nexspace.dev / admin1234  ·  member@nexspace.dev / member1234
  @Post("login")
  login(@Body() body: { email: string; password: string }) {
    return this.auth.login(body.email, body.password);
  }
}
