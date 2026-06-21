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
export interface PortalObject { id: string; x: number; y: number; w: number; h: number; to: string; label: string; color: string } // links to another floor's slug (§6 multi-floor)
// Interactive widgets placed on a floor (§6): embeds (YouTube/Spotify/web), sticky notes, shared countdowns.
export interface WidgetObject { id: string; type: "note" | "embed" | "timer"; x: number; y: number; w: number; h: number;
  text?: string; color?: string; url?: string; kind?: string; title?: string; label?: string; endsAt?: number }
export interface WorldBlob {
  slug?: string;   // which floor this is
  name?: string;   // human floor name (e.g. "Rooftop Garden")
  w: number;
  h: number;
  obstacles: Array<{ x: number; y: number; w: number; h: number; r?: number }>;
  furniture?: Array<{ id: string; x: number; y: number; w: number; h: number; r?: number }>; // editable in-office (§6.10)
  rooms: Array<{ id: string; name: string; color: string;
    bounds: { x: number; y: number; w: number; h: number };
    door: { x: number; y: number; w: number; h: number; state?: DoorState } }>;
  mediaWall: { x: number; y: number; w: number; base: number; screenH: number; title: string; dur: number } | null;
  portals?: PortalObject[];                                  // doorways to other floors (§6 multi-floor)
  widgets?: WidgetObject[];                                  // interactive objects: embeds, notes, timers (§6)
  branding?: { name: string; color: string; logo: string; whiteLabel: boolean }; // per-space white-label (6.12)
  floors?: Array<{ slug: string; name: string }>;            // every floor, for the switcher (§6 multi-floor)
}

// ---- Client → Server ----
export interface JoinMsg      { t: "join"; name: string; token?: string; talking?: boolean; } // token = JWT from /auth/login (6.14)
export interface MoveMsg      { t: "move"; x: number; y: number; facing?: number; }
export interface StateMsg     { t: "state"; status?: PresenceStatus; talking?: boolean; }
export interface BroadcastMsg { t: "broadcast"; on: boolean; }              // talk floor-wide (spec 6.5)
export interface MediaMsg     { t: "media"; playing: boolean; }            // shared media wall play/pause (6.22)
export interface DoorMsg      { t: "door"; roomId: string; state: DoorState; } // occupant opens/closes (6.4)
export interface KnockMsg     { t: "knock"; roomId: string; }              // request entry; occupant admits (6.4)
export interface RecordingMsg { t: "recording"; on: boolean; egressId?: string; } // start/stop room recording (6.17)
export interface AdminReloadMsg { t: "adminReload"; token: string; } // admin re-pushes the world to everyone live (6.10/6.14)
export interface ChatSendMsg  { t: "chat"; scope: "nearby" | "floor" | "channel" | "dm"; channel?: string; to?: string; body: string; } // multi-scope chat (6.9)
export interface WhiteboardStroke { color: string; width: number; pts: [number, number][]; } // (6.8)
export interface DrawMsg       { t: "draw"; stroke: WhiteboardStroke; } // collaborative whiteboard stroke (6.8)
export interface WbClearMsg    { t: "wbclear"; }                        // clear the whiteboard (6.8)
export interface ReactSendMsg  { t: "react"; emoji: string; }          // emoji reaction (6.6)
export interface NudgeSendMsg  { t: "nudge"; to: string; }             // ping a user (6.9)
export interface ModerateMsg   { t: "moderate"; action: "mute" | "unmute" | "kick"; target: string; } // moderation (6.16)
export interface PortalMsg     { t: "portal"; to: string; } // travel to another floor by slug (§6 multi-floor)
export type ClientMsg = JoinMsg | MoveMsg | StateMsg | BroadcastMsg | MediaMsg | DoorMsg | KnockMsg | RecordingMsg | AdminReloadMsg | ChatSendMsg | DrawMsg | WbClearMsg | ReactSendMsg | NudgeSendMsg | ModerateMsg | PortalMsg;

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
  role: string;            // owner | admin | member | guest (6.14)
  floor?: string;          // which floor this player is on (§6 multi-floor)
}
export interface WelcomeMsg  { t: "welcome"; id: string; world: WorldBlob; you: PlayerSnapshot; whiteboard?: WhiteboardStroke[]; }
export interface DeniedMsg   { t: "denied"; action: string; need: string; }   // RBAC refusal (6.14)
export interface WorldUpdateMsg { t: "world"; world: WorldBlob; }              // live layout reload pushed to clients (6.10)
export interface RateLimitedMsg { t: "rateLimited"; }                          // connection exceeded the message rate (§8)
export interface FullMsg        { t: "full"; }                                 // server at capacity, join refused (§8)
export interface ChatMessage    { t: "chat"; from: string; name: string; scope: "nearby" | "floor" | "channel" | "dm"; channel?: string | null; to?: string | null; body: string; ts: number; } // (6.9)
export interface SnapshotMsg {
  t: "snapshot";
  floor?: string;                            // which floor this snapshot is for (§6 multi-floor)
  players: PlayerSnapshot[];
  doors: Record<string, DoorState>;          // roomId -> state
  media: { playing: boolean; pos: number } | null;  // shared media-wall playback (null if floor has no media wall)
  recording: { on: boolean; by: string | null; egressId?: string | null }; // shared recording indicator (6.17)
}
export interface FloorChangeMsg { t: "floor"; world: WorldBlob; you: { id: string; x: number; y: number; floor: string }; } // arrived on a new floor via portal (§6)
export interface ReactMsg      { t: "react"; from: string; emoji: string; } // broadcast reaction (6.6)
export interface NudgeMsg      { t: "nudge"; from: string; name: string; }   // nudge delivered (6.9)
export interface KickedMsg     { t: "kicked"; }                              // you were removed (6.16)
export type ServerMsg = WelcomeMsg | SnapshotMsg | FloorChangeMsg | DeniedMsg | WorldUpdateMsg | RateLimitedMsg | FullMsg | ChatMessage | DrawMsg | WbClearMsg | ReactMsg | NudgeMsg | KickedMsg;

// ====================================================================
// Public API + webhooks (spec §6.18). See docs/PUBLIC_API.md.
// ====================================================================
export interface PublicPresenceUser {
  id: string; name: string; role: string; status: PresenceStatus;
  x: number; y: number; room: string | null;
}
export interface WebhookEvent {
  event: "user.joined" | "user.left";
  data: Record<string, unknown>;
  ts: number;
}
