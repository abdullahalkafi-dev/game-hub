import { clamp } from "../math/ScratchMath.js";
import { DEFAULT_LIVERY_ID, isLiveryId, type LiveryId } from "./LiveryRegistry.js";
import {
  DEFAULT_VEHICLE_ID,
  getVehicleDefinition,
  isVehicleId,
  type EngineAudioProfile,
  type VehicleDrivetrain,
  type VehicleId,
  type VehicleStatsBars,
} from "./VehicleRegistry.js";

export type TuneId = "tune_street" | "tune_track" | "tune_drift";
export type SpoilerId = "spoiler_none" | "spoiler_gt_wing" | "spoiler_ducktail";
export type RimId = "rim_sport" | "rim_mesh_gold" | "rim_aero_carbon";
export type UnderglowId =
  | "underglow_none"
  | "underglow_cyan"
  | "underglow_magenta"
  | "underglow_amber"
  | "underglow_emerald";

export type TransmissionMode = "AUTO" | "MANUAL";

export interface TuneDefinition {
  id: TuneId;
  name: string;
  description: string;
  topSpeedMult: number;
  accelMult: number;
  brakingMult: number;
  lateralGripMult: number;
  driftGripMult: number;
  driftControlMult: number;
  nitroChargeMult: number;
  statDeltas: VehicleStatsBars;
}

export interface SpoilerDefinition {
  id: SpoilerId;
  name: string;
  style: "NONE" | "GT_WING" | "DUCKTAIL";
  description: string;
}

export interface RimDefinition {
  id: RimId;
  name: string;
  style: "SPORT_5SPOKE" | "MESH_GOLD" | "AERO_CARBON";
  spokeCount: number;
  overrideTintHex: string | null;
  description: string;
}

export interface UnderglowDefinition {
  id: UnderglowId;
  name: string;
  /** Emissive hex color when equipped, or null for off */
  hex: string | null;
  /** Swatch display color for UI buttons */
  swatchHex: string;
}

export interface CarSetupConfig {
  vehicleId: VehicleId;
  liveryId: LiveryId;
  tuneId: TuneId;
  spoilerId: SpoilerId;
  rimId: RimId;
  underglowId: UnderglowId;
  transmission: TransmissionMode;
}

export interface EffectiveVehicleStats {
  vehicleId: VehicleId;
  tuneId: TuneId;
  name: string;
  drivetrain: VehicleDrivetrain;
  engineAudioProfile: EngineAudioProfile;
  bars: VehicleStatsBars;
  massKg: number;
  wheelbaseM: number;
  trackWidthM: number;
  wheelRadiusM: number;
  topSpeedKmh: number;
  topSpeedMps: number;
  reverseSpeedMps: number;
  accelerationMps2: number;
  brakingMps2: number;
  lateralGrip: number;
  driftGrip: number;
  driftControl: number;
  maxSteerAngleRad: number;
  suspensionStiffness: number;
  suspensionDamping: number;
  rollFactor: number;
  pitchFactor: number;
  nitroCapacity: number;
  nitroBoostMultiplier: number;
  nitroBurnRate: number;
  nitroDriftChargeRate: number;
  idleRpm: number;
  redlineRpm: number;
  gearTopSpeedsKmh: readonly [number, number, number, number, number, number];
}

export const TUNE_REGISTRY: Record<TuneId, TuneDefinition> = {
  tune_street: {
    id: "tune_street",
    name: "Street Balanced",
    description: "Factory-balanced gear ratios, clean turn-in, and dependable drift recovery.",
    topSpeedMult: 1.0,
    accelMult: 1.0,
    brakingMult: 1.0,
    lateralGripMult: 1.0,
    driftGripMult: 1.0,
    driftControlMult: 1.0,
    nitroChargeMult: 1.0,
    statDeltas: { topSpeed: 0, acceleration: 0, driftGrip: 0 },
  },
  tune_track: {
    id: "tune_track",
    name: "Track Grip",
    description: "High-downforce suspension and longer final drive for peak apex velocity.",
    topSpeedMult: 1.05,
    accelMult: 1.04,
    brakingMult: 1.1,
    lateralGripMult: 1.16,
    driftGripMult: 1.14,
    driftControlMult: 0.94,
    nitroChargeMult: 0.92,
    statDeltas: { topSpeed: 6, acceleration: 4, driftGrip: -4 },
  },
  tune_drift: {
    id: "tune_drift",
    name: "Drift Spec",
    description: "Increased steering lock, looser rear slip angle, and +28% faster Nitro charge.",
    topSpeedMult: 0.97,
    accelMult: 1.03,
    brakingMult: 0.98,
    lateralGripMult: 0.92,
    driftGripMult: 0.84,
    driftControlMult: 1.22,
    nitroChargeMult: 1.28,
    statDeltas: { topSpeed: -3, acceleration: 3, driftGrip: 9 },
  },
};

export const SPOILER_REGISTRY: Record<SpoilerId, SpoilerDefinition> = {
  spoiler_none: {
    id: "spoiler_none",
    name: "Clean Deck",
    style: "NONE",
    description: "Factory streamlined rear deck with zero aero clutter.",
  },
  spoiler_gt_wing: {
    id: "spoiler_gt_wing",
    name: "Carbon GT Wing",
    style: "GT_WING",
    description: "Twin-pylon motorsport swan-neck wing with carbon endplates.",
  },
  spoiler_ducktail: {
    id: "spoiler_ducktail",
    name: "Street Ducktail",
    style: "DUCKTAIL",
    description: "Low-slung integrated lip spoiler for timeless touge aesthetics.",
  },
};

export const RIM_REGISTRY: Record<RimId, RimDefinition> = {
  rim_sport: {
    id: "rim_sport",
    name: "Forged 5-Spoke",
    style: "SPORT_5SPOKE",
    spokeCount: 5,
    overrideTintHex: null,
    description: "Lightweight forged split-5 alloys matched to your livery.",
  },
  rim_mesh_gold: {
    id: "rim_mesh_gold",
    name: "Motorsport Gold Mesh",
    style: "MESH_GOLD",
    spokeCount: 10,
    overrideTintHex: "#e3b549",
    description: "Deep-dish anodized gold Y-mesh racing wheels.",
  },
  rim_aero_carbon: {
    id: "rim_aero_carbon",
    name: "Aero Carbon Disc",
    style: "AERO_CARBON",
    spokeCount: 6,
    overrideTintHex: "#1c2028",
    description: "Satin carbon turbine blades built for cooling hot brake rotors.",
  },
};

export const UNDERGLOW_REGISTRY: Record<UnderglowId, UnderglowDefinition> = {
  underglow_none: {
    id: "underglow_none",
    name: "Off",
    hex: null,
    swatchHex: "#283040",
  },
  underglow_cyan: {
    id: "underglow_cyan",
    name: "Cyber Cyan",
    hex: "#00f0ff",
    swatchHex: "#00f0ff",
  },
  underglow_magenta: {
    id: "underglow_magenta",
    name: "Tokyo Magenta",
    hex: "#ff26a8",
    swatchHex: "#ff26a8",
  },
  underglow_amber: {
    id: "underglow_amber",
    name: "Solar Amber",
    hex: "#ff9b1a",
    swatchHex: "#ff9b1a",
  },
  underglow_emerald: {
    id: "underglow_emerald",
    name: "Neon Emerald",
    hex: "#00f59b",
    swatchHex: "#00f59b",
  },
};

export const TUNE_LIST: readonly TuneDefinition[] = Object.values(TUNE_REGISTRY);
export const SPOILER_LIST: readonly SpoilerDefinition[] = Object.values(SPOILER_REGISTRY);
export const RIM_LIST: readonly RimDefinition[] = Object.values(RIM_REGISTRY);
export const UNDERGLOW_LIST: readonly UnderglowDefinition[] = Object.values(UNDERGLOW_REGISTRY);

export const DEFAULT_TUNE_ID: TuneId = "tune_street";
export const DEFAULT_SPOILER_ID: SpoilerId = "spoiler_gt_wing";
export const DEFAULT_RIM_ID: RimId = "rim_sport";
export const DEFAULT_UNDERGLOW_ID: UnderglowId = "underglow_cyan";

export function getTuneDefinition(id?: string): TuneDefinition {
  if (id && id in TUNE_REGISTRY) return TUNE_REGISTRY[id as TuneId];
  return TUNE_REGISTRY[DEFAULT_TUNE_ID];
}

export function getSpoilerDefinition(id?: string): SpoilerDefinition {
  if (id && id in SPOILER_REGISTRY) return SPOILER_REGISTRY[id as SpoilerId];
  return SPOILER_REGISTRY[DEFAULT_SPOILER_ID];
}

export function getRimDefinition(id?: string): RimDefinition {
  if (id && id in RIM_REGISTRY) return RIM_REGISTRY[id as RimId];
  return RIM_REGISTRY[DEFAULT_RIM_ID];
}

export function getUnderglowDefinition(id?: string): UnderglowDefinition {
  if (id && id in UNDERGLOW_REGISTRY) return UNDERGLOW_REGISTRY[id as UnderglowId];
  return UNDERGLOW_REGISTRY[DEFAULT_UNDERGLOW_ID];
}

export function computeEffectiveVehicleStats(vehicleId: string, tuneId?: string): EffectiveVehicleStats {
  const vehicle = getVehicleDefinition(vehicleId);
  const tune = getTuneDefinition(tuneId);
  const topSpeedKmh = vehicle.topSpeedKmh * tune.topSpeedMult;
  const gearScale = tune.topSpeedMult;

  return {
    vehicleId: vehicle.id,
    tuneId: tune.id,
    name: vehicle.name,
    drivetrain: vehicle.drivetrain,
    engineAudioProfile: vehicle.engineAudioProfile,
    bars: {
      topSpeed: clamp(Math.round(vehicle.stats.topSpeed + tune.statDeltas.topSpeed), 10, 100),
      acceleration: clamp(Math.round(vehicle.stats.acceleration + tune.statDeltas.acceleration), 10, 100),
      driftGrip: clamp(Math.round(vehicle.stats.driftGrip + tune.statDeltas.driftGrip), 10, 100),
    },
    massKg: vehicle.massKg,
    wheelbaseM: vehicle.wheelbaseM,
    trackWidthM: vehicle.trackWidthM,
    wheelRadiusM: vehicle.wheelRadiusM,
    topSpeedKmh,
    topSpeedMps: topSpeedKmh / 3.6,
    reverseSpeedMps: vehicle.reverseSpeedKmh / 3.6,
    accelerationMps2: vehicle.accelerationMps2 * tune.accelMult,
    brakingMps2: vehicle.brakingMps2 * tune.brakingMult,
    lateralGrip: vehicle.lateralGrip * tune.lateralGripMult,
    driftGrip: vehicle.driftGrip * tune.driftGripMult,
    driftControl: vehicle.driftControl * tune.driftControlMult,
    maxSteerAngleRad: vehicle.maxSteerAngleRad * (tune.id === "tune_drift" ? 1.12 : 1.0),
    suspensionStiffness: vehicle.suspensionStiffness * (tune.id === "tune_track" ? 1.15 : 1.0),
    suspensionDamping: vehicle.suspensionDamping,
    rollFactor: vehicle.rollFactor * (tune.id === "tune_track" ? 0.85 : 1.0),
    pitchFactor: vehicle.pitchFactor,
    nitroCapacity: vehicle.nitroCapacity,
    nitroBoostMultiplier: vehicle.nitroBoostMultiplier,
    nitroBurnRate: vehicle.nitroBurnRate,
    nitroDriftChargeRate: vehicle.nitroDriftChargeRate * tune.nitroChargeMult,
    idleRpm: vehicle.idleRpm,
    redlineRpm: vehicle.redlineRpm,
    gearTopSpeedsKmh: [
      vehicle.gearTopSpeedsKmh[0] * gearScale,
      vehicle.gearTopSpeedsKmh[1] * gearScale,
      vehicle.gearTopSpeedsKmh[2] * gearScale,
      vehicle.gearTopSpeedsKmh[3] * gearScale,
      vehicle.gearTopSpeedsKmh[4] * gearScale,
      vehicle.gearTopSpeedsKmh[5] * gearScale,
    ],
  };
}

export function defaultCarSetup(): CarSetupConfig {
  return {
    vehicleId: DEFAULT_VEHICLE_ID,
    liveryId: DEFAULT_LIVERY_ID,
    tuneId: DEFAULT_TUNE_ID,
    spoilerId: DEFAULT_SPOILER_ID,
    rimId: DEFAULT_RIM_ID,
    underglowId: DEFAULT_UNDERGLOW_ID,
    transmission: "AUTO",
  };
}

export function sanitizeCarSetup(input?: Partial<CarSetupConfig>): CarSetupConfig {
  const base = defaultCarSetup();
  if (!input) return base;
  return {
    vehicleId: isVehicleId(input.vehicleId) ? input.vehicleId : base.vehicleId,
    liveryId: isLiveryId(input.liveryId) ? input.liveryId : base.liveryId,
    tuneId: input.tuneId && input.tuneId in TUNE_REGISTRY ? input.tuneId : base.tuneId,
    spoilerId: input.spoilerId && input.spoilerId in SPOILER_REGISTRY ? input.spoilerId : base.spoilerId,
    rimId: input.rimId && input.rimId in RIM_REGISTRY ? input.rimId : base.rimId,
    underglowId: input.underglowId && input.underglowId in UNDERGLOW_REGISTRY ? input.underglowId : base.underglowId,
    transmission: input.transmission === "MANUAL" ? "MANUAL" : "AUTO",
  };
}
