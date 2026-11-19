import { Color3, Scene, StandardMaterial, Vector3 } from "@babylonjs/core";
import {
  FIXED_DT,
  applySnapshotToVehicleState,
  clamp,
  cloneVehicleState,
  computeEffectiveVehicleStats,
  createEmptyRaceInput,
  createInitialVehicleState,
  damp,
  getLiveryDefinition,
  getTrackBlueprint,
  getUnderglowDefinition,
  isInLaunchGreenZone,
  lerp,
  projectPointToTrack,
  sanitizeCarSetup,
  stepVehiclePhysics,
  type CarSetupConfig,
  type EffectiveVehicleStats,
  type RaceEventMessage,
  type RaceInputCommand,
  type RaceMode,
  type RacePhase,
  type RacePlayerSummary,
  type RacePodiumEntry,
  type RaceRoomStateBroadcast,
  type RivalDraftSample,
  type TrackBlueprint,
  type TrackFrame,
  type TrackId,
  type TransmissionMode,
  type Vec3,
  type VehiclePhysicsState,
} from "@game/shared";
import type { EngineApp } from "../../core/EngineApp.js";
import { GameLoop } from "../../core/GameLoop.js";
import type { GuestProfile } from "../../state/UserProfileStore.js";
import { ChaseCamera, getCameraModeLabel, type RaceCameraMode } from "./ChaseCamera.js";
import { DriftVfxSystem } from "./DriftVfxSystem.js";
import type { EngineAudioSynth, RivalAudioSample } from "./EngineAudioSynth.js";
import { RaceAssetCache, type CarVisualRig } from "./RaceAssetCache.js";
import { RACE_PAD, type RaceTouchControl } from "./RaceControls.js";
import type { RaceNetClient, SelfSnapshotEnvelope } from "./RaceNetClient.js";
import { TrackBuilder, type BuiltTrackEnvironment } from "./TrackBuilder.js";
import { GHOST_FRAME_INTERVAL_MS, loadTimeTrialGhost, saveTimeTrialGhost, type GhostFrame, type TimeTrialGhost } from "./TimeTrialGhost.js";

export interface RaceMinimapCar {
  id: string;
  callsign: string;
  x: number;
  z: number;
  yaw: number;
  isPlayer: boolean;
  isBot: boolean;
  position: number;
  colorHex: string;
}

export interface RaceStandingRow {
  playerId: string;
  callsign: string;
  isPlayer: boolean;
  isBot: boolean;
  position: number;
  vehicleId: string;
  liveryHex: string;
  lap: number;
  bestLapMs: number | null;
  totalDriftScore: number;
  finished: boolean;
  finishTimeMs: number | null;
  pingMs: number;
}

export interface RaceHudSnapshot {
  speedKmh: number;
  rpm: number;
  rpmNorm: number;
  gear: number;
  transmission: TransmissionMode;
  nitroPct: number;
  nitroActive: boolean;
  drifting: boolean;
  driftScore: number;
  totalDriftScore: number;
  driftMultiplier: number;
  slipstreamActive: boolean;
  wrongWay: boolean;
  countdownState: number; // 3, 2, 1 during countdown; 0 during GO flash; -1 otherwise
  phase: RacePhase;
  inLaunchGreenZone: boolean;
  perfectLaunchActive: boolean;
  position: number;
  totalRacers: number;
  lap: number;
  totalLaps: number;
  lapTimeMs: number;
  bestLapMs: number | null;
  splitDeltaMs: number | null;
  playerPos: Vec3;
  playerYaw: number;
  cameraMode: RaceCameraMode;
  cameraModeLabel: string;
  minimapCars: RaceMinimapCar[];
  standings: RaceStandingRow[];
  fps: number;
  pingMs: number | null;
  finished: boolean;
  podiumEntries: RacePodiumEntry[];
  timeTrialGhostMs: number | null;
  inTunnel: boolean;
  onGravel: boolean;
  paused: boolean;
}

export interface RaceFinishSummary {
  rank: number;
  dnf: boolean;
  bestLapMs: number | null;
  totalDriftScore: number;
  trackId: TrackId;
  mode: RaceMode;
}

export interface RacerSceneCallbacks {
  onHudUpdate: (snap: RaceHudSnapshot) => void;
  onRoomUpdate: (room: RaceRoomStateBroadcast) => void;
  onRaceEvent?: (ev: RaceEventMessage) => void;
  onPauseChanged?: (paused: boolean) => void;
  onStandingsChanged?: (visible: boolean) => void;
  onGridLoading?: (room: RaceRoomStateBroadcast | null) => void;
  onFinishRace?: (summary: RaceFinishSummary) => void;
}

interface PendingInputRecord {
  input: RaceInputCommand;
  raceElapsedMs: number;
  gridLocked: boolean;
}

interface RivalVisualEntry {
  playerId: string;
  playerIndex: number;
  setupKey: string;
  rig: CarVisualRig;
  lastPos: Vector3;
  lastYaw: number;
  lastSpeedKmh: number;
  lastRpmNorm: number;
  lastDrifting: boolean;
}

function wrapAngleRad(a: number): number {
  let r = a;
  while (r > Math.PI) r -= Math.PI * 2;
  while (r < -Math.PI) r += Math.PI * 2;
  return r;
}

function lerpAngle(a: number, b: number, t: number): number {
  return wrapAngleRad(a + wrapAngleRad(b - a) * t);
}

function setupSignature(setup: CarSetupConfig): string {
  return `${setup.vehicleId}|${setup.liveryId}|${setup.spoilerId}|${setup.rimId}|${setup.underglowId}`;
}

function isEditableFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el as HTMLElement).isContentEditable;
}

/**
 * Full 3D Playable Street & Track Racing Scene (Game 2 — ApexDrive Street Racer):
 * - Fixed 60Hz local physics prediction with zero-snap server sequence reconciliation & 150ms visual error damping
 * - 100ms smoothly interpolated rival cars with live wheel spin, steering, brake lights, drift smoke & 3D spatial audio
 * - Keyboard + HTML5 Gamepad API input polling
 * - TrackBuilder 3D spline circuits, DriftVfxSystem (500 ThinInstance skid marks, smoke, nitro flames, sparks),
 *   ChaseCamera (4 modes + look-back + finish podium orbit), and EngineAudioSynth
 */
export class RacerScene {
  public readonly scene: Scene;
  public readonly assets: RaceAssetCache;
  public readonly chaseCam: ChaseCamera;
  public readonly vfx: DriftVfxSystem;

  private readonly loop: GameLoop;
  private room: RaceRoomStateBroadcast;
  private track: TrackBlueprint;
  private builtTrack: BuiltTrackEnvironment | null = null;

  private localSetup: CarSetupConfig;
  private localStats: EffectiveVehicleStats;
  private localState: VehiclePhysicsState;
  private prevLocalState: VehiclePhysicsState;
  private localRig: CarVisualRig | null = null;

  private readonly rivalEntries = new Map<string, RivalVisualEntry>();
  private readonly pendingInputs: PendingInputRecord[] = [];
  private lastReconciledServerTick = -1;

  // Residual reconciliation offset smoothly damped to zero over ~150ms (ZERO snap-back!)
  private readonly visualOffset = new Vector3();
  private visualYawOffset = 0;

  // Input state (Keyboard + HTML5 Gamepad)
  private readonly keysDown = new Set<string>();
  private readonly touchControls = new Set<RaceTouchControl>();
  private gamepadStandingsHeld = false;
  private keySteerSmoothed = 0;
  private queuedShiftUp = false;
  private queuedShiftDown = false;
  private queuedReset = false;
  private lookBackHeld = false;
  private standingsVisible = false;
  private paused = false;
  private disposed = false;
  private started = false;

  // Gamepad edge-trigger memory
  private gpPrevCam = false;
  private gpPrevShiftUp = false;
  private gpPrevShiftDown = false;
  private gpPrevReset = false;
  private gpPrevPause = false;

  // Race event / HUD transient timers
  private raceElapsedMs = 0;
  private localPositionRank = 1;
  private lastSampledThrottle = 0;
  private lastSplitDeltaMs: number | null = null;
  private splitBannerTimer = 0;
  private goBannerTimer = 0;
  private perfectLaunchTimer = 0;
  private finishReportedForRace = false;
  private prevScrapeSoundCooldown = 0;
  private prevBumpSoundCooldown = 0;
  private preparedGridRevision = 0;
  private trackRebuildInFlight = false;
  private ghostRig: CarVisualRig | null = null;
  private ghostMaterial: StandardMaterial | null = null;
  private ghost: TimeTrialGhost | null = null;
  private ghostRecording: GhostFrame[] = [];
  private ghostFrameIndex = 0;

  // Scratch vectors (zero per-frame allocations)
  private readonly _carPos = new Vector3();
  private readonly _carFwd = new Vector3();
  private readonly _carUp = new Vector3();
  private readonly _carVel = new Vector3();
  private readonly _rivalPos = new Vector3();
  private readonly _rivalFwd = new Vector3();
  private readonly _rivalUp = new Vector3();
  private readonly _rivalVel = new Vector3();

  // Bound DOM listeners
  private readonly onKeyDownBound: (e: KeyboardEvent) => void;
  private readonly onKeyUpBound: (e: KeyboardEvent) => void;
  private readonly onBlurBound: () => void;

  constructor(
    private readonly app: EngineApp,
    private readonly net: RaceNetClient,
    private readonly audio: EngineAudioSynth,
    private readonly profile: GuestProfile,
    initialRoom: RaceRoomStateBroadcast,
    private readonly localPlayerId: string,
    private readonly callbacks: RacerSceneCallbacks
  ) {
    this.room = initialRoom;
    this.track = getTrackBlueprint(initialRoom.trackId);

    const localSummary = initialRoom.players.find((p) => p.id === localPlayerId);
    this.localSetup = sanitizeCarSetup((localSummary?.setup ?? profile.racing) as Partial<CarSetupConfig>);
    this.localStats = computeEffectiveVehicleStats(this.localSetup.vehicleId, this.localSetup.tuneId);

    const gridSlot = localSummary?.gridSlot ?? 0;
    this.localState = createInitialVehicleState(this.track, gridSlot, this.localStats);
    this.prevLocalState = cloneVehicleState(this.localState);
    this.localPositionRank = localSummary?.position ?? gridSlot + 1;

    this.scene = new Scene(app.engine);
    this.assets = new RaceAssetCache(this.scene);
    this.chaseCam = new ChaseCamera(this.scene, "racer_chase_cam");
    this.scene.activeCamera = this.chaseCam.camera;
    this.vfx = new DriftVfxSystem(this.scene);

    this.loop = new GameLoop({
      onFixedStep: (dt) => this.onFixedStep(dt),
      onRenderFrame: (alpha, rawDt) => this.onRenderFrame(alpha, rawDt),
      onFpsSample: (fps) => {
        const presetScale = this.getTargetHardwareScaling();
        this.app.adaptResolution(fps, presetScale);
      },
    });

    this.onKeyDownBound = (e) => this.handleKeyDown(e);
    this.onKeyUpBound = (e) => this.handleKeyUp(e);
    this.onBlurBound = () => {
      this.keysDown.clear();
      this.touchControls.clear();
      this.lookBackHeld = false;
      if (this.standingsVisible) {
        this.standingsVisible = false;
        this.callbacks.onStandingsChanged?.(false);
      }
    };
  }

  private getTargetHardwareScaling(): number {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    switch (this.profile.settings.graphicsQuality) {
      case "LOW":
        return 1.35;
      case "MEDIUM":
        return 1.05;
      case "HIGH":
        return 1 / Math.min(dpr, 1.25);
      case "ULTRA":
        return 1 / dpr;
    }
  }

  async warmUpAndStart(onProgress?: (pct: number, detail: string) => void): Promise<void> {
    if (this.disposed || this.started) return;
    this.app.resetResolution(this.getTargetHardwareScaling());
    this.app.setScene(this.scene);
    onProgress?.(10, "Loading cars and the selected circuit");
    await this.prepareLatestGrid(onProgress);
    if (this.disposed) return;

    this.audio.setMasterVolume(this.profile.settings.masterVolume);
    this.audio.startEngine(this.localStats.engineAudioProfile);
    window.addEventListener("keydown", this.onKeyDownBound);
    window.addEventListener("keyup", this.onKeyUpBound);
    window.addEventListener("blur", this.onBlurBound);
    this.started = true;
    this.loop.start();
    onProgress?.(100, "Ready on the grid");
  }

  private async prepareLatestGrid(onProgress?: (pct: number, detail: string) => void): Promise<void> {
    while (!this.disposed && this.preparedGridRevision !== this.room.gridRevision) {
      const { gridRevision, trackId } = this.room;
      const rebuild = !this.builtTrack || this.track.id !== trackId;
      if (rebuild) {
        await this.assets.preload(getTrackBlueprint(trackId).theme);
        if (this.disposed) return;
        if (gridRevision !== this.room.gridRevision) continue;
        onProgress?.(68, "Building the circuit and starting grid");
        this.rebuildTrackGeometry(trackId);
        this.rebuildLocalCarRig();
        for (const entry of this.rivalEntries.values()) entry.rig.dispose();
        this.rivalEntries.clear();
      }
      this.syncRivalRigs(this.room.players);
      const local = this.room.players.find((p) => p.id === this.localPlayerId);
      this.resetForNewRace(local?.gridSlot ?? 0);
      this.prepareTimeTrialGhost();

      if (rebuild) {
        onProgress?.(86, "Preparing circuit textures and shaders");
        await this.waitForSceneReady();
        if (this.disposed) return;
        if (gridRevision !== this.room.gridRevision) continue;
      }
      const self = this.net.getLatestSelfSnapshot();
      if (self && self.phase === this.room.phase) {
        applySnapshotToVehicleState(this.localState, self.car);
        this.prevLocalState = cloneVehicleState(this.localState);
        this.lastReconciledServerTick = self.serverTick;
        this.localPositionRank = self.car.position;
      }
      this.applyLocalCarVisual(this.localState, 0);
      this.snapCameraToLocalCar();
      this.syncGantryLightFromRoom();
      this.preparedGridRevision = gridRevision;
    }
  }

  private async waitForSceneReady(): Promise<void> {
    this.scene.render();
    await new Promise<void>((resolve) => {
      const timeout = window.setTimeout(resolve, 5500);
      this.scene.executeWhenReady(() => {
        window.clearTimeout(timeout);
        resolve();
      });
    });
  }

  markGridReady(): void {
    if (this.started && !this.disposed && !this.trackRebuildInFlight && this.room.phase === "LOBBY") {
      this.net.send({ type: "RACE_READY", gridRevision: this.preparedGridRevision });
    }
  }

  private async prepareNextGrid(): Promise<void> {
    if (this.trackRebuildInFlight) return;
    this.trackRebuildInFlight = true;
    this.callbacks.onGridLoading?.(this.room);
    try {
      await this.prepareLatestGrid();
    } finally {
      this.trackRebuildInFlight = false;
      if (!this.disposed) this.callbacks.onGridLoading?.(null);
    }
    this.markGridReady();
  }

  private rebuildTrackGeometry(trackId: TrackId): void {
    this.builtTrack?.dispose();
    this.track = getTrackBlueprint(trackId);
    this.builtTrack = TrackBuilder.build(this.scene, this.track, this.assets, {
      camera: this.chaseCam.camera,
      quality: this.profile.settings.graphicsQuality,
    });
    this.vfx.clearSkidMarks();
  }

  private rebuildLocalCarRig(): void {
    this.localRig?.dispose();
    const livery = getLiveryDefinition(this.localSetup.liveryId);
    const underglow = getUnderglowDefinition(this.localSetup.underglowId);
    this.localRig = this.assets.buildCarRig({
      vehicleId: this.localSetup.vehicleId,
      livery,
      spoilerId: this.localSetup.spoilerId,
      rimId: this.localSetup.rimId,
      underglowHex: underglow.hex,
      isNight: this.track.isNight,
      shadowGen: this.builtTrack?.shadowGenerator ?? undefined,
      idSuffix: "local",
    });
    this.localRig.setHeadlights(this.track.isNight);
    this.localRig.setUnderglow(underglow.hex);
  }

  private syncRivalRigs(players: readonly RacePlayerSummary[]): void {
    const activeIds = new Set<string>();
    for (const p of players) {
      if (p.id === this.localPlayerId) continue;
      activeIds.add(p.id);

      const cleanSetup = sanitizeCarSetup(p.setup);
      const sig = setupSignature(cleanSetup);
      const existing = this.rivalEntries.get(p.id);

      if (!existing || existing.setupKey !== sig) {
        existing?.rig.dispose();
        const livery = getLiveryDefinition(cleanSetup.liveryId);
        const underglow = getUnderglowDefinition(cleanSetup.underglowId);
        const rig = this.assets.buildCarRig({
          vehicleId: cleanSetup.vehicleId,
          livery,
          spoilerId: cleanSetup.spoilerId,
          rimId: cleanSetup.rimId,
          underglowHex: underglow.hex,
          isNight: this.track.isNight,
          shadowGen: this.builtTrack?.shadowGenerator ?? undefined,
          idSuffix: `rival_${p.playerIndex}`,
        });
        rig.setHeadlights(this.track.isNight);
        rig.setUnderglow(underglow.hex);

        const initialStats = computeEffectiveVehicleStats(cleanSetup.vehicleId, cleanSetup.tuneId);
        const initState = createInitialVehicleState(this.track, p.gridSlot, initialStats);
        rig.root.position.set(initState.position.x, initState.position.y, initState.position.z);
        rig.root.rotation.set(0, initState.yaw, 0);

        this.rivalEntries.set(p.id, {
          playerId: p.id,
          playerIndex: p.playerIndex,
          setupKey: sig,
          rig,
          lastPos: new Vector3(initState.position.x, initState.position.y, initState.position.z),
          lastYaw: initState.yaw,
          lastSpeedKmh: 0,
          lastRpmNorm: 0.1,
          lastDrifting: false,
        });
      }
    }

    // Dispose departed rival rigs
    for (const [id, entry] of this.rivalEntries.entries()) {
      if (!activeIds.has(id)) {
        entry.rig.dispose();
        this.rivalEntries.delete(id);
      }
    }
  }

  private snapCameraToLocalCar(): void {
    const proj = projectPointToTrack(this.track, this.localState.position, this.localState.trackFrameIndex);
    this._carPos.set(this.localState.position.x, this.localState.position.y, this.localState.position.z);
    this._carFwd.set(Math.sin(this.localState.yaw), Math.sin(proj.frame.pitch), Math.cos(this.localState.yaw)).normalize();
    this._carUp.set(proj.frame.up.x, proj.frame.up.y, proj.frame.up.z);
    this.chaseCam.snapToCar(this._carPos, this._carFwd, this._carUp);
  }

  private syncGantryLightFromRoom(): void {
    if (!this.builtTrack) return;
    if (this.room.phase === "COUNTDOWN") {
      this.builtTrack.setCountdownLight(this.room.countdownValue);
    } else if (this.room.phase === "RACING") {
      this.builtTrack.setCountdownLight(this.goBannerTimer > 0 ? 0 : -1);
    } else {
      this.builtTrack.setCountdownLight(-1);
    }
  }

  // ---------------------------------------------------------------------------
  // PUBLIC LIFECYCLE & NETWORK HANDLERS
  // ---------------------------------------------------------------------------
  handleRoomState(nextRoom: RaceRoomStateBroadcast): void {
    if (this.disposed) return;

    const gridChanged = nextRoom.gridRevision !== this.room.gridRevision;
    this.room = nextRoom;
    if (gridChanged) this.net.clearSnapshots();

    const localSummary = nextRoom.players.find((p) => p.id === this.localPlayerId);
    if (localSummary) {
      this.localPositionRank = localSummary.position;
      const incomingSetup = sanitizeCarSetup(localSummary.setup);
      const visualChanged = setupSignature(incomingSetup) !== setupSignature(this.localSetup);
      const engineChanged = incomingSetup.vehicleId !== this.localSetup.vehicleId;
      this.localSetup = { ...incomingSetup, transmission: this.localSetup.transmission };
      this.localStats = computeEffectiveVehicleStats(incomingSetup.vehicleId, incomingSetup.tuneId);
      if (this.started && this.builtTrack && visualChanged) this.rebuildLocalCarRig();
      if (this.started && engineChanged) this.audio.startEngine(this.localStats.engineAudioProfile);
    }

    if (this.started && gridChanged) {
      void this.prepareNextGrid().catch((err: unknown) => {
        console.error("Unable to prepare the next ApexDrive grid", err);
      });
    } else if (this.started && !this.trackRebuildInFlight) {
      this.syncRivalRigs(nextRoom.players);
    }

    if (nextRoom.phase === "PODIUM") {
      this.enterFinishOrbitIfNeeded();
      this.reportFinalResult(nextRoom.podium);
    }
    this.syncGantryLightFromRoom();
    this.callbacks.onRoomUpdate(nextRoom);
  }

  handleRaceEvent(ev: RaceEventMessage): void {
    if (this.disposed) return;

    if (ev.event === "COUNTDOWN_TICK") {
      this.builtTrack?.setCountdownLight(ev.value);
      this.audio.playCountdownBeep(ev.value === 0);

      if (ev.value === 0) {
        this.goBannerTimer = 1.4;
        this.raceElapsedMs = 0;
        // Local immediate launch-control response (server also runs identical check on its GO tick!)
        if (isInLaunchGreenZone(this.localState.rpmNorm)) {
          this.perfectLaunchTimer = 2.0;
          this.audio.playLaunchBoost();
        }
      }
    } else if (ev.event === "PERFECT_LAUNCH" && ev.playerId === this.localPlayerId) {
      if (this.perfectLaunchTimer <= 0.1) {
        this.audio.playLaunchBoost();
      }
      this.perfectLaunchTimer = 2.0;
      this.chaseCam.triggerImpactShake(0.42);
    } else if (ev.event === "LAP_COMPLETE" && ev.playerId === this.localPlayerId) {
      this.lastSplitDeltaMs = ev.splitDeltaMs;
      this.splitBannerTimer = 3.6;
    } else if (ev.event === "RACER_FINISHED" && ev.playerId === this.localPlayerId) {
      this.localState.finished = true;
      this.localState.finishTimeMs = ev.finishTimeMs;
      this.localPositionRank = ev.rank;
      this.enterFinishOrbitIfNeeded();
    } else if (ev.event === "PODIUM_READY") {
      this.room = { ...this.room, podium: ev.podium, phase: "PODIUM" };
      this.enterFinishOrbitIfNeeded();
      this.reportFinalResult(ev.podium);
      this.callbacks.onRoomUpdate(this.room);
    }

    this.callbacks.onRaceEvent?.(ev);
  }

  private reportFinalResult(podium: RacePodiumEntry[]): void {
    const result = podium.find((entry) => entry.playerId === this.localPlayerId);
    if (this.finishReportedForRace || !result) return;

    this.finishReportedForRace = true;
    this.localPositionRank = result.rank;
    this.localState.bestLapMs = result.bestLapMs;
    this.localState.finishTimeMs = result.finishTimeMs;
    this.localState.finished = !result.dnf;
    if (this.room.mode === "TIME_TRIAL" && result.bestLapMs !== null && !result.dnf &&
        (!this.ghost || result.bestLapMs < this.ghost.lapTimeMs)) {
      const lapTimeMs = result.bestLapMs;
      const frames = this.ghostRecording.filter((frame) => frame[0] <= lapTimeMs);
      if (frames.length >= 2 && lapTimeMs - frames[frames.length - 1][0] <= 750) {
        saveTimeTrialGhost(this.profile.guestUuid, this.track.id, { lapTimeMs, setup: this.localSetup, frames });
      }
    }
    this.callbacks.onFinishRace?.({
      rank: result.rank,
      dnf: result.dnf,
      bestLapMs: result.bestLapMs,
      totalDriftScore: result.totalDriftScore,
      trackId: this.track.id,
      mode: this.room.mode,
    });
  }

  private prepareTimeTrialGhost(): void {
    this.ghostRig?.dispose();
    this.ghostMaterial?.dispose();
    this.ghostRig = null;
    this.ghostMaterial = null;
    this.ghost = null;
    this.ghostRecording = [];
    this.ghostFrameIndex = 0;
    if (this.room.mode !== "TIME_TRIAL") return;

    const initial = this.localState;
    this.ghostRecording.push([0, initial.position.x, initial.position.y, initial.position.z, initial.yaw, initial.pitch, initial.roll]);
    this.ghost = loadTimeTrialGhost(this.profile.guestUuid, this.track.id);
    if (!this.ghost) return;

    const setup = this.ghost.setup;
    const rig = this.assets.buildCarRig({
      idSuffix: "time_trial_ghost",
      vehicleId: setup.vehicleId,
      livery: getLiveryDefinition("tokyo_cyber_cyan"),
      spoilerId: setup.spoilerId,
      rimId: setup.rimId,
      underglowHex: null,
      isNight: false,
    });
    rig.setHeadlights(false);
    const ghostMaterial = new StandardMaterial("time_trial_ghost_material", this.scene);
    ghostMaterial.emissiveColor = new Color3(0.08, 0.72, 0.92);
    ghostMaterial.alpha = 0.32;
    ghostMaterial.disableLighting = true;
    for (const mesh of rig.root.getChildMeshes()) {
      mesh.material = ghostMaterial;
      mesh.receiveShadows = false;
    }
    rig.root.setEnabled(false);
    this.ghostRig = rig;
    this.ghostMaterial = ghostMaterial;
  }

  private recordGhostFrame(snapshot: SelfSnapshotEnvelope): void {
    if (this.room.mode !== "TIME_TRIAL" || snapshot.phase !== "RACING" || this.finishReportedForRace) return;
    const time = snapshot.raceElapsedMs;
    const previous = this.ghostRecording[this.ghostRecording.length - 1];
    if (!previous || time - previous[0] < GHOST_FRAME_INTERVAL_MS) return;

    const { x, y, z, yaw, pitch, roll } = snapshot.car;
    const round = (value: number) => Math.round(value * 1000) / 1000;
    this.ghostRecording.push([time, round(x), round(y), round(z), round(yaw), round(pitch), round(roll)]);
  }

  private renderTimeTrialGhost(): void {
    const rig = this.ghostRig;
    const ghost = this.ghost;
    if (!rig || !ghost) return;
    const time = this.raceElapsedMs;
    const active = this.room.phase === "RACING" && time <= ghost.lapTimeMs;
    rig.root.setEnabled(active);
    if (!active) return;

    const frames = ghost.frames;
    while (this.ghostFrameIndex > 0 && frames[this.ghostFrameIndex][0] > time) this.ghostFrameIndex--;
    while (this.ghostFrameIndex < frames.length - 2 && frames[this.ghostFrameIndex + 1][0] <= time) this.ghostFrameIndex++;
    const [a, b] = [frames[this.ghostFrameIndex], frames[this.ghostFrameIndex + 1]];
    const t = clamp((time - a[0]) / (b[0] - a[0]), 0, 1);
    rig.root.position.set(lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(a[3], b[3], t));
    rig.root.rotation.y = lerpAngle(a[4], b[4], t);
    rig.chassisNode.rotation.x = -lerp(a[5], b[5], t);
    rig.chassisNode.rotation.z = lerp(a[6], b[6], t);
  }

  private resetForNewRace(gridSlot: number): void {
    this.pendingInputs.length = 0;
    this.lastReconciledServerTick = -1;
    this.visualOffset.setAll(0);
    this.visualYawOffset = 0;
    this.raceElapsedMs = 0;
    this.lastSplitDeltaMs = null;
    this.splitBannerTimer = 0;
    this.goBannerTimer = 0;
    this.perfectLaunchTimer = 0;
    this.finishReportedForRace = false;

    this.localState = createInitialVehicleState(this.track, gridSlot, this.localStats);
    this.prevLocalState = cloneVehicleState(this.localState);
    this.vfx.clearSkidMarks();
    this.chaseCam.exitFinishOrbit();
    this.applyLocalCarVisual(this.localState, 0);
    this.snapCameraToLocalCar();
  }

  private enterFinishOrbitIfNeeded(): void {
    if (this.chaseCam.isOrbiting()) return;
    this._carPos.set(this.localState.position.x, this.localState.position.y, this.localState.position.z);
    this._carFwd.set(Math.sin(this.localState.yaw), 0, Math.cos(this.localState.yaw)).normalize();
    this.chaseCam.enterFinishOrbit(this._carPos, this._carFwd, 7.2, 2.05);
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (paused) {
      this.keysDown.clear();
      this.touchControls.clear();
      this.lookBackHeld = false;
    }
    this.callbacks.onPauseChanged?.(paused);
  }

  isPaused(): boolean {
    return this.paused;
  }

  cycleCameraMode(): RaceCameraMode {
    const next = this.chaseCam.cycleMode();
    if (!this.chaseCam.isOrbiting()) {
      this.snapCameraToLocalCar();
    }
    return next;
  }

  setTransmission(mode: TransmissionMode): void {
    this.localSetup = { ...this.localSetup, transmission: mode };
    this.profile.racing.transmission = mode;
  }

  updateLocalCarSetup(setup: Partial<CarSetupConfig> | Partial<Record<keyof CarSetupConfig, string>>): void {
    if (this.room.phase !== "LOBBY") return;
    const next = sanitizeCarSetup({ ...this.localSetup, ...(setup as Partial<CarSetupConfig>) });
    this.localSetup = next;
    this.localStats = computeEffectiveVehicleStats(next.vehicleId, next.tuneId);
    if (this.started) {
      this.rebuildLocalCarRig();
      this.audio.startEngine(this.localStats.engineAudioProfile);
    }
    this.net.send({ type: "RACE_SET_SETUP", setup: next });
  }

  setTouchControl(control: RaceTouchControl, active: boolean): void {
    if (!active) {
      this.touchControls.delete(control);
      return;
    }
    if (this.paused || this.room.phase === "PODIUM") return;
    if (control === "camera") this.cycleCameraMode();
    else if (control === "reset") this.queuedReset = true;
    else if (control === "shiftUp") this.queuedShiftUp = true;
    else if (control === "shiftDown") this.queuedShiftDown = true;
    else this.touchControls.add(control);
  }

  applyUpdatedSettings(): void {
    this.audio.setMasterVolume(this.profile.settings.masterVolume);
    this.app.resetResolution(this.getTargetHardwareScaling());
  }

  resetNetworkState(): void {
    this.pendingInputs.length = 0;
    this.lastReconciledServerTick = -1;
    this.visualOffset.setAll(0);
    this.visualYawOffset = 0;
  }

  getTrackFrames(): readonly TrackFrame[] {
    return this.builtTrack?.frames ?? [];
  }

  getTrackBlueprint(): TrackBlueprint {
    return this.track;
  }

  // ---------------------------------------------------------------------------
  // KEYBOARD + HTML5 GAMEPAD INPUT HANDLING
  // ---------------------------------------------------------------------------
  private handleKeyDown(e: KeyboardEvent): void {
    if (isEditableFocused()) return;

    if (e.code === "Tab") {
      e.preventDefault();
      if (!this.standingsVisible) {
        this.standingsVisible = true;
        this.callbacks.onStandingsChanged?.(true);
      }
      return;
    }

    if (e.code === "KeyM" || e.code === "Escape") {
      if (!e.repeat) {
        e.preventDefault();
        this.setPaused(!this.paused);
      }
      return;
    }

    if (this.paused) return;

    if (
      e.code === "Space" ||
      e.code === "ArrowUp" ||
      e.code === "ArrowDown" ||
      e.code === "ArrowLeft" ||
      e.code === "ArrowRight"
    ) {
      e.preventDefault();
    }

    // Unlock Web Audio on first user driving keystroke
    this.audio.unlock();
    this.keysDown.add(e.code);

    if (!e.repeat) {
      if (e.code === "KeyC") {
        this.cycleCameraMode();
      } else if (e.code === "KeyE") {
        this.queuedShiftUp = true;
      } else if (e.code === "KeyQ") {
        this.queuedShiftDown = true;
      } else if (e.code === "KeyR") {
        this.queuedReset = true;
      }
    }

    if (e.code === "KeyB") {
      this.lookBackHeld = true;
    }
  }

  private handleKeyUp(e: KeyboardEvent): void {
    this.keysDown.delete(e.code);

    if (e.code === "Tab") {
      e.preventDefault();
      if (this.standingsVisible) {
        this.standingsVisible = false;
        this.callbacks.onStandingsChanged?.(false);
      }
      return;
    }

    if (e.code === "KeyB") {
      this.lookBackHeld = false;
    }
  }

  private sampleControls(dt: number): { input: RaceInputCommand; lookBack: boolean } {
    const seq = this.net.nextInputSeq();
    const pads = typeof navigator.getGamepads === "function" ? navigator.getGamepads() : [];
    const pad = Array.from(pads).find((candidate) => candidate?.connected && candidate.mapping === "standard");
    const btnVal = (idx: number) => pad?.buttons[idx]?.value ?? 0;
    const btnDown = (idx: number) => Boolean(pad?.buttons[idx]?.pressed);
    const menu = btnDown(RACE_PAD.menu.index);
    if (menu && !this.gpPrevPause) this.setPaused(!this.paused);
    this.gpPrevPause = menu;
    const padStandings = !this.paused && btnDown(RACE_PAD.standings.index);
    if (this.gamepadStandingsHeld !== padStandings) {
      this.gamepadStandingsHeld = padStandings;
      this.callbacks.onStandingsChanged?.(padStandings || this.standingsVisible);
    }
    if (this.paused || this.room.phase === "PODIUM" || this.localState.finished) {
      this.keySteerSmoothed = damp(this.keySteerSmoothed, 0, 12, dt);
      return {
        input: { ...createEmptyRaceInput(seq), transmission: this.localSetup.transmission },
        lookBack: false,
      };
    }

    // 1. Keyboard controls
    let throttle = this.keysDown.has("KeyW") || this.keysDown.has("ArrowUp") || this.touchControls.has("throttle") ? 1 : 0;
    let brake = this.keysDown.has("KeyS") || this.keysDown.has("ArrowDown") || this.touchControls.has("brake") ? 1 : 0;
    const leftKey = this.keysDown.has("KeyA") || this.keysDown.has("ArrowLeft") || this.touchControls.has("left");
    const rightKey = this.keysDown.has("KeyD") || this.keysDown.has("ArrowRight") || this.touchControls.has("right");
    const rawKeySteer = (rightKey ? 1 : 0) - (leftKey ? 1 : 0);

    // Responsive counter-steering ramp for keyboard drivers
    const steerLambda = rawKeySteer === 0 ? 18 : rawKeySteer * this.keySteerSmoothed < 0 ? 28 : 13;
    this.keySteerSmoothed = damp(this.keySteerSmoothed, rawKeySteer, steerLambda, dt);
    if (Math.abs(this.keySteerSmoothed) < 0.01 && rawKeySteer === 0) {
      this.keySteerSmoothed = 0;
    }

    let steer = this.keySteerSmoothed;
    let handbrake = this.keysDown.has("Space") || this.touchControls.has("drift");
    let nitro = this.keysDown.has("ShiftLeft") || this.keysDown.has("ShiftRight") || this.touchControls.has("nitro");
    let shiftUp = this.queuedShiftUp;
    let shiftDown = this.queuedShiftDown;
    let reset = this.queuedReset;
    let lookBack = this.lookBackHeld;

    this.queuedShiftUp = false;
    this.queuedShiftDown = false;
    this.queuedReset = false;

    if (pad) {
      const rt = btnVal(RACE_PAD.throttle.index);
      const accelerate = btnDown(RACE_PAD.accelerateButton.index);
      throttle = Math.max(throttle, rt, accelerate && rt < 0.1 ? 0.95 : 0);
      brake = Math.max(brake, btnVal(RACE_PAD.brake.index), btnDown(RACE_PAD.brakeButton.index) ? 1 : 0);

      // Left stick X (axis 0) with 0.10 deadzone and gentle precision curve
      const rawAxis = pad.axes[0] ?? 0;
      if (Math.abs(rawAxis) > 0.1) {
        const mag = (Math.abs(rawAxis) - 0.1) / 0.9;
        const curved = Math.sign(rawAxis) * (mag * 0.72 + mag * mag * 0.28);
        steer = clamp(curved, -1, 1);
      }

      if (btnDown(RACE_PAD.driftButton.index) || btnDown(RACE_PAD.drift.index)) handbrake = true; // B or LB
      if (btnDown(RACE_PAD.nitro.index) || (accelerate && rt > 0.2)) nitro = true; // RB or A while RT held
      if (btnDown(RACE_PAD.rearLeft.index) || btnDown(RACE_PAD.rearRight.index)) lookBack = true; // L3 / R3 look-back

      const gpCam = btnDown(RACE_PAD.camera.index); // Y / Triangle
      if (gpCam && !this.gpPrevCam) this.cycleCameraMode();
      this.gpPrevCam = gpCam;

      const gpUp = btnDown(RACE_PAD.shiftUp.index); // D-pad up
      if (gpUp && !this.gpPrevShiftUp) shiftUp = true;
      this.gpPrevShiftUp = gpUp;

      const gpDown = btnDown(RACE_PAD.shiftDown.index); // D-pad down
      if (gpDown && !this.gpPrevShiftDown) shiftDown = true;
      this.gpPrevShiftDown = gpDown;

      const gpReset = btnDown(RACE_PAD.reset.index); // Back / Share
      if (gpReset && !this.gpPrevReset) reset = true;
      this.gpPrevReset = gpReset;

    }

    return {
      input: {
        seq,
        throttle: clamp(throttle, 0, 1),
        brake: clamp(brake, 0, 1),
        steer: clamp(steer, -1, 1),
        handbrake,
        nitro,
        shiftUp,
        shiftDown,
        reset,
        transmission: this.localSetup.transmission,
      },
      lookBack,
    };
  }

  // ---------------------------------------------------------------------------
  // 60HZ FIXED PHYSICS STEP + ZERO-SNAP LOCAL RECONCILIATION
  // ---------------------------------------------------------------------------
  private buildRivalsDraftSamples(): RivalDraftSample[] {
    const out: RivalDraftSample[] = [];
    for (const entry of this.rivalEntries.values()) {
      const interp = this.net.getInterpolatedRival(entry.playerIndex);
      if (!interp) continue;
      out.push({
        id: entry.playerId,
        position: { x: interp.x, y: interp.y, z: interp.z },
        yaw: interp.yaw,
        forwardSpeed: interp.forwardSpeed,
      });
    }
    return out;
  }

  private onFixedStep(dt: number): void {
    if (this.disposed) return;

    this.prevLocalState = cloneVehicleState(this.localState);

    // 1. Reconcile against latest authoritative server self snapshot (ZERO-DELAY & ZERO-SNAP!)
    const selfSnap = this.net.getLatestSelfSnapshot();
    if (selfSnap && selfSnap.serverTick > this.lastReconciledServerTick) {
      this.recordGhostFrame(selfSnap);
      this.reconcileWithAuthoritativeSnapshot(selfSnap);
    }

    // 2. Sample local inputs & stream to authoritative server
    const { input, lookBack } = this.sampleControls(dt);
    this.lookBackHeld = lookBack;
    this.lastSampledThrottle = input.throttle;

    const phase = this.room.phase;
    const gridLocked = phase === "LOBBY" || phase === "COUNTDOWN";
    if (phase === "RACING") {
      this.raceElapsedMs += dt * 1000;
    }

    // If finished or in podium, track server's smooth autopilot cruise cleanly
    if (phase === "PODIUM" || this.localState.finished) {
      if (selfSnap) {
        const s = selfSnap.car;
        this.localState.position.x = damp(this.localState.position.x, s.x, 12, dt);
        this.localState.position.y = damp(this.localState.position.y, s.y, 12, dt);
        this.localState.position.z = damp(this.localState.position.z, s.z, 12, dt);
        this.localState.yaw = lerpAngle(this.localState.yaw, s.yaw, 1 - Math.exp(-12 * dt));
        this.localState.pitch = damp(this.localState.pitch, s.pitch, 12, dt);
        this.localState.roll = damp(this.localState.roll, s.roll, 12, dt);
        this.localState.speedKmh = damp(this.localState.speedKmh, s.speedKmh, 10, dt);
        this.localState.rpmNorm = damp(this.localState.rpmNorm, s.rpmNorm, 10, dt);
        this.localState.rpm = s.rpm;
        this.localState.gear = s.gear;
        this.localState.wheelSpinRad = s.wheelSpinRad;
        this.localState.steerAngle = damp(this.localState.steerAngle, s.steerAngle, 12, dt);
      }
      return;
    }

    // Send input packet to server & buffer for reconciliation replay
    if (this.net.connected) {
      this.net.sendRaceInput(input);
      this.pendingInputs.push({
        input,
        raceElapsedMs: this.raceElapsedMs,
        gridLocked,
      });
      if (this.pendingInputs.length > 120) {
        this.pendingInputs.splice(0, this.pendingInputs.length - 120);
      }
    }

    // 3. Step local deterministic 60Hz vehicle physics
    const rivals = this.buildRivalsDraftSamples();
    const prevSpeed = this.localState.speedKmh;
    const stepEvents = stepVehiclePhysics(this.localState, input, this.localStats, this.track, {
      gridLocked,
      launchGoThisTick: false,
      raceElapsedMs: this.raceElapsedMs,
      totalLaps: this.room.totalLaps,
      rivals,
      selfId: this.localPlayerId,
      dt,
    });

    if (stepEvents.finishedRace) {
      this.localState.finished = false;
      this.localState.finishTimeMs = null;
    }

    // 4. Local sensory triggers (backfire flame on upshift/downshift, scrape audio, camera shake, reset snap)
    if (stepEvents.shiftedUp || stepEvents.shiftedDown) {
      if (this.localRig) {
        this._carFwd.set(Math.sin(this.localState.yaw), 0, Math.cos(this.localState.yaw)).normalize();
        this.vfx.triggerShiftBackfire(this.localRig.exhaustTips, this._carFwd, stepEvents.shiftedUp ? 0.14 : 0.11);
      }
      if (stepEvents.shiftedUp && this.localState.speedKmh > 55) {
        this.chaseCam.triggerImpactShake(0.14);
      }
    }

    if (stepEvents.resetTriggered) {
      this.visualOffset.setAll(0);
      this.visualYawOffset = 0;
      this.snapCameraToLocalCar();
    }

    this.prevScrapeSoundCooldown = Math.max(0, this.prevScrapeSoundCooldown - dt);
    this.prevBumpSoundCooldown = Math.max(0, this.prevBumpSoundCooldown - dt);

    if (this.localState.wallScrapeIntensity > 0.14 && this.prevScrapeSoundCooldown <= 0) {
      this.audio.playWallScrape(this.localState.wallScrapeIntensity);
      this.chaseCam.triggerImpactShake(this.localState.wallScrapeIntensity * 0.45);
      this.prevScrapeSoundCooldown = 0.12;
    }

    // Detect sharp speed drop from car-to-car bump
    const speedDrop = prevSpeed - this.localState.speedKmh;
    if (speedDrop > 18 && input.brake < 0.2 && this.prevBumpSoundCooldown <= 0) {
      this.audio.playCollision(speedDrop / 3.6);
      this.chaseCam.triggerImpactShake(clamp(speedDrop / 45, 0.25, 0.85));
      this._carPos.set(this.localState.position.x, this.localState.position.y + 0.55, this.localState.position.z);
      this.vfx.spawnCollisionSparks(this._carPos, clamp(speedDrop / 30, 0.4, 1.3));
      this.prevBumpSoundCooldown = 0.25;
    }
  }

  private reconcileWithAuthoritativeSnapshot(env: SelfSnapshotEnvelope): void {
    this.lastReconciledServerTick = env.serverTick;
    const auth = env.car;

    // Sync authoritative room race telemetry
    this.localPositionRank = auth.position;
    if (env.phase === "RACING") {
      this.raceElapsedMs = env.raceElapsedMs;
    }

    // Prune acknowledged inputs (`seq <= lastProcessedSeq`)
    while (this.pendingInputs.length > 0 && this.pendingInputs[0].input.seq <= auth.lastProcessedSeq) {
      this.pendingInputs.shift();
    }

    // During LOBBY/COUNTDOWN keep grid anchor locked cleanly to server while keeping responsive local revving
    if (env.phase === "LOBBY" || env.phase === "COUNTDOWN") {
      this.localState.position.x = auth.x;
      this.localState.position.y = auth.y;
      this.localState.position.z = auth.z;
      this.localState.yaw = auth.yaw;
      this.localState.pitch = auth.pitch;
      this.localState.roll = auth.roll;
      this.localState.nitro = auth.nitro;
      this.visualOffset.setAll(0);
      this.visualYawOffset = 0;
      return;
    }

    if (env.phase === "PODIUM" || auth.finished) {
      if (auth.finished && !this.localState.finished) {
        this.localState.finished = true;
        this.localState.finishTimeMs = auth.finishTimeMs;
        this.enterFinishOrbitIfNeeded();
      }
      return;
    }

    // Replay unacknowledged local inputs from authoritative server snapshot
    const replayState = cloneVehicleState(this.localState);
    applySnapshotToVehicleState(replayState, auth);
    const rivals = this.buildRivalsDraftSamples();

    for (let i = 0; i < this.pendingInputs.length; i++) {
      const rec = this.pendingInputs[i];
      stepVehiclePhysics(replayState, rec.input, this.localStats, this.track, {
        gridLocked: rec.gridLocked,
        launchGoThisTick: false,
        raceElapsedMs: rec.raceElapsedMs,
        totalLaps: this.room.totalLaps,
        rivals,
        selfId: this.localPlayerId,
        dt: FIXED_DT,
      });
    }

    replayState.finished = false;
    replayState.finishTimeMs = null;

    // Measure error between replayed authoritative state and current predicted state
    const errX = replayState.position.x - this.localState.position.x;
    const errZ = replayState.position.z - this.localState.position.z;
    const posErr = Math.hypot(errX, errZ);
    const yawErr = Math.abs(wrapAngleRad(replayState.yaw - this.localState.yaw));

    // Always trust authoritative lap/finish/bestLap/nitro-floor progression
    this.localState.lap = replayState.lap;
    this.localState.bestLapMs = auth.bestLapMs ?? this.localState.bestLapMs;
    this.localState.totalDriftScore = Math.max(this.localState.totalDriftScore, auth.totalDriftScore);

    // Only reconcile physics transform if positional error exceeds 0.35m (or large yaw drift)
    if (posErr > 0.35 || yawErr > 0.14) {
      // Compute pre-reconcile rendered world position so visual motion remains 100% continuous!
      const prevVisX = this.localState.position.x + this.visualOffset.x;
      const prevVisY = this.localState.position.y + this.visualOffset.y;
      const prevVisZ = this.localState.position.z + this.visualOffset.z;
      const prevVisYaw = wrapAngleRad(this.localState.yaw + this.visualYawOffset);

      this.localState = replayState;

      const deltaX = prevVisX - replayState.position.x;
      const deltaY = prevVisY - replayState.position.y;
      const deltaZ = prevVisZ - replayState.position.z;
      const visualJump = Math.hypot(deltaX, deltaZ);

      if (visualJump < 12.0) {
        // Store residual offset & smoothly damp to zero over ~150ms (ZERO snap-back!)
        this.visualOffset.set(deltaX, deltaY, deltaZ);
        this.visualYawOffset = wrapAngleRad(prevVisYaw - replayState.yaw);
      } else {
        // Large intentional teleport (reset / rematch)
        this.visualOffset.setAll(0);
        this.visualYawOffset = 0;
        this.snapCameraToLocalCar();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // NATIVE-HZ RENDER FRAME (INTERPOLATION, VFX, CAMERA, AUDIO, HUD SNAPSHOT)
  // ---------------------------------------------------------------------------
  private onRenderFrame(alpha: number, rawDt: number): void {
    if (this.disposed) return;
    const dt = Math.min(0.05, Math.max(0.001, rawDt));

    // Decay transient HUD banners
    if (this.goBannerTimer > 0) {
      this.goBannerTimer = Math.max(0, this.goBannerTimer - dt);
      if (this.goBannerTimer === 0 && this.room.phase === "RACING") {
        this.builtTrack?.setCountdownLight(-1);
      }
    }
    if (this.perfectLaunchTimer > 0) {
      this.perfectLaunchTimer = Math.max(0, this.perfectLaunchTimer - dt);
    }
    if (this.splitBannerTimer > 0) {
      this.splitBannerTimer = Math.max(0, this.splitBannerTimer - dt);
      if (this.splitBannerTimer === 0) {
        this.lastSplitDeltaMs = null;
      }
    }

    // Exponentially damp residual reconciliation offset over ~150ms (lambda = 20 -> e^-3 = 5% at 150ms!)
    const dampFactor = Math.exp(-20 * dt);
    this.visualOffset.scaleInPlace(dampFactor);
    if (this.visualOffset.lengthSquared() < 1e-6) this.visualOffset.setAll(0);
    this.visualYawOffset *= dampFactor;
    if (Math.abs(this.visualYawOffset) < 1e-4) this.visualYawOffset = 0;

    // 1. Interpolate local vehicle state for native 60-240Hz butter-smooth display
    const renderPos = {
      x: lerp(this.prevLocalState.position.x, this.localState.position.x, alpha) + this.visualOffset.x,
      y: lerp(this.prevLocalState.position.y, this.localState.position.y, alpha) + this.visualOffset.y,
      z: lerp(this.prevLocalState.position.z, this.localState.position.z, alpha) + this.visualOffset.z,
    };
    const renderYaw = wrapAngleRad(
      lerpAngle(this.prevLocalState.yaw, this.localState.yaw, alpha) + this.visualYawOffset
    );

    const proj = projectPointToTrack(this.track, renderPos, this.localState.trackFrameIndex);
    this.applyCarVisualTransform(
      this.localRig,
      renderPos,
      renderYaw,
      lerp(this.prevLocalState.pitch, this.localState.pitch, alpha),
      lerp(this.prevLocalState.roll, this.localState.roll, alpha),
      lerp(this.prevLocalState.suspensionOffset, this.localState.suspensionOffset, alpha),
      lerp(this.prevLocalState.steerAngle, this.localState.steerAngle, alpha),
      this.localState.wheelSpinRad,
      this.localState.brakeLight,
      this.localState.gear === 0 && this.localState.forwardSpeed < -0.5,
      this.localState.brakeHeat,
      proj.frame
    );

    // 2. Update local car VFX (skid marks, smoke, nitro flames, gravel dust, scrape sparks)
    this._carPos.set(renderPos.x, renderPos.y, renderPos.z);
    this._carFwd.set(Math.sin(renderYaw), Math.sin(proj.frame.pitch), Math.cos(renderYaw)).normalize();
    this._carUp.set(proj.frame.up.x, proj.frame.up.y, proj.frame.up.z);
    this._carVel.set(this.localState.velocity.x, this.localState.velocity.y, this.localState.velocity.z);

    const driftSlipNorm = clamp(Math.abs(this.localState.driftAngleRad) / 0.45, 0, 1);
    const launchWheelspin =
      this.localState.launchBoostTimer > 0.75 ||
      (this.localState.speedKmh < 42 && this.localState.rpmNorm > 0.72 && this.room.phase === "RACING");

    if (this.localRig) {
      this.localRig.root.computeWorldMatrix(true);
      this.vfx.updateCar({
        carId: this.localPlayerId,
        carPos: this._carPos,
        carForward: this._carFwd,
        carUp: this._carUp,
        velocity: this._carVel,
        speedKmh: this.localState.speedKmh,
        driftSlip: driftSlipNorm,
        drifting: this.localState.drifting,
        launchWheelspin,
        hardBraking: this.localState.brakeLight > 0.75,
        nitroActive: this.localState.nitroActive,
        onGravel: this.localState.onGravel,
        wallScrapeIntensity: this.localState.wallScrapeIntensity,
        wallScrapeSide: Math.sign(this.localState.lateralOffset) || 1,
        slipstreamActive: this.localState.slipstreamActive,
        rig: this.localRig,
        isPlayer: true,
        dt,
      });
    }

    // 3. Update Rival Cars (100ms smooth interpolation) + Rival VFX + 3D Audio Samples
    const rivalAudioSamples: RivalAudioSample[] = [];
    const minimapCars: RaceMinimapCar[] = [];

    const localLivery = getLiveryDefinition(this.localSetup.liveryId);
    minimapCars.push({
      id: this.localPlayerId,
      callsign: this.profile.callsign,
      x: renderPos.x,
      z: renderPos.z,
      yaw: renderYaw,
      isPlayer: true,
      isBot: false,
      position: this.localPositionRank,
      colorHex: "#00f0ff",
    });

    for (const p of this.room.players) {
      if (p.id === this.localPlayerId) continue;
      const entry = this.rivalEntries.get(p.id);
      if (!entry) continue;

      const interp = this.net.getInterpolatedRival(entry.playerIndex);
      if (interp) {
        entry.lastPos.set(interp.x, interp.y, interp.z);
        entry.lastYaw = interp.yaw;
        entry.lastSpeedKmh = interp.speedKmh;
        entry.lastRpmNorm = interp.rpmNorm;
        entry.lastDrifting = interp.drifting;

        const rProj = projectPointToTrack(this.track, entry.lastPos);
        this.applyCarVisualTransform(
          entry.rig,
          entry.lastPos,
          interp.yaw,
          interp.pitch,
          interp.roll,
          interp.suspensionOffset,
          interp.steerAngle,
          interp.wheelSpinRad,
          interp.brakeLight,
          interp.gear === 0 && interp.forwardSpeed < -0.5,
          interp.brakeHeat,
          rProj.frame
        );

        this._rivalPos.copyFrom(entry.lastPos);
        this._rivalFwd.set(Math.sin(interp.yaw), Math.sin(rProj.frame.pitch), Math.cos(interp.yaw)).normalize();
        this._rivalUp.set(rProj.frame.up.x, rProj.frame.up.y, rProj.frame.up.z);
        this._rivalVel.set(interp.vx, interp.vy, interp.vz);

        entry.rig.root.computeWorldMatrix(true);
        this.vfx.updateCar({
          carId: entry.playerId,
          carPos: this._rivalPos,
          carForward: this._rivalFwd,
          carUp: this._rivalUp,
          velocity: this._rivalVel,
          speedKmh: interp.speedKmh,
          driftSlip: clamp(Math.abs(interp.driftAngleRad) / 0.45, 0, 1),
          drifting: interp.drifting,
          launchWheelspin: false,
          hardBraking: interp.brakeLight > 0.8,
          nitroActive: interp.nitroActive,
          onGravel: interp.onGravel,
          wallScrapeIntensity: interp.wallScrapeIntensity,
          wallScrapeSide: 0,
          slipstreamActive: false,
          rig: entry.rig,
          isPlayer: false,
          dt,
        });
      }

      rivalAudioSamples.push({
        id: entry.playerId,
        pos: { x: entry.lastPos.x, y: entry.lastPos.y, z: entry.lastPos.z },
        speedKmh: entry.lastSpeedKmh,
        rpmNorm: entry.lastRpmNorm,
      });

      const rivalLivery = getLiveryDefinition(p.setup.liveryId);
      minimapCars.push({
        id: p.id,
        callsign: p.callsign,
        x: entry.lastPos.x,
        z: entry.lastPos.z,
        yaw: entry.lastYaw,
        isPlayer: false,
        isBot: p.isBot,
        position: p.position,
        colorHex: rivalLivery.bodyHex || "#f43f5e",
      });
    }

    this.vfx.flushFrame();

    // 4. Update Chase Camera
    this.chaseCam.update({
      carPos: this._carPos,
      carForward: this._carFwd,
      carUp: this._carUp,
      velocity: this._carVel,
      speedKmh: this.localState.speedKmh,
      driftAngleRad: this.localState.driftAngleRad,
      steerInput: this.localState.steerAngle / Math.max(this.localStats.maxSteerAngleRad, 0.1),
      nitroActive: this.localState.nitroActive,
      lookBack: this.lookBackHeld,
      launchBoostActive: this.localState.launchBoostTimer > 0,
      inTunnel: this.localState.inTunnel,
      wallScrapeIntensity: this.localState.wallScrapeIntensity,
      dt,
    });

    // Keep Directional sun light centered around player for crisp shadows anywhere along the 1.6km circuit!
    if (this.builtTrack?.shadowGenerator) {
      const sun = this.builtTrack.sunLight;
      const dir = sun.direction;
      sun.position.set(
        renderPos.x - dir.x * 75,
        renderPos.y - dir.y * 75,
        renderPos.z - dir.z * 75
      );
    }

    // 5. Update Automotive Engine Audio + 3D HRTF Rival Audio
    this.audio.updatePlayerAudio({
      rpmNorm: this.localState.rpmNorm,
      throttle: this.lastSampledThrottle,
      speedKmh: this.localState.speedKmh,
      driftSlip: this.localState.drifting ? Math.max(0.35, driftSlipNorm) : driftSlipNorm * 0.4,
      nitroActive: this.localState.nitroActive,
      onGravel: this.localState.onGravel,
      inTunnel: this.localState.inTunnel,
      gear: this.localState.gear,
      paused: this.paused,
    });

    this.audio.updateRivalsAudio(
      { x: renderPos.x, y: renderPos.y, z: renderPos.z },
      { x: this._carFwd.x, y: this._carFwd.y, z: this._carFwd.z },
      rivalAudioSamples
    );

    // 6. Render 3D Scene
    this.renderTimeTrialGhost();
    this.scene.render();

    // 7. Emit Crisp RaceHudSnapshot Every Render Frame
    const countdownState =
      this.room.phase === "COUNTDOWN"
        ? this.room.countdownValue
        : this.goBannerTimer > 0
          ? 0
          : -1;

    const standings: RaceStandingRow[] = this.room.players
      .map((p) => {
        const isSelf = p.id === this.localPlayerId;
        const liv = isSelf ? localLivery : getLiveryDefinition(p.setup.liveryId);
        return {
          playerId: p.id,
          callsign: p.callsign,
          isPlayer: isSelf,
          isBot: p.isBot,
          position: isSelf ? this.localPositionRank : p.position,
          vehicleId: p.setup.vehicleId,
          liveryHex: liv.bodyHex,
          lap: isSelf ? this.localState.lap : p.lap,
          bestLapMs: isSelf ? this.localState.bestLapMs : p.bestLapMs,
          totalDriftScore: isSelf
            ? Math.round(this.localState.totalDriftScore + this.localState.currentDriftScore)
            : p.totalDriftScore,
          finished: isSelf ? this.localState.finished : p.finished,
          finishTimeMs: isSelf ? this.localState.finishTimeMs : p.finishTimeMs,
          pingMs: isSelf ? (this.net.currentPingMs ?? p.pingMs) : p.pingMs,
        };
      })
      .sort((a, b) => a.position - b.position);

    this.callbacks.onHudUpdate({
      speedKmh: Math.round(this.localState.speedKmh),
      rpm: Math.round(this.localState.rpm),
      rpmNorm: this.localState.rpmNorm,
      gear: this.localState.gear,
      transmission: this.localSetup.transmission,
      nitroPct: clamp((this.localState.nitro / Math.max(this.localStats.nitroCapacity, 1)) * 100, 0, 100),
      nitroActive: this.localState.nitroActive,
      drifting: this.localState.drifting,
      driftScore: Math.round(this.localState.currentDriftScore),
      totalDriftScore: Math.round(this.localState.totalDriftScore + this.localState.currentDriftScore),
      driftMultiplier: this.localState.driftMultiplier,
      slipstreamActive: this.localState.slipstreamActive,
      wrongWay: this.localState.wrongWay,
      countdownState,
      phase: this.room.phase,
      inLaunchGreenZone:
        (this.room.phase === "COUNTDOWN" || this.room.phase === "LOBBY") &&
        isInLaunchGreenZone(this.localState.rpmNorm),
      perfectLaunchActive: this.perfectLaunchTimer > 0,
      position: this.localPositionRank,
      totalRacers: Math.max(1, this.room.players.length),
      lap: Math.min(this.localState.lap, this.room.totalLaps),
      totalLaps: this.room.totalLaps,
      lapTimeMs: Math.round(this.localState.currentLapTimeMs),
      bestLapMs: this.localState.bestLapMs !== null ? Math.round(this.localState.bestLapMs) : null,
      splitDeltaMs: this.lastSplitDeltaMs !== null ? Math.round(this.lastSplitDeltaMs) : null,
      playerPos: renderPos,
      playerYaw: renderYaw,
      cameraMode: this.chaseCam.mode,
      cameraModeLabel: getCameraModeLabel(this.chaseCam.mode),
      minimapCars,
      standings,
      fps: this.loop.currentFps,
      pingMs: this.net.currentPingMs,
      finished: this.localState.finished,
      podiumEntries: this.room.podium,
      timeTrialGhostMs: this.ghost?.lapTimeMs ?? null,
      inTunnel: this.localState.inTunnel,
      onGravel: this.localState.onGravel,
      paused: this.paused,
    });
  }

  private applyLocalCarVisual(state: VehiclePhysicsState, _alpha: number): void {
    const proj = projectPointToTrack(this.track, state.position, state.trackFrameIndex);
    this.applyCarVisualTransform(
      this.localRig,
      state.position,
      state.yaw,
      state.pitch,
      state.roll,
      state.suspensionOffset,
      state.steerAngle,
      state.wheelSpinRad,
      state.brakeLight,
      state.gear === 0 && state.forwardSpeed < -0.5,
      state.brakeHeat,
      proj.frame
    );
  }

  private applyCarVisualTransform(
    rig: CarVisualRig | null,
    pos: Readonly<Vec3>,
    yaw: number,
    pitch: number,
    roll: number,
    suspensionOffset: number,
    steerAngle: number,
    wheelSpinRad: number,
    brakeLight: number,
    reverseOn: boolean,
    brakeHeat: number,
    frame: TrackFrame
  ): void {
    if (!rig) return;

    // Align wheel base plane flush with local track slope & banking even mid-drift!
    const fwdX = Math.sin(yaw);
    const fwdZ = Math.cos(yaw);
    const rightX = Math.cos(yaw);
    const rightZ = -Math.sin(yaw);

    const roadPitch = Math.asin(clamp(-(fwdX * frame.up.x + fwdZ * frame.up.z), -0.45, 0.45));
    const roadBank = Math.asin(clamp(-(rightX * frame.up.x + rightZ * frame.up.z), -0.45, 0.45));

    // Babylon Euler order is YXZ: Yaw around world Y, then -Pitch around local X, then Bank around local Z
    rig.root.position.set(pos.x, pos.y, pos.z);
    rig.root.rotation.set(-roadPitch, yaw, roadBank);

    // Dynamic suspension squat/dive/roll relative to road plane
    const dynPitch = clamp(pitch - frame.pitch, -0.1, 0.1);
    const dynRoll = clamp(roll - frame.bankRad, -0.12, 0.12);
    rig.chassisNode.position.y = suspensionOffset;
    rig.chassisNode.rotation.set(-dynPitch, 0, dynRoll);

    for (let i = 0; i < rig.frontSteerNodes.length; i++) {
      rig.frontSteerNodes[i].rotation.y = steerAngle;
    }
    for (let i = 0; i < rig.wheelSpinNodes.length; i++) {
      rig.wheelSpinNodes[i].rotation.x = wheelSpinRad;
    }

    rig.setBrakeLight(brakeLight);
    rig.setReverseLight(reverseOn);
    rig.setBrakeDiscGlow(brakeHeat);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.started = false;

    this.loop.stop();
    window.removeEventListener("keydown", this.onKeyDownBound);
    window.removeEventListener("keyup", this.onKeyUpBound);
    window.removeEventListener("blur", this.onBlurBound);

    this.audio.stopEngine();

    this.localRig?.dispose();
    this.localRig = null;
    for (const entry of this.rivalEntries.values()) {
      entry.rig.dispose();
    }
    this.rivalEntries.clear();

    this.vfx.dispose();
    this.builtTrack?.dispose();
    this.builtTrack = null;
    this.chaseCam.dispose();
    this.ghostRig?.dispose();
    this.ghostMaterial?.dispose();
    this.assets.dispose();
    this.scene.dispose();
  }
}
