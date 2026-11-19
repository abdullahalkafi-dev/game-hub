import type { BotDifficulty } from "../net/PacketCodec.js";
import type { CarSetupConfig } from "./CarPartRegistry.js";
import type { TrackId } from "./TrackRegistry.js";
import type { RaceInputCommand, VehiclePhysicsState } from "./VehiclePhysics.js";
import type { VehicleId } from "./VehicleRegistry.js";

export const RACING_PROTOCOL_VERSION = 2;

export type RaceMode = "GRAND_PRIX" | "DUEL_1V1" | "DRIFT_ATTACK" | "TIME_TRIAL";
export type RacePhase = "LOBBY" | "COUNTDOWN" | "RACING" | "PODIUM";

export interface RaceModeConfig {
  id: RaceMode;
  label: string;
  shortLabel: string;
  maxPlayers: number;
  defaultBotFill: boolean;
  description: string;
}

export const RACE_MODE_CONFIGS: Record<RaceMode, RaceModeConfig> = {
  GRAND_PRIX: {
    id: "GRAND_PRIX",
    label: "Grand Prix 8P",
    shortLabel: "GRAND PRIX",
    maxPlayers: 8,
    defaultBotFill: true,
    description: "Full 8-car grid street race with drafting, splits & 3D podium.",
  },
  DUEL_1V1: {
    id: "DUEL_1V1",
    label: "1v1 Touge Duel",
    shortLabel: "1V1 DUEL",
    maxPlayers: 2,
    defaultBotFill: true,
    description: "Head-to-head touge sprint with zero traffic clutter.",
  },
  DRIFT_ATTACK: {
    id: "DRIFT_ATTACK",
    label: "Drift Attack",
    shortLabel: "DRIFT ATTACK",
    maxPlayers: 8,
    defaultBotFill: true,
    description: "Chain power-slides up to 5x multiplier; highest drift score wins.",
  },
  TIME_TRIAL: {
    id: "TIME_TRIAL",
    label: "Solo Time Trial",
    shortLabel: "TIME TRIAL",
    maxPlayers: 1,
    defaultBotFill: false,
    description: "Run one timed lap and race your personal-best ghost.",
  },
};

export const RACE_MODE_LIST: readonly RaceModeConfig[] = Object.values(RACE_MODE_CONFIGS);

export interface RacePlayerSummary {
  id: string;
  playerIndex: number;
  callsign: string;
  isHost: boolean;
  isBot: boolean;
  ready: boolean;
  connected: boolean;
  gridSlot: number;
  setup: CarSetupConfig;
  position: number;
  lap: number;
  bestLapMs: number | null;
  totalDriftScore: number;
  finished: boolean;
  finishTimeMs: number | null;
  pingMs: number;
}

export interface RacePodiumEntry {
  playerId: string;
  playerIndex: number;
  callsign: string;
  isBot: boolean;
  rank: number;
  vehicleId: VehicleId;
  liveryId: string;
  finishTimeMs: number | null;
  gapToWinnerMs: number | null;
  bestLapMs: number | null;
  totalDriftScore: number;
  dnf: boolean;
}

export interface RaceRoomStateBroadcast {
  code: string;
  isPublic: boolean;
  mode: RaceMode;
  trackId: TrackId;
  totalLaps: number;
  phase: RacePhase;
  gridRevision: number;
  waitingForReady: boolean;
  readyWaitExpired: boolean;
  canRestartPractice: boolean;
  raceRemainingSec: number;
  /** 3, 2, 1 during countdown; 0 on GO/RACING */
  countdownValue: number;
  countdownRemainingSec: number;
  raceElapsedMs: number;
  botFill: boolean;
  botDifficulty: BotDifficulty;
  players: RacePlayerSummary[];
  podium: RacePodiumEntry[];
  trackVoteOptions: TrackId[];
  trackVotes: Record<string, number>;
  podiumAutoRematchSec: number;
}

export interface RacePublicRoomSummary {
  code: string;
  mode: RaceMode;
  trackId: TrackId;
  phase: RacePhase;
  humanCount: number;
  playerCount: number;
  maxPlayers: number;
  botFill: boolean;
  botDifficulty: BotDifficulty;
}

export interface RaceCarSnapshot {
  playerId: string;
  playerIndex: number;
  /** Last client input seq applied by the server for zero-snap reconciliation */
  lastProcessedSeq: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  pitch: number;
  roll: number;
  suspensionOffset: number;
  suspensionVel: number;
  yawRate: number;
  steerAngle: number;
  wheelSpinRad: number;
  forwardSpeed: number;
  lateralSpeed: number;
  speedKmh: number;
  rpm: number;
  rpmNorm: number;
  gear: number;
  nitro: number;
  nitroActive: boolean;
  launchBoostTimer: number;
  drifting: boolean;
  driftAngleRad: number;
  currentDriftScore: number;
  driftMultiplier: number;
  totalDriftScore: number;
  slipstreamActive: boolean;
  slipstreamFactor: number;
  inTunnel: boolean;
  onGravel: boolean;
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
  position: number;
  lapStartTimeMs: number;
  currentLapTimeMs: number;
  bestLapMs: number | null;
  finished: boolean;
  finishTimeMs: number | null;
}

export type RaceEventMessage =
  | { type: "RACE_EVENT"; event: "COUNTDOWN_TICK"; value: 3 | 2 | 1 | 0 }
  | { type: "RACE_EVENT"; event: "PERFECT_LAUNCH"; playerId: string; callsign: string }
  | {
      type: "RACE_EVENT";
      event: "LAP_COMPLETE";
      playerId: string;
      lap: number;
      lapTimeMs: number;
      bestLapMs: number;
      splitDeltaMs: number | null;
    }
  | {
      type: "RACE_EVENT";
      event: "RACER_FINISHED";
      playerId: string;
      callsign: string;
      rank: number;
      finishTimeMs: number;
    }
  | { type: "RACE_EVENT"; event: "PODIUM_READY"; podium: RacePodiumEntry[] }
  | { type: "RACE_EVENT"; event: "REMATCH_STARTED"; trackId: TrackId };

export type RaceClientToServerMessage =
  | {
      type: "RACE_JOIN_OR_CREATE";
      action: "QUICK_PLAY" | "CREATE" | "JOIN_CODE";
      guestUuid: string;
      callsign: string;
      mode: RaceMode;
      trackId: TrackId;
      isPublic: boolean;
      botFill: boolean;
      botDifficulty?: BotDifficulty;
      roomCode?: string;
      setup: CarSetupConfig;
    }
  | { type: "RACE_SET_SETUP"; setup: CarSetupConfig }
  | {
      type: "RACE_UPDATE_SETTINGS";
      trackId?: TrackId;
      mode?: RaceMode;
      botFill?: boolean;
      botDifficulty?: BotDifficulty;
      isPublic?: boolean;
    }
  | { type: "RACE_START" }
  | { type: "RACE_READY"; gridRevision: number }
  | { type: "RACE_RESTART_PRACTICE" }
  | { type: "RACE_INPUT"; input: RaceInputCommand; clientTimeMs: number }
  | { type: "RACE_VOTE_TRACK"; trackId: TrackId }
  | { type: "RACE_REMATCH" }
  | { type: "RACE_PING"; t0: number };

export type RaceServerToClientMessage =
  | {
      type: "RACE_WELCOME";
      yourPlayerId: string;
      yourPlayerIndex: number;
      room: RaceRoomStateBroadcast;
      reconnected: boolean;
      protocolVersion: number;
    }
  | { type: "RACE_ROOM_STATE"; room: RaceRoomStateBroadcast }
  | {
      type: "RACE_SNAPSHOT";
      serverTick: number;
      serverTimeMs: number;
      phase: RacePhase;
      countdownValue: number;
      countdownRemainingSec: number;
      raceElapsedMs: number;
      cars: RaceCarSnapshot[];
    }
  | RaceEventMessage
  | { type: "RACE_PONG"; t0: number; serverTimeMs: number }
  | { type: "RACE_ERROR"; message: string };

/**
 * Serializes a VehiclePhysicsState into a compact wire RaceCarSnapshot.
 */
export function vehicleStateToSnapshot(
  playerId: string,
  playerIndex: number,
  lastProcessedSeq: number,
  positionRank: number,
  state: Readonly<VehiclePhysicsState>
): RaceCarSnapshot {
  return {
    playerId,
    playerIndex,
    lastProcessedSeq,
    x: state.position.x,
    y: state.position.y,
    z: state.position.z,
    vx: state.velocity.x,
    vy: state.velocity.y,
    vz: state.velocity.z,
    yaw: state.yaw,
    pitch: state.pitch,
    roll: state.roll,
    suspensionOffset: state.suspensionOffset,
    suspensionVel: state.suspensionVel,
    yawRate: state.yawRate,
    steerAngle: state.steerAngle,
    wheelSpinRad: state.wheelSpinRad,
    forwardSpeed: state.forwardSpeed,
    lateralSpeed: state.lateralSpeed,
    speedKmh: state.speedKmh,
    rpm: state.rpm,
    rpmNorm: state.rpmNorm,
    gear: state.gear,
    nitro: state.nitro,
    nitroActive: state.nitroActive,
    launchBoostTimer: state.launchBoostTimer,
    drifting: state.drifting,
    driftAngleRad: state.driftAngleRad,
    currentDriftScore: Math.round(state.currentDriftScore),
    driftMultiplier: state.driftMultiplier,
    totalDriftScore: state.totalDriftScore,
    slipstreamActive: state.slipstreamActive,
    slipstreamFactor: state.slipstreamFactor,
    inTunnel: state.inTunnel,
    onGravel: state.onGravel,
    wallScrapeIntensity: state.wallScrapeIntensity,
    wrongWay: state.wrongWay,
    brakeLight: state.brakeLight,
    brakeHeat: state.brakeHeat,
    trackFrameIndex: state.trackFrameIndex,
    distanceAlongLap: state.distanceAlongLap,
    progressAlongLap: state.progressAlongLap,
    lateralOffset: state.lateralOffset,
    lap: state.lap,
    checkpointIndex: state.checkpointIndex,
    totalRaceDistanceM: state.totalRaceDistanceM,
    position: positionRank,
    lapStartTimeMs: state.lapStartTimeMs,
    currentLapTimeMs: state.currentLapTimeMs,
    bestLapMs: state.bestLapMs,
    finished: state.finished,
    finishTimeMs: state.finishTimeMs,
  };
}

/**
 * Applies an authoritative RaceCarSnapshot onto a local VehiclePhysicsState before
 * replaying unacknowledged client inputs (`seq > snap.lastProcessedSeq`).
 */
export function applySnapshotToVehicleState(
  target: VehiclePhysicsState,
  snap: Readonly<RaceCarSnapshot>
): VehiclePhysicsState {
  target.position.x = snap.x;
  target.position.y = snap.y;
  target.position.z = snap.z;
  target.velocity.x = snap.vx;
  target.velocity.y = snap.vy;
  target.velocity.z = snap.vz;
  target.yaw = snap.yaw;
  target.pitch = snap.pitch;
  target.roll = snap.roll;
  target.suspensionOffset = snap.suspensionOffset;
  target.suspensionVel = snap.suspensionVel;
  target.yawRate = snap.yawRate;
  target.steerAngle = snap.steerAngle;
  target.wheelSpinRad = snap.wheelSpinRad;
  target.forwardSpeed = snap.forwardSpeed;
  target.lateralSpeed = snap.lateralSpeed;
  target.speedKmh = snap.speedKmh;
  target.rpm = snap.rpm;
  target.rpmNorm = snap.rpmNorm;
  target.gear = snap.gear;
  target.nitro = snap.nitro;
  target.nitroActive = snap.nitroActive;
  target.launchBoostTimer = snap.launchBoostTimer;
  target.drifting = snap.drifting;
  target.driftAngleRad = snap.driftAngleRad;
  target.currentDriftScore = snap.currentDriftScore;
  target.driftMultiplier = snap.driftMultiplier;
  target.totalDriftScore = snap.totalDriftScore;
  target.slipstreamActive = snap.slipstreamActive;
  target.slipstreamFactor = snap.slipstreamFactor;
  target.inTunnel = snap.inTunnel;
  target.onGravel = snap.onGravel;
  target.wallScrapeIntensity = snap.wallScrapeIntensity;
  target.wrongWay = snap.wrongWay;
  target.brakeLight = snap.brakeLight;
  target.brakeHeat = snap.brakeHeat;
  target.trackFrameIndex = snap.trackFrameIndex;
  target.distanceAlongLap = snap.distanceAlongLap;
  target.progressAlongLap = snap.progressAlongLap;
  target.lateralOffset = snap.lateralOffset;
  target.lap = snap.lap;
  target.checkpointIndex = snap.checkpointIndex;
  target.totalRaceDistanceM = snap.totalRaceDistanceM;
  target.lapStartTimeMs = snap.lapStartTimeMs;
  target.currentLapTimeMs = snap.currentLapTimeMs;
  target.bestLapMs = snap.bestLapMs;
  target.finished = snap.finished;
  target.finishTimeMs = snap.finishTimeMs;
  return target;
}
