import type { BotDifficulty, PlayerLoadoutPayload, ThrowableType } from "@game/shared";

export type CrosshairStyle = "DYNAMIC_CROSS" | "STATIC_DOT" | "CIRCLE_CROSS" | "CLASSIC_T";
export type SensitivitySourceGame = "VALORANT" | "CS2" | "COD";
export type GraphicsQuality = "LOW" | "MEDIUM" | "HIGH" | "ULTRA";
export type HitMarkerStyle = "CROSS" | "DOT" | "MINIMAL";

export const COMBAT_CONTROLS = {
  primary: { label: "Primary weapon", code: "Digit1" },
  secondary: { label: "Secondary weapon", code: "Digit2" },
  swapWeapon: { label: "Swap weapon", code: "KeyX" },
  frag: { label: "Select frag", code: "Digit3" },
  flashbang: { label: "Select flashbang", code: "Digit4" },
  smoke: { label: "Select smoke", code: "Digit5" },
  throwGrenade: { label: "Preview and throw", code: "KeyG" },
  reload: { label: "Reload", code: "KeyR" },
  crouch: { label: "Crouch / slide", code: "KeyC" },
  melee: { label: "Quick knife", code: "KeyK" },
  inspect: { label: "Inspect weapon", code: "KeyI" },
} as const;

export type CombatAction = keyof typeof COMBAT_CONTROLS;
export type CombatBindings = Partial<Record<CombatAction, string>>;
const FIXED_GAME_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "KeyB", "KeyV", "KeyZ", "KeyF", "KeyL", "KeyM"]);

export function canBindCombatKey(code: string): boolean {
  return /^(Key[A-Z]|Digit[0-9]|Numpad[0-9]|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash)$/.test(code)
    && !FIXED_GAME_KEYS.has(code);
}

export function combatKey(bindings: CombatBindings, action: CombatAction): string {
  const code = bindings?.[action];
  return code && canBindCombatKey(code) ? code : COMBAT_CONTROLS[action].code;
}

export function combatKeyLabel(code: string): string {
  return code.replace(/^Key|^Digit/, "").replace(/^Numpad/, "Num ");
}

export interface UserSettings {
  fov: number;
  hipSens: number;
  adsSensMult: number;
  rawMouseInput: boolean;
  toggleCrouch: boolean;
  crosshairStyle: CrosshairStyle;
  crosshairColor: string;
  crosshairSize: number;
  crosshairGap: number;
  masterVolume: number;
  gunfireVolume: number;
  hitFeedbackVolume: number;
  headshotAnnouncer: boolean;
  hrtfEnabled: boolean;
  graphicsQuality: GraphicsQuality;
  botDifficulty: BotDifficulty;
  combatBindings: CombatBindings;
  hitMarkerStyle: HitMarkerStyle;
}

export interface CareerStats {
  kills: number;
  deaths: number;
  headshots: number;
  wins: number;
  matches: number;
  xp: number;
  rating: number;
}

export type RacingTransmission = "AUTO" | "MANUAL";

export interface RacingCareerStats {
  races: number;
  wins: number;
  bestDriftScore: number;
  bestLapMsByTrack: Record<string, number>;
  bestTimeTrialMsByTrack: Record<string, number>;
}

export interface RacingProfileConfig {
  vehicleId: string;
  liveryId: string;
  tuneId: string;
  spoilerId: string;
  rimId: string;
  underglowId: string;
  transmission: RacingTransmission;
  stats: RacingCareerStats;
}

export interface GuestProfile {
  guestUuid: string;
  callsign: string;
  settings: UserSettings;
  stats: CareerStats;
  loadout: PlayerLoadoutPayload;
  tdmKits?: [PlayerLoadoutPayload, PlayerLoadoutPayload];
  tdmKitSlot?: 0 | 1;
  racing: RacingProfileConfig;
}

const STORAGE_KEY = "strikecore_guest_profile_v1";

function generateUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `guest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function defaultCallsign(): string {
  const prefixes = ["Apex", "Viper", "Shadow", "Nova", "Frost", "Kestrel", "Phantom", "Blaze"];
  const p = prefixes[Math.floor(Math.random() * prefixes.length)];
  const n = 10 + Math.floor(Math.random() * 89);
  return `${p}Op-${n}`;
}

export function createDefaultRacingProfile(): RacingProfileConfig {
  return {
    vehicleId: "apex_gt",
    liveryId: "rosso_corsa",
    tuneId: "tune_street",
    spoilerId: "spoiler_gt_wing",
    rimId: "rim_sport",
    underglowId: "underglow_cyan",
    transmission: "AUTO",
    stats: {
      races: 0,
      wins: 0,
      bestDriftScore: 0,
      bestLapMsByTrack: {},
      bestTimeTrialMsByTrack: {},
    },
  };
}

export function createDefaultProfile(): GuestProfile {
  return {
    guestUuid: generateUuid(),
    callsign: defaultCallsign(),
    settings: {
      fov: 95,
      hipSens: 1.0,
      adsSensMult: 0.72,
      rawMouseInput: true,
      toggleCrouch: false,
      crosshairStyle: "DYNAMIC_CROSS",
      crosshairColor: "#22d3ee",
      crosshairSize: 8,
      crosshairGap: 4,
      masterVolume: 0.75,
      gunfireVolume: 0.55,
      hitFeedbackVolume: 0.7,
      headshotAnnouncer: false,
      hrtfEnabled: true,
      graphicsQuality: "MEDIUM",
      botDifficulty: "NORMAL",
      combatBindings: {},
      hitMarkerStyle: "CROSS",
    },
    stats: {
      kills: 0,
      deaths: 0,
      headshots: 0,
      wins: 0,
      matches: 0,
      xp: 0,
      rating: 1000,
    },
    loadout: {
      primary: {
        weaponId: "m416",
        skinId: "standard_issue",
        attachments: { optic: "optic_red_dot", muzzle: "muzzle_compensator" },
      },
      secondary: {
        weaponId: "deagle",
        skinId: "standard_issue",
        attachments: {},
      },
      throwable: "frag",
    },
    racing: createDefaultRacingProfile(),
  };
}

export function loadGuestProfile(): GuestProfile {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const fresh = createDefaultProfile();
      saveGuestProfile(fresh);
      return fresh;
    }
    const parsed = JSON.parse(raw) as Partial<GuestProfile>;
    const defaults = createDefaultProfile();
    const parsedRacing = parsed.racing as Partial<RacingProfileConfig> | undefined;
    const parsedRacingStats = parsedRacing?.stats as Partial<RacingCareerStats> | undefined;
    const bestLapMsByTrack =
      parsedRacingStats?.bestLapMsByTrack && typeof parsedRacingStats.bestLapMsByTrack === "object"
        ? { ...parsedRacingStats.bestLapMsByTrack }
        : {};
    const bestTimeTrialMsByTrack = parsedRacingStats?.bestTimeTrialMsByTrack;
    return {
      guestUuid: parsed.guestUuid || defaults.guestUuid,
      callsign: parsed.callsign || defaults.callsign,
      settings: { ...defaults.settings, ...(parsed.settings ?? {}) },
      stats: { ...defaults.stats, ...(parsed.stats ?? {}) },
      loadout: parsed.loadout ?? defaults.loadout,
      tdmKits: parsed.tdmKits,
      tdmKitSlot: parsed.tdmKitSlot === 1 ? 1 : 0,
      racing: {
        ...defaults.racing,
        ...(parsedRacing ?? {}),
        transmission: parsedRacing?.transmission === "MANUAL" ? "MANUAL" : "AUTO",
        stats: {
          ...defaults.racing.stats,
          ...(parsedRacingStats ?? {}),
          bestLapMsByTrack,
          bestTimeTrialMsByTrack: bestTimeTrialMsByTrack && typeof bestTimeTrialMsByTrack === "object"
            ? { ...bestTimeTrialMsByTrack }
            : {},
        },
      },
    };
  } catch {
    return createDefaultProfile();
  }
}

export function saveGuestProfile(profile: GuestProfile): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // Ignore storage quota errors in restricted tabs
  }
}

/**
 * 1-Click Sensitivity Converter from Valorant, CS2, or Call of Duty
 * to StrikeCore normalized hip-fire sensitivity.
 */
export function convertSensitivityFromGame(source: SensitivitySourceGame, value: number): number {
  const safeVal = Math.max(0.01, value);
  switch (source) {
    case "VALORANT":
      return Number((safeVal * 3.18).toFixed(2));
    case "CS2":
      return Number((safeVal * 1.0).toFixed(2));
    case "COD":
      return Number((safeVal * 0.3).toFixed(2));
  }
}

export function setLoadoutThrowable(profile: GuestProfile, t: ThrowableType): void {
  profile.loadout.throwable = t;
  saveGuestProfile(profile);
}
