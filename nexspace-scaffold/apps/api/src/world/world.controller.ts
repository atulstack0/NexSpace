import { Body, Controller, ForbiddenException, Get, Headers, Param, Put } from "@nestjs/common";
import { WorldService } from "./world.service";
import { AuthService } from "../auth/auth.service";

@Controller("floors")
export class WorldController {
  constructor(private world: WorldService, private auth: AuthService) {}

  // GET /floors/default/world  -> WorldBlob consumed by the realtime server + clients
  @Get(":slug/world")
  getWorld(@Param("slug") slug: string) {
    return this.world.getWorld(slug);
  }

  // GET /floors/default  -> raw rooms + typed objects, for the editor
  @Get(":slug")
  getRaw(@Param("slug") slug: string) {
    return this.world.getFloorRaw(slug);
  }

  // PUT /floors/default/layout  -> persist an edited layout (spec §6.10). Admin+ only (§6.14).
  @Put(":slug/layout")
  saveLayout(@Param("slug") slug: string, @Body() body: { objects?: any[]; rooms?: any[]; branding?: any }, @Headers("authorization") authz?: string) {
    const u = this.auth.verify(authz);
    if (!u || this.auth.rank(u.role) < this.auth.rank("admin")) {
      throw new ForbiddenException("Admin role required to save layouts");
    }
    return this.world.saveLayout(slug, body);
  }
}
