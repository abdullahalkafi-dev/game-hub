import { DEFAULT_SCORE_LIMIT, DEFAULT_TIME_LIMIT_SEC, type GameMode, type RoundPhase } from "./gameRules.js";
import type { Vec3 } from "../math/ScratchMath.js";

export const HEAL_DELAY_SEC = 5;
export const HEAL_HP_PER_SEC = 10;
export const MELEE_RANGE = 2.2;
export const MELEE_COOLDOWN_MS = 650;
export const REPLAY_SAMPLE_HZ = 12;
export const REPLAY_SECONDS = 2.5;
export const STARTING_RATING = 1000;

export function isCombatPhase(phase: RoundPhase): boolean {
  return phase === "WARMUP" || phase === "LIVE";
}

export interface MatchRules {
  ranked: boolean;
  /** Match length in seconds; 0 = unlimited. */
  timeLimitSeconds: number;
  /** Team kills that end the match; 0 = no kill limit. */
  scoreLimit: number;
  friendlyFire: boolean;
}

export const RANKED_TIME_LIMIT_SEC = 7 * 60;
export const RANKED_SCORE_LIMIT = 30;

export function normalizeMatchRules(mode: GameMode, rules?: Partial<MatchRules>): MatchRules {
  const ranked = mode === "TDM" && rules?.ranked === true;
  if (ranked) {
    return { ranked, timeLimitSeconds: RANKED_TIME_LIMIT_SEC, scoreLimit: RANKED_SCORE_LIMIT, friendlyFire: false };
  }
  const pick = (value: number | undefined, fallback: number, min: number, max: number): number => {
    if (value === undefined || !Number.isFinite(value)) return fallback;
    const rounded = Math.round(value);
    return rounded <= 0 ? 0 : Math.min(max, Math.max(min, rounded));
  };
  const warmup = mode === "WARMUP";
  return {
    ranked: false,
    timeLimitSeconds: warmup ? 0 : pick(rules?.timeLimitSeconds, DEFAULT_TIME_LIMIT_SEC, 60, 3600),
    scoreLimit: warmup ? 0 : pick(rules?.scoreLimit, DEFAULT_SCORE_LIMIT, 1, 200),
    friendlyFire: rules?.friendlyFire === true,
  };
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
