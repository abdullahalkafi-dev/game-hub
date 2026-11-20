import type { GameMode, RoundPhase, TeamId } from "../constants/gameRules.js";
import type { ArenaPickup, CombatStats, MatchRules, PickupKind } from "../constants/arenaFeatures.js";
import type { Vec3 } from "../math/ScratchMath.js";
import type { FpsPlayerState } from "../physics/FpsCharacterController.js";
import type { ThrowablePair, ThrowableStock, ThrowableType } from "../registries/ThrowableRegistry.js";
import type { PlayerWeaponConfig } from "../systems/WeaponStatCalculator.js";

/**
 * Compact 26-byte-per-player binary snapshot format (< 28 bytes target).
 * Layout per player (26 bytes):
 *   playerIndex (uint16)   : 2B
 *   posX (float32)         : 4B
 *   posY (float32)         : 4B
 *   posZ (float32)         : 4B
 *   yaw (int16 quantized)  : 2B
 *   pitch (int16 quantized): 2B
 *   lean (int8 -100..100)  : 1B
 *   stateFlags (uint8)     : 1B  (crouch, slide, alive, ads, bot, vault, slot1, grounded)
 *   hp (uint8)             : 1B
 *   armor (uint8)          : 1B
 *   velX (int16 * 100)     : 2B
 *   velZ (int16 * 100)     : 2B
 */
export const PLAYER_BINARY_STRIDE = 26;
export const BINARY_SNAPSHOT_MAGIC = 0x534e; // "SN"
export const MOVEMENT_PROTOCOL_VERSION = 4;

export interface BinaryPlayerSnapshot {
  playerIndex: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  lean: number;
  crouching: boolean;
  sliding: boolean;
  alive: boolean;
  ads: boolean;
  isBot: boolean;
  vaulting: boolean;
  grounded?: boolean;
  activeSlot: 0 | 1;
  hp: number;
  armor: number;
  vx: number;
  vz: number;
}

export function encodeWorldSnapshotBinary(
  serverTimeMs: number,
  players: readonly BinaryPlayerSnapshot[]
): ArrayBuffer {
  const headerBytes = 12; // 2 magic + 2 count + 8 timestamp
  const buffer = new ArrayBuffer(headerBytes + players.length * PLAYER_BINARY_STRIDE);
  const view = new DataView(buffer);

  view.setUint16(0, BINARY_SNAPSHOT_MAGIC, true);
  view.setUint16(2, players.length, true);
  view.setFloat64(4, serverTimeMs, true);

  let offset = headerBytes;
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    view.setUint16(offset, p.playerIndex, true);
    view.setFloat32(offset + 2, p.x, true);
    view.setFloat32(offset + 6, p.y, true);
    view.setFloat32(offset + 10, p.z, true);
    const yaw = Math.atan2(Math.sin(p.yaw), Math.cos(p.yaw));
    view.setInt16(offset + 14, Math.round(yaw * 4000), true);
    view.setInt16(offset + 16, Math.round(p.pitch * 4000), true);
    view.setInt8(offset + 18, Math.max(-100, Math.min(100, Math.round(p.lean * 100))));

    let flags = 0;
    if (p.crouching) flags |= 1 << 0;
    if (p.sliding) flags |= 1 << 1;
    if (p.alive) flags |= 1 << 2;
    if (p.ads) flags |= 1 << 3;
    if (p.isBot) flags |= 1 << 4;
    if (p.vaulting) flags |= 1 << 5;
    if (p.activeSlot === 1) flags |= 1 << 6;
    if (p.grounded !== false) flags |= 1 << 7;
    view.setUint8(offset + 19, flags);

    view.setUint8(offset + 20, Math.max(0, Math.min(255, Math.round(p.hp))));
    view.setUint8(offset + 21, Math.max(0, Math.min(255, Math.round(p.armor))));
    view.setInt16(offset + 22, Math.max(-32767, Math.min(32767, Math.round(p.vx * 100))), true);
    view.setInt16(offset + 24, Math.max(-32767, Math.min(32767, Math.round(p.vz * 100))), true);
    offset += PLAYER_BINARY_STRIDE;
  }
  return buffer;
}

export function decodeWorldSnapshotBinary(buffer: ArrayBuffer): {
  serverTimeMs: number;
  players: BinaryPlayerSnapshot[];
} {
  const view = new DataView(buffer);
  const magic = view.getUint16(0, true);
  if (magic !== BINARY_SNAPSHOT_MAGIC) {
    throw new Error("Invalid snapshot magic");
  }
  const count = view.getUint16(2, true);
  const serverTimeMs = view.getFloat64(4, true);
  const players: BinaryPlayerSnapshot[] = new Array(count);

  let offset = 12;
  for (let i = 0; i < count; i++) {
    const flags = view.getUint8(offset + 19);
    players[i] = {
      playerIndex: view.getUint16(offset, true),
      x: view.getFloat32(offset + 2, true),
      y: view.getFloat32(offset + 6, true),
      z: view.getFloat32(offset + 10, true),
      yaw: view.getInt16(offset + 14, true) / 4000,
      pitch: view.getInt16(offset + 16, true) / 4000,
      lean: view.getInt8(offset + 18) / 100,
      crouching: (flags & (1 << 0)) !== 0,
      sliding: (flags & (1 << 1)) !== 0,
      alive: (flags & (1 << 2)) !== 0,
      ads: (flags & (1 << 3)) !== 0,
      isBot: (flags & (1 << 4)) !== 0,
      vaulting: (flags & (1 << 5)) !== 0,
      grounded: (flags & (1 << 7)) !== 0,
      activeSlot: (flags & (1 << 6)) !== 0 ? 1 : 0,
      hp: view.getUint8(offset + 20),
      armor: view.getUint8(offset + 21),
      vx: view.getInt16(offset + 22, true) / 100,
      vz: view.getInt16(offset + 24, true) / 100,
    };
    offset += PLAYER_BINARY_STRIDE;
  }
  return { serverTimeMs, players };
}

export interface PlayerLoadoutPayload {
  primary: PlayerWeaponConfig;
  secondary: PlayerWeaponConfig;
  throwable: ThrowableType;
  tdmThrowables?: ThrowablePair;
}

export interface RoomPlayerSummary {
  id: string;
  playerIndex: number;
  callsign: string;
  team: TeamId;
  isHost: boolean;
  isBot: boolean;
  kills: number;
  deaths: number;
  assists: number;
  alive: boolean;
  hp: number;
  armor: number;
  loadout: PlayerLoadoutPayload;
  combatStats?: CombatStats;
  rating?: number;
}

export interface DamageBreakdownPayload {
  dealtTotal: number;
  dealtHits: number;
  dealtHeadshots: number;
  takenTotal: number;
  takenHits: number;
  takenHeadshots: number;
  killerName?: string;
  killerWeaponId?: string;
  killerHpLeft?: number;
  distanceM?: number;
}

export type HitMarkerTier = "BODY" | "ARMOR_BREAK" | "HEADSHOT" | "KILL";
export type BotDifficulty = "EASY" | "NORMAL" | "PRO";

export interface RoomStateBroadcast {
  code: string;
  isPublic: boolean;
  mode: GameMode;
  mapId: string;
  phase: RoundPhase;
  /** Seconds left in the match (or countdown). Meaningless when matchRules.timeLimitSeconds is 0. */
  timeRemainingSec: number;
  /** Seconds since the match went live. */
  elapsedSec: number;
  scoreA: number;
  scoreB: number;
  botFill: boolean;
  botDifficulty?: BotDifficulty;
  matchRules?: MatchRules;
  pickups?: ArenaPickup[];
  players: RoomPlayerSummary[];
  mapVoteOptions?: string[];
  mapVotes?: Record<string, number>;
}

export type ClientToServerMessage =
  | {
      type: "JOIN_OR_CREATE";
      action: "QUICK_PLAY" | "CREATE" | "JOIN_CODE";
      guestUuid: string;
      callsign: string;
      mode: GameMode;
      mapId: string;
      isPublic: boolean;
      botFill: boolean;
      botDifficulty?: BotDifficulty;
      matchRules?: Partial<MatchRules>;
      roomCode?: string;
      loadout: PlayerLoadoutPayload;
    }
  | { type: "SET_LOADOUT"; loadout: PlayerLoadoutPayload }
  /** Quick optic swap on one weapon slot (0 = primary, 1 = sidearm); null removes the optic. Keeps ammo. */
  | { type: "SET_OPTIC"; slot: 0 | 1; optic: string | null }
  | {
      type: "UPDATE_ROOM_SETTINGS";
      mapId?: string;
      mode?: GameMode;
      botFill?: boolean;
      isPublic?: boolean;
      botDifficulty?: BotDifficulty;
      matchRules?: Partial<MatchRules>;
    }
  | { type: "START_MATCH" }
  | { type: "MELEE"; movementEpoch?: number }
  | {
      type: "INPUT";
      seq: number;
      flags: number;
      yaw: number;
      pitch: number;
      activeSlot: 0 | 1;
      clientTimeMs: number;
      movementEpoch?: number;
    }
  | {
      type: "FIRE_SHOT";
      seq: number;
      origin: Vec3;
      dir: Vec3;
      activeSlot: 0 | 1;
      ads: boolean;
      crouching: boolean;
      grounded: boolean;
      clientTimeMs: number;
      movementEpoch?: number;
    }
  | {
      type: "THROW_GRENADE";
      throwable: ThrowableType;
      origin: Vec3;
      dir: Vec3;
      cookElapsedSec: number;
      movementEpoch?: number;
    }
  | { type: "DANGER_PING"; position: Vec3 }
  | { type: "VOTE_MAP"; mapId: string }
  | { type: "REMATCH_NOW" }
  | { type: "PING_CHECK"; t0: number };

export type ServerToClientMessage =
  | {
      type: "WELCOME";
      yourPlayerId: string;
      yourPlayerIndex: number;
      room: RoomStateBroadcast;
      reconnected: boolean;
      movementProtocolVersion?: number;
    }
  | { type: "ERROR"; message: string }
  | { type: "ROOM_STATE"; room: RoomStateBroadcast }
  | {
      type: "LOCAL_STATE";
      serverTick: number;
      movementEpoch: number;
      inputAck: number;
      shotAck: number;
      movement: FpsPlayerState;
      alive: boolean;
      hp: number;
      armor: number;
      respawnSeconds: number;
      throwableStock?: ThrowableStock;
      healingDelaySeconds?: number;
      spawnProtectionSeconds?: number;
      ammoInMag: [number, number];
      ammoReserve: [number, number];
      reloadSeconds: number;
      activeSlot: 0 | 1;
    }
  | {
      type: "SHOT_FIRED";
      shooterId: string;
      shooterIndex: number;
      weaponId: string;
      suppressed: boolean;
      origin: Vec3;
      seq: number;
      paths: ShotPath[];
    }
  | {
      type: "HIT_CONFIRM";
      tier: HitMarkerTier;
      damage: number;
      victimName: string;
      hitZone: "HEAD" | "CHEST" | "LIMB";
      isHeadshot?: boolean;
      isWallbang: boolean;
    }
  | {
      type: "DAMAGE_TAKEN";
      attackerPosition: Vec3;
      damage: number;
      armorRemaining: number;
      hpRemaining: number;
      isHeadshot: boolean;
    }
  | { type: "DAMAGE_BREAKDOWN"; breakdown: DamageBreakdownPayload }
  | {
      type: "KILL_FEED";
      killerName: string;
      killerTeam: TeamId;
      victimName: string;
      victimTeam: TeamId;
      weaponId: string;
      isHeadshot: boolean;
      isWallbang: boolean;
      distanceM: number;
      isMatchWinningKill: boolean;
      /** Killer's running streak after this kill, and how many kills in the current multi-kill window. */
      streak: number;
      multi: number;
      killerHpLeft: number;
    }
  | {
      type: "PROP_DESTROYED";
      blockId: string;
      material: string;
      position: Vec3;
    }
  | {
      type: "PROP_DAMAGED";
      blockId: string;
      material: string;
      position: Vec3;
      /** Remaining health 0..1. 0 means the prop is about to detonate. */
      hpFraction: number;
    }
  | {
      type: "THROWABLE_SPAWNED";
      id: string;
      throwable: ThrowableType;
      ownerTeam: TeamId;
      position: Vec3;
      velocity: Vec3;
      fuseRemainingSec: number;
    }
  | {
      type: "THROWABLE_DETONATED";
      id: string;
      throwable: ThrowableType;
      position: Vec3;
      durationSec: number;
      radius: number;
    }
  | { type: "FLASHED"; intensity: number; durationSec: number }
  | { type: "DANGER_PING"; playerId: string; callsign: string; team: TeamId; position: Vec3; enemySpotted?: boolean }
  | { type: "COMBAT_STREAK"; run: number; multi: number }
  | { type: "PICKUP_COLLECTED"; kind: PickupKind }
  | { type: "DEATH_REPLAY"; killerId: string; killerName: string; frames: DeathReplayFrame[] }
  | { type: "MATCH_RESULTS"; winnerTeam: TeamId | "DRAW"; mvpId?: string; players: MatchResultPlayer[] }
  | { type: "MATCH_ENDED"; winnerTeam: TeamId | "DRAW"; reason: string }
  | { type: "PONG_CHECK"; t0: number; serverTimeMs: number };

export interface ShotSurface {
  point: Vec3;
  normal: Vec3;
  material: string;
  blockId: string;
}

export interface DeathReplayFrame {
  timeMs: number;
  eye: Vec3;
  yaw: number;
  pitch: number;
  victim: Vec3;
}

export interface MatchResultPlayer {
  id: string;
  callsign: string;
  team: TeamId;
  kills: number;
  deaths: number;
  combatStats: CombatStats;
  xpEarned: number;
  rating?: number;
  ratingChange?: number;
}

export interface ShotPath {
  end: Vec3;
  bends?: Vec3[];
  surfaces: ShotSurface[];
  playerId?: string;
  practiceTarget?: number;
}
