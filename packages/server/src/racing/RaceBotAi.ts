import {
  clamp,
  getTrackLength,
  sampleTrackAtDistance,
  type BotDifficulty,
  type RaceInputCommand,
  type RaceMode,
  type RivalDraftSample,
  type TrackBlueprint,
  type VehiclePhysicsState,
} from "@game/shared";

export interface RaceBotMemory {
  botIndex: number;
  preferredLane: number;
  currentTargetLane: number;
  paceVariance: number;
  stuckTimerSec: number;
  launchTargetRpm: number;
  nitroCooldownSec: number;
  driftHoldSec: number;
  seq: number;
}

interface BotDifficultyProfile {
  throttleCap: number;
  straightSpeedKmh: number;
  cornerSpeedScale: number;
  lookaheadBaseM: number;
  steerGain: number;
  laneChangeSpeed: number;
  nitroMinCharge: number;
  nitroStraightCurvature: number;
  launchAccuracy: number;
}

const DIFFICULTY_PROFILES: Record<BotDifficulty, BotDifficultyProfile> = {
  EASY: {
    throttleCap: 0.67,
    straightSpeedKmh: 220,
    cornerSpeedScale: 0.7,
    lookaheadBaseM: 29,
    steerGain: 1.5,
    laneChangeSpeed: 1.5,
    nitroMinCharge: 68,
    nitroStraightCurvature: 0.004,
    launchAccuracy: 0.2,
  },
  NORMAL: {
    throttleCap: 0.91,
    straightSpeedKmh: 360,
    cornerSpeedScale: 0.91,
    lookaheadBaseM: 22,
    steerGain: 1.75,
    laneChangeSpeed: 2.3,
    nitroMinCharge: 42,
    nitroStraightCurvature: 0.006,
    launchAccuracy: 0.65,
  },
  PRO: {
    throttleCap: 1.0,
    straightSpeedKmh: 360,
    cornerSpeedScale: 1.03,
    lookaheadBaseM: 20,
    steerGain: 2.0,
    laneChangeSpeed: 3.1,
    nitroMinCharge: 24,
    nitroStraightCurvature: 0.0075,
    launchAccuracy: 0.9,
  },
};

function wrapAngleRad(a: number): number {
  let r = a;
  while (r > Math.PI) r -= Math.PI * 2;
  while (r < -Math.PI) r += Math.PI * 2;
  return r;
}

export function createRaceBotMemory(botIndex: number, difficulty: BotDifficulty): RaceBotMemory {
  const lanePattern = [-3.6, 3.6, -1.8, 1.8, -4.4, 4.4, 0.0, -2.8];
  const preferredLane = lanePattern[botIndex % lanePattern.length];
  // Deterministic slight pace variation so grid battles feel organic
  const paceVariance = 0.96 + ((botIndex * 37) % 9) * 0.009;
  const profile = DIFFICULTY_PROFILES[difficulty];
  // Some bots aim cleanly inside Green Zone [0.65..0.85], others slightly off
  const hitsGreen = ((botIndex * 29 + 7) % 100) / 100 < profile.launchAccuracy;
  const launchTargetRpm = hitsGreen ? 0.72 + ((botIndex * 13) % 10) * 0.01 : 0.45 + ((botIndex * 17) % 5) * 0.1;

  return {
    botIndex,
    preferredLane,
    currentTargetLane: preferredLane,
    paceVariance,
    stuckTimerSec: 0,
    launchTargetRpm,
    nitroCooldownSec: 0,
    driftHoldSec: 0,
    seq: 0,
  };
}

export function stepRaceBotAi(opts: {
  botId: string;
  state: Readonly<VehiclePhysicsState>;
  memory: RaceBotMemory;
  track: TrackBlueprint;
  rivals: readonly RivalDraftSample[];
  difficulty: BotDifficulty;
  mode: RaceMode;
  gridLocked: boolean;
  dt: number;
}): RaceInputCommand {
  const { botId, state, memory, track, rivals, difficulty, mode, gridLocked, dt } = opts;
  const profile = DIFFICULTY_PROFILES[difficulty];
  memory.seq += 1;

  if (gridLocked) {
    // Feather throttle on the grid toward launchTargetRpm
    const throttle = state.rpmNorm < memory.launchTargetRpm ? 0.72 : 0.08;
    return {
      seq: memory.seq,
      throttle,
      brake: 0,
      steer: 0,
      handbrake: false,
      nitro: false,
      transmission: "AUTO",
    };
  }

  memory.nitroCooldownSec = Math.max(0, memory.nitroCooldownSec - dt);
  memory.driftHoldSec = Math.max(0, memory.driftHoldSec - dt);

  const trackLen = getTrackLength(track);
  const speedMps = Math.max(0, state.forwardSpeed);
  const lookaheadM = clamp(profile.lookaheadBaseM + speedMps * 0.42, 18, 68);

  const currentFrame = sampleTrackAtDistance(track, state.distanceAlongLap);
  const nearFrame = sampleTrackAtDistance(track, (state.distanceAlongLap + 26) % trackLen);
  const midFrame = sampleTrackAtDistance(track, (state.distanceAlongLap + 58) % trackLen);
  const farFrame = sampleTrackAtDistance(track, (state.distanceAlongLap + 95) % trackLen);
  const maxAheadCurv = Math.max(
    Math.abs(nearFrame.curvature),
    Math.abs(midFrame.curvature),
    Math.abs(farFrame.curvature) * 0.8
  );

  // --- Racing Line & Lateral Overtaking Offset ---
  const maxSafeLane = Math.max(2.0, currentFrame.roadWidth * 0.5 - 2.4);
  // Subtle apex hugging: shift slightly toward inside of upcoming corner
  const apexBias = clamp(midFrame.curvature * 180, -2.5, 2.5);
  let desiredLane = clamp(memory.preferredLane * 0.55 + apexBias, -maxSafeLane, maxSafeLane);

  // Scan rivals directly ahead to steer smoothly around slower traffic
  const fwdX = Math.sin(state.yaw);
  const fwdZ = Math.cos(state.yaw);
  const rightX = Math.cos(state.yaw);
  const rightZ = -Math.sin(state.yaw);

  for (let i = 0; i < rivals.length; i++) {
    const rival = rivals[i];
    if (rival.id === botId) continue;
    const dx = rival.position.x - state.position.x;
    const dz = rival.position.z - state.position.z;
    const along = dx * fwdX + dz * fwdZ;
    if (along < 2.0 || along > 26.0) continue;
    const latDiff = dx * rightX + dz * rightZ;
    if (Math.abs(latDiff) < 3.2) {
      // Pass on whichever side has more room on track
      const passRight = state.lateralOffset < maxSafeLane - 3.2 && (latDiff <= 0 || state.lateralOffset < -maxSafeLane + 3.2);
      const avoidOffset = passRight ? 3.8 : -3.8;
      desiredLane = clamp(state.lateralOffset + avoidOffset, -maxSafeLane, maxSafeLane);
      break;
    }
  }

  const laneDelta = desiredLane - memory.currentTargetLane;
  memory.currentTargetLane += clamp(laneDelta, -profile.laneChangeSpeed * dt, profile.laneChangeSpeed * dt);

  const targetFrame = sampleTrackAtDistance(track, (state.distanceAlongLap + lookaheadM) % trackLen);
  const targetX = targetFrame.position.x + targetFrame.right.x * memory.currentTargetLane;
  const targetZ = targetFrame.position.z + targetFrame.right.z * memory.currentTargetLane;

  const toTargetYaw = Math.atan2(targetX - state.position.x, targetZ - state.position.z);
  const yawError = wrapAngleRad(toTargetYaw - state.yaw);
  const steer = clamp(yawError * profile.steerGain, -1, 1);

  // --- Corner Speed Modulation & Braking ---
  // Safe corner speed scales inversely with sqrt(curvature)
  const paceCeiling = difficulty === "EASY" && track.theme === "COASTAL_SUNSET"
    ? profile.straightSpeedKmh * 0.93
    : profile.straightSpeedKmh;
  const rawCornerSpeedKmh =
    maxAheadCurv > 0.0025
      ? clamp((28.5 / Math.sqrt(maxAheadCurv)) * profile.cornerSpeedScale * memory.paceVariance, 85, paceCeiling)
      : paceCeiling;

  let throttle = profile.throttleCap * memory.paceVariance;
  let brake = 0;

  if (state.speedKmh > rawCornerSpeedKmh + 14) {
    throttle = 0.05;
    brake = clamp((state.speedKmh - rawCornerSpeedKmh) / 55, 0.2, 0.92);
  } else if (state.speedKmh > rawCornerSpeedKmh - 6) {
    throttle = Math.min(throttle, 0.45);
  }

  // Handbrake drift in Drift Attack mode or tight corners on PRO
  let handbrake = false;
  if (
    (mode === "DRIFT_ATTACK" && Math.abs(nearFrame.curvature) > 0.006 && state.speedKmh > 90 && Math.abs(steer) > 0.32) ||
    (difficulty === "PRO" && Math.abs(nearFrame.curvature) > 0.011 && state.speedKmh > 135 && Math.abs(steer) > 0.42)
  ) {
    if (memory.driftHoldSec <= 0 && !state.drifting) {
      memory.driftHoldSec = 0.35;
    }
  }
  if (memory.driftHoldSec > 0 && Math.abs(state.driftAngleRad) < 0.38) {
    handbrake = true;
    throttle = Math.max(throttle, 0.8);
    brake = 0;
  }

  // --- Tactical Nitro Use on Straightaways ---
  let nitro = false;
  if (
    difficulty !== "EASY" &&
    !state.wrongWay &&
    brake < 0.05 &&
    Math.abs(yawError) < 0.16 &&
    maxAheadCurv < profile.nitroStraightCurvature &&
    state.speedKmh > 110 &&
    (state.nitroActive ? state.nitro > 8 : state.nitro >= profile.nitroMinCharge && memory.nitroCooldownSec <= 0)
  ) {
    nitro = true;
  } else if (state.nitroActive && state.nitro <= 8) {
    memory.nitroCooldownSec = 2.0;
  }

  // --- Stuck / Wrong-Way Recovery ---
  let reset = false;
  if (state.speedKmh < 12 || state.wrongWay) {
    memory.stuckTimerSec += dt;
    if (memory.stuckTimerSec > 2.6) {
      reset = true;
      memory.stuckTimerSec = 0;
    }
  } else {
    memory.stuckTimerSec = Math.max(0, memory.stuckTimerSec - dt * 2);
  }

  return {
    seq: memory.seq,
    throttle: clamp(throttle, 0, 1),
    brake: clamp(brake, 0, 1),
    steer,
    handbrake,
    nitro,
    reset,
    transmission: "AUTO",
  };
}
