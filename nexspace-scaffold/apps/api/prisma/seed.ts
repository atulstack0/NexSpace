/**
 * Seed the "default" office floor — the same geometry the realtime server
 * used to hardcode. Run: npm run seed  (after `prisma migrate dev`).
 */
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const WALLS = [
  { x: 0, y: 0, w: 2200, h: 16 }, { x: 0, y: 1484, w: 2200, h: 16 },
  { x: 0, y: 0, w: 16, h: 1500 }, { x: 2184, y: 0, w: 16, h: 1500 },
  { x: 520, y: 120, w: 16, h: 300 }, { x: 520, y: 520, w: 16, h: 240 }, { x: 120, y: 760, w: 430, h: 16 },
  { x: 1500, y: 120, w: 16, h: 560 }, { x: 1516, y: 120, w: 300, h: 16 }, { x: 1516, y: 666, w: 300, h: 16 },
  { x: 1800, y: 120, w: 16, h: 236 }, { x: 1800, y: 452, w: 16, h: 230 },
];
const FURNITURE = [
  { x: 980, y: 560, w: 240, h: 120, r: 14 }, { x: 300, y: 300, w: 150, h: 80, r: 12 },
  { x: 1600, y: 330, w: 170, h: 90, r: 12 }, { x: 900, y: 1150, w: 120, h: 120, r: 60 },
  { x: 1750, y: 1150, w: 150, h: 80, r: 12 }, { x: 250, y: 1150, w: 90, h: 90, r: 10 },
];
const ROOMS = [
  { key: "focus", name: "Focus Room", color: "#7c6bff", x: 140, y: 130, w: 380, h: 630,
    doorX: 512, doorY: 418, doorW: 18, doorH: 104, doorState: "closed" },
  { key: "board", name: "Boardroom", color: "#39d3a6", x: 1516, y: 136, w: 300, h: 546,
    doorX: 1796, doorY: 356, doorW: 18, doorH: 96, doorState: "locked" },
];
const MEDIA_WALL = { x: 1180, y: 980, w: 300, base: 16, screenH: 150, title: "Lo-fi Beats — Focus Radio", dur: 213 };

async function main() {
  await prisma.floor.deleteMany({ where: { slug: "default" } }); // idempotent reseed (cascades)
  const floor = await prisma.floor.create({
    data: { slug: "default", name: "HQ — Ground Floor", width: 2200, height: 1500, environment: "indoor", supports3d: true },
  });

  for (const r of ROOMS) await prisma.room.create({ data: { floorId: floor.id, ...r, audioMode: "room" } });

  for (const w of WALLS)
    await prisma.placedObject.create({ data: { floorId: floor.id, type: "wall", x: w.x, y: w.y, collidable: true, config: { w: w.w, h: w.h } } });
  for (const f of FURNITURE)
    await prisma.placedObject.create({ data: { floorId: floor.id, type: "furniture", x: f.x, y: f.y, collidable: true, config: { w: f.w, h: f.h, r: f.r } } });

  await prisma.placedObject.create({
    data: { floorId: floor.id, type: "mediaWall", x: MEDIA_WALL.x, y: MEDIA_WALL.y, collidable: true,
      config: { w: MEDIA_WALL.w, base: MEDIA_WALL.base, screenH: MEDIA_WALL.screenH, title: MEDIA_WALL.title, dur: MEDIA_WALL.dur } },
  });

  console.log("Seeded floor 'default' with", ROOMS.length, "rooms,", WALLS.length + FURNITURE.length, "obstacles + media wall.");
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
