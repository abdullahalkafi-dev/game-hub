export type EngineAudioProfile = "V10_SUPER" | "I6_TURBO" | "V8_MUSCLE" | "BOXER_RALLY";

export type VehicleId = "apex_gt" | "skyline_r34" | "viper_v8" | "rally_rs";

export type VehicleDrivetrain = "RWD" | "AWD";

export interface VehicleStatsBars {
  /** 0..100 normalized top speed stat for Garage UI */
  topSpeed: number;
  /** 0..100 normalized acceleration stat for Garage UI */
  acceleration: number;
  /** 0..100 normalized drift & cornering grip stat for Garage UI */
  driftGrip: number;
}

export interface VehicleDefinition {
  id: VehicleId;
  name: string;
  classLabel: string;
  tagline: string;
  drivetrain: VehicleDrivetrain;
  /** Optional real glTF asset path (null uses sculpted procedural kit in RaceAssetCache) */
  modelAsset: string | null;
  engineAudioProfile: EngineAudioProfile;
  defaultLiveryId: string;
  stats: VehicleStatsBars;
  massKg: number;
  wheelbaseM: number;
  trackWidthM: number;
  wheelRadiusM: number;
  dimensions: {
    lengthM: number;
    widthM: number;
    heightM: number;
  };
  /** Base physics parameters (modified by TuneDefinition in CarPartRegistry) */
  topSpeedKmh: number;
  reverseSpeedKmh: number;
  accelerationMps2: number;
  brakingMps2: number;
  /** Cornering lateral grip while NOT drifting (higher = sharper rail grip) */
  lateralGrip: number;
  /** Lateral grip maintained while actively drifting (controls slide arc) */
  driftGrip: number;
  /** Yaw turn-in authority during active drift */
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

export const VEHICLE_REGISTRY: Record<VehicleId, VehicleDefinition> = {
  apex_gt: {
    id: "apex_gt",
    name: "Apex GT458",
    classLabel: "GT SUPERCAR",
    tagline: "Mid-engine V10 razor with ferocious top-end aero and instant turn-in.",
    drivetrain: "RWD",
    modelAsset: "/assets/racing/ferrari.glb",
    engineAudioProfile: "V10_SUPER",
    defaultLiveryId: "rosso_corsa",
    stats: {
      topSpeed: 96,
      acceleration: 91,
      driftGrip: 86,
    },
    massKg: 1380,
    wheelbaseM: 2.65,
    trackWidthM: 1.94,
    wheelRadiusM: 0.35,
    dimensions: { lengthM: 4.53, widthM: 1.94, heightM: 1.21 },
    topSpeedKmh: 318,
    reverseSpeedKmh: 72,
    accelerationMps2: 19.6,
    brakingMps2: 39.0,
    lateralGrip: 1.18,
    driftGrip: 0.54,
    driftControl: 1.14,
    maxSteerAngleRad: 0.58,
    suspensionStiffness: 42,
    suspensionDamping: 6.2,
    rollFactor: 0.045,
    pitchFactor: 0.032,
    nitroCapacity: 100,
    nitroBoostMultiplier: 1.2,
    nitroBurnRate: 27,
    nitroDriftChargeRate: 24,
    idleRpm: 1100,
    redlineRpm: 9000,
    gearTopSpeedsKmh: [72, 122, 174, 224, 272, 326],
  },
  skyline_r34: {
    id: "skyline_r34",
    name: "Skyline R34 Spec-Z",
    classLabel: "JDM TURBO",
    tagline: "Twin-turbo inline-6 street legend tuned for silky wide-angle highway drifts.",
    drivetrain: "AWD",
    modelAsset: null,
    engineAudioProfile: "I6_TURBO",
    defaultLiveryId: "midnight_purple",
    stats: {
      topSpeed: 88,
      acceleration: 89,
      driftGrip: 95,
    },
    massKg: 1460,
    wheelbaseM: 2.67,
    trackWidthM: 1.82,
    wheelRadiusM: 0.34,
    dimensions: { lengthM: 4.6, widthM: 1.82, heightM: 1.35 },
    topSpeedKmh: 300,
    reverseSpeedKmh: 68,
    accelerationMps2: 19.1,
    brakingMps2: 37.5,
    lateralGrip: 1.14,
    driftGrip: 0.5,
    driftControl: 1.26,
    maxSteerAngleRad: 0.62,
    suspensionStiffness: 38,
    suspensionDamping: 5.8,
    rollFactor: 0.055,
    pitchFactor: 0.038,
    nitroCapacity: 100,
    nitroBoostMultiplier: 1.22,
    nitroBurnRate: 25,
    nitroDriftChargeRate: 29,
    idleRpm: 980,
    redlineRpm: 8400,
    gearTopSpeedsKmh: [68, 115, 165, 212, 258, 308],
  },
  viper_v8: {
    id: "viper_v8",
    name: "Viper V8 Dominator",
    classLabel: "MUSCLE V8",
    tagline: "Brutal supercharged V8 torque monster that devours straights and melts rear rubber.",
    drivetrain: "RWD",
    modelAsset: null,
    engineAudioProfile: "V8_MUSCLE",
    defaultLiveryId: "sunset_orange_metallic",
    stats: {
      topSpeed: 93,
      acceleration: 94,
      driftGrip: 79,
    },
    massKg: 1580,
    wheelbaseM: 2.74,
    trackWidthM: 1.92,
    wheelRadiusM: 0.36,
    dimensions: { lengthM: 4.72, widthM: 1.92, heightM: 1.31 },
    topSpeedKmh: 312,
    reverseSpeedKmh: 70,
    accelerationMps2: 20.4,
    brakingMps2: 35.5,
    lateralGrip: 1.06,
    driftGrip: 0.44,
    driftControl: 1.18,
    maxSteerAngleRad: 0.59,
    suspensionStiffness: 35,
    suspensionDamping: 5.4,
    rollFactor: 0.065,
    pitchFactor: 0.048,
    nitroCapacity: 100,
    nitroBoostMultiplier: 1.23,
    nitroBurnRate: 26,
    nitroDriftChargeRate: 27,
    idleRpm: 820,
    redlineRpm: 7000,
    gearTopSpeedsKmh: [74, 126, 178, 226, 270, 320],
  },
  rally_rs: {
    id: "rally_rs",
    name: "Rally RS Evo-X",
    classLabel: "AWD RALLY",
    tagline: "Lightweight AWD gravel-eater with explosive corner exit and fearless canyon grip.",
    drivetrain: "AWD",
    modelAsset: null,
    engineAudioProfile: "BOXER_RALLY",
    defaultLiveryId: "tokyo_cyber_cyan",
    stats: {
      topSpeed: 84,
      acceleration: 96,
      driftGrip: 93,
    },
    massKg: 1290,
    wheelbaseM: 2.58,
    trackWidthM: 1.84,
    wheelRadiusM: 0.34,
    dimensions: { lengthM: 4.38, widthM: 1.84, heightM: 1.44 },
    topSpeedKmh: 290,
    reverseSpeedKmh: 66,
    accelerationMps2: 21.0,
    brakingMps2: 40.0,
    lateralGrip: 1.24,
    driftGrip: 0.56,
    driftControl: 1.24,
    maxSteerAngleRad: 0.64,
    suspensionStiffness: 33,
    suspensionDamping: 5.5,
    rollFactor: 0.06,
    pitchFactor: 0.042,
    nitroCapacity: 100,
    nitroBoostMultiplier: 1.21,
    nitroBurnRate: 26,
    nitroDriftChargeRate: 28,
    idleRpm: 1000,
    redlineRpm: 7800,
    gearTopSpeedsKmh: [65, 110, 156, 202, 246, 298],
  },
};

export const VEHICLE_LIST: readonly VehicleDefinition[] = Object.values(VEHICLE_REGISTRY);
export const DEFAULT_VEHICLE_ID: VehicleId = "apex_gt";

export function isVehicleId(id: string | undefined): id is VehicleId {
  return typeof id === "string" && id in VEHICLE_REGISTRY;
}

export function getVehicleDefinition(id?: string): VehicleDefinition {
  if (isVehicleId(id)) {
    return VEHICLE_REGISTRY[id];
  }
  return VEHICLE_REGISTRY[DEFAULT_VEHICLE_ID];
}
