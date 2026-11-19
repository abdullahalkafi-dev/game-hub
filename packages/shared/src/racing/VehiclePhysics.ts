import { FIXED_DT } from "../constants/tick.js";
import { clamp, damp, lerp, type Vec3 } from "../math/ScratchMath.js";
import type { EffectiveVehicleStats, TransmissionMode } from "./CarPartRegistry.js";
import {
  getTrackBlueprint,
  getTrackCheckpoints,
  getTrackLength,
  getTrackStartGrid,
  projectPointToTrack,
  sampleTrackAtDistance,
  type TrackBlueprint,
  type TrackId,
} from "./TrackRegistry.js";

export const LAUNCH_GREEN_ZONE_MIN = 0.65;
export const LAUNCH_GREEN_ZONE_MAX = 0.85;
export const PERFECT_LAUNCH_DURATION_SEC = 1.8;

export const SLIPSTREAM_MIN_DIST_M = 3.0;
export const SLIPSTREAM_MAX_DIST_M = 22.0;
export const SLIPSTREAM_CONE_COS = Math.cos(0.28); // ~16 deg half-angle cone
export const SLIPSTREAM_SPEED_BONUS = 0.1; // +10% top speed
export const SLIPSTREAM_NITRO_MULT = 1.5; // 1.5x Nitro charge

export interface RaceInputCommand {
  seq: number;
  /** 0..1 throttle pedal */
  throttle: number;
  /** 0..1 brake/reverse pedal */
  brake: number;
  /** -1 (left) .. +1 (right) steering */
  steer: number;
  /** Space — initiates/extends power-slide drift */
  handbrake: boolean;
  /** Shift — fires Nitrous boost */
  nitro: boolean;
  /** E — manual upshift pulse */
  shiftUp?: boolean;
  /** Q — manual downshift pulse */
  shiftDown?: boolean;
  /** R — instant track centerline reset */
  reset?: boolean;
  transmission?: TransmissionMode;
}

export interface RivalDraftSample {
  id: string;
  position: Vec3;
  yaw: number;
  forwardSpeed: number;
}

export interface VehicleStepContext {
  /** True while countdown 3-2-1 is active; car is held on grid and engine revs freely for launch control */
  gridLocked: boolean;
  /** Set true on the single tick where countdown transitions to GO! */
  launchGoThisTick?: boolean;
  /** Elapsed race clock in ms since GO! */
  raceElapsedMs: number;
  /** Number of laps required to finish */
  totalLaps: number;
  /** Other racers on track for slipstream drafting & soft bump separation */
  rivals?: readonly RivalDraftSample[];
  /** Self player ID to skip in rivals list */
  selfId?: string;
  /** Optional dt override (defaults to FIXED_DT = 1/60) */
  dt?: number;
}

export interface VehicleStepEvents {
  perfectLaunch: boolean;
  completedLap: number | null;
  completedLapTimeMs: number | null;
  finishedRace: boolean;
  shiftedUp: boolean;
  shiftedDown: boolean;
  resetTriggered: boolean;
}

export interface VehiclePhysicsState {
  position: Vec3;
  velocity: Vec3;
  /** Heading yaw in radians (0 = +Z, + = turning right) */
  yaw: number;
  /** Pitch in radians (+ = nose up, so Babylon chassis rotation.x = -pitch) */
  pitch: number;
  /** Roll in radians (+ = right side higher / leaning left, Babylon chassis rotation.z = roll) */
  roll: number;
  /** Vertical chassis suspension bounce offset in meters */
  suspensionOffset: number;
  /** Vertical suspension bounce velocity in m/s */
  suspensionVel: number;
  yawRate: number;
  /** Front wheel visual steering angle in radians */
  steerAngle: number;
  /** Cumulative wheel spin angle in radians */
  wheelSpinRad: number;
  /** Signed speed along car forward axis (m/s) */
  forwardSpeed: number;
  /** Signed speed along car right axis (m/s) */
  lateralSpeed: number;
  /** Absolute speed in km/h */
  speedKmh: number;
  rpm: number;
  /** Normalized RPM in [0..1] */
  rpmNorm: number;
  /** Gear: 0 = Reverse, 1..6 = Forward */
  gear: number;
  shiftCutTimer: number;
  justShiftedUp: boolean;
  justShiftedDown: boolean;
  /** Nitro meter [0..nitroCapacity] */
  nitro: number;
  nitroActive: boolean;
  launchBoostTimer: number;
  perfectLaunchTriggered: boolean;
  drifting: boolean;
  /** Signed slip angle in radians */
  driftAngleRad: number;
  /** Current live unbanked drift chain score */
  currentDriftScore: number;
  /** Live drift multiplier 1..5 */
  driftMultiplier: number;
  /** Banked total drift score across the race */
  totalDriftScore: number;
  driftGraceTimer: number;
  slipstreamActive: boolean;
  slipstreamFactor: number;
  inTunnel: boolean;
  onGravel: boolean;
  /** 0..1 guardrail scrape intensity */
  wallScrapeIntensity: number;
  wrongWay: boolean;
  brakeLight: number;
  brakeHeat: number;
  trackFrameIndex: number;
  distanceAlongLap: number;
  progressAlongLap: number;
  lateralOffset: number;
  lap: number;
  checkpointIndex: number;
  totalRaceDistanceM: number;
  lapStartTimeMs: number;
  currentLapTimeMs: number;
  bestLapMs: number | null;
  lapTimesMs: number[];
  finished: boolean;
  finishTimeMs: number | null;
  resetCooldownSec: number;
}

export function isInLaunchGreenZone(rpmNorm: number): boolean {
  return rpmNorm >= LAUNCH_GREEN_ZONE_MIN && rpmNorm <= LAUNCH_GREEN_ZONE_MAX;
}

export function createEmptyRaceInput(seq = 0): RaceInputCommand {
  return {
    seq,
    throttle: 0,
    brake: 0,
    steer: 0,
    handbrake: false,
    nitro: false,
    shiftUp: false,
    shiftDown: false,
    reset: false,
    transmission: "AUTO",
  };
}

export function createInitialVehicleState(
  trackOrId: TrackBlueprint | TrackId | string,
  slotIndex: number,
  stats: EffectiveVehicleStats
): VehiclePhysicsState {
  const track = typeof trackOrId === "string" ? getTrackBlueprint(trackOrId) : trackOrId;
  const grid = getTrackStartGrid(track, Math.max(8, slotIndex + 1));
  const slot = grid[slotIndex % grid.length];
  const proj = projectPointToTrack(track, slot.position);
  const trackLen = getTrackLength(track);

  return {
    position: { ...slot.position },
    velocity: { x: 0, y: 0, z: 0 },
    yaw: slot.yaw,
    pitch: slot.pitch,
    roll: proj.frame.bankRad,
    suspensionOffset: 0,
    suspensionVel: 0,
    yawRate: 0,
    steerAngle: 0,
    wheelSpinRad: 0,
    forwardSpeed: 0,
    lateralSpeed: 0,
    speedKmh: 0,
    rpm: stats.idleRpm,
    rpmNorm: 0.08,
    gear: 1,
    shiftCutTimer: 0,
    justShiftedUp: false,
    justShiftedDown: false,
    nitro: 25, // Start every race with 25% tactical Nitro charge
    nitroActive: false,
    launchBoostTimer: 0,
    perfectLaunchTriggered: false,
    drifting: false,
    driftAngleRad: 0,
    currentDriftScore: 0,
    driftMultiplier: 1,
    totalDriftScore: 0,
    driftGraceTimer: 0,
    slipstreamActive: false,
    slipstreamFactor: 0,
    inTunnel: proj.inTunnel,
    onGravel: proj.onGravel,
    wallScrapeIntensity: 0,
    wrongWay: false,
    brakeLight: 0,
    brakeHeat: 0,
    trackFrameIndex: proj.frameIndex,
    distanceAlongLap: proj.distanceM,
    progressAlongLap: proj.distanceM / trackLen,
    lateralOffset: proj.lateralOffset,
    lap: 1,
    checkpointIndex: 0,
    totalRaceDistanceM: -slot.distanceBehindStartM,
    lapStartTimeMs: 0,
    currentLapTimeMs: 0,
    bestLapMs: null,
    lapTimesMs: [],
    finished: false,
    finishTimeMs: null,
    resetCooldownSec: 0,
  };
}

export function cloneVehicleState(state: Readonly<VehiclePhysicsState>): VehiclePhysicsState {
  return {
    ...state,
    position: { ...state.position },
    velocity: { ...state.velocity },
    lapTimesMs: [...state.lapTimesMs],
  };
}

function wrapAngleRad(a: number): number {
  let r = a;
  while (r > Math.PI) r -= Math.PI * 2;
  while (r < -Math.PI) r += Math.PI * 2;
  return r;
}

function computeDriftMultiplier(unbankedScore: number): number {
  if (unbankedScore >= 5000) return 5;
  if (unbankedScore >= 3000) return 4;
  if (unbankedScore >= 1500) return 3;
  if (unbankedScore >= 500) return 2;
  return 1;
}

/**
 * Deterministic 60Hz arcade-drift vehicle simulation shared identically between client prediction
 * and authoritative server rooms.
 */
export function stepVehiclePhysics(
  state: VehiclePhysicsState,
  rawInput: Readonly<RaceInputCommand>,
  stats: EffectiveVehicleStats,
  trackOrId: TrackBlueprint | TrackId | string,
  ctx: VehicleStepContext
): VehicleStepEvents {
  const dt = ctx.dt ?? FIXED_DT;
  const track = typeof trackOrId === "string" ? getTrackBlueprint(trackOrId) : trackOrId;
  const trackLen = getTrackLength(track);
  const checkpoints = getTrackCheckpoints(track);

  const events: VehicleStepEvents = {
    perfectLaunch: false,
    completedLap: null,
    completedLapTimeMs: null,
    finishedRace: false,
    shiftedUp: false,
    shiftedDown: false,
    resetTriggered: false,
  };

  const throttle = clamp(rawInput.throttle, 0, 1);
  const brake = clamp(rawInput.brake, 0, 1);
  const steer = clamp(rawInput.steer, -1, 1);
  const handbrake = Boolean(rawInput.handbrake);
  const nitroInput = Boolean(rawInput.nitro);
  const transmission: TransmissionMode = rawInput.transmission ?? "AUTO";

  state.justShiftedUp = false;
  state.justShiftedDown = false;
  state.wallScrapeIntensity = 0;
  state.resetCooldownSec = Math.max(0, state.resetCooldownSec - dt);
  state.shiftCutTimer = Math.max(0, state.shiftCutTimer - dt);

  // --- 1. Grid Countdown Lock (3-2-1-GO! Launch Control) ---
  if (ctx.gridLocked) {
    state.velocity.x = 0;
    state.velocity.y = 0;
    state.velocity.z = 0;
    state.forwardSpeed = 0;
    state.lateralSpeed = 0;
    state.speedKmh = 0;
    state.yawRate = 0;
    state.drifting = false;
    state.driftAngleRad = 0;
    state.nitroActive = false;
    state.slipstreamActive = false;
    state.slipstreamFactor = 0;
    state.brakeLight = brake > 0.1 || handbrake ? 1 : 0.25;

    // Free-rev engine on grid so player can feather throttle into Green Zone [0.65..0.85]
    if (throttle > 0.05) {
      const targetRpm = lerp(0.15, 0.99, throttle);
      state.rpmNorm = damp(state.rpmNorm, targetRpm, 3.6, dt);
      if (state.rpmNorm > 0.95) {
        // Rev limiter subtle bounce
        state.rpmNorm = 0.94 + Math.sin(ctx.raceElapsedMs * 0.06) * 0.03;
      }
    } else {
      state.rpmNorm = damp(state.rpmNorm, 0.1, 2.8, dt);
    }
    state.rpm = stats.idleRpm + state.rpmNorm * (stats.redlineRpm - stats.idleRpm);
    state.gear = 1;
    state.steerAngle = damp(state.steerAngle, steer * stats.maxSteerAngleRad * 0.7, 12, dt);

    // Subtle chassis vibration while revving on the starting line
    const revKick = throttle > 0.2 ? Math.sin(state.rpm * 0.04) * 0.008 * state.rpmNorm : 0;
    state.suspensionOffset = damp(state.suspensionOffset, revKick, 16, dt);
    state.pitch = damp(state.pitch, throttle * 0.015, 10, dt);
    state.roll = damp(state.roll, 0, 10, dt);
    return events;
  }

  // --- 2. Handle Launch Transition (GO!) ---
  if (ctx.launchGoThisTick && isInLaunchGreenZone(state.rpmNorm)) {
    state.launchBoostTimer = PERFECT_LAUNCH_DURATION_SEC;
    state.perfectLaunchTriggered = true;
    state.nitro = Math.min(stats.nitroCapacity, state.nitro + 12);
    const fwdX0 = Math.sin(state.yaw);
    const fwdZ0 = Math.cos(state.yaw);
    state.velocity.x += fwdX0 * 7.5;
    state.velocity.z += fwdZ0 * 7.5;
    events.perfectLaunch = true;
  }

  if (state.launchBoostTimer > 0) {
    state.launchBoostTimer = Math.max(0, state.launchBoostTimer - dt);
  }

  // --- 3. Instant Track Reset [R] ---
  if (rawInput.reset && state.resetCooldownSec <= 0 && !state.finished) {
    const projReset = projectPointToTrack(track, state.position, state.trackFrameIndex);
    const resetFrame = sampleTrackAtDistance(track, projReset.distanceM);
    state.position.x = resetFrame.position.x;
    state.position.y = resetFrame.position.y;
    state.position.z = resetFrame.position.z;
    state.velocity.x = 0;
    state.velocity.y = 0;
    state.velocity.z = 0;
    state.yaw = resetFrame.yaw;
    state.pitch = resetFrame.pitch;
    state.roll = resetFrame.bankRad;
    state.yawRate = 0;
    state.forwardSpeed = 0;
    state.lateralSpeed = 0;
    state.speedKmh = 0;
    state.lateralOffset = 0;
    state.distanceAlongLap = resetFrame.distanceM;
    state.progressAlongLap = resetFrame.t;
    state.trackFrameIndex = resetFrame.index;
    state.inTunnel = resetFrame.isTunnel;
    state.onGravel = false;
    state.drifting = false;
    state.driftAngleRad = 0;
    state.currentDriftScore = 0;
    state.driftMultiplier = 1;
    state.driftGraceTimer = 0;
    state.wrongWay = false;
    state.resetCooldownSec = 1.5;
    events.resetTriggered = true;
    return events;
  }

  // --- 4. Decompose Current Velocity into Car Local Frame ---
  const fwdX = Math.sin(state.yaw);
  const fwdZ = Math.cos(state.yaw);
  const rightX = Math.cos(state.yaw);
  const rightZ = -Math.sin(state.yaw);

  let vFwd = state.velocity.x * fwdX + state.velocity.z * fwdZ;
  let vLat = state.velocity.x * rightX + state.velocity.z * rightZ;
  const speedMps = Math.hypot(vFwd, vLat);
  const prevForwardSpeed = vFwd;

  // --- 5. Slipstream Drafting Cone (< 22m behind a rival within narrow cone) ---
  state.slipstreamActive = false;
  state.slipstreamFactor = 0;
  if (ctx.rivals && ctx.rivals.length > 0 && vFwd > 19) {
    let bestFactor = 0;
    for (let i = 0; i < ctx.rivals.length; i++) {
      const rival = ctx.rivals[i];
      if (ctx.selfId && rival.id === ctx.selfId) continue;
      if (rival.forwardSpeed < 14) continue;
      const dx = rival.position.x - state.position.x;
      const dz = rival.position.z - state.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist < SLIPSTREAM_MIN_DIST_M || dist > SLIPSTREAM_MAX_DIST_M) continue;
      const invDist = 1 / dist;
      const dirX = dx * invDist;
      const dirZ = dz * invDist;
      // Rival must be inside forward cone of our car
      const forwardAlign = fwdX * dirX + fwdZ * dirZ;
      if (forwardAlign < SLIPSTREAM_CONE_COS) continue;
      // Rival must be heading roughly the same direction (not oncoming)
      const rivalFwdX = Math.sin(rival.yaw);
      const rivalFwdZ = Math.cos(rival.yaw);
      const headingAlign = fwdX * rivalFwdX + fwdZ * rivalFwdZ;
      if (headingAlign < 0.72) continue;

      const distFactor = clamp(1 - (dist - SLIPSTREAM_MIN_DIST_M) / (SLIPSTREAM_MAX_DIST_M - SLIPSTREAM_MIN_DIST_M), 0.25, 1);
      const coneFactor = clamp((forwardAlign - SLIPSTREAM_CONE_COS) / (1 - SLIPSTREAM_CONE_COS), 0.3, 1);
      const factor = distFactor * coneFactor;
      if (factor > bestFactor) {
        bestFactor = factor;
      }
    }
    if (bestFactor > 0.05) {
      state.slipstreamActive = true;
      state.slipstreamFactor = bestFactor;
    }
  }

  // --- 6. Nitrous Boost Activation & Consumption ---
  const nitroMinThreshold = state.nitroActive ? 0.5 : 4.0;
  if (nitroInput && state.nitro >= nitroMinThreshold && vFwd > 3.5 && !state.wrongWay) {
    state.nitroActive = true;
    state.nitro = Math.max(0, state.nitro - stats.nitroBurnRate * dt);
  } else {
    state.nitroActive = false;
  }

  // Passive slipstream Nitro charge (1.5x drafting bonus!)
  if (state.slipstreamActive && !state.nitroActive) {
    state.nitro = Math.min(
      stats.nitroCapacity,
      state.nitro + 4.8 * SLIPSTREAM_NITRO_MULT * state.slipstreamFactor * dt
    );
  }

  // --- 7. Effective Top Speed & Acceleration ---
  let topSpeedMult = 1.0;
  let accelMult = 1.0;

  if (state.nitroActive) {
    topSpeedMult *= stats.nitroBoostMultiplier;
    accelMult *= 1.58;
  }
  if (state.slipstreamActive) {
    topSpeedMult *= 1 + SLIPSTREAM_SPEED_BONUS;
    accelMult *= 1.22;
  }
  if (state.launchBoostTimer > 0) {
    topSpeedMult *= 1.08;
    accelMult *= 1.32;
  }
  if (state.onGravel) {
    const gravelPenalty = stats.drivetrain === "AWD" ? 0.9 : 0.78;
    topSpeedMult *= gravelPenalty;
    accelMult *= gravelPenalty;
  }
  if (state.shiftCutTimer > 0) {
    accelMult *= 0.72;
  }

  // Manual transmission gear cap (forces shifting up cleanly)
  let manualGearCapMps = Infinity;
  if (transmission === "MANUAL" && state.gear >= 1 && state.gear <= 6) {
    const gearMaxKmh = stats.gearTopSpeedsKmh[state.gear - 1] * (state.nitroActive ? 1.15 : 1.04);
    manualGearCapMps = gearMaxKmh / 3.6;
  }

  const effectiveTopSpeedMps = Math.min(stats.topSpeedMps * topSpeedMult, manualGearCapMps);

  // Longitudinal forces (Throttle, Brake, Reverse, Aero & Rolling Drag)
  const speedRatio = clamp(Math.max(0, vFwd) / Math.max(effectiveTopSpeedMps, 1), 0, 1.35);
  const powerCurve = clamp(1 - 0.65 * Math.pow(Math.min(speedRatio, 1.05), 1.6), 0.22, 1.0);

  if (throttle > 0.01) {
    if (vFwd < -1.0) {
      // Pressing gas while reversing acts as strong braking first
      vFwd += stats.brakingMps2 * throttle * dt;
    } else {
      vFwd += stats.accelerationMps2 * accelMult * powerCurve * throttle * dt;
    }
  }

  if (brake > 0.01) {
    if (vFwd > 1.2) {
      vFwd = Math.max(0, vFwd - stats.brakingMps2 * brake * dt);
    } else {
      // Engage Reverse smoothly
      vFwd = Math.max(-stats.reverseSpeedMps, vFwd - stats.accelerationMps2 * 0.52 * brake * dt);
    }
  }

  if (handbrake && vFwd > 2) {
    // Handbrake gently trims speed while initiating rear breakaway (doesn't dead-stop car)
    vFwd = Math.max(0, vFwd - 7.5 * dt);
  }

  // Aerodynamic + rolling resistance (tuned so cars hit advertised topSpeedKmh & Nitro surges past it)
  const coastDrag = throttle < 0.05 ? 0.38 : 0.028;
  const gravelDrag = state.onGravel ? 0.55 : 0;
  const aeroDrag = (0.00024 * vFwd * Math.abs(vFwd) + (coastDrag + gravelDrag) * vFwd) * dt;
  vFwd -= aeroDrag;

  if (vFwd > effectiveTopSpeedMps) {
    vFwd = damp(vFwd, effectiveTopSpeedMps, 2.4, dt);
  }
  if (Math.abs(vFwd) < 0.08 && throttle < 0.05 && brake < 0.05) {
    vFwd = 0;
  }

  // --- 8. Speed-Sensitive Steering & Arcade-Drift Slip Physics ---
  const absKmh = Math.abs(vFwd) * 3.6;
  const speedSteerFactor = lerp(1.0, 0.44, clamp(absKmh / 290, 0, 1));
  const targetSteerAngle = steer * stats.maxSteerAngleRad * speedSteerFactor;
  state.steerAngle = damp(state.steerAngle, targetSteerAngle, 14, dt);

  const currentSlipAngle = Math.atan2(-vLat, Math.max(Math.abs(vFwd), 4.0));
  const wantsEnterDrift =
    absKmh > 42 &&
    ((handbrake && Math.abs(steer) > 0.1) || (brake > 0.35 && Math.abs(steer) > 0.45 && absKmh > 78));
  const sustainDrift =
    state.drifting &&
    absKmh > 34 &&
    (handbrake || Math.abs(currentSlipAngle) > 0.11 || (Math.abs(steer) > 0.25 && Math.abs(vLat) > 2.2));

  state.drifting = wantsEnterDrift || sustainDrift;

  // Compute desired yaw rate
  const moveSign = vFwd >= -0.2 ? 1 : -1;
  const lowSpeedScale = clamp(speedMps / 7.5, 0, 1);
  const baseYawRate =
    (state.steerAngle / Math.max(stats.wheelbaseM, 1.5)) *
    Math.min(Math.abs(vFwd), 38) *
    lerp(1.08, 0.72, clamp(absKmh / 260, 0, 1)) *
    moveSign;

  if (state.drifting) {
    const driftTurnBoost = steer * 1.48 * stats.driftControl * lowSpeedScale;
    const targetYawRate = clamp(baseYawRate * 0.92 + driftTurnBoost, -2.55, 2.55);
    state.yawRate = damp(state.yawRate, targetYawRate, 8.5, dt);

    // Kick rear out gently when initiating drift with handbrake
    if (handbrake && Math.abs(steer) > 0.12) {
      vLat -= steer * 13.5 * dt;
    }

    // Controllable lateral slide damping (prevents uncontrollable spinouts)
    const driftLatDamping = stats.driftGrip * 4.4;
    vLat = damp(vLat, 0, driftLatDamping, dt);

    // Clamp max lateral slip speed so drifts feel heroic & controllable (~38 deg max)
    const maxLatSpeed = Math.max(6, Math.abs(vFwd) * 0.68);
    vLat = clamp(vLat, -maxLatSpeed, maxLatSpeed);
  } else {
    const targetYawRate = clamp(baseYawRate, -2.2, 2.2);
    state.yawRate = damp(state.yawRate, targetYawRate, 13.5, dt);

    // Crisp planted lateral grip when not drifting
    const gripDamping = stats.lateralGrip * (state.onGravel ? 5.2 : 9.8);
    vLat = damp(vLat, 0, gripDamping, dt);
  }

  state.yaw = wrapAngleRad(state.yaw + state.yawRate * dt);

  // Reconstruct world velocity from updated yaw + local speeds (turning blends momentum naturally)
  const newFwdX = Math.sin(state.yaw);
  const newFwdZ = Math.cos(state.yaw);
  const newRightX = Math.cos(state.yaw);
  const newRightZ = -Math.sin(state.yaw);

  // During grip cornering, velocity rotates tightly with heading; during drift, momentum slides wider
  const alignRate = state.drifting ? 3.4 : 10.5 * stats.lateralGrip;
  const worldVxTarget = newFwdX * vFwd + newRightX * vLat;
  const worldVzTarget = newFwdZ * vFwd + newRightZ * vLat;

  if (!state.drifting) {
    state.velocity.x = worldVxTarget;
    state.velocity.z = worldVzTarget;
  } else {
    state.velocity.x = damp(state.velocity.x, worldVxTarget, alignRate * 2.2, dt);
    state.velocity.z = damp(state.velocity.z, worldVzTarget, alignRate * 2.2, dt);
  }

  // Integrate XZ position
  state.position.x += state.velocity.x * dt;
  state.position.z += state.velocity.z * dt;

  // --- 9. Soft Car-to-Car Collision Separation ---
  if (ctx.rivals && ctx.rivals.length > 0) {
    const minSep = 2.45;
    for (let i = 0; i < ctx.rivals.length; i++) {
      const rival = ctx.rivals[i];
      if (ctx.selfId && rival.id === ctx.selfId) continue;
      const dx = state.position.x - rival.position.x;
      const dz = state.position.z - rival.position.z;
      const distSq = dx * dx + dz * dz;
      if (distSq > 1e-4 && distSq < minSep * minSep) {
        const dist = Math.sqrt(distSq);
        const nx = dx / dist;
        const nz = dz / dist;
        const overlap = (minSep - dist) * 0.52;
        state.position.x += nx * overlap;
        state.position.z += nz * overlap;
        const relOut = state.velocity.x * nx + state.velocity.z * nz;
        if (relOut < 0) {
          state.velocity.x -= nx * relOut * 0.6;
          state.velocity.z -= nz * relOut * 0.6;
        }
      }
    }
  }

  // --- 10. Track Projection, Road Height, Banking & Guardrail Containment ---
  const prevDist = state.distanceAlongLap;
  const proj = projectPointToTrack(track, state.position, state.trackFrameIndex);
  const maxAllowedLat = Math.max(3.5, proj.guardrailHalfWidth - 1.05);

  if (Math.abs(proj.lateralOffset) > maxAllowedLat) {
    const sign = Math.sign(proj.lateralOffset);
    const clampedLat = sign * maxAllowedLat;

    // Place flush inside guardrail boundary
    state.position.x = proj.frame.position.x + proj.frame.right.x * clampedLat;
    state.position.z = proj.frame.position.z + proj.frame.right.z * clampedLat;

    // Outward normal points along sign * proj.frame.right
    const outX = proj.frame.right.x * sign;
    const outZ = proj.frame.right.z * sign;
    const vOut = state.velocity.x * outX + state.velocity.z * outZ;

    if (vOut > 0) {
      // Smooth guardrail bounce & slide (no sticking, no flying out of world)
      state.velocity.x -= outX * vOut * 1.24;
      state.velocity.z -= outZ * vOut * 1.24;
      const scrapeSpeedLoss = 1 - clamp(vOut / 28, 0.02, 0.18);
      state.velocity.x *= scrapeSpeedLoss;
      state.velocity.z *= scrapeSpeedLoss;
      state.wallScrapeIntensity = clamp(vOut / 12 + (absKmh / 240) * 0.35, 0.15, 1.0);
    } else {
      state.wallScrapeIntensity = clamp((absKmh / 240) * 0.3, 0.1, 0.45);
    }

    // Prevent nose from turning further into the guardrail and gently align parallel to track
    if (state.yawRate * sign > 0) {
      state.yawRate = 0;
    }
    const yawErr = wrapAngleRad(proj.frame.yaw - state.yaw);
    if (yawErr * sign < 0) {
      state.yaw = wrapAngleRad(state.yaw + clamp(yawErr, -0.45, 0.45) * 11.0 * dt);
    } else {
      state.yaw = wrapAngleRad(state.yaw + clamp(yawErr, -0.25, 0.25) * 4.0 * dt);
    }
    state.lateralOffset = clampedLat;
    state.position.y = proj.frame.position.y + proj.frame.right.y * clampedLat;
  } else {
    state.lateralOffset = proj.lateralOffset;
    state.position.y = proj.surfaceY;
  }

  state.trackFrameIndex = proj.frameIndex;
  state.distanceAlongLap = proj.distanceM;
  state.progressAlongLap = proj.distanceM / trackLen;
  state.inTunnel = proj.inTunnel;
  state.onGravel = proj.onGravel;

  // Recompute clean local speeds after any collision/guardrail adjustment
  const finalFwdX = Math.sin(state.yaw);
  const finalFwdZ = Math.cos(state.yaw);
  const finalRightX = Math.cos(state.yaw);
  const finalRightZ = -Math.sin(state.yaw);

  state.forwardSpeed = state.velocity.x * finalFwdX + state.velocity.z * finalFwdZ;
  state.lateralSpeed = state.velocity.x * finalRightX + state.velocity.z * finalRightZ;
  state.speedKmh = Math.hypot(state.forwardSpeed, state.lateralSpeed) * 3.6;
  state.velocity.y = (proj.frame.forward.y * state.forwardSpeed);
  state.wheelSpinRad = (state.wheelSpinRad + (state.forwardSpeed / Math.max(stats.wheelRadiusM, 0.2)) * dt) % (Math.PI * 200);

  const trackSpeed = state.velocity.x * proj.frame.forward.x + state.velocity.z * proj.frame.forward.z;
  state.wrongWay = trackSpeed < -3.5;

  // --- 11. Drift Scoring & Nitro Charging ---
  state.driftAngleRad =
    state.speedKmh > 25 ? Math.atan2(-state.lateralSpeed, Math.max(Math.abs(state.forwardSpeed), 3.0)) : 0;

  const cleanDriftActive =
    state.drifting &&
    !state.wrongWay &&
    Math.abs(state.driftAngleRad) > 0.1 &&
    state.speedKmh > 38 &&
    state.wallScrapeIntensity < 0.35;

  if (cleanDriftActive) {
    const slipIntensity = clamp((Math.abs(state.driftAngleRad) - 0.09) / 0.42, 0.15, 1.0);
    const speedBonus = clamp(state.speedKmh / 135, 0.35, 1.65);
    const nitroMult = state.slipstreamActive ? SLIPSTREAM_NITRO_MULT : 1.0;

    if (!state.nitroActive) {
      state.nitro = Math.min(
        stats.nitroCapacity,
        state.nitro + stats.nitroDriftChargeRate * slipIntensity * speedBonus * nitroMult * dt
      );
    }

    state.currentDriftScore += 420 * slipIntensity * speedBonus * state.driftMultiplier * dt;
    state.driftMultiplier = computeDriftMultiplier(state.currentDriftScore);
    state.driftGraceTimer = 1.25;
  } else if (state.currentDriftScore > 0) {
    if (state.wallScrapeIntensity > 0.65) {
      // Heavy guardrail hit banks half the combo and drops multiplier
      state.totalDriftScore += Math.round(state.currentDriftScore * 0.5);
      state.currentDriftScore = 0;
      state.driftMultiplier = 1;
      state.driftGraceTimer = 0;
    } else {
      state.driftGraceTimer -= dt;
      if (state.driftGraceTimer <= 0) {
        state.totalDriftScore += Math.round(state.currentDriftScore);
        state.currentDriftScore = 0;
        state.driftMultiplier = 1;
        state.driftGraceTimer = 0;
      }
    }
  }

  // --- 12. Body Pitch, Roll & Suspension Bounce ---
  const longAccel = (state.forwardSpeed - prevForwardSpeed) / Math.max(dt, 1e-4);
  const squatPitch = clamp(longAccel * 0.0022, -0.055, 0.055) * (stats.pitchFactor / 0.035);
  const lateralG = state.yawRate * state.forwardSpeed;
  // Turning right (lateralG > 0) rolls chassis left (left dips, right lifts -> negative roll? Let's tilt nicely outward)
  const bodyRoll = clamp(-lateralG * 0.0024, -0.085, 0.085) * (stats.rollFactor / 0.05);

  state.pitch = damp(state.pitch, proj.frame.pitch + squatPitch, 11, dt);
  state.roll = damp(state.roll, proj.frame.bankRad + bodyRoll, 11, dt);

  // Spring-damper suspension ripple (gravel & kerb bumps excite suspension!)
  const onKerb =
    (proj.frame.kerbLeft && state.lateralOffset < -proj.roadHalfWidth + 1.1) ||
    (proj.frame.kerbRight && state.lateralOffset > proj.roadHalfWidth - 1.1);
  const bumpExcitation =
    state.onGravel
      ? Math.sin(state.distanceAlongLap * 4.5) * 0.35 * clamp(state.speedKmh / 100, 0, 1)
      : onKerb
        ? Math.sin(state.distanceAlongLap * 6.0) * 0.25 * clamp(state.speedKmh / 100, 0, 1)
        : 0;
  const springForce = -stats.suspensionStiffness * state.suspensionOffset - stats.suspensionDamping * state.suspensionVel + bumpExcitation;
  state.suspensionVel += springForce * dt;
  state.suspensionOffset = clamp(state.suspensionOffset + state.suspensionVel * dt, -0.14, 0.14);

  // Brake lights & brake rotor heat
  const isBraking = (brake > 0.1 && state.forwardSpeed > 1) || handbrake;
  state.brakeLight = damp(state.brakeLight, isBraking ? 1.0 : 0.0, 18, dt);
  if (isBraking && state.speedKmh > 40) {
    state.brakeHeat = clamp(state.brakeHeat + 0.55 * dt * clamp(state.speedKmh / 180, 0.3, 1.3), 0, 1);
  } else {
    state.brakeHeat = Math.max(0, state.brakeHeat - 0.18 * dt);
  }

  // --- 13. Gearbox (1..6 + Reverse 0) & Engine RPM ---
  const prevGear = state.gear;
  if (state.forwardSpeed < -0.6 && (transmission === "AUTO" || brake > 0.1)) {
    state.gear = 0;
  } else {
    if (state.gear === 0) state.gear = 1;
    if (transmission === "MANUAL") {
      if (rawInput.shiftUp && state.gear < 6) {
        state.gear += 1;
      } else if (rawInput.shiftDown && state.gear > 1) {
        state.gear -= 1;
      }
    } else {
      // Automatic transmission with clean hysteresis
      while (state.gear < 6 && state.speedKmh > stats.gearTopSpeedsKmh[state.gear - 1] * 0.94) {
        state.gear += 1;
      }
      while (state.gear > 1 && state.speedKmh < stats.gearTopSpeedsKmh[state.gear - 2] * 0.72) {
        state.gear -= 1;
      }
    }
  }

  if (state.gear > prevGear && prevGear >= 1) {
    state.justShiftedUp = true;
    state.shiftCutTimer = 0.085;
    events.shiftedUp = true;
  } else if (state.gear < prevGear && state.gear >= 1) {
    state.justShiftedDown = true;
    events.shiftedDown = true;
  }

  if (state.gear === 0) {
    const revNorm = clamp(Math.abs(state.forwardSpeed) / Math.max(stats.reverseSpeedMps, 1), 0, 1);
    state.rpmNorm = damp(state.rpmNorm, lerp(0.14, 0.85, revNorm), 14, dt);
  } else {
    const gIdx = clamp(state.gear - 1, 0, 5);
    const lowKmh = gIdx === 0 ? 0 : stats.gearTopSpeedsKmh[gIdx - 1] * 0.62;
    const highKmh = stats.gearTopSpeedsKmh[gIdx];
    const inBand = clamp((state.speedKmh - lowKmh) / Math.max(highKmh - lowKmh, 15), 0, 1.02);
    const wheelspinBump = (state.drifting || state.launchBoostTimer > 0) && throttle > 0.3 ? 0.1 : 0;
    const targetNorm = clamp(lerp(0.18, 0.96, inBand) + wheelspinBump, 0.1, 0.99);
    state.rpmNorm = damp(state.rpmNorm, targetNorm, 16, dt);
  }
  state.rpm = stats.idleRpm + state.rpmNorm * (stats.redlineRpm - stats.idleRpm);

  // --- 14. Checkpoints, Lap Completion & Monotonic Total Race Distance ---
  if (!state.finished) {
    state.currentLapTimeMs = Math.max(0, ctx.raceElapsedMs - state.lapStartTimeMs);

    const cpCount = checkpoints.length;
    const cpLen = trackLen / cpCount;
    const currentSector = Math.floor(state.distanceAlongLap / cpLen) % cpCount;

    const previousSector = Math.floor(prevDist / cpLen) % cpCount;
    // Check the completed sequence before moving the checkpoint cursor to sector zero.
    const wrappedForward =
      previousSector === cpCount - 1 &&
      currentSector === 0 &&
      state.checkpointIndex === cpCount - 1 &&
      trackSpeed > 0;

    if (trackSpeed > 0 && currentSector === state.checkpointIndex + 1 && previousSector === state.checkpointIndex) {
      state.checkpointIndex = currentSector;
    }

    if (wrappedForward) {
      const completedLap = state.lap;
      const lapTimeMs = Math.max(1000, Math.round(ctx.raceElapsedMs - state.lapStartTimeMs));
      state.lapTimesMs.push(lapTimeMs);
      if (state.bestLapMs === null || lapTimeMs < state.bestLapMs) {
        state.bestLapMs = lapTimeMs;
      }
      state.lapStartTimeMs = ctx.raceElapsedMs;
      state.currentLapTimeMs = 0;
      state.checkpointIndex = 0;
      events.completedLap = completedLap;
      events.completedLapTimeMs = lapTimeMs;

      if (state.lap >= ctx.totalLaps) {
        // Bank any remaining drift combo upon crossing checkered flag
        if (state.currentDriftScore > 0) {
          state.totalDriftScore += Math.round(state.currentDriftScore);
          state.currentDriftScore = 0;
          state.driftMultiplier = 1;
        }
        state.finished = true;
        state.finishTimeMs = Math.round(ctx.raceElapsedMs);
        events.finishedRace = true;
      } else {
        state.lap += 1;
      }
    }

    // Compute smooth monotonic totalRaceDistanceM (handles cars sitting behind start line at -10..-60m!)
    let effectiveLapDist = state.distanceAlongLap;
    if (state.checkpointIndex <= 1 && state.distanceAlongLap > trackLen * 0.75) {
      effectiveLapDist = state.distanceAlongLap - trackLen;
    }
    state.totalRaceDistanceM = state.finished
      ? ctx.totalLaps * trackLen + Math.max(0, state.distanceAlongLap)
      : (state.lap - 1) * trackLen + effectiveLapDist;
  }

  return events;
}
