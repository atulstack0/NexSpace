import { Body, Controller, Post } from "@nestjs/common";
import { LivekitService } from "./livekit.service";

@Controller("livekit")
export class LivekitController {
  constructor(private lk: LivekitService) {}

  // POST /livekit/token  { room, identity, name }  ->  { url, token }
  @Post("token")
  token(@Body() body: { room: string; identity: string; name?: string }) {
    return this.lk.mintToken(body.room, body.identity, body.name);
  }
}
