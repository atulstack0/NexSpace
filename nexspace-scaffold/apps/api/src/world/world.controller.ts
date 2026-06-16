import { Body, Controller, Get, Param, Put } from "@nestjs/common";
import { WorldService } from "./world.service";

@Controller("floors")
export class WorldController {
  constructor(private world: WorldService) {}

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

  // PUT /floors/default/layout  -> persist an edited layout (spec §6.10)
  @Put(":slug/layout")
  saveLayout(@Param("slug") slug: string, @Body() body: { objects?: any[]; rooms?: any[] }) {
    return this.world.saveLayout(slug, body);
  }
}
