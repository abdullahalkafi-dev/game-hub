export type GameMode = "1v1" | "2v2" | "TDM" | "WARMUP";
export type TeamId = "A" | "B";
/**
 * Every competitive mode is a continuous deathmatch: WARMUP (lobby / practice) -> COUNTDOWN
 * (brief pre-match freeze) -> LIVE (continuous respawns until the score or time limit) -> MATCH_END.
 */
export type RoundPhase = "WARMUP" | "COUNTDOWN" | "LIVE" | "MATCH_END";

export interface ModeConfig {
  id: GameMode;
  label: string;
  description: string;
  teamSize: number;
  maxPlayers: number;
}

export const DEFAULT_TIME_LIMIT_SEC = 8 * 60;
export const DEFAULT_SCORE_LIMIT = 20;
/** Selectable in the room-creation UI. 0 means "unlimited". */
export const TIME_LIMIT_OPTIONS_SEC = [5 * 60, 8 * 60, 10 * 60, 15 * 60, 0] as const;
export const SCORE_LIMIT_OPTIONS = [10, 15, 20, 30, 50, 0] as const;

export const MODE_CONFIGS: Record<GameMode, ModeConfig> = {
  "1v1": {
    id: "1v1",
    label: "1v1 Duel",
    description: "Continuous duel. Respawn after every kill; most kills at the limit wins.",
    teamSize: 1,
    maxPlayers: 2,
  },
  "2v2": {
    id: "2v2",
    label: "2v2 Team Duel",
    description: "Two-player squads trade kills with continuous respawns.",
    teamSize: 2,
    maxPlayers: 4,
  },
  TDM: {
    id: "TDM",
    label: "4v4 Team Deathmatch",
    description: "Squad deathmatch with continuous respawns.",
    teamSize: 4,
    maxPlayers: 8,
  },
  WARMUP: {
    id: "WARMUP",
    label: "Warm-Up Aim Range",
    description: "Solo or squad instant respawn target practice & gunsmith test range.",
    teamSize: 4,
    maxPlayers: 8,
  },
};

export const COUNTDOWN_SEC = 3;
export const MATCH_END_DELAY_SEC = 10.0;
export const AFK_HOST_AUTOSTART_SEC = 45;
export const RECONNECT_GRACE_SEC = 20;

export const BASE_HP = 100;
export const RESPAWN_SEC = 3;
export const SPAWN_PROTECTION_SEC = 2;
export const BASE_ARMOR = 50;
export const ARMOR_ABSORB_RATIO = 0.5;


export const GRAVITY = -22.0;
export const PLAYER_RADIUS = 0.36;
export const PLAYER_HEIGHT_STAND = 1.8;
export const PLAYER_HEIGHT_CROUCH = 1.2;
export const EYE_HEIGHT_STAND = 1.62;
export const EYE_HEIGHT_CROUCH = 1.05;
export const EYE_HEIGHT_SLIDE = 0.85;
export const LEAN_OFFSET_MAX = 0.38;
export const LEAN_ROLL_DEG = 12;
export const SLIDE_DURATION_SEC = 0.65;
export const SLIDE_COOLDOWN_SEC = 1.5;
export const VAULT_DURATION_SEC = 0.38;
