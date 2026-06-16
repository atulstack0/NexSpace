import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma.service";

/**
 * Composes the WorldBlob the realtime server + web client expect
 * (see packages/shared/types.ts -> WorldBlob) from persisted rows.
 */
@Injectable()
export class WorldService {
  constructor(private prisma: PrismaService) {}

  async getWorld(slug: string) {
    const floor = await this.prisma.floor.findUnique({
      where: { slug },
      include: { rooms: true, objects: true },
    });
    if (!floor) throw new NotFoundException(`Floor '${slug}' not found — did you run the seed?`);

    const collidable = floor.objects.filter((o) => o.collidable && (o.type === "wall" || o.type === "furniture"));
    const obstacles = collidable.map((o) => {
      const c = o.config as any;
      const rect: any = { x: o.x, y: o.y, w: c.w, h: c.h };
      if (c.r != null) rect.r = c.r;
      return rect;
    });

    const mw = floor.objects.find((o) => o.type === "mediaWall");
    const mwc = (mw?.config as any) ?? {};
    const mediaWall = mw
      ? { x: mw.x, y: mw.y, w: mwc.w, base: mwc.base, screenH: mwc.screenH, title: mwc.title, dur: mwc.dur }
      : null;
    // the media-wall stand is also a physical obstacle
    if (mw) obstacles.push({ x: mw.x, y: mw.y, w: mwc.w, h: mwc.base });

    const rooms = floor.rooms.map((r) => ({
      id: r.key,
      name: r.name,
      color: r.color,
      bounds: { x: r.x, y: r.y, w: r.w, h: r.h },
      door: { x: r.doorX, y: r.doorY, w: r.doorW, h: r.doorH, state: r.doorState },
    }));

    return { w: floor.width, h: floor.height, environment: floor.environment, supports3d: floor.supports3d, obstacles, rooms, mediaWall };
  }

  /** Raw floor (rooms + typed objects) for the editor to load and round-trip. */
  async getFloorRaw(slug: string) {
    const floor = await this.prisma.floor.findUnique({ where: { slug }, include: { rooms: true, objects: true } });
    if (!floor) throw new NotFoundException(`Floor '${slug}' not found`);
    return floor;
  }

  /**
   * Persist an edited layout (spec §6.10). Transactional: replace this floor's
   * placed objects, and update existing rooms in place (by stable key).
   */
  async saveLayout(slug: string, body: { objects?: any[]; rooms?: any[] }) {
    const floor = await this.prisma.floor.findUnique({ where: { slug } });
    if (!floor) throw new NotFoundException(`Floor '${slug}' not found`);

    await this.prisma.$transaction(async (tx) => {
      await tx.placedObject.deleteMany({ where: { floorId: floor.id } });
      for (const o of body.objects ?? []) {
        await tx.placedObject.create({
          data: {
            floorId: floor.id,
            type: String(o.type || "furniture"),
            x: Number(o.x) || 0,
            y: Number(o.y) || 0,
            z: Number(o.z) || 0,
            rotation: Number(o.rotation) || 0,
            scale: Number(o.scale) || 1,
            collidable: o.collidable !== false,
            config: o.config ?? {},
          },
        });
      }
      for (const r of body.rooms ?? []) {
        if (!r.key) continue;
        await tx.room.update({
          where: { floorId_key: { floorId: floor.id, key: r.key } },
          data: {
            name: r.name, color: r.color,
            x: Number(r.x), y: Number(r.y), w: Number(r.w), h: Number(r.h),
            doorX: Number(r.doorX), doorY: Number(r.doorY), doorW: Number(r.doorW), doorH: Number(r.doorH),
            doorState: r.doorState ?? "closed", audioMode: r.audioMode ?? "room",
          },
        });
      }
    });
    return { ok: true, objects: (body.objects ?? []).length, rooms: (body.rooms ?? []).length };
  }
}
