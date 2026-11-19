export type WeaponCategory = "AR" | "SMG" | "SNIPER" | "SHOTGUN" | "PISTOL";
export type AttachmentSlot = "optic" | "muzzle" | "underbarrel" | "mag";
export type FireMode = "AUTO" | "BURST" | "SINGLE";

export interface WeaponBlueprint {
  id: string;
  name: string;
  category: WeaponCategory;
  description: string;
  modelPath: string;
  stats: {
    damage: { head: number; chest: number; limb: number };
    armorPenetration: number;
    pellets: number;
    rpm: number;
    fireModes: FireMode[];
    magSize: number;
    reserveMags: number;
    reloadTimeSec: { tactical: number; empty: number };
    adsTimeMs: number;
    adsFov: number;
    hipSpreadDeg: number;
    adsSpreadDeg: number;
    moveSpeedMultiplier: number;
    wallbangPower: number;
    maxRangeMeters: number;
  };
  recoilPattern: {
    vertical: number;
    horizontalJitter: number;
    patternX: number[];
    recoverySpeed: number;
  };
  audio: {
    fire: string;
    suppressed: string;
    reloadTactical: string;
    reloadEmpty: string;
  };
  allowedSlots: AttachmentSlot[];
  defaultAttachments?: Partial<Record<AttachmentSlot, string>>;
}

/**
 * Modular Weapon Registry.
 * Add any new gun in < 2 minutes by adding a blueprint entry here.
 * Both client Gunsmith/ViewModel/Recoil and server Hitscan/Anti-cheat read from this single source.
 */
export const WEAPON_REGISTRY: Record<string, WeaponBlueprint> = {
  m416: {
    id: "m416",
    name: "M416 Tactical",
    category: "AR",
    description: "Balanced modular 5.56mm assault rifle with crisp recoil control.",
    modelPath: "weapons/m416.glb",
    stats: {
      damage: { head: 48, chest: 24, limb: 18 },
      armorPenetration: 0.48,
      pellets: 1,
      rpm: 750,
      fireModes: ["AUTO", "SINGLE"],
      magSize: 30,
      reserveMags: 4,
      reloadTimeSec: { tactical: 1.85, empty: 2.35 },
      adsTimeMs: 180,
      adsFov: 52,
      hipSpreadDeg: 3.1,
      adsSpreadDeg: 0.12,
      moveSpeedMultiplier: 0.94,
      wallbangPower: 0.55,
      maxRangeMeters: 120,
    },
    recoilPattern: {
      vertical: 1.35,
      horizontalJitter: 0.32,
      patternX: [0, 0.12, 0.25, -0.15, -0.35, -0.2, 0.3, 0.4, 0.1, -0.3],
      recoverySpeed: 8.5,
    },
    audio: {
      fire: "sfx_m416_shot",
      suppressed: "sfx_ar_silenced",
      reloadTactical: "sfx_ar_reload_tac",
      reloadEmpty: "sfx_ar_reload_dry",
    },
    allowedSlots: ["optic", "muzzle", "underbarrel", "mag"],
    defaultAttachments: { optic: "optic_red_dot" },
  },

  akm: {
    id: "akm",
    name: "AKM Heavy 7.62",
    category: "AR",
    description: "High-caliber 7.62mm rifle punching through armor and wooden cover.",
    modelPath: "weapons/akm.glb",
    stats: {
      damage: { head: 58, chest: 32, limb: 22 },
      armorPenetration: 0.62,
      pellets: 1,
      rpm: 600,
      fireModes: ["AUTO", "SINGLE"],
      magSize: 30,
      reserveMags: 4,
      reloadTimeSec: { tactical: 2.0, empty: 2.55 },
      adsTimeMs: 210,
      adsFov: 52,
      hipSpreadDeg: 3.6,
      adsSpreadDeg: 0.16,
      moveSpeedMultiplier: 0.91,
      wallbangPower: 0.72,
      maxRangeMeters: 125,
    },
    recoilPattern: {
      vertical: 1.95,
      horizontalJitter: 0.52,
      patternX: [0, -0.2, -0.45, 0.15, 0.55, 0.4, -0.35, -0.6, 0.2, 0.4],
      recoverySpeed: 7.2,
    },
    audio: {
      fire: "sfx_akm_shot",
      suppressed: "sfx_ar_silenced",
      reloadTactical: "sfx_ar_reload_tac",
      reloadEmpty: "sfx_ar_reload_dry",
    },
    allowedSlots: ["optic", "muzzle", "underbarrel", "mag"],
  },

  ump45: {
    id: "ump45",
    name: "UMP-45 Tactical",
    category: "SMG",
    description: "Controllable .45 ACP submachine gun built for aggressive corner clearing.",
    modelPath: "weapons/ump45.glb",
    stats: {
      damage: { head: 42, chest: 24, limb: 19 },
      armorPenetration: 0.35,
      pellets: 1,
      rpm: 650,
      fireModes: ["AUTO", "BURST", "SINGLE"],
      magSize: 25,
      reserveMags: 5,
      reloadTimeSec: { tactical: 1.55, empty: 2.0 },
      adsTimeMs: 145,
      adsFov: 56,
      hipSpreadDeg: 2.1,
      adsSpreadDeg: 0.18,
      moveSpeedMultiplier: 1.0,
      wallbangPower: 0.35,
      maxRangeMeters: 75,
    },
    recoilPattern: {
      vertical: 1.0,
      horizontalJitter: 0.22,
      patternX: [0, 0.1, -0.1, 0.15, -0.15, 0.2, -0.2, 0.1, 0, -0.1],
      recoverySpeed: 10.0,
    },
    audio: {
      fire: "sfx_ump45_shot",
      suppressed: "sfx_smg_silenced",
      reloadTactical: "sfx_smg_reload_tac",
      reloadEmpty: "sfx_smg_reload_dry",
    },
    allowedSlots: ["optic", "muzzle", "underbarrel", "mag"],
    defaultAttachments: { optic: "optic_red_dot" },
  },

  vector: {
    id: "vector",
    name: "Kriss Vector .45",
    category: "SMG",
    description: "Extreme 1100 RPM shredder with Super-V recoil mitigation for CQC duels.",
    modelPath: "weapons/vector.glb",
    stats: {
      damage: { head: 34, chest: 19, limb: 14 },
      armorPenetration: 0.32,
      pellets: 1,
      rpm: 1100,
      fireModes: ["AUTO", "BURST"],
      magSize: 19,
      reserveMags: 6,
      reloadTimeSec: { tactical: 1.45, empty: 1.85 },
      adsTimeMs: 130,
      adsFov: 58,
      hipSpreadDeg: 1.9,
      adsSpreadDeg: 0.22,
      moveSpeedMultiplier: 1.03,
      wallbangPower: 0.28,
      maxRangeMeters: 60,
    },
    recoilPattern: {
      vertical: 0.85,
      horizontalJitter: 0.28,
      patternX: [0, 0.08, 0.15, 0.12, -0.1, -0.18, -0.12, 0.08, 0.14, -0.14],
      recoverySpeed: 11.5,
    },
    audio: {
      fire: "sfx_vector_shot",
      suppressed: "sfx_smg_silenced",
      reloadTactical: "sfx_smg_reload_tac",
      reloadEmpty: "sfx_smg_reload_dry",
    },
    allowedSlots: ["optic", "muzzle", "underbarrel", "mag"],
  },

  kar98k: {
    id: "kar98k",
    name: "Kar98k Bolt",
    category: "SNIPER",
    description: "Classic 7.92mm bolt-action marksman rifle. One-shot headshot lethal.",
    modelPath: "weapons/kar98k.glb",
    stats: {
      damage: { head: 180, chest: 85, limb: 64 },
      armorPenetration: 0.88,
      pellets: 1,
      rpm: 46,
      fireModes: ["SINGLE"],
      magSize: 5,
      reserveMags: 5,
      reloadTimeSec: { tactical: 2.2, empty: 2.9 },
      adsTimeMs: 280,
      adsFov: 24,
      hipSpreadDeg: 7.5,
      adsSpreadDeg: 0.01,
      moveSpeedMultiplier: 0.89,
      wallbangPower: 0.88,
      maxRangeMeters: 220,
    },
    recoilPattern: {
      vertical: 4.5,
      horizontalJitter: 0.4,
      patternX: [0, 0.2],
      recoverySpeed: 5.5,
    },
    audio: {
      fire: "sfx_kar98k_shot",
      suppressed: "sfx_sniper_silenced",
      reloadTactical: "sfx_bolt_reload",
      reloadEmpty: "sfx_bolt_reload",
    },
    allowedSlots: ["optic", "muzzle"],
    defaultAttachments: { optic: "optic_6x_sniper" },
  },

  awm: {
    id: "awm",
    name: "AWM .338 Magnum",
    category: "SNIPER",
    description: "Heavy anti-materiel sniper punching cleanly through vests and sheet metal.",
    modelPath: "weapons/awm.glb",
    stats: {
      damage: { head: 240, chest: 112, limb: 80 },
      armorPenetration: 0.95,
      pellets: 1,
      rpm: 38,
      fireModes: ["SINGLE"],
      magSize: 5,
      reserveMags: 4,
      reloadTimeSec: { tactical: 2.45, empty: 3.1 },
      adsTimeMs: 320,
      adsFov: 20,
      hipSpreadDeg: 8.5,
      adsSpreadDeg: 0.005,
      moveSpeedMultiplier: 0.85,
      wallbangPower: 0.96,
      maxRangeMeters: 260,
    },
    recoilPattern: {
      vertical: 5.8,
      horizontalJitter: 0.55,
      patternX: [0, -0.3],
      recoverySpeed: 4.8,
    },
    audio: {
      fire: "sfx_awm_shot",
      suppressed: "sfx_sniper_silenced",
      reloadTactical: "sfx_bolt_reload",
      reloadEmpty: "sfx_bolt_reload",
    },
    allowedSlots: ["optic", "muzzle", "mag"],
    defaultAttachments: { optic: "optic_6x_sniper" },
  },

  m870: {
    id: "m870",
    name: "M870 Breacher",
    category: "SHOTGUN",
    description: "12-gauge pump-action shotgun delivering devastating 8-pellet close-range blasts.",
    modelPath: "weapons/m870.glb",
    stats: {
      damage: { head: 24, chest: 15, limb: 11 }, // x8 pellets = 192 head / 120 chest
      armorPenetration: 0.3,
      pellets: 8,
      rpm: 75,
      fireModes: ["SINGLE"],
      magSize: 6,
      reserveMags: 4,
      reloadTimeSec: { tactical: 2.1, empty: 2.7 },
      adsTimeMs: 170,
      adsFov: 56,
      hipSpreadDeg: 4.2,
      adsSpreadDeg: 2.6,
      moveSpeedMultiplier: 0.95,
      wallbangPower: 0.25,
      maxRangeMeters: 40,
    },
    recoilPattern: {
      vertical: 4.2,
      horizontalJitter: 0.8,
      patternX: [0, 0.3],
      recoverySpeed: 6.5,
    },
    audio: {
      fire: "sfx_shotgun_shot",
      suppressed: "sfx_shotgun_shot",
      reloadTactical: "sfx_shotgun_reload",
      reloadEmpty: "sfx_shotgun_reload",
    },
    allowedSlots: ["optic", "muzzle"],
  },

  deagle: {
    id: "deagle",
    name: "Desert Eagle .50",
    category: "PISTOL",
    description: "High-impact .50 AE tactical sidearm capable of crisp 1-tap headshots.",
    modelPath: "weapons/deagle.glb",
    stats: {
      damage: { head: 125, chest: 52, limb: 38 },
      armorPenetration: 0.7,
      pellets: 1,
      rpm: 260,
      fireModes: ["SINGLE"],
      magSize: 7,
      reserveMags: 5,
      reloadTimeSec: { tactical: 1.45, empty: 1.85 },
      adsTimeMs: 130,
      adsFov: 58,
      hipSpreadDeg: 2.3,
      adsSpreadDeg: 0.14,
      moveSpeedMultiplier: 1.05,
      wallbangPower: 0.65,
      maxRangeMeters: 90,
    },
    recoilPattern: {
      vertical: 3.1,
      horizontalJitter: 0.45,
      patternX: [0, 0.2, -0.15, 0.25],
      recoverySpeed: 7.5,
    },
    audio: {
      fire: "sfx_deagle_shot",
      suppressed: "sfx_pistol_silenced",
      reloadTactical: "sfx_pistol_reload_tac",
      reloadEmpty: "sfx_pistol_reload_dry",
    },
    allowedSlots: ["optic", "muzzle", "mag"],
  },
};

export const WEAPON_LIST: WeaponBlueprint[] = Object.values(WEAPON_REGISTRY);
export const PRIMARY_WEAPON_IDS = WEAPON_LIST.filter((w) => w.category !== "PISTOL").map((w) => w.id);
export const SECONDARY_WEAPON_IDS = WEAPON_LIST.filter((w) => w.category === "PISTOL").map((w) => w.id);
