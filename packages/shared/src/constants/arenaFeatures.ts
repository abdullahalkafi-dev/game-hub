import { MODE_CONFIGS, type GameMode, type RoundPhase } from "./gameRules.js";
import type { Vec3 } from "../math/ScratchMath.js";

export const HEAL_DELAY_SEC = 5;
export const HEAL_HP_PER_SEC = 10;
export const MELEE_RANGE = 2.2;
export const MELEE_COOLDOWN_MS = 650;
export const REPLAY_SAMPLE_HZ = 12;
export const REPLAY_SECONDS = 2.5;
export const STARTING_RATING = 1000;

export function isCombatPhase(phase: RoundPhase): boolean {
  return phase === "WARMUP" || phase === "LIVE_ROUND" || phase === "OVERTIME_ZONE";
}

export interface MatchRules {
  ranked: boolean;
  timeLimitSeconds: number;
  friendlyFire: boolean;
}

export function normalizeMatchRules(mode: GameMode, rules?: Partial<MatchRules>): MatchRules {
  const ranked = mode === "TDM" && rules?.ranked === true;
  const customTime = rules?.timeLimitSeconds;
  const timeLimitSeconds = !ranked && mode !== "WARMUP" && Number.isFinite(customTime) && customTime !== undefined
    ? Math.min(900, Math.max(30, Math.round(customTime)))
    : MODE_CONFIGS[mode].roundTimeSec;
  return { ranked, timeLimitSeconds, friendlyFire: !ranked && rules?.friendlyFire === true };
}

export type PickupKind = "armor" | "ammo";

export interface ArenaPickup {
  id: string;
  kind: PickupKind;
  position: Vec3;
  available: boolean;
}

export interface CombatStats {
  shots: number;
  shotsHit: number;
  headshotKills: number;
  damage: number;
  longestStreak: number;
}

export function emptyCombatStats(): CombatStats {
  return { shots: 0, shotsHit: 0, headshotKills: 0, damage: 0, longestStreak: 0 };
}

export function careerLevel(xp: number): number {
  return Math.floor(Math.max(0, xp) / 250) + 1;
}
