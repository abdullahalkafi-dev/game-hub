export type GameMode = "1v1" | "2v2" | "4v4" | "TDM" | "WARMUP";
export type TeamId = "A" | "B";
export type RoundPhase =
  | "LOBBY"
  | "WARMUP"
  | "PRE_ROUND_FREEZE"
  | "LIVE_ROUND"
  | "OVERTIME_ZONE"
  | "ROUND_END"
  | "MATCH_END";

export interface ModeConfig {
  id: GameMode;
  label: string;
  description: string;
  teamSize: number;
  maxPlayers: number;
  roundTimeSec: number;
  roundsToWin: number;
  hasBombObjective: boolean;
  mirroredLoadoutInterval: number; // > 0 in 2v2 Gunfight
}

export const MODE_CONFIGS: Record<GameMode, ModeConfig> = {
  "1v1": {
    id: "1v1",
    label: "1v1 Aim Duel",
    description: "Tight symmetrical duel. First to 5 rounds wins.",
    teamSize: 1,
    maxPlayers: 2,
    roundTimeSec: 45,
    roundsToWin: 5,
    hasBombObjective: false,
    mirroredLoadoutInterval: 0,
  },
  "2v2": {
    id: "2v2",
    label: "2v2 Gunfight",
    description: "Both duos share a randomized weapon kit every 2 rounds. First to 4.",
    teamSize: 2,
    maxPlayers: 4,
    roundTimeSec: 60,
    roundsToWin: 4,
    hasBombObjective: false,
    mirroredLoadoutInterval: 2,
  },
  "4v4": {
    id: "4v4",
    label: "4v4 Tactical Wipeout",
    description: "Team elimination with fast plant/defuse objective. First to 4.",
    teamSize: 4,
    maxPlayers: 8,
    roundTimeSec: 75,
    roundsToWin: 4,
    hasBombObjective: true,
    mirroredLoadoutInterval: 0,
  },
  TDM: {
    id: "TDM",
    label: "4v4 Team Deathmatch",
    description: "Continuous respawns. First to 30 eliminations or the lead after 7 minutes wins.",
    teamSize: 4,
    maxPlayers: 8,
    roundTimeSec: 7 * 60,
    roundsToWin: 1,
    hasBombObjective: false,
    mirroredLoadoutInterval: 0,
  },
  WARMUP: {
    id: "WARMUP",
    label: "Warm-Up Aim Range",
    description: "Solo or squad instant respawn target practice & gunsmith test range.",
    teamSize: 4,
    maxPlayers: 8,
    roundTimeSec: 9999,
    roundsToWin: 99,
    hasBombObjective: false,
    mirroredLoadoutInterval: 0,
  },
};

export const PRE_ROUND_FREEZE_SEC = 1;
export const OVERTIME_UNLOCK_SEC = 45;
export const OVERTIME_CAPTURE_NEEDED_SEC = 3.0;
export const ROUND_END_DELAY_SEC = 4.0;
export const MATCH_END_DELAY_SEC = 10.0;
export const AFK_HOST_AUTOSTART_SEC = 45;
export const RECONNECT_GRACE_SEC = 20;

export const BASE_HP = 100;
export const TDM_SCORE_TARGET = 30;
export const TDM_RESPAWN_SEC = 3;
export const TDM_PROTECTION_SEC = 2;
export const BASE_ARMOR = 50;
export const ARMOR_ABSORB_RATIO = 0.5;

export const BOMB_PLANT_SEC = 3.0;
export const BOMB_DEFUSE_SEC = 4.0;
export const BOMB_DETONATE_SEC = 25.0;

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
