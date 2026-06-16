/**
 * NexSpace — canonical shared types (spec §5).
 *
 * This is the single source of truth for world state and the realtime wire
 * protocol. Both the realtime server and the web client should depend on this
 * package so the (x, y, z) contract stays view-agnostic (spec §4.2).
 *
 * NOTE: The runnable demo in apps/ uses plain JS to stay zero-build, but these
 * types are the schema it implements — port them in when you add a TS build.
 */

// ---------- Geometry ----------
export interface Vec3 { x: number; y: number; z: number; }

// ---------- Identity ----------
export interface User {
  id: string;
  displayName: string;
  isGuest: boolean;
  avatarConfig?: { hue?: number; image?: string; accessory?: string };
}

// ---------- World (persistent; PostgreSQL in production) ----------
export interface Floor {
  id: string;
  name: string;
  width: number;
  height: number;
  environment: "indoor" | "outdoor";
  supports3d: boolean;
}

export interface Room {
  id: string;
  floorId: string;
  name: string;
  bounds: { x: number; y: number; w: number; h: number };
  height?: number;                       // wall height for 3D
  hasDoor: boolean;
  doorState: "open" | "closed" | "locked";
  audioMode: "room" | "broadcast";
}

export type ObjectType =
  | "chair" | "table" | "plant" | "mediaWall" | "portal" | "whiteboard" | "sign";

export interface PlacedObject {
  id: string;
  floorId: string;
  type: ObjectType;
  position: Vec3;
  rotation: Vec3;
  scale: number;
  config: Record<string, unknown>;
  collidable: boolean;
}

// ---------- Live / ephemeral (Redis in production) ----------
export type PresenceStatus = "available" | "away" | "busy" | "dnd" | "inMeeting";
export type AudioRadius = "quiet" | "normal" | "megaphone";

export interface PresenceState {
  userId: string;
  floorId: string;
  position: Vec3;
  facing: number;                        // heading in radians (3D avatar orientation)
  roomId?: string;
  status: PresenceStatus;
  mediaState: { camOn: boolean; micOn: boolean; screenSharing: boolean };
  audioRadius: AudioRadius;
  talking: boolean;
}

// ====================================================================
// Realtime wire protocol (WebSocket). Tick-based snapshots at ~15 Hz.
// ====================================================================

export type DoorState = "open" | "closed" | "locked";

/** Static geometry sent once in `welcome` (authoritative; from the API/DB in prod). */
export interface WorldBlob {
  w: number;
  h: number;
  obstacles: Array<{ x: number; y: number; w: number; h: number; r?: number }>;
  rooms: Array<{ id: string; name: string; color: string;
    bounds: { x: number; y: number; w: number; h: number };
    door: { x: number; y: number; w: number; h: number; state?: DoorState } }>;
  mediaWall: { x: number; y: number; w: number; base: number; screenH: number; title: string; dur: number };
}

// ---- Client → Server ----
export interface JoinMsg      { t: "join"; name: string; talking?: boolean; }
export interface MoveMsg      { t: "move"; x: number; y: number; facing?: number; }
export interface StateMsg     { t: "state"; status?: PresenceStatus; talking?: boolean; }
export interface BroadcastMsg { t: "broadcast"; on: boolean; }              // talk floor-wide (spec 6.5)
export interface MediaMsg     { t: "media"; playing: boolean; }            // shared media wall play/pause (6.22)
export interface DoorMsg      { t: "door"; roomId: string; state: DoorState; } // occupant opens/closes (6.4)
export interface KnockMsg     { t: "knock"; roomId: string; }              // request entry; occupant admits (6.4)
export interface RecordingMsg { t: "recording"; on: boolean; egressId?: string; } // start/stop room recording (6.17)
export type ClientMsg = JoinMsg | MoveMsg | StateMsg | BroadcastMsg | MediaMsg | DoorMsg | KnockMsg | RecordingMsg;

// ---- Server → Client ----
export interface PlayerSnapshot {
  id: string;
  name: string;
  x: number;
  y: number;
  facing: number;
  status: PresenceStatus;
  talking: boolean;
  bcast: boolean;          // broadcasting to the whole floor
}
export interface WelcomeMsg  { t: "welcome"; id: string; world: WorldBlob; you: PlayerSnapshot; }
export interface SnapshotMsg {
  t: "snapshot";
  players: PlayerSnapshot[];
  doors: Record<string, DoorState>;          // roomId -> state
  media: { playing: boolean; pos: number };  // shared media-wall playback (synced)
  recording: { on: boolean; by: string | null; egressId?: string | null }; // shared recording indicator (6.17)
}
export type ServerMsg = WelcomeMsg | SnapshotMsg;
