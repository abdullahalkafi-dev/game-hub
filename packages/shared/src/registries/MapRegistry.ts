import type { Vec3 } from "../math/ScratchMath.js";

export type SurfaceMaterialTag =
  | "CONCRETE"
  | "METAL"
  | "WOOD_THIN"
  | "SHEET_METAL"
  | "GLASS"
  | "EXPLOSIVE_BARREL"
  | "SANDSTONE"
  | "NEON_TRIM";

export interface MapBlockSpec {
  id: string;
  position: Vec3; // Center position in world space
  size: Vec3;     // Full dimensions (width, height, depth)
  rotationY?: number;
  material: SurfaceMaterialTag;
  colorHex: string;
  emissiveHex?: string;
  destructible?: boolean;
  maxHp?: number;
  isCatwalk?: boolean;
  isPuddle?: boolean; // Visual wet reflection patch on floor
  isRamp?: boolean;   // Tilted ramp for smooth climb
  rotationX?: number;
}

export interface MapSpawnSpec {
  position: Vec3;
  yaw: number;
}

export interface MapBlueprint {
  id: string;
  name: string;
  subtitle: string;
  theme: "CARGO_DOCKS" | "DESERT_OUTPOST" | "NEON_ROOFTOP";
  skyColorHex: string;
  fogColorHex: string;
  fogDensity: number;
  ambientHex: string;
  sunDirection: Vec3;
  sunColorHex: string;
  floorSize: { width: number; depth: number };
  floorMaterial: SurfaceMaterialTag;
  floorColorHex: string;
  blocks: MapBlockSpec[];
  spawnsA: MapSpawnSpec[];
  spawnsB: MapSpawnSpec[];
  spawnScreenZ?: number;
  overtimeZone: { center: Vec3; radius: number };
  bombSite: { center: Vec3; radius: number };
  warmupTargets: Vec3[];
  botWaypoints: Vec3[];
  previewAccentHex: string;
}

const CARGO_SPAWN_SCREEN_Z = 21.8;
const DESERT_SPAWN_SCREEN_Z = 20.7;
const ROOFTOP_SPAWN_SCREEN_Z = 18.7;

function spawnCover(screenZ: number, material: SurfaceMaterialTag, colorHex: string): MapBlockSpec[] {
  return ([-1, 1] as const).flatMap((end) => {
    const team = end < 0 ? "a" : "b";
    const screens = ([-1, 1] as const).map((side) => ({
      id: `spawn_screen_${team}_${side < 0 ? "west" : "east"}`,
      position: { x: side * 8, y: 1.15, z: end * screenZ },
      size: { x: 11.6, y: 2.3, z: 0.55 },
      material,
      colorHex,
    }));
    return [...screens, {
      id: `spawn_peek_${team}`,
      position: { x: 0, y: 0.67, z: end * (screenZ - 2.4) },
      size: { x: 3, y: 1.34, z: 0.7 },
      material,
      colorHex,
    }];
  });
}

/**
 * 3 Complete Arenas:
 * 1. Cargo Docks (wet asphalt puddles, shipping containers, sniper catwalks, explosive red fuel drums, wood wallbang crates)
 * 2. Desert Outpost (sandstone compounds, climbable rooftops, bazaar arch, thin wood market stalls)
 * 3. Neon Rooftop (night skyscraper helipad, volumetric neon signage, shatterable glass cover panels, HVAC cover)
 */
export const MAP_REGISTRY: Record<string, MapBlueprint> = {
  cargo_docks: {
    id: "cargo_docks",
    name: "Cargo Docks",
    subtitle: "Shipping containers, sniper catwalks, wet asphalt reflections & explosive drums.",
    theme: "CARGO_DOCKS",
    skyColorHex: "#49667d",
    fogColorHex: "#49667d",
    fogDensity: 0.006,
    ambientHex: "#6f8699",
    sunDirection: { x: -0.45, y: -0.8, z: 0.35 },
    sunColorHex: "#ffe6c2",
    floorSize: { width: 52, depth: 64 },
    floorMaterial: "CONCRETE",
    floorColorHex: "#2d333b",
    previewAccentHex: "#38bdf8",
    spawnScreenZ: CARGO_SPAWN_SCREEN_Z,
    spawnsA: [
      { position: { x: -6, y: 0, z: -26 }, yaw: 0 },
      { position: { x: 6, y: 0, z: -26 }, yaw: 0 },
      { position: { x: -12, y: 0, z: -24 }, yaw: 0.15 },
      { position: { x: 12, y: 0, z: -24 }, yaw: -0.15 },
    ],
    spawnsB: [
      { position: { x: -6, y: 0, z: 26 }, yaw: Math.PI },
      { position: { x: 6, y: 0, z: 26 }, yaw: Math.PI },
      { position: { x: -12, y: 0, z: 24 }, yaw: Math.PI - 0.15 },
      { position: { x: 12, y: 0, z: 24 }, yaw: Math.PI + 0.15 },
    ],
    overtimeZone: { center: { x: 0, y: 0.05, z: 0 }, radius: 4.0 },
    bombSite: { center: { x: 0, y: 0.05, z: 2 }, radius: 3.5 },
    warmupTargets: [
      { x: -7, y: 1.4, z: 5 },
      { x: 0, y: 1.4, z: 9 },
      { x: 7, y: 1.4, z: 5 },
      { x: -14, y: 3.9, z: 0 },
      { x: 14, y: 3.9, z: 0 },
    ],
    botWaypoints: [
      { x: 0, y: 0, z: -12 },
      { x: -11, y: 0, z: -8 },
      { x: 11, y: 0, z: -8 },
      { x: 0, y: 0, z: 0 },
      { x: -11, y: 0, z: 8 },
      { x: 11, y: 0, z: 8 },
      { x: 0, y: 0, z: 12 },
      { x: -18, y: 2.6, z: 0 },
      { x: 18, y: 2.6, z: 0 },
    ],
    blocks: [
      ...spawnCover(CARGO_SPAWN_SCREEN_Z, "CONCRETE", "#788d91"),
      // Perimeter walls
      { id: "wall_n", position: { x: 0, y: 3.5, z: 32 }, size: { x: 52, y: 7, z: 1.5 }, material: "CONCRETE", colorHex: "#3e4650" },
      { id: "wall_s", position: { x: 0, y: 3.5, z: -32 }, size: { x: 52, y: 7, z: 1.5 }, material: "CONCRETE", colorHex: "#3e4650" },
      { id: "wall_w", position: { x: -26, y: 3.5, z: 0 }, size: { x: 1.5, y: 7, z: 64 }, material: "CONCRETE", colorHex: "#3e4650" },
      { id: "wall_e", position: { x: 26, y: 3.5, z: 0 }, size: { x: 1.5, y: 7, z: 64 }, material: "CONCRETE", colorHex: "#3e4650" },

      // Wet asphalt reflection puddles (visual only)
      { id: "puddle_1", position: { x: -4, y: 0.015, z: -5 }, size: { x: 6, y: 0.02, z: 8 }, material: "CONCRETE", colorHex: "#1c242e", isPuddle: true },
      { id: "puddle_2", position: { x: 5, y: 0.015, z: 6 }, size: { x: 7, y: 0.02, z: 5 }, material: "CONCRETE", colorHex: "#1c242e", isPuddle: true },

      // Main shipping containers (symmetrical tactical lanes)
      { id: "cont_a_left", position: { x: -9.5, y: 1.45, z: -13 }, size: { x: 3.0, y: 2.9, z: 7.5 }, material: "METAL", colorHex: "#1d5c8c" },
      { id: "cont_a_right", position: { x: 9.5, y: 1.45, z: -13 }, size: { x: 3.0, y: 2.9, z: 7.5 }, material: "METAL", colorHex: "#b34429" },
      { id: "cont_b_left", position: { x: -9.5, y: 1.45, z: 13 }, size: { x: 3.0, y: 2.9, z: 7.5 }, material: "METAL", colorHex: "#b34429" },
      { id: "cont_b_right", position: { x: 9.5, y: 1.45, z: 13 }, size: { x: 3.0, y: 2.9, z: 7.5 }, material: "METAL", colorHex: "#1d5c8c" },

      // Center double-stacked dock landmark & flank lanes
      { id: "cont_mid_w", position: { x: -6.2, y: 1.45, z: 0 }, size: { x: 3.0, y: 2.9, z: 7.0 }, material: "METAL", colorHex: "#2d6a4f" },
      { id: "cont_mid_e", position: { x: 6.2, y: 1.45, z: 0 }, size: { x: 3.0, y: 2.9, z: 7.0 }, material: "METAL", colorHex: "#d48826" },
      { id: "cont_mid_top", position: { x: -6.2, y: 4.35, z: 0 }, size: { x: 3.0, y: 2.9, z: 7.0 }, material: "METAL", colorHex: "#3a5a40" },

      // Waist-high vaultable concrete barriers & thin wood wallbang crates
      { id: "vault_mid_n", position: { x: 0, y: 0.52, z: 6.5 }, size: { x: 4.2, y: 1.04, z: 0.7 }, material: "CONCRETE", colorHex: "#6c757d" },
      { id: "vault_mid_s", position: { x: 0, y: 0.52, z: -6.5 }, size: { x: 4.2, y: 1.04, z: 0.7 }, material: "CONCRETE", colorHex: "#6c757d" },
      { id: "crate_wb_1", position: { x: -1.8, y: 0.85, z: 0 }, size: { x: 1.4, y: 1.7, z: 0.25 }, material: "WOOD_THIN", colorHex: "#8d6338" },
      { id: "crate_wb_2", position: { x: 1.8, y: 0.85, z: 0 }, size: { x: 1.4, y: 1.7, z: 0.25 }, material: "WOOD_THIN", colorHex: "#8d6338" },
      { id: "crate_wb_a", position: { x: 0, y: 0.8, z: -15 }, size: { x: 3.4, y: 1.6, z: 0.28 }, material: "WOOD_THIN", colorHex: "#9c6d3b" },
      { id: "crate_wb_b", position: { x: 0, y: 0.8, z: 15 }, size: { x: 3.4, y: 1.6, z: 0.28 }, material: "WOOD_THIN", colorHex: "#9c6d3b" },

      // Sniper catwalks (West & East elevated walkways + ramps)
      { id: "catwalk_w", position: { x: -19, y: 2.5, z: 0 }, size: { x: 4.2, y: 0.35, z: 20 }, material: "SHEET_METAL", colorHex: "#55606e", isCatwalk: true },
      { id: "catwalk_w_rail", position: { x: -17.0, y: 3.15, z: 0 }, size: { x: 0.16, y: 0.95, z: 16 }, material: "SHEET_METAL", colorHex: "#6b7785" },
      { id: "ramp_w_s", position: { x: -19, y: 1.25, z: -14 }, size: { x: 3.4, y: 0.3, z: 9.2 }, rotationX: -0.28, material: "METAL", colorHex: "#49535e", isRamp: true },
      { id: "ramp_w_n", position: { x: -19, y: 1.25, z: 14 }, size: { x: 3.4, y: 0.3, z: 9.2 }, rotationX: 0.28, material: "METAL", colorHex: "#49535e", isRamp: true },

      { id: "catwalk_e", position: { x: 19, y: 2.5, z: 0 }, size: { x: 4.2, y: 0.35, z: 20 }, material: "SHEET_METAL", colorHex: "#55606e", isCatwalk: true },
      { id: "catwalk_e_rail", position: { x: 17.0, y: 3.15, z: 0 }, size: { x: 0.16, y: 0.95, z: 16 }, material: "SHEET_METAL", colorHex: "#6b7785" },
      { id: "ramp_e_s", position: { x: 19, y: 1.25, z: -14 }, size: { x: 3.4, y: 0.3, z: 9.2 }, rotationX: -0.28, material: "METAL", colorHex: "#49535e", isRamp: true },
      { id: "ramp_e_n", position: { x: 19, y: 1.25, z: 14 }, size: { x: 3.4, y: 0.3, z: 9.2 }, rotationX: 0.28, material: "METAL", colorHex: "#49535e", isRamp: true },

      // Explosive red fuel barrels (destructible micro-destruction)
      { id: "barrel_1", position: { x: -12.5, y: 0.65, z: -7.5 }, size: { x: 0.85, y: 1.3, z: 0.85 }, material: "EXPLOSIVE_BARREL", colorHex: "#d62828", destructible: true, maxHp: 45 },
      { id: "barrel_2", position: { x: 12.5, y: 0.65, z: 7.5 }, size: { x: 0.85, y: 1.3, z: 0.85 }, material: "EXPLOSIVE_BARREL", colorHex: "#d62828", destructible: true, maxHp: 45 },
      { id: "barrel_3", position: { x: 12.5, y: 0.65, z: -7.5 }, size: { x: 0.85, y: 1.3, z: 0.85 }, material: "EXPLOSIVE_BARREL", colorHex: "#d62828", destructible: true, maxHp: 45 },
      { id: "barrel_4", position: { x: -12.5, y: 0.65, z: 7.5 }, size: { x: 0.85, y: 1.3, z: 0.85 }, material: "EXPLOSIVE_BARREL", colorHex: "#d62828", destructible: true, maxHp: 45 },
    ],
  },

  desert_outpost: {
    id: "desert_outpost",
    name: "Desert Outpost",
    subtitle: "PUBG Miramar-inspired sandstone compounds, climbable roofs & wallbang stalls.",
    theme: "DESERT_OUTPOST",
    skyColorHex: "#e0b685",
    fogColorHex: "#d9aa73",
    fogDensity: 0.0055,
    ambientHex: "#d9a977",
    sunDirection: { x: -0.6, y: -0.65, z: 0.45 },
    sunColorHex: "#fff0d4",
    floorSize: { width: 54, depth: 62 },
    floorMaterial: "SANDSTONE",
    floorColorHex: "#c29b68",
    previewAccentHex: "#f59e0b",
    spawnScreenZ: DESERT_SPAWN_SCREEN_Z,
    spawnsA: [
      { position: { x: -5, y: 0, z: -25 }, yaw: 0 },
      { position: { x: 5, y: 0, z: -25 }, yaw: 0 },
      { position: { x: -11, y: 0, z: -23 }, yaw: 0.1 },
      { position: { x: 11, y: 0, z: -23 }, yaw: -0.1 },
    ],
    spawnsB: [
      { position: { x: -5, y: 0, z: 25 }, yaw: Math.PI },
      { position: { x: 5, y: 0, z: 25 }, yaw: Math.PI },
      { position: { x: -11, y: 0, z: 23 }, yaw: Math.PI - 0.1 },
      { position: { x: 11, y: 0, z: 23 }, yaw: Math.PI + 0.1 },
    ],
    overtimeZone: { center: { x: 0, y: 0.05, z: 0 }, radius: 4.0 },
    bombSite: { center: { x: 0, y: 0.05, z: 0 }, radius: 3.5 },
    warmupTargets: [
      { x: -6, y: 1.4, z: 6 },
      { x: 0, y: 1.4, z: 10 },
      { x: 6, y: 1.4, z: 6 },
      { x: -14, y: 4.2, z: 0 },
      { x: 14, y: 4.2, z: 0 },
    ],
    botWaypoints: [
      { x: 0, y: 0, z: -13 },
      { x: -10, y: 0, z: -6 },
      { x: 10, y: 0, z: -6 },
      { x: 0, y: 0, z: 0 },
      { x: -10, y: 0, z: 6 },
      { x: 10, y: 0, z: 6 },
      { x: 0, y: 0, z: 13 },
    ],
    blocks: [
      ...spawnCover(DESERT_SPAWN_SCREEN_Z, "SANDSTONE", "#be976f"),
      { id: "d_wall_n", position: { x: 0, y: 3.5, z: 31 }, size: { x: 54, y: 7, z: 1.5 }, material: "SANDSTONE", colorHex: "#b08452" },
      { id: "d_wall_s", position: { x: 0, y: 3.5, z: -31 }, size: { x: 54, y: 7, z: 1.5 }, material: "SANDSTONE", colorHex: "#b08452" },
      { id: "d_wall_w", position: { x: -27, y: 3.5, z: 0 }, size: { x: 1.5, y: 7, z: 62 }, material: "SANDSTONE", colorHex: "#b08452" },
      { id: "d_wall_e", position: { x: 27, y: 3.5, z: 0 }, size: { x: 1.5, y: 7, z: 62 }, material: "SANDSTONE", colorHex: "#b08452" },

      // West & East two-story sandstone compounds with accessible rooftops
      { id: "comp_w_base", position: { x: -15.5, y: 1.5, z: 0 }, size: { x: 7, y: 3.0, z: 14 }, material: "SANDSTONE", colorHex: "#cfa97c" },
      { id: "comp_w_parapet", position: { x: -12.3, y: 3.45, z: 0 }, size: { x: 0.4, y: 0.9, z: 13 }, material: "SANDSTONE", colorHex: "#b89060" },
      { id: "comp_w_ramp_s", position: { x: -15.5, y: 1.5, z: -11.5 }, size: { x: 3.6, y: 0.35, z: 10.5 }, rotationX: -0.3, material: "SANDSTONE", colorHex: "#9e774a", isRamp: true },
      { id: "comp_w_ramp_n", position: { x: -15.5, y: 1.5, z: 11.5 }, size: { x: 3.6, y: 0.35, z: 10.5 }, rotationX: 0.3, material: "SANDSTONE", colorHex: "#9e774a", isRamp: true },

      { id: "comp_e_base", position: { x: 15.5, y: 1.5, z: 0 }, size: { x: 7, y: 3.0, z: 14 }, material: "SANDSTONE", colorHex: "#cfa97c" },
      { id: "comp_e_parapet", position: { x: 12.3, y: 3.45, z: 0 }, size: { x: 0.4, y: 0.9, z: 13 }, material: "SANDSTONE", colorHex: "#b89060" },
      { id: "comp_e_ramp_s", position: { x: 15.5, y: 1.5, z: -11.5 }, size: { x: 3.6, y: 0.35, z: 10.5 }, rotationX: -0.3, material: "SANDSTONE", colorHex: "#9e774a", isRamp: true },
      { id: "comp_e_ramp_n", position: { x: 15.5, y: 1.5, z: 11.5 }, size: { x: 3.6, y: 0.35, z: 10.5 }, rotationX: 0.3, material: "SANDSTONE", colorHex: "#9e774a", isRamp: true },

      // Central Bazaar courtyard pillars & wallbang wooden market shutters
      { id: "bazaar_pillar_1", position: { x: -4.5, y: 1.8, z: -5.5 }, size: { x: 2.2, y: 3.6, z: 2.2 }, material: "SANDSTONE", colorHex: "#b88f5e" },
      { id: "bazaar_pillar_2", position: { x: 4.5, y: 1.8, z: -5.5 }, size: { x: 2.2, y: 3.6, z: 2.2 }, material: "SANDSTONE", colorHex: "#b88f5e" },
      { id: "bazaar_pillar_3", position: { x: -4.5, y: 1.8, z: 5.5 }, size: { x: 2.2, y: 3.6, z: 2.2 }, material: "SANDSTONE", colorHex: "#b88f5e" },
      { id: "bazaar_pillar_4", position: { x: 4.5, y: 1.8, z: 5.5 }, size: { x: 2.2, y: 3.6, z: 2.2 }, material: "SANDSTONE", colorHex: "#b88f5e" },

      { id: "stall_wb_w", position: { x: -5.5, y: 0.95, z: 0 }, size: { x: 0.25, y: 1.9, z: 4.5 }, material: "WOOD_THIN", colorHex: "#7d532d" },
      { id: "stall_wb_e", position: { x: 5.5, y: 0.95, z: 0 }, size: { x: 0.25, y: 1.9, z: 4.5 }, material: "WOOD_THIN", colorHex: "#7d532d" },

      // Spawn courtyard cover walls (vaultable)
      { id: "sand_vault_a", position: { x: 0, y: 0.55, z: -15 }, size: { x: 8, y: 1.1, z: 0.8 }, material: "SANDSTONE", colorHex: "#a87e4d" },
      { id: "sand_vault_b", position: { x: 0, y: 0.55, z: 15 }, size: { x: 8, y: 1.1, z: 0.8 }, material: "SANDSTONE", colorHex: "#a87e4d" },
      { id: "sand_box_1", position: { x: -8, y: 0.65, z: -14 }, size: { x: 2.2, y: 1.3, z: 2.2 }, material: "WOOD_THIN", colorHex: "#8c5f34" },
      { id: "sand_box_2", position: { x: 8, y: 0.65, z: 14 }, size: { x: 2.2, y: 1.3, z: 2.2 }, material: "WOOD_THIN", colorHex: "#8c5f34" },
      { id: "d_barrel_1", position: { x: -2.6, y: 0.65, z: -5.5 }, size: { x: 0.85, y: 1.3, z: 0.85 }, material: "EXPLOSIVE_BARREL", colorHex: "#d62828", destructible: true, maxHp: 45 },
      { id: "d_barrel_2", position: { x: 2.6, y: 0.65, z: 5.5 }, size: { x: 0.85, y: 1.3, z: 0.85 }, material: "EXPLOSIVE_BARREL", colorHex: "#d62828", destructible: true, maxHp: 45 },
    ],
  },

  neon_rooftop: {
    id: "neon_rooftop",
    name: "Neon Rooftop",
    subtitle: "Night skyscraper helipad with glowing signage, shatterable glass & HVAC cover.",
    theme: "NEON_ROOFTOP",
    skyColorHex: "#0a0d1a",
    fogColorHex: "#0f152b",
    fogDensity: 0.007,
    ambientHex: "#2d3a66",
    sunDirection: { x: 0.3, y: -0.9, z: -0.3 },
    sunColorHex: "#7aa2ff",
    floorSize: { width: 48, depth: 58 },
    floorMaterial: "CONCRETE",
    floorColorHex: "#191d29",
    previewAccentHex: "#ec4899",
    spawnScreenZ: ROOFTOP_SPAWN_SCREEN_Z,
    spawnsA: [
      { position: { x: -5, y: 0, z: -23 }, yaw: 0 },
      { position: { x: 5, y: 0, z: -23 }, yaw: 0 },
      { position: { x: -11, y: 0, z: -21 }, yaw: 0.1 },
      { position: { x: 11, y: 0, z: -21 }, yaw: -0.1 },
    ],
    spawnsB: [
      { position: { x: -5, y: 0, z: 23 }, yaw: Math.PI },
      { position: { x: 5, y: 0, z: 23 }, yaw: Math.PI },
      { position: { x: -11, y: 0, z: 21 }, yaw: Math.PI - 0.1 },
      { position: { x: 11, y: 0, z: 21 }, yaw: Math.PI + 0.1 },
    ],
    overtimeZone: { center: { x: 0, y: 0.05, z: 0 }, radius: 4.0 },
    bombSite: { center: { x: 0, y: 0.05, z: 0 }, radius: 3.8 },
    warmupTargets: [
      { x: -6, y: 1.4, z: 5 },
      { x: 0, y: 1.4, z: 8 },
      { x: 6, y: 1.4, z: 5 },
      { x: -12, y: 3.1, z: 0 },
      { x: 12, y: 3.1, z: 0 },
    ],
    botWaypoints: [
      { x: 0, y: 0, z: -11 },
      { x: -10, y: 0, z: -5 },
      { x: 10, y: 0, z: -5 },
      { x: 0, y: 0, z: 0 },
      { x: -10, y: 0, z: 5 },
      { x: 10, y: 0, z: 5 },
      { x: 0, y: 0, z: 11 },
    ],
    blocks: [
      ...spawnCover(ROOFTOP_SPAWN_SCREEN_Z, "CONCRETE", "#666c83"),
      // Rooftop glass & concrete perimeter parapets
      { id: "n_wall_n", position: { x: 0, y: 1.6, z: 29 }, size: { x: 48, y: 3.2, z: 1.0 }, material: "CONCRETE", colorHex: "#23293a" },
      { id: "n_wall_s", position: { x: 0, y: 1.6, z: -29 }, size: { x: 48, y: 3.2, z: 1.0 }, material: "CONCRETE", colorHex: "#23293a" },
      { id: "n_wall_w", position: { x: -24, y: 1.6, z: 0 }, size: { x: 1.0, y: 3.2, z: 58 }, material: "CONCRETE", colorHex: "#23293a" },
      { id: "n_wall_e", position: { x: 24, y: 1.6, z: 0 }, size: { x: 1.0, y: 3.2, z: 58 }, material: "CONCRETE", colorHex: "#23293a" },

      // Glowing Neon Signage Towers
      { id: "neon_sign_w", position: { x: -22.5, y: 4.5, z: 0 }, size: { x: 0.6, y: 5.5, z: 16 }, material: "NEON_TRIM", colorHex: "#00f0ff", emissiveHex: "#00f0ff" },
      { id: "neon_sign_e", position: { x: 22.5, y: 4.5, z: 0 }, size: { x: 0.6, y: 5.5, z: 16 }, material: "NEON_TRIM", colorHex: "#ff007f", emissiveHex: "#ff007f" },
      { id: "neon_arch_n", position: { x: 0, y: 4.6, z: 28.2 }, size: { x: 18, y: 0.8, z: 0.4 }, material: "NEON_TRIM", colorHex: "#ff007f", emissiveHex: "#ff007f" },
      { id: "neon_arch_s", position: { x: 0, y: 4.6, z: -28.2 }, size: { x: 18, y: 0.8, z: 0.4 }, material: "NEON_TRIM", colorHex: "#00f0ff", emissiveHex: "#00f0ff" },

      // Raised center helipad deck
      { id: "helipad_deck", position: { x: 0, y: 0.18, z: 0 }, size: { x: 14, y: 0.36, z: 14 }, material: "CONCRETE", colorHex: "#262d40" },
      { id: "helipad_trim", position: { x: 0, y: 0.37, z: 0 }, size: { x: 9, y: 0.04, z: 9 }, material: "NEON_TRIM", colorHex: "#f59e0b", emissiveHex: "#f59e0b" },

      // Industrial HVAC units (climbable/elevated cover)
      { id: "hvac_w", position: { x: -13, y: 1.1, z: 0 }, size: { x: 4.2, y: 2.2, z: 7.5 }, material: "SHEET_METAL", colorHex: "#3b455e" },
      { id: "hvac_e", position: { x: 13, y: 1.1, z: 0 }, size: { x: 4.2, y: 2.2, z: 7.5 }, material: "SHEET_METAL", colorHex: "#3b455e" },
      { id: "hvac_nw", position: { x: -9, y: 0.85, z: 13 }, size: { x: 3.6, y: 1.7, z: 3.6 }, material: "SHEET_METAL", colorHex: "#354057" },
      { id: "hvac_ne", position: { x: 9, y: 0.85, z: 13 }, size: { x: 3.6, y: 1.7, z: 3.6 }, material: "SHEET_METAL", colorHex: "#354057" },
      { id: "hvac_sw", position: { x: -9, y: 0.85, z: -13 }, size: { x: 3.6, y: 1.7, z: 3.6 }, material: "SHEET_METAL", colorHex: "#354057" },
      { id: "hvac_se", position: { x: 9, y: 0.85, z: -13 }, size: { x: 3.6, y: 1.7, z: 3.6 }, material: "SHEET_METAL", colorHex: "#354057" },

      // 6 Shatterable Glass Skybridge Cover Panels (destructible!)
      { id: "glass_mid_1", position: { x: -4.2, y: 1.35, z: -5.2 }, size: { x: 3.2, y: 1.9, z: 0.16 }, material: "GLASS", colorHex: "#67e8f9", destructible: true, maxHp: 35 },
      { id: "glass_mid_2", position: { x: 4.2, y: 1.35, z: -5.2 }, size: { x: 3.2, y: 1.9, z: 0.16 }, material: "GLASS", colorHex: "#67e8f9", destructible: true, maxHp: 35 },
      { id: "glass_mid_3", position: { x: -4.2, y: 1.35, z: 5.2 }, size: { x: 3.2, y: 1.9, z: 0.16 }, material: "GLASS", colorHex: "#67e8f9", destructible: true, maxHp: 35 },
      { id: "glass_mid_4", position: { x: 4.2, y: 1.35, z: 5.2 }, size: { x: 3.2, y: 1.9, z: 0.16 }, material: "GLASS", colorHex: "#67e8f9", destructible: true, maxHp: 35 },
      { id: "glass_flank_w", position: { x: -18, y: 1.2, z: 0 }, size: { x: 3.5, y: 2.2, z: 0.16 }, material: "GLASS", colorHex: "#a5f3fc", destructible: true, maxHp: 35 },
      { id: "glass_flank_e", position: { x: 18, y: 1.2, z: 0 }, size: { x: 3.5, y: 2.2, z: 0.16 }, material: "GLASS", colorHex: "#a5f3fc", destructible: true, maxHp: 35 },
    ],
  },
};

export const MAP_LIST: MapBlueprint[] = Object.values(MAP_REGISTRY);
