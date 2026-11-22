export type SkinRarity = "COMMON" | "RARE" | "EPIC" | "LEGENDARY";
export type CamoPatternType = "NONE" | "CARBON" | "CYBER_GRID" | "DESERT_DIGITAL" | "BRUSHED_METAL";

export interface MaterialZoneOverride {
  baseColorHex?: string;
  emissiveHex?: string;
  emissiveIntensity?: number;
  patternType?: CamoPatternType;
  patternKtx2?: string;
  uvScale?: number;
  roughness?: number;
  metallic?: number;
}

/**
 * Describes an imported 3D model that replaces the procedural gun body for a skin.
 * Positions are fractions of the fitted model's bounding box, so a new model only needs a handful of
 * numbers: x runs left to right, y bottom to top, z rear (0) to muzzle (1).
 */
export interface SkinModelSpec {
  /** Served path of the optimised binary glTF, e.g. /assets/models/weapons/m416_tactical.glb */
  url: string;
  /** Length of the gun from stock to muzzle in metres once in the game. */
  lengthM: number;
  /** Set when the model's barrel points the wrong way after loading. */
  flipForward?: boolean;
  /** Where the trigger hand holds the gun. */
  firingGrip: readonly [x: number, y: number, z: number];
  /** Where the support hand holds the gun (hand-guard). */
  supportGrip: readonly [x: number, y: number, z: number];
  /** Where attached optics sit on top of the gun: [y, z]. */
  optic: readonly [y: number, z: number];
  /** Where an underbarrel grip attaches below the hand-guard: [y, z]. */
  underbarrel: readonly [y: number, z: number];
  /** Height of the muzzle: fraction of the model's height. */
  muzzleY: number;
  /** Optional iron-sight height override when no optic is mounted. */
  adsIronHeightBoost?: number;
  /** Optional iron-sight Z position override. */
  adsIronZ?: number;
}

export interface SkinBlueprint {
  id: string;
  name: string;
  rarity: SkinRarity;
  previewGradient: string;
  targetWeaponId?: string; // Omit = UNIVERSAL (works across all current & future weapons)
  unlockLevel?: number;
  /** Optional imported model. The skin then ignores the colour zones and shows the model as authored. */
  model?: SkinModelSpec;
  materials: {
    primary: MaterialZoneOverride;
    secondary: MaterialZoneOverride;
    accent: MaterialZoneOverride;
  };
}

/**
 * Zero-Bloat Modular Skin Registry.
 * Works via standardized 3 PBR material zones (Mat_Body_Primary, Mat_Metal_Secondary, Mat_Grip_Accent)
 * so creating 1 skin instantly unlocks it on all 8+ current and future guns.
 */
export const SKIN_REGISTRY: Record<string, SkinBlueprint> = {
  arctic_service: {
    id: "arctic_service",
    name: "Arctic Service",
    rarity: "RARE",
    unlockLevel: 2,
    previewGradient: "linear-gradient(135deg, #dbe9ec, #526673)",
    materials: {
      primary: { baseColorHex: "#cad9df", roughness: 0.52, patternType: "DESERT_DIGITAL" },
      secondary: { baseColorHex: "#546974", roughness: 0.4, metallic: 0.65 },
      accent: { baseColorHex: "#15242c", roughness: 0.76 },
    },
  },
  redline_veteran: {
    id: "redline_veteran",
    name: "Redline Veteran",
    rarity: "EPIC",
    unlockLevel: 4,
    previewGradient: "linear-gradient(135deg, #201a22, #bd443d)",
    materials: {
      primary: { baseColorHex: "#38303a", roughness: 0.38, patternType: "CARBON" },
      secondary: { baseColorHex: "#a03f3a", roughness: 0.48, metallic: 0.65 },
      accent: { baseColorHex: "#57201e", roughness: 0.67 },
    },
  },
  standard_issue: {
    id: "standard_issue",
    name: "Factory Tactical",
    rarity: "COMMON",
    previewGradient: "linear-gradient(135deg, #2b3038 0%, #1a1d24 100%)",
    materials: {
      primary: { baseColorHex: "#2a2f38", roughness: 0.65, metallic: 0.25, patternType: "NONE" },
      secondary: { baseColorHex: "#1c2026", roughness: 0.35, metallic: 0.85 },
      accent: { baseColorHex: "#16181d", roughness: 0.88, metallic: 0.05 },
    },
  },
  carbon_gold: {
    id: "carbon_gold",
    name: "Carbon & Gold Elite",
    rarity: "EPIC",
    previewGradient: "linear-gradient(135deg, #1b1b1f 0%, #d4af37 100%)",
    materials: {
      primary: {
        baseColorHex: "#1d1e24",
        patternType: "CARBON",
        patternKtx2: "camos/carbon_fiber.ktx2",
        uvScale: 4,
        roughness: 0.32,
        metallic: 0.35,
      },
      secondary: { baseColorHex: "#f5c542", roughness: 0.16, metallic: 0.96 },
      accent: { baseColorHex: "#111215", roughness: 0.82, metallic: 0.1 },
    },
  },
  tokyo_neon: {
    id: "tokyo_neon",
    name: "Tokyo Neon Pulse",
    rarity: "LEGENDARY",
    previewGradient: "linear-gradient(135deg, #120428 0%, #00f0ff 50%, #ff007f 100%)",
    materials: {
      primary: {
        baseColorHex: "#14082b",
        emissiveHex: "#00f0ff",
        emissiveIntensity: 0.65,
        patternType: "CYBER_GRID",
        patternKtx2: "camos/cyber_grid.ktx2",
        uvScale: 3,
        roughness: 0.25,
        metallic: 0.55,
      },
      secondary: {
        baseColorHex: "#ff1684",
        emissiveHex: "#ff1684",
        emissiveIntensity: 0.45,
        roughness: 0.2,
        metallic: 0.85,
      },
      accent: { baseColorHex: "#0b0714", roughness: 0.75, metallic: 0.15 },
    },
  },
  desert_digital: {
    id: "desert_digital",
    name: "Miramar Desert Camo",
    rarity: "RARE",
    previewGradient: "linear-gradient(135deg, #c7a97e 0%, #8a6d4b 100%)",
    materials: {
      primary: {
        baseColorHex: "#c9ab7f",
        patternType: "DESERT_DIGITAL",
        patternKtx2: "camos/desert_digital.ktx2",
        uvScale: 3,
        roughness: 0.78,
        metallic: 0.08,
      },
      secondary: { baseColorHex: "#594833", roughness: 0.48, metallic: 0.65 },
      accent: { baseColorHex: "#3a3024", roughness: 0.9, metallic: 0.05 },
    },
  },
  m416_frost_crystal: {
    id: "m416_frost_crystal",
    name: "Frost Crystal (M416)",
    rarity: "LEGENDARY",
    targetWeaponId: "m416",
    previewGradient: "linear-gradient(135deg, #7c3aed 0%, #38bdf8 55%, #e0f2fe 100%)",
    model: {
      url: "/assets/models/weapons/m416_frost_crystal.glb",
      lengthM: 0.72,
      firingGrip: [0.5, 0.3, 0.31],
      supportGrip: [0.5, 0.44, 0.68],
      optic: [0.7, 0.6],
      underbarrel: [0.42, 0.7],
      muzzleY: 0.57,
    },
    materials: {
      primary: { baseColorHex: "#6d4bd1", roughness: 0.35, metallic: 0.3 },
      secondary: { baseColorHex: "#38bdf8", roughness: 0.3, metallic: 0.6 },
      accent: { baseColorHex: "#e0f2fe", roughness: 0.5, metallic: 0.1 },
    },
  },
  m416_lizard_roar: {
    id: "m416_lizard_roar",
    name: "Lizard Roar (M416)",
    rarity: "LEGENDARY",
    targetWeaponId: "m416",
    previewGradient: "linear-gradient(135deg, #1d4ed8 0%, #a3e635 55%, #c026d3 100%)",
    model: {
      url: "/assets/models/weapons/m416_lizard_roar.glb",
      lengthM: 0.72,
      firingGrip: [0.5, 0.3, 0.3],
      supportGrip: [0.5, 0.5, 0.68],
      optic: [0.86, 0.58],
      underbarrel: [0.5, 0.68],
      muzzleY: 0.74,
    },
    materials: {
      primary: { baseColorHex: "#1d4ed8", roughness: 0.4, metallic: 0.3 },
      secondary: { baseColorHex: "#a3e635", roughness: 0.4, metallic: 0.4 },
      accent: { baseColorHex: "#c026d3", roughness: 0.5, metallic: 0.2 },
    },
  },
  akm_scarecrow: {
    id: "akm_scarecrow",
    name: "Scarecrow (AKM)",
    rarity: "LEGENDARY",
    targetWeaponId: "akm",
    previewGradient: "linear-gradient(135deg, #78350f 0%, #d9a441 55%, #dc2626 100%)",
    model: {
      url: "/assets/models/weapons/akm_scarecrow.glb",
      lengthM: 0.8,
      firingGrip: [0.5, 0.45, 0.35],
      supportGrip: [0.5, 0.66, 0.72],
      optic: [0.96, 0.5],
      underbarrel: [0.62, 0.74],
      muzzleY: 0.8,
    },
    materials: {
      primary: { baseColorHex: "#b9853b", roughness: 0.7, metallic: 0.1 },
      secondary: { baseColorHex: "#3a2a1a", roughness: 0.5, metallic: 0.5 },
      accent: { baseColorHex: "#dc2626", roughness: 0.6, metallic: 0.1 },
    },
  },
  crimson_viper: {
    id: "crimson_viper",
    name: "Crimson Anodized",
    rarity: "EPIC",
    previewGradient: "linear-gradient(135deg, #a81020 0%, #1c1c20 100%)",
    materials: {
      primary: { baseColorHex: "#b01222", roughness: 0.28, metallic: 0.78, patternType: "NONE" },
      secondary: { baseColorHex: "#1b1d22", roughness: 0.25, metallic: 0.9 },
      accent: {
        baseColorHex: "#e01a2f",
        emissiveHex: "#750812",
        emissiveIntensity: 0.2,
        roughness: 0.6,
        metallic: 0.2,
      },
    },
  },
  arctic_titanium: {
    id: "arctic_titanium",
    name: "Arctic Titanium",
    rarity: "RARE",
    previewGradient: "linear-gradient(135deg, #eef3f8 0%, #68829e 100%)",
    materials: {
      primary: {
        baseColorHex: "#e2e8f0",
        patternType: "BRUSHED_METAL",
        roughness: 0.3,
        metallic: 0.72,
      },
      secondary: { baseColorHex: "#4d6782", roughness: 0.22, metallic: 0.92 },
      accent: { baseColorHex: "#1f2933", roughness: 0.75, metallic: 0.15 },
    },
  },
};

export const SKIN_LIST: SkinBlueprint[] = Object.values(SKIN_REGISTRY);

/** Skins that may be equipped on a gun: universal skins plus any made for that exact weapon. */
export function skinsForWeapon(weaponId: string): SkinBlueprint[] {
  return SKIN_LIST.filter((skin) => !skin.targetWeaponId || skin.targetWeaponId === weaponId);
}

/** Cache key under which a skin's imported model is stored. */
export function skinModelKey(skinId: string): string {
  return "skin:" + skinId;
}
