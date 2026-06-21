/**
 * Seed the office floors — the same geometry the realtime server falls back to.
 * Run: npm run seed  (after `prisma migrate dev`). Idempotent: floors are deleted + recreated.
 *
 * Multi-floor (spec §6): a "default" ground floor and a "rooftop" garden, linked by portals.
 */
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

type Wall = { x: number; y: number; w: number; h: number };
type Furn = { x: number; y: number; w: number; h: number; r: number };
type RoomDef = { key: string; name: string; color: string; x: number; y: number; w: number; h: number;
  doorX: number; doorY: number; doorW: number; doorH: number; doorState: string };
type MediaDef = { x: number; y: number; w: number; base: number; screenH: number; title: string; dur: number };
type PortalDef = { x: number; y: number; w: number; h: number; to: string; label: string; color: string };
type WidgetDef = { type: "note" | "embed" | "timer"; x: number; y: number; config: Record<string, any> };
type FloorDef = {
  slug: string; name: string; width: number; height: number; supports3d: boolean;
  branding: { name: string; color: string; logo: string; whiteLabel: boolean };
  walls: Wall[]; furniture: Furn[]; rooms: RoomDef[]; media: MediaDef | null; portals: PortalDef[]; widgets: WidgetDef[];
};

const DEFAULT_FLOOR: FloorDef = {
  slug: "default", name: "HQ — Ground Floor", width: 2200, height: 1500, supports3d: true,
  branding: { name: "NexSpace", color: "#5b8cff", logo: "", whiteLabel: false },
  walls: [
    { x: 0, y: 0, w: 2200, h: 16 }, { x: 0, y: 1484, w: 2200, h: 16 },
    { x: 0, y: 0, w: 16, h: 1500 }, { x: 2184, y: 0, w: 16, h: 1500 },
    { x: 520, y: 120, w: 16, h: 300 }, { x: 520, y: 520, w: 16, h: 240 }, { x: 120, y: 760, w: 430, h: 16 },
    { x: 1500, y: 120, w: 16, h: 560 }, { x: 1516, y: 120, w: 300, h: 16 }, { x: 1516, y: 666, w: 300, h: 16 },
    { x: 1800, y: 120, w: 16, h: 236 }, { x: 1800, y: 452, w: 16, h: 230 },
  ],
  furniture: [
    { x: 980, y: 560, w: 240, h: 120, r: 14 }, { x: 300, y: 300, w: 150, h: 80, r: 12 },
    { x: 1600, y: 330, w: 170, h: 90, r: 12 }, { x: 900, y: 1150, w: 120, h: 120, r: 60 },
    { x: 1750, y: 1150, w: 150, h: 80, r: 12 }, { x: 250, y: 1150, w: 90, h: 90, r: 10 },
  ],
  rooms: [
    { key: "focus", name: "Focus Room", color: "#7c6bff", x: 140, y: 130, w: 380, h: 630,
      doorX: 512, doorY: 418, doorW: 18, doorH: 104, doorState: "closed" },
    { key: "board", name: "Boardroom", color: "#39d3a6", x: 1516, y: 136, w: 300, h: 546,
      doorX: 1796, doorY: 356, doorW: 18, doorH: 96, doorState: "locked" },
  ],
  media: { x: 1180, y: 980, w: 300, base: 16, screenH: 150, title: "📺 NexSpace TV — click to watch", dur: 213 },
  portals: [{ x: 2030, y: 1290, w: 96, h: 96, to: "rooftop", label: "Rooftop ↑", color: "#ffb454" }],
  widgets: [
    { type: "note", x: 360, y: 980, config: { w: 190, h: 130, text: "Welcome to NexSpace! Click the 📺 TV to watch & queue songs together, or pop up to the rooftop 🌇", color: "#ffd166" } },
    { type: "timer", x: 980, y: 300, config: { w: 180, h: 96, label: "Standup ends", endsAt: Date.now() + 30 * 60000 } },
  ],
};

const ROOFTOP_FLOOR: FloorDef = {
  slug: "rooftop", name: "Rooftop Garden", width: 1600, height: 1100, supports3d: true,
  branding: { name: "NexSpace", color: "#39d3a6", logo: "", whiteLabel: false },
  walls: [
    { x: 0, y: 0, w: 1600, h: 16 }, { x: 0, y: 1084, w: 1600, h: 16 },
    { x: 0, y: 0, w: 16, h: 1100 }, { x: 1584, y: 0, w: 16, h: 1100 },
  ],
  furniture: [
    { x: 700, y: 300, w: 200, h: 120, r: 18 },
    { x: 220, y: 760, w: 140, h: 90, r: 12 }, { x: 1240, y: 760, w: 140, h: 90, r: 12 },
  ],
  rooms: [
    { key: "cabana", name: "Cabana", color: "#39d3a6", x: 120, y: 130, w: 360, h: 360,
      doorX: 472, doorY: 290, doorW: 18, doorH: 90, doorState: "open" },
  ],
  media: { x: 660, y: 720, w: 280, base: 16, screenH: 140, title: "Sunset Set — Rooftop Radio", dur: 240 },
  portals: [{ x: 90, y: 960, w: 96, h: 96, to: "default", label: "Ground ↓", color: "#5b8cff" }],
  widgets: [
    { type: "note", x: 1180, y: 250, config: { w: 190, h: 120, text: "Rooftop vibes ☕ — grab a seat by the cabana", color: "#39d3a6" } },
  ],
};

async function seedFloor(def: FloorDef) {
  await prisma.floor.deleteMany({ where: { slug: def.slug } }); // idempotent reseed (cascades)
  const floor = await prisma.floor.create({
    data: { slug: def.slug, name: def.name, width: def.width, height: def.height,
      environment: "indoor", supports3d: def.supports3d, branding: JSON.stringify(def.branding) },
  });
  for (const r of def.rooms) await prisma.room.create({ data: { floorId: floor.id, ...r, audioMode: "room" } });
  for (const w of def.walls)
    await prisma.placedObject.create({ data: { floorId: floor.id, type: "wall", x: w.x, y: w.y, collidable: true, config: JSON.stringify({ w: w.w, h: w.h }) } });
  for (const f of def.furniture)
    await prisma.placedObject.create({ data: { floorId: floor.id, type: "furniture", x: f.x, y: f.y, collidable: true, config: JSON.stringify({ w: f.w, h: f.h, r: f.r }) } });
  if (def.media)
    await prisma.placedObject.create({ data: { floorId: floor.id, type: "mediaWall", x: def.media.x, y: def.media.y, collidable: true,
      config: JSON.stringify({ w: def.media.w, base: def.media.base, screenH: def.media.screenH, title: def.media.title, dur: def.media.dur }) } });
  for (const pt of def.portals)
    await prisma.placedObject.create({ data: { floorId: floor.id, type: "portal", x: pt.x, y: pt.y, collidable: false,
      config: JSON.stringify({ w: pt.w, h: pt.h, to: pt.to, label: pt.label, color: pt.color }) } });
  for (const wd of def.widgets)
    await prisma.placedObject.create({ data: { floorId: floor.id, type: wd.type, x: wd.x, y: wd.y, collidable: false, config: JSON.stringify(wd.config) } });
  console.log(`Seeded floor '${def.slug}' — ${def.rooms.length} room(s), ${def.walls.length + def.furniture.length} obstacle(s), ${def.portals.length} portal(s), ${def.widgets.length} widget(s)${def.media ? " + media wall" : ""}.`);
}

async function main() {
  await seedFloor(DEFAULT_FLOOR);
  await seedFloor(ROOFTOP_FLOOR);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
