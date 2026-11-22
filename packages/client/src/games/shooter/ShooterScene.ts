import {
  Color3,
  Color4,
  DefaultRenderingPipeline,
  DirectionalLight,
  DynamicTexture,
  HemisphericLight,
  ImageProcessingConfiguration,
  Matrix,
  Mesh,
  MeshBuilder,
  ParticleSystem,
  PBRMaterial,
  PointLight,
  Scene,
  ShadowGenerator,
  SSAO2RenderingPipeline,
  StandardMaterial,
  TransformNode,
  UniversalCamera,
  Vector3,
  VertexBuffer,
} from "@babylonjs/core";
import {
  FIXED_DT,
  INPUT_FLAG_ADS,
  INPUT_FLAG_BACK,
  INPUT_FLAG_CROUCH,
  INPUT_FLAG_FORWARD,
  INPUT_FLAG_HOLD_BREATH,
  INPUT_FLAG_JUMP,
  INPUT_FLAG_LEAN_LEFT,
  INPUT_FLAG_LEAN_RIGHT,
  INPUT_FLAG_LEFT,
  INPUT_FLAG_RELOAD,
  INPUT_FLAG_RIGHT,
  INPUT_FLAG_SPRINT,
  PRACTICE_TARGET_RADIUS,
  LEAN_ROLL_DEG,
  MAP_REGISTRY,
  MELEE_COOLDOWN_MS,
  THROWABLE_ORDER,
  THROWABLE_REGISTRY,
  computeEffectiveWeaponStats,
  getAttachmentsForWeaponSlot,
  createCharacterPhysics,
  createInitialFpsState,
  createThrowableStock,
  damp,
  destroyCharacterPhysics,
  distPointToRay,
  getCameraEyePosition,
  COUNTDOWN_SEC,
  SKIN_REGISTRY,
  skinModelKey,
  isCombatPhase,
  lerp,
  restoreCharacterPhysics,
  shotSpreadMultiplier,
  stepFpsCharacter,
  teleportCharacterPhysics,
  yawPitchToDir,
  type CharacterPhysicsHandle,
  type DamageBreakdownPayload,
  type EffectiveWeaponStats,
  type FpsPlayerState,
  type HitMarkerTier,
  type InputCommand,
  type MapBlueprint,
  type PlayerWeaponConfig,
  type RoomStateBroadcast,
  type ServerToClientMessage,
  type ThrowableType,
  type ThrowableStock,
  type Vec3,
  PhysicsWorld,
} from "@game/shared";
import type { EngineApp } from "../../core/EngineApp.js";
import { GameLoop } from "../../core/GameLoop.js";
import { InstancePoolManager } from "../../core/InstancePoolManager.js";
import type { NetClient } from "../../core/NetClient.js";
import { ShaderWarmer } from "../../core/ShaderWarmer.js";
import type { SpatialAudio } from "../../core/SpatialAudio.js";
import { VfxSystem } from "../../core/VfxSystem.js";
import { combatKey, saveGuestProfile, type GuestProfile } from "../../state/UserProfileStore.js";
import { createGrenadeModel, grenadeTrailColor } from "./GrenadeModels.js";
import { ModelAssetCache, type InstantiatedProp, type ModelAssetKey } from "./ModelAssetCache.js";
import { PbrTextureGenerator } from "./PbrTextureGenerator.js";
import { RemoteSoldier } from "./RemoteSoldier.js";
import { ViewModelWeapon } from "./ViewModelWeapon.js";
import { advanceStepPhase } from "./Locomotion.js";
import { ArenaPickupsView } from "./ArenaPickupsView.js";
import { DeathCamera } from "./DeathCamera.js";

export type ArenaHudEvent = Extract<ServerToClientMessage, { type: "COMBAT_STREAK" | "PICKUP_COLLECTED" | "MATCH_RESULTS" }>;

export interface HudLiveSnapshot {
  replayName: string | null;
  hp: number;
  armor: number;
  weaponName: string;
  skinName: string;
  opticName: string;
  ammoInMag: number;
  magSize: number;
  ammoReserve: number;
  reloading: boolean;
  ads: boolean;
  adsScopeLevel: "NONE" | "RED_DOT" | "2X" | "6X";
  holdBreathPct: number;
  spreadBloom: number;
  lean: number;
  crouching: boolean;
  sliding: boolean;
  throwable: ThrowableType;
  throwablesLeft: number;
  throwableStock: ThrowableStock | null;
  grenadePreviewing: boolean;
  cookingFusePct: number;
  healingDelaySeconds: number | null;
  spawnProtectionSeconds: number;
  fps: number;
  pingMs: number | null;
  snapshotAgeMs: number | null;
  movementCorrections: number;
  respawnSeconds: number | null;
  alive: boolean;
  spectatingName: string | null;
  activeSlot: 0 | 1;
  pointerLocked: boolean;
  flashAlpha: number;
  damageVignetteAlpha: number;
  fireMode: string;
  playerPos: Vec3;
  playerYaw: number;
  minimapTeammates: { x: number; z: number }[];
  minimapEnemyBlips: { x: number; z: number }[];
  minimapPings: { x: number; z: number }[];
  screenMarkers: (
    | { kind: "TEAMMATE"; x: number; y: number; label: string; hp: number }
    | { kind: "PING"; x: number; y: number; label: string; distanceM: number }
  )[];
}

interface PredictedMovement {
  input: InputCommand;
  speed: number;
  canMove: boolean;
  result: FpsPlayerState;
}

const ADS_READY_THRESHOLD = 0.6;
const HOLD_BREATH_SECONDS = 3;

const HELD_MOVEMENT_KEYS = new Set([
  "KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowLeft", "ArrowDown", "ArrowRight",
  "ShiftLeft", "KeyC", "ControlLeft",
]);

function statesAgree(a: FpsPlayerState, b: FpsPlayerState): boolean {
  return a.crouching === b.crouching && a.crouchHeld === b.crouchHeld && a.sliding === b.sliding &&
    a.vaulting === b.vaulting && a.grounded === b.grounded &&
    Math.abs(a.slideTimer - b.slideTimer) < 0.001 && Math.abs(a.slideCooldown - b.slideCooldown) < 0.001 &&
    Math.abs(a.vaultTimer - b.vaultTimer) < 0.001 && Math.abs(a.eyeHeight - b.eyeHeight) < 0.001 &&
    Math.abs(a.lean - b.lean) < 0.001 &&
    Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y, a.position.z - b.position.z) < 0.001 &&
    Math.hypot(a.velocity.x - b.velocity.x, a.velocity.y - b.velocity.y, a.velocity.z - b.velocity.z) < 0.001;
}

export interface ShooterSceneCallbacks {
  onHudUpdate: (hud: HudLiveSnapshot) => void;
  onRoomUpdate: (room: RoomStateBroadcast) => void;
  onHitConfirm: (tier: HitMarkerTier, damage: number, isWallbang: boolean) => void;
  onDamageTaken: (attackerRelAngleRad: number) => void;
  onKillFeed: (msg: Extract<ServerToClientMessage, { type: "KILL_FEED" }>) => void;
  onDamageBreakdown: (bd: DamageBreakdownPayload) => void;
  onMatchEnded: (msg: Extract<ServerToClientMessage, { type: "MATCH_ENDED" }>) => void;
  onDangerPing: (msg: Extract<ServerToClientMessage, { type: "DANGER_PING" }>) => void;
  onPauseChanged: (paused: boolean) => void;
  onScoreboardChanged: (visible: boolean) => void;
  onToggleLoadout: () => void;
  /** +1 / -1 nudges the master volume; 0 toggles mute. */
  onVolumeKey: (direction: -1 | 0 | 1) => void;
  onPointerCaptureError: (message: string) => void;
  onArenaEvent: (event: ArenaHudEvent) => void;
}

interface ActiveSmokeVisual {
  root: TransformNode;
  meshes: Mesh[];
  mat: StandardMaterial;
  ttl: number;
  maxTtl: number;
}

interface ActiveGrenadeVisual {
  id: string;
  mesh: Mesh;
  vel: Vector3;
  ttl: number;
  restitution: number;
  elapsed: number;
  trail: ParticleSystem;
  spin: Vector3;
}

interface ActivePingMarker {
  playerId: string;
  mesh: Mesh;
  worldPos: Vec3;
  label: string;
  ttl: number;
}

/**
 * Full 3D Tactical Shooter Arena Scene:
 * - Builds Cargo Docks, Desert Outpost, or Neon Rooftop from MapBlueprint with Poly Haven PBR & glTF props
 * - Client-predicted 60Hz Rapier movement (Lean, Slide, Auto-Vault)
 * - ViewModel recoil, ADS scope zoom + Hold-Breath, ParticleSystem VFX, decals & live grenade arc
 * - Destructible glass & explosive fuel barrels, Warm-Up Steel Targets
 */
export class ShooterScene {
  public readonly scene: Scene;
  public readonly camera: UniversalCamera;
  private map: MapBlueprint;
  private physWorld: PhysicsWorld;
  private playerState: FpsPlayerState;
  private playerPhysics: CharacterPhysicsHandle;
  private prevPosition: Vec3 = { x: 0, y: 0, z: 0 };
  private audioWasAlive = true;
  private nextHeartbeatAtMs = 0;
  private wasGroundedAudio = true;
  private fallSpeedAudio = 0;
  private prevEyeHeight = 1.62;

  private readonly viewModel: ViewModelWeapon;
  private readonly pools: InstancePoolManager;
  private readonly vfx: VfxSystem;
  private readonly modelCache: ModelAssetCache;
  private readonly loop: GameLoop;
  private readonly texGen: PbrTextureGenerator;
  private shadowGen: ShadowGenerator | null = null;
  private pipeline: DefaultRenderingPipeline | null = null;
  private ssao: SSAO2RenderingPipeline | null = null;
  private skyMesh: Mesh | null = null;
  private floorMesh: Mesh | null = null;
  private hemiLight: HemisphericLight | null = null;
  private sunLight: DirectionalLight | null = null;
  private readonly extraLights: PointLight[] = [];
  private readonly warmupPostMeshes: Mesh[] = [];
  private readonly storytellingMeshes: Mesh[] = [];
  private readonly landmarkTextures: DynamicTexture[] = [];
  private readonly spawnBannerMeshes: Mesh[] = [];
  private readonly spawnBannerMats: (StandardMaterial | PBRMaterial)[] = [];
  private readonly spawnBannerEntries: {
    team: "A" | "B";
    tex: DynamicTexture;
    mat: StandardMaterial;
    lastKey: string;
  }[] = [];

  private readonly blockMeshes = new Map<string, Mesh>();
  private readonly blockProps = new Map<string, InstantiatedProp>();
  private readonly remoteSoldiers = new Map<string, RemoteSoldier>();
  private readonly smokeVisuals: ActiveSmokeVisual[] = [];
  private readonly grenadeVisuals: ActiveGrenadeVisual[] = [];
  private readonly pingMarkers: ActivePingMarker[] = [];
  private pingMaterial?: StandardMaterial;
  private lastDangerPingAt = -Infinity;
  private readonly enemyBlips: { x: number; z: number; ttl: number }[] = [];
  private readonly warmupTargetMeshes: { mesh: Mesh; mat: StandardMaterial; flashTimer: number }[] = [];


  private room: RoomStateBroadcast;
  private localPlayerId: string;
  private currentMapId: string;
  private assetsReady = false;

  // Input & weapon simulation state
  private readonly keys = new Set<string>();
  private mouseDownLeft = false;
  private mouseDownRight = false;
  private justFiredTrigger = false;
  private activeSlot: 0 | 1 = 0;
  private fireModeIndex = 0;
  private burstRemaining = 0;
  private ammoInMag: [number, number] = [30, 7];
  private ammoReserve: [number, number] = [120, 35];
  private reloadTimer = 0;
  private nextShotAllowedMs = 0;
  private shotSequence = 0;
  private inputSequence = 0;
  private lastStateTick = -1;
  private movementEpoch: number | null = null;
  private readonly predictedMovement: PredictedMovement[] = [];
  private readonly renderCorrection: Vec3 = { x: 0, y: 0, z: 0 };
  private movementCorrections = 0;
  private jumpPressed = false;
  private crouchPressed = false;
  private crouchLatched = false;
  private reloadRequested = false;
  private reloadInputSequence = -1;
  private readonly pendingShots: { seq: number; slot: 0 | 1; muzzle: Vec3 }[] = [];

  private recoilOffsetPitch = 0;
  private recoilOffsetYaw = 0;
  private recoilShotCount = 0;
  private pointerLockGraceEvents = 0;
  private cameraRoll = 0;
  private pendingRecoilRecoveryPitch = 0;
  private lastShotAtMs = 0;
  private readonly predictedTracerSeqs = new Set<number>();
  private holdBreathRemaining = HOLD_BREATH_SECONDS;
  private holdBreathExhausted = false;
  private breathSteady = 0;
  private adsAlpha = 0;
  private sprintFovKick = 0;
  private stepPhase = 0;
  private airborneSeconds = 0;
  private landDipOffset = 0;
  private cameraShakeIntensity = 0;
  private lastOpticSwapMs = 0;

  private cookingGrenade = false;
  private cookElapsedSec = 0;
  private throwablesLeft = 2;
  private throwableStock: ThrowableStock;
  private activeThrowable: ThrowableType;
  private lastWeaponScroll = -Infinity;

  private flashAlpha = 0;
  private flashHoldSec = 0;
  private flashFadePerSec = 0.65;
  private damageVignetteAlpha = 0;
  private slowMoTimer = 0;
  private paused = false;
  private loadoutOpen = false;
  private appliedQuality: GuestProfile["settings"]["graphicsQuality"] | null = null;
  private currentPrimaryKey = "";
  private currentSecondaryKey = "";
  private readonly effectiveWeapons: [EffectiveWeaponStats | null, EffectiveWeaponStats | null] = [null, null];
  private spectatorIndex = 0;
  private lastMelee = -Infinity;
  private readonly deathCamera = new DeathCamera();
  private replayVictim: RemoteSoldier | null = null;
  private readonly pickupView: ArenaPickupsView;

  private keyDownHandler!: (e: KeyboardEvent) => void;
  private keyUpHandler!: (e: KeyboardEvent) => void;
  private mouseDownHandler!: (e: MouseEvent) => void;
  private mouseUpHandler!: (e: MouseEvent) => void;
  private mouseMoveHandler!: (e: MouseEvent) => void;
  private wheelHandler!: (e: WheelEvent) => void;
  private pointerLockHandler!: () => void;
  private contextMenuHandler!: (e: MouseEvent) => void;
  private readonly lostFocusHandler = () => this.clearCombatInputs();

  constructor(
    private readonly app: EngineApp,
    private readonly net: NetClient,
    private readonly audio: SpatialAudio,
    private readonly profile: GuestProfile,
    initialRoom: RoomStateBroadcast,
    localPlayerId: string,
    private readonly callbacks: ShooterSceneCallbacks
  ) {
    this.room = initialRoom;
    this.localPlayerId = localPlayerId;
    this.currentMapId = initialRoom.mapId;
    this.map = MAP_REGISTRY[this.currentMapId] ?? MAP_REGISTRY.cargo_docks;
    this.activeThrowable = profile.loadout.throwable;
    const loadout = initialRoom.players.find((p) => p.id === localPlayerId)?.loadout ?? profile.loadout;
    this.throwableStock = createThrowableStock(loadout.throwable, loadout.tdmThrowables);

    this.scene = new Scene(app.engine);
    this.pickupView = new ArenaPickupsView(this.scene);
    this.pickupView.sync(initialRoom.pickups ?? []);
    this.scene.clearColor = Color4.FromHexString(`${this.map.skyColorHex}ff`);
    this.scene.fogMode = Scene.FOGMODE_EXP2;
    this.scene.fogColor = Color3.FromHexString(this.map.fogColorHex);
    this.scene.fogDensity = this.map.fogDensity;

    this.texGen = new PbrTextureGenerator(this.scene);
    this.scene.environmentTexture = this.texGen.createEnvironmentCubeTexture(this.map.theme);
    this.scene.environmentIntensity = 0.92;

    this.camera = new UniversalCamera("fps_cam", new Vector3(0, 1.65, -20), this.scene);
    this.camera.updateUpVectorFromRotation = true;
    this.camera.minZ = 0.03;
    this.camera.maxZ = 350;
    this.camera.fov = (this.profile.settings.fov * Math.PI) / 180;
    this.scene.activeCamera = this.camera;

    this.pipeline = new DefaultRenderingPipeline("shooter_pipe", true, this.scene, [this.camera]);
    this.pipeline.fxaaEnabled = true;
    this.pipeline.bloomEnabled = true;
    this.pipeline.bloomThreshold = 0.85;
    this.pipeline.bloomWeight = 0.22;
    this.pipeline.bloomKernel = 48;
    this.pipeline.sharpenEnabled = true;
    this.pipeline.sharpen.edgeAmount = 0.22;
    this.pipeline.imageProcessingEnabled = true;
    this.pipeline.imageProcessing.toneMappingEnabled = true;
    this.pipeline.imageProcessing.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    this.pipeline.imageProcessing.exposure = 1.15;
    this.pipeline.imageProcessing.contrast = 1.2;

    this.physWorld = new PhysicsWorld(this.map);
    // Walls between you and a sound muffle it, so enemies behind cover sound distant and dull.
    this.audio.setOcclusionTest((from, to) =>
      !this.physWorld.hasLineOfSight(from, { x: to.x, y: to.y < 0.5 ? to.y + 1.0 : to.y, z: to.z }));
    const localSummary = this.getLocalPlayerSummary();
    const spawn =
      localSummary?.team === "B" ? this.map.spawnsB[0] : this.map.spawnsA[0];
    this.playerState = createInitialFpsState(spawn.position, spawn.yaw);
    this.playerPhysics = createCharacterPhysics(this.physWorld, spawn.position);
    this.prevPosition = { ...this.playerState.position };

    this.modelCache = new ModelAssetCache(this.scene);
    this.vfx = new VfxSystem(this.scene);
    this.pools = new InstancePoolManager(this.scene);
    this.viewModel = new ViewModelWeapon(this.scene, this.camera, this.modelCache, this.texGen);
    this.bindInputs();

    this.loop = new GameLoop({
      onFixedStep: (dt) => this.fixedTick(dt),
      onRenderFrame: (alpha, rawDt) => this.renderTick(alpha, rawDt),
      onFpsSample: (fps) => this.app.adaptResolution(fps, this.graphicsScale),
    });
  }

  async warmUpAndStart(onProgress?: (pct: number, detail: string) => void): Promise<void> {
    // Dev-only inspection hook used by the browser verification scripts.
    if ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) {
      (window as unknown as { __shooter?: ShooterScene }).__shooter = this;
    }
    this.app.setScene(this.scene);
    onProgress?.(68, "Loading 3D models & PBR assets...");
    await this.modelCache.preloadAll();
    await this.modelCache.preloadSkinModels(this.modelSkinIds());
    this.assetsReady = true;
    this.buildEnvironment();
    this.applyGraphicsQuality();
    this.syncEquippedWeapons(true);
    this.syncRemotePlayers();
    await ShaderWarmer.warmUpScene(this.scene, onProgress);
    this.loop.start();
  }

  requestPointerLock(): void {
    const canvas = this.app.canvas;
    if (document.pointerLockElement === canvas || !this.net.connected) return;
    this.callbacks.onPointerCaptureError("");
    canvas.focus({ preventScroll: true });
    const capture = async () => {
      try {
        if (this.profile.settings.rawMouseInput) {
          try {
            await canvas.requestPointerLock({ unadjustedMovement: true });
            return;
          } catch (error) {
            const unsupported = error instanceof TypeError || (error instanceof DOMException && error.name === "NotSupportedError");
            if (!unsupported) throw error;
          }
        }
        await canvas.requestPointerLock();
      } catch {
        this.callbacks.onPointerCaptureError("Click Lock mouse to try again.");
      }
    };
    void capture();
  }

  private clearCombatInputs(preserveMovement = false): void {
    if (this.keys.has("Tab")) this.callbacks.onScoreboardChanged(false);
    if (preserveMovement) {
      for (const key of this.keys) {
        if (!HELD_MOVEMENT_KEYS.has(key) && !this.isCrouchKey(key)) this.keys.delete(key);
      }
    } else {
      this.keys.clear();
    }
    this.mouseDownLeft = false;
    this.mouseDownRight = false;
    this.justFiredTrigger = false;
    this.burstRemaining = 0;
    this.jumpPressed = false;
    this.crouchPressed = false;
    this.cancelGrenadePreview();
  }

  public resetNetworkState(): void {
    this.clearCombatInputs();
    this.lastStateTick = -1;
    this.movementEpoch = null;
    this.predictedMovement.length = 0;
    this.pendingShots.length = 0;
    this.predictedTracerSeqs.clear();
    this.pendingRecoilRecoveryPitch = 0;
    this.reloadRequested = false;
    this.reloadInputSequence = -1;
    this.airborneSeconds = 0;
    this.landDipOffset = 0;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) this.clearCombatInputs();
    if (!paused && !this.loadoutOpen) {
      this.requestPointerLock();
    } else if (paused && document.pointerLockElement === this.app.canvas) {
      document.exitPointerLock();
    }
    this.callbacks.onPauseChanged(paused);
  }

  setLoadoutOpen(open: boolean): void {
    this.loadoutOpen = open;
    if (open) {
      this.clearCombatInputs();
      if (document.pointerLockElement === this.app.canvas) {
        document.exitPointerLock();
      }
    } else if (!this.paused) {
      this.requestPointerLock();
    }
  }

  forceEquipLocalLoadout(): void {
    const summary = this.getLocalPlayerSummary();
    if (summary) {
      summary.loadout = structuredClone(this.profile.loadout);
    }
    this.reloadTimer = 0;
    this.reloadRequested = false;
    this.burstRemaining = 0;
    this.fireModeIndex = 0;
    this.loadMissingSkinModels();
    this.syncEquippedWeapons(true);
  }

  applyUpdatedSettings(): void {
    if (!this.profile.settings.toggleCrouch) this.crouchLatched = false;
    this.applyGraphicsQuality();
  }

  private isCrouchKey(code: string): boolean {
    const binding = combatKey(this.profile.settings.combatBindings, "crouch");
    return code === binding || (binding === "KeyC" && code === "ControlLeft");
  }

  private applyGraphicsQuality(): void {
    const q = this.profile.settings.graphicsQuality;
    if (q === this.appliedQuality) return;
    this.appliedQuality = q;
    this.app.resetResolution(this.graphicsScale);
    this.scene.shadowsEnabled = q !== "LOW";

    if (this.pipeline) {
      this.pipeline.fxaaEnabled = q !== "LOW";
      this.pipeline.bloomEnabled = q === "HIGH" || q === "ULTRA";
      this.pipeline.sharpenEnabled = q === "HIGH" || q === "ULTRA";
    }

    this.ssao?.dispose(true);
    this.ssao = null;
    if ((q === "HIGH" || q === "ULTRA") && SSAO2RenderingPipeline.IsSupported) {
      try {
        this.ssao = new SSAO2RenderingPipeline(
          "ssao2",
          this.scene,
          { ssaoRatio: 0.5, blurRatio: 1.0 },
          [this.camera],
          false
        );
        this.ssao.radius = 1.4;
        this.ssao.totalStrength = q === "ULTRA" ? 1.15 : 0.85;
        this.ssao.maxZ = 90;
        this.ssao.samples = q === "ULTRA" ? 24 : 16;
      } catch {
        this.ssao = null;
      }
    }
  }

  private get graphicsScale(): number {
    const quality = this.profile.settings.graphicsQuality;
    return quality === "LOW" ? 1.45 : quality === "MEDIUM" ? 1.17 : 1;
  }

  private getLocalPlayerSummary() {
    return this.room.players.find((p) => p.id === this.localPlayerId);
  }

  private getActiveWeaponConfig(): PlayerWeaponConfig {
    const summary = this.getLocalPlayerSummary();
    const kit = summary?.loadout ?? this.profile.loadout;
    return this.activeSlot === 0 ? kit.primary : kit.secondary;
  }

  private getActiveWeaponStats(): EffectiveWeaponStats {
    const cached = this.effectiveWeapons[this.activeSlot];
    if (cached) return cached;
    const cfg = this.getActiveWeaponConfig();
    const stats = computeEffectiveWeaponStats(cfg.weaponId, cfg.attachments);
    this.effectiveWeapons[this.activeSlot] = stats;
    return stats;
  }

  private syncEquippedWeapons(forceResetAmmo = false): void {
    const summary = this.getLocalPlayerSummary();
    const kit = summary?.loadout ?? this.profile.loadout;

    const pKey = JSON.stringify(kit.primary);
    const sKey = JSON.stringify(kit.secondary);
    // Same gun with only a sight swap: refresh the model and stats but keep the rounds in the magazine.
    const keepsAmmo = (prevKey: string, next: PlayerWeaponConfig): boolean => {
      if (!prevKey) return false;
      try {
        const prev = JSON.parse(prevKey) as PlayerWeaponConfig;
        return prev.weaponId === next.weaponId && prev.attachments.mag === next.attachments.mag;
      } catch {
        return false;
      }
    };

    if (forceResetAmmo || pKey !== this.currentPrimaryKey) {
      const keep = !forceResetAmmo && keepsAmmo(this.currentPrimaryKey, kit.primary);
      this.currentPrimaryKey = pKey;
      const pStats = computeEffectiveWeaponStats(kit.primary.weaponId, kit.primary.attachments);
      this.effectiveWeapons[0] = pStats;
      if (!keep) {
        this.ammoInMag[0] = pStats.magSize;
        this.ammoReserve[0] = pStats.reserveAmmoMax;
      }
      if (this.assetsReady && this.activeSlot === 0) {
        this.equipViewModel(kit.primary);
      }
    }

    if (forceResetAmmo || sKey !== this.currentSecondaryKey) {
      const keep = !forceResetAmmo && keepsAmmo(this.currentSecondaryKey, kit.secondary);
      this.currentSecondaryKey = sKey;
      const sStats = computeEffectiveWeaponStats(kit.secondary.weaponId, kit.secondary.attachments);
      this.effectiveWeapons[1] = sStats;
      if (!keep) {
        this.ammoInMag[1] = sStats.magSize;
        this.ammoReserve[1] = sStats.reserveAmmoMax;
      }
      if (this.assetsReady && this.activeSlot === 1) {
        this.equipViewModel(kit.secondary);
      }
    }
  }

  private buildEnvironment(): void {
    this.disposeSpawnBanners();
    for (const mesh of this.blockMeshes.values()) {
      mesh.material?.dispose(false, false);
      mesh.dispose();
    }
    this.blockMeshes.clear();

    for (const prop of this.blockProps.values()) prop.dispose();
    this.blockProps.clear();

    for (const sm of this.storytellingMeshes) {
      sm.material?.dispose(false, false);
      sm.dispose();
    }
    this.storytellingMeshes.length = 0;
    for (const texture of this.landmarkTextures) texture.dispose();
    this.landmarkTextures.length = 0;

    for (const wt of this.warmupTargetMeshes) {
      wt.mat.dispose();
      wt.mesh.dispose();
    }
    this.warmupTargetMeshes.length = 0;


    this.skyMesh?.material?.dispose(false, false);
    this.skyMesh?.dispose();
    this.skyMesh = this.texGen.createSkyDome(this.map);

    this.floorMesh?.material?.dispose(false, false);
    this.floorMesh?.dispose();
    this.hemiLight?.dispose();
    this.sunLight?.dispose();
    for (const l of this.extraLights) l.dispose();
    this.extraLights.length = 0;
    for (const pm of this.warmupPostMeshes) {
      pm.material?.dispose(false, false);
      pm.dispose();
    }
    this.warmupPostMeshes.length = 0;

    // Lighting & Adaptive Blur-Exponential Real-Time Shadows
    const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), this.scene);
    hemi.diffuse = Color3.FromHexString(this.map.ambientHex);
    hemi.groundColor = Color3.FromHexString(this.map.theme === "CARGO_DOCKS" ? "#4c5e65" : "#1e293b");
    hemi.intensity = this.map.theme === "NEON_ROOFTOP" ? 0.58 : 0.92;
    this.hemiLight = hemi;

    const sun = new DirectionalLight(
      "sun",
      new Vector3(this.map.sunDirection.x, this.map.sunDirection.y, this.map.sunDirection.z),
      this.scene
    );
    sun.position = new Vector3(
      -this.map.sunDirection.x * 45,
      -this.map.sunDirection.y * 45,
      -this.map.sunDirection.z * 45
    );
    sun.diffuse = Color3.FromHexString(this.map.sunColorHex);
    sun.intensity = this.map.theme === "NEON_ROOFTOP" ? 1.0 : 1.85;
    sun.shadowMinZ = 10;
    sun.shadowMaxZ = 130;
    this.sunLight = sun;

    const q = this.profile.settings.graphicsQuality;
    const shadowSize = q === "ULTRA" ? 2048 : q === "LOW" ? 512 : 1024;
    this.shadowGen?.dispose();
    this.shadowGen = new ShadowGenerator(shadowSize, sun);
    if (q === "HIGH" || q === "ULTRA") {
      this.shadowGen.useBlurExponentialShadowMap = true;
      this.shadowGen.blurScale = 2;
    } else if (q === "MEDIUM") {
      this.shadowGen.usePercentageCloserFiltering = true;
      this.shadowGen.filteringQuality = ShadowGenerator.QUALITY_LOW;
    }
    this.shadowGen.depthScale = 50;

    if (this.map.theme === "NEON_ROOFTOP") {
      const cyanLight = new PointLight("neon_l_w", new Vector3(-16, 5, 0), this.scene);
      cyanLight.diffuse = Color3.FromHexString("#00f0ff");
      cyanLight.intensity = 2.6;
      cyanLight.range = 42;
      this.extraLights.push(cyanLight);

      const pinkLight = new PointLight("neon_l_e", new Vector3(16, 5, 0), this.scene);
      pinkLight.diffuse = Color3.FromHexString("#ff007f");
      pinkLight.intensity = 2.6;
      pinkLight.range = 42;
      this.extraLights.push(pinkLight);
    }

    // Real Poly Haven PBR Textured Floor Mesh (World-scale UVs -> zero stretching)
    const floor = MeshBuilder.CreateBox(
      "map_floor",
      { width: this.map.floorSize.width, height: 1, depth: this.map.floorSize.depth },
      this.scene
    );
    floor.position.set(0, -0.5, 0);
    floor.receiveShadows = true;
    this.applyWorldBoxUvs(floor, { x: this.map.floorSize.width, y: 1, z: this.map.floorSize.depth }, 3.5);
    const floorMat = new PBRMaterial("floor_mat", this.scene);
    const floorSlug = this.texGen.getFloorSlug(this.map);
    const floorTint = this.map.theme === "NEON_ROOFTOP" ? "#64748b" : undefined;
    const floorRough =
      this.map.theme === "CARGO_DOCKS" ? 0.72 : this.map.theme === "DESERT_OUTPOST" ? 0.95 : 0.55;
    const floorMetal =
      this.map.theme === "CARGO_DOCKS" ? 0.15 : this.map.theme === "DESERT_OUTPOST" ? 0.02 : 0.25;
    this.texGen.applyRealPbrToMaterial(floorMat, floorSlug, 1, 1, floorTint, floorRough, floorMetal);
    floorMat.environmentIntensity = this.map.theme === "DESERT_OUTPOST" ? 0.35 : 0.65;
    floor.material = floorMat;
    this.floorMesh = floor;

    // Cover, Real Photogrammetry glTF Props, Shipping Containers, Catwalks, Glass & Barrels
    for (const block of this.map.blocks) {
      let propKey: ModelAssetKey | null = null;
      let propTint: string | undefined;
      if (block.material === "EXPLOSIVE_BARREL") {
        propKey = "barrel";
        propTint = "#b91c1c";
      } else if (block.id.startsWith("vault_")) {
        propKey = "barrier";
      } else if (block.id.startsWith("sand_box_")) {
        propKey = "crate";
      } else if (block.id.startsWith("hvac_")) {
        propKey = "hvac";
      }

      if (propKey) {
        const prop = this.modelCache.instantiateBoxAlignedProp(
          propKey,
          block.size,
          `prop_${block.id}`,
          this.shadowGen ?? undefined,
          propTint
        );
        if (prop) {
          prop.root.position.set(block.position.x, block.position.y, block.position.z);
          if (block.rotationX) prop.root.rotation.x = block.rotationX;
          if (block.rotationY) prop.root.rotation.y = block.rotationY;
          this.blockProps.set(block.id, prop);
          continue;
        }
      }

      let m: Mesh;
      if (block.material === "EXPLOSIVE_BARREL") {
        m = MeshBuilder.CreateCylinder(
          block.id,
          { diameter: block.size.x, height: block.size.y, tessellation: 18 },
          this.scene
        );
      } else {
        m = MeshBuilder.CreateBox(
          block.id,
          { width: block.size.x, height: block.size.y, depth: block.size.z },
          this.scene
        );
      }

      m.position.set(block.position.x, block.position.y, block.position.z);
      if (block.rotationX) m.rotation.x = block.rotationX;
      if (block.rotationY) m.rotation.y = block.rotationY;
      m.receiveShadows = !block.isPuddle && block.material !== "GLASS";

      const mat = new PBRMaterial(`mat_${block.id}`, this.scene);

      if (block.isPuddle) {
        mat.albedoColor = Color3.FromHexString("#0f172a");
        mat.roughness = 0.04;
        mat.metallic = 0.94;
        mat.alpha = 0.78;
      } else if (block.material === "GLASS") {
        mat.albedoColor = Color3.FromHexString(block.colorHex);
        mat.roughness = 0.05;
        mat.metallic = 0.2;
        mat.alpha = 0.32;
      } else if (block.material === "NEON_TRIM") {
        const neonTex = this.texGen.getNeonBillboardTexture(block.emissiveHex ?? block.colorHex);
        mat.albedoTexture = neonTex;
        mat.emissiveTexture = neonTex;
        mat.emissiveColor = Color3.FromHexString(block.emissiveHex ?? block.colorHex).scale(1.15);
        mat.roughness = 0.25;
      } else {
        if (block.material !== "EXPLOSIVE_BARREL") {
          this.applyWorldBoxUvs(m, block.size, block.material === "METAL" ? 2.4 : 2.8);
        }
        const slug = this.texGen.getBlockSlug(block.material);
        const isContainer = block.material === "METAL";
        const isMetallicPlate = block.material === "SHEET_METAL";
        const tint = isContainer || block.id.startsWith("spawn_") ? block.colorHex
          : block.id.startsWith("wall_") && this.map.theme === "CARGO_DOCKS" ? "#b4c1c5" : undefined;
        const rough = isContainer ? 0.52 : isMetallicPlate ? 0.48 : 0.9;
        const metal = isContainer ? 0.68 : isMetallicPlate ? 0.72 : 0.05;
        this.texGen.applyRealPbrToMaterial(mat, slug, 1, 1, tint, rough, metal);
        if (!isContainer && !isMetallicPlate) {
          mat.environmentIntensity = 0.38;
        }
        if (!block.id.includes("wall_")) {
          this.shadowGen.addShadowCaster(m);
        }
      }

      m.material = mat;
      this.blockMeshes.set(block.id, m);
    }

    this.buildEnvironmentalLandmarks();

    // Tactical Steel Silhouette Practice Targets
    for (let i = 0; i < this.map.warmupTargets.length; i++) {
      const tp = this.map.warmupTargets[i];
      const tgt = MeshBuilder.CreateCylinder(
        `warmup_target_${i}`,
        { diameter: PRACTICE_TARGET_RADIUS * 2, height: 0.08, tessellation: 20 },
        this.scene
      );
      tgt.rotation.x = Math.PI * 0.5;
      tgt.position.set(tp.x, tp.y, tp.z);

      const post = MeshBuilder.CreateCylinder(
        `warmup_post_${i}`,
        { diameter: 0.07, height: 1.45, tessellation: 8 },
        this.scene
      );
      post.position.set(tp.x, tp.y - 0.72, tp.z + 0.05);
      const postMat = new PBRMaterial(`wp_mat_${i}`, this.scene);
      postMat.albedoColor = Color3.FromHexString("#334155");
      postMat.metallic = 0.8;
      postMat.roughness = 0.4;
      post.material = postMat;
      post.setEnabled(this.room.phase === "WARMUP");
      this.warmupPostMeshes.push(post);

      const tMat = new StandardMaterial(`wt_mat_${i}`, this.scene);
      tMat.diffuseColor = Color3.FromHexString("#e2e8f0");
      tMat.emissiveColor = Color3.FromHexString("#0284c7");
      tgt.material = tMat;
      tgt.setEnabled(this.room.phase === "WARMUP");
      this.shadowGen.addShadowCaster(tgt);
      this.warmupTargetMeshes.push({ mesh: tgt, mat: tMat, flashTimer: 0 });
    }

    this.buildSpawnBanners();
  }

  private disposeSpawnBanners(): void {
    for (const mesh of this.spawnBannerMeshes) mesh.dispose();
    this.spawnBannerMeshes.length = 0;
    for (const mat of this.spawnBannerMats) mat.dispose();
    this.spawnBannerMats.length = 0;
    for (const entry of this.spawnBannerEntries) {
      entry.mat.dispose();
      entry.tex.dispose();
    }
    this.spawnBannerEntries.length = 0;
  }

  private buildSpawnBanners(): void {
    const screenZ = this.map.spawnScreenZ ?? 20;
    const baseZ = screenZ + 0.45;
    const frameMat = new PBRMaterial("spawn_banner_frame_mat", this.scene);
    frameMat.albedoColor = Color3.FromHexString("#161e2e");
    frameMat.metallic = 0.72;
    frameMat.roughness = 0.42;
    this.spawnBannerMats.push(frameMat);

    for (const team of ["A", "B"] as const) {
      const end = team === "A" ? -1 : 1;
      const zPos = end * baseZ;
      const screenCenterZ = end * screenZ;

      const tex = new DynamicTexture(`spawn_banner_${team}`, { width: 768, height: 192 }, this.scene, true);
      const mat = new StandardMaterial(`spawn_banner_mat_${team}`, this.scene);
      mat.diffuseTexture = tex;
      mat.emissiveTexture = tex;
      mat.emissiveColor = new Color3(0.78, 0.78, 0.78);
      mat.specularColor = Color3.Black();

      const backing = MeshBuilder.CreateBox(
        `spawn_banner_backing_${team}`,
        { width: 5.96, height: 1.58, depth: 0.05 },
        this.scene
      );
      backing.position.set(0, 3.15, zPos);
      backing.material = frameMat;
      backing.isPickable = false;
      this.spawnBannerMeshes.push(backing);

      for (const side of [-1, 1] as const) {
        const strut = MeshBuilder.CreateBox(
          `spawn_banner_strut_${team}_${side}`,
          { width: 0.12, height: 0.12, depth: Math.abs(zPos - screenCenterZ) + 0.14 },
          this.scene
        );
        strut.position.set(side * 2.82, 2.28, (zPos + screenCenterZ) * 0.5);
        strut.material = frameMat;
        strut.isPickable = false;
        this.spawnBannerMeshes.push(strut);

        const riser = MeshBuilder.CreateBox(
          `spawn_banner_riser_${team}_${side}`,
          { width: 0.12, height: 0.24, depth: 0.12 },
          this.scene
        );
        riser.position.set(side * 2.82, 2.38, zPos);
        riser.material = frameMat;
        riser.isPickable = false;
        this.spawnBannerMeshes.push(riser);
      }

      const front = MeshBuilder.CreatePlane(`spawn_banner_front_${team}`, { width: 5.8, height: 1.45 }, this.scene);
      front.position.set(0, 3.15, zPos - 0.03);
      front.rotation.y = 0;
      front.material = mat;
      front.isPickable = false;
      this.spawnBannerMeshes.push(front);

      const back = MeshBuilder.CreatePlane(`spawn_banner_back_${team}`, { width: 5.8, height: 1.45 }, this.scene);
      back.position.set(0, 3.15, zPos + 0.03);
      back.rotation.y = Math.PI;
      back.material = mat;
      back.isPickable = false;
      this.spawnBannerMeshes.push(back);

      this.spawnBannerEntries.push({ team, tex, mat, lastKey: "" });
    }

    this.updateSpawnBanners();
  }

  private updateSpawnBanners(): void {
    if (!this.spawnBannerEntries.length) return;
    const localTeam = this.getLocalPlayerSummary()?.team ?? "A";
    for (const entry of this.spawnBannerEntries) {
      const names = this.room.players
        .filter((p) => p.team === entry.team)
        .map((p) => p.callsign);
      const isMySide = entry.team === localTeam;
      const key = `${isMySide}|${names.join(",")}`;
      if (entry.lastKey === key) continue;
      entry.lastKey = key;

      const ctx = entry.tex.getContext();
      const w = 768;
      const h = 192;
      const accent = isMySide ? "#38bdf8" : "#f87171";
      const header = isMySide ? "YOUR SPAWN" : "ENEMY SPAWN";
      const body = names.length ? names.join("  •  ") : "OPEN SPAWN";

      ctx.fillStyle = "#0b1320";
      ctx.fillRect(0, 0, w, h);

      ctx.strokeStyle = isMySide ? "rgba(56, 189, 248, 0.45)" : "rgba(248, 113, 113, 0.45)";
      ctx.lineWidth = 4;
      ctx.strokeRect(2, 2, w - 4, h - 4);
      ctx.fillStyle = accent;
      ctx.fillRect(0, 0, w, 16);

      ctx.font = "900 28px Inter, Segoe UI, sans-serif";
      ctx.fillStyle = accent;
      ctx.fillText(header, (w - ctx.measureText(header).width) * 0.5, 64);

      let fontSize = names.length >= 4 ? 34 : names.length === 3 ? 40 : names.length === 2 ? 46 : 54;
      ctx.font = `900 ${fontSize}px Inter, Segoe UI, sans-serif`;
      while (fontSize > 22 && ctx.measureText(body).width > w - 56) {
        fontSize -= 3;
        ctx.font = `900 ${fontSize}px Inter, Segoe UI, sans-serif`;
      }
      ctx.fillStyle = "#f8fafc";
      ctx.fillText(body, (w - ctx.measureText(body).width) * 0.5, 134);
      entry.tex.update();
    }
  }

  private applyWorldBoxUvs(mesh: Mesh, size: Readonly<Vec3>, tileMeters = 2.8): void {
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
    const normals = mesh.getVerticesData(VertexBuffer.NormalKind);
    if (!positions || !normals) return;
    const count = positions.length / 3;
    const uvs = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const px = positions[i * 3];
      const py = positions[i * 3 + 1];
      const pz = positions[i * 3 + 2];
      const nx = Math.abs(normals[i * 3]);
      const ny = Math.abs(normals[i * 3 + 1]);
      const nz = Math.abs(normals[i * 3 + 2]);
      let u = 0;
      let v = 0;
      if (nx >= ny && nx >= nz) {
        u = (pz + size.z * 0.5) / tileMeters;
        v = (py + size.y * 0.5) / tileMeters;
      } else if (nz >= nx && nz >= ny) {
        u = (px + size.x * 0.5) / tileMeters;
        v = (py + size.y * 0.5) / tileMeters;
      } else {
        u = (px + size.x * 0.5) / tileMeters;
        v = (pz + size.z * 0.5) / tileMeters;
      }
      uvs[i * 2] = u;
      uvs[i * 2 + 1] = v;
    }
    mesh.setVerticesData(VertexBuffer.UVKind, uvs);
  }

  private buildEnvironmentalLandmarks(): void {
    if (this.map.theme === "CARGO_DOCKS") {
      this.buildDockWayfinding();
      const towerMat = new PBRMaterial("dock_tower_mat", this.scene);
      this.texGen.applyRealPbrToMaterial(towerMat, "metal_plate_02", 1, 4, "#334155", 0.5, 0.75);
      const lampMat = new StandardMaterial("dock_lamp_mat", this.scene);
      lampMat.emissiveColor = Color3.FromHexString("#f8fafc");
      lampMat.disableLighting = true;

      for (const side of [-29.5, 29.5]) {
        const mast = MeshBuilder.CreateBox(
          `dock_mast_${side}`,
          { width: 0.9, height: 16, depth: 0.9 },
          this.scene
        );
        mast.position.set(side, 8, 0);
        mast.material = towerMat;
        mast.isPickable = false;
        this.storytellingMeshes.push(mast);

        const bar = MeshBuilder.CreateBox(
          `dock_bar_${side}`,
          { width: 0.6, height: 0.5, depth: 4.8 },
          this.scene
        );
        bar.position.set(side, 14.5, 0);
        bar.material = towerMat;
        bar.isPickable = false;
        this.storytellingMeshes.push(bar);

        const lamp = MeshBuilder.CreateBox(
          `dock_lamp_${side}`,
          { width: 0.35, height: 0.45, depth: 3.6 },
          this.scene
        );
        lamp.position.set(side + (side < 0 ? 0.42 : -0.42), 14.3, 0);
        lamp.material = lampMat;
        lamp.isPickable = false;
        this.storytellingMeshes.push(lamp);
      }
    } else if (this.map.theme === "DESERT_OUTPOST") {
      const beamMat = new PBRMaterial("bazaar_beam_mat", this.scene);
      this.texGen.applyRealPbrToMaterial(beamMat, "brown_planks_04", 3, 1, undefined, 0.9, 0.04);
      for (const bz of [-5.5, 5.5]) {
        const beam = MeshBuilder.CreateBox(
          `bazaar_beam_${bz}`,
          { width: 9.8, height: 0.32, depth: 0.35 },
          this.scene
        );
        beam.position.set(0, 3.7, bz);
        beam.material = beamMat;
        beam.isPickable = false;
        this.shadowGen?.addShadowCaster(beam);
        this.storytellingMeshes.push(beam);
      }

      const canopyMat = new PBRMaterial("bazaar_canopy_mat", this.scene);
      canopyMat.albedoColor = Color3.FromHexString("#d6b88d");
      canopyMat.roughness = 0.96;
      canopyMat.metallic = 0;
      const canopy = MeshBuilder.CreateBox(
        "bazaar_canopy",
        { width: 9.2, height: 0.08, depth: 11.4 },
        this.scene
      );
      canopy.position.set(0, 3.88, 0);
      canopy.material = canopyMat;
      canopy.isPickable = false;
      this.shadowGen?.addShadowCaster(canopy);
      this.storytellingMeshes.push(canopy);
    } else if (this.map.theme === "NEON_ROOFTOP") {
      const mastMat = new PBRMaterial("roof_mast_mat", this.scene);
      this.texGen.applyRealPbrToMaterial(mastMat, "metal_plate_02", 1, 2, "#1e293b", 0.45, 0.8);
      const strobeMat = new StandardMaterial("roof_strobe_mat", this.scene);
      strobeMat.emissiveColor = Color3.FromHexString("#ef4444");
      strobeMat.disableLighting = true;

      for (const [cx, cz] of [
        [-23.2, -28.2],
        [23.2, -28.2],
        [-23.2, 28.2],
        [23.2, 28.2],
      ]) {
        const pole = MeshBuilder.CreateCylinder(
          `strobe_pole_${cx}_${cz}`,
          { diameter: 0.14, height: 2.6, tessellation: 10 },
          this.scene
        );
        pole.position.set(cx, 4.5, cz);
        pole.material = mastMat;
        pole.isPickable = false;
        this.storytellingMeshes.push(pole);

        const bulb = MeshBuilder.CreateSphere(
          `strobe_bulb_${cx}_${cz}`,
          { diameter: 0.34, segments: 10 },
          this.scene
        );
        bulb.position.set(cx, 5.9, cz);
        bulb.material = strobeMat;
        bulb.isPickable = false;
        this.storytellingMeshes.push(bulb);
      }

      const hMat = new StandardMaterial("helipad_h_mat", this.scene);
      hMat.emissiveColor = Color3.FromHexString("#f59e0b");
      hMat.disableLighting = true;
      for (const [hx, hw, hd] of [
        [-1.8, 0.55, 4.8],
        [1.8, 0.55, 4.8],
        [0, 3.6, 0.55],
      ]) {
        const bar = MeshBuilder.CreateBox(`helipad_h_${hx}`, { width: hw, height: 0.04, depth: hd }, this.scene);
        bar.position.set(hx, 0.395, 0);
        bar.material = hMat;
        bar.isPickable = false;
        this.storytellingMeshes.push(bar);
      }
    }
  }

  private buildDockWayfinding(): void {
    const lanes = [
      { x: -18.0, pitch: "WEST BERTH", color: "#69b6d6" },
      { x: 0, pitch: "FREIGHT YARD", color: "#e7d98e" },
      { x: 18.0, pitch: "EAST GANTRY", color: "#e88b57" },
    ];
    for (const lane of lanes) {
      const paint = new StandardMaterial(`dock_paint_${lane.x}`, this.scene);
      paint.diffuseColor = Color3.FromHexString(lane.color).scale(0.65);
      paint.emissiveColor = Color3.FromHexString(lane.color).scale(0.12);
      paint.specularColor = Color3.Black();
      const laneLines: Mesh[] = [];
      for (const x of [lane.x - 1.25, lane.x + 1.25]) {
        for (const z of [-25, -20, -9, 9, 20, 25]) {
          const stripe = MeshBuilder.CreateGround(`lane_line_${x}_${z}`, { width: 0.13, height: 2.5 }, this.scene);
          stripe.position.set(x, 0.018, z);
          laneLines.push(stripe);
        }
      }
      const stripes = Mesh.MergeMeshes(laneLines, true);
      if (stripes) {
        stripes.material = paint;
        stripes.receiveShadows = true;
        stripes.isPickable = false;
        this.storytellingMeshes.push(stripes);
      } else paint.dispose();

      const texture = new DynamicTexture(`dock_sign_${lane.x}`, { width: 512, height: 160 }, this.scene, true);
      const ctx = texture.getContext();
      ctx.fillStyle = "#202e37";
      ctx.fillRect(0, 0, 512, 160);
      ctx.fillStyle = lane.color;
      ctx.fillRect(0, 0, 512, 13);
      ctx.font = "bold 46px sans-serif";
      ctx.fillStyle = "#f0f1e7";
      ctx.fillText(lane.pitch, (512 - ctx.measureText(lane.pitch).width) / 2, 100);
      texture.update();
      this.landmarkTextures.push(texture);
      const signMat = new StandardMaterial(`dock_sign_mat_${lane.x}`, this.scene);
      signMat.diffuseTexture = texture;
      signMat.emissiveTexture = texture;
      signMat.emissiveColor = new Color3(0.58, 0.58, 0.58);
      for (const z of [-31.20, 31.20]) {
        const sign = MeshBuilder.CreatePlane(`dock_sign_${lane.x}_${z}`, { width: 5.5, height: 1.72 }, this.scene);
        sign.position.set(lane.x, 4.8, z);
        sign.rotation.y = z > 0 ? 0 : Math.PI;
        sign.material = signMat;
        sign.isPickable = false;
        this.storytellingMeshes.push(sign);
      }
    }
  }

  private bindInputs(): void {
    this.keyDownHandler = (e: KeyboardEvent) => {
      if (e.code === "Escape" && document.pointerLockElement === this.app.canvas) {
        document.exitPointerLock();
        return;
      }
      if (!this.net.connected || document.querySelector(".modal-backdrop:not(.hidden):has(#set-close)")) return;
      if ((e.target as HTMLElement | null)?.closest?.("input, select, textarea, [contenteditable]")) return;
      if (e.code === "F2" && !e.repeat && !this.loadoutOpen) {
        e.preventDefault();
        if (this.paused) this.setPaused(false);
        else this.requestPointerLock();
        return;
      }
      if (e.code === "KeyM" && !e.repeat && !this.loadoutOpen) {
        e.preventDefault();
        this.setPaused(!this.paused);
        return;
      }
      if (e.code === "Minus" || e.code === "NumpadSubtract") {
        e.preventDefault();
        this.callbacks.onVolumeKey(-1);
        return;
      }
      if (e.code === "Equal" || e.code === "NumpadAdd") {
        e.preventDefault();
        this.callbacks.onVolumeKey(1);
        return;
      }
      if (e.code === "F8" && !e.repeat) {
        e.preventDefault();
        this.callbacks.onVolumeKey(0);
        return;
      }
      if (this.paused || e.repeat) return;
      if (e.code === "KeyL") {
        e.preventDefault();
        this.callbacks.onToggleLoadout();
        return;
      }
      if (this.loadoutOpen) return;
      this.keys.add(e.code);
      if (e.code === "Tab") {
        e.preventDefault();
        this.callbacks.onScoreboardChanged(true);
        return;
      }
      if (e.code === "Space" && this.deathCamera.name) {
        this.deathCamera.stop();
        return;
      }
      if (e.code === "Space") this.jumpPressed = true;
      if (this.isCrouchKey(e.code)) {
        const sprintSlide = this.keys.has("ShiftLeft") && (this.keys.has("KeyW") || this.keys.has("ArrowUp")) &&
          this.playerState.grounded && !this.playerState.crouching && this.playerState.slideCooldown <= 0;
        if (this.profile.settings.toggleCrouch && !sprintSlide) this.crouchLatched = !this.crouchLatched;
        else this.crouchPressed = true;
      }

      const bindings = this.profile.settings.combatBindings;
      if (e.code === combatKey(bindings, "inspect") && this.net.latestLocalState?.alive && !this.cookingGrenade) this.viewModel.inspect();
      if (e.code === combatKey(bindings, "melee")) this.quickMelee();
      if (e.code === combatKey(bindings, "primary")) this.switchWeaponSlot(0);
      if (e.code === combatKey(bindings, "secondary")) this.switchWeaponSlot(1);
      if (e.code === combatKey(bindings, "swapWeapon")) this.switchWeaponSlot(this.activeSlot === 0 ? 1 : 0);
      if (e.code === "KeyB") this.cycleFireMode();
      if (e.code === "KeyV") this.cycleOptic();
      const throwable = THROWABLE_ORDER.find((kind) => e.code === combatKey(bindings, kind));
      if (throwable && !this.cookingGrenade && this.grenadesAvailable(throwable) > 0) this.activeThrowable = throwable;
      if (e.code === combatKey(bindings, "throwGrenade") && !this.cookingGrenade &&
        document.pointerLockElement === this.app.canvas && this.canThrowGrenade()) {
        this.mouseDownRight = false;
        this.mouseDownLeft = false;
        this.justFiredTrigger = false;
        this.burstRemaining = 0;
        this.cookingGrenade = true;
        this.cookElapsedSec = 0;
      }
      if (e.code === "KeyZ") {
        this.sendDangerPing();
      }
      if (e.code === combatKey(bindings, "reload") && !this.cookingGrenade) {
        this.startReload();
      }
    };

    this.keyUpHandler = (e: KeyboardEvent) => {
      this.keys.delete(e.code);
      if (e.code === "Tab") {
        e.preventDefault();
        this.callbacks.onScoreboardChanged(false);
      }
      if (e.code === combatKey(this.profile.settings.combatBindings, "throwGrenade") && this.cookingGrenade) {
        this.releaseThrowGrenade();
      }
    };

    this.mouseDownHandler = (e: MouseEvent) => {
      if (this.paused || this.loadoutOpen || !this.net.connected) return;
      this.audio.unlock();
      if (document.pointerLockElement !== this.app.canvas) {
        this.requestPointerLock();
        return;
      }
      if (this.cookingGrenade) {
        if (e.button === 2) this.cancelGrenadePreview();
        return;
      }
      if (e.button === 0) {
        this.mouseDownLeft = true;
        this.justFiredTrigger = true;
        const local = this.getLocalPlayerSummary();
        if (local && !local.alive) {
          this.deathCamera.stop();
          this.spectatorIndex++;
        }
      } else if (e.button === 2) {
        this.mouseDownRight = true;
      } else if (e.button === 1) {
        e.preventDefault();
        this.sendDangerPing();
      }
    };

    this.mouseUpHandler = (e: MouseEvent) => {
      if (e.button === 0) this.mouseDownLeft = false;
      if (e.button === 2) this.mouseDownRight = false;
    };

    this.mouseMoveHandler = (e: MouseEvent) => {
      if (this.paused || this.loadoutOpen || document.pointerLockElement !== this.app.canvas) return;
      if (this.pointerLockGraceEvents > 0) {
        this.pointerLockGraceEvents--;
        return;
      }
      const { movementX: dx, movementY: dy } = e;
      if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.abs(dx) > 260 || Math.abs(dy) > 260) return;
      const cdx = Math.max(-180, Math.min(180, dx));
      const cdy = Math.max(-180, Math.min(180, dy));

      const stats = this.getActiveWeaponStats();
      const adsFactor = lerp(1, this.profile.settings.adsSensMult, this.adsAlpha);
      const fovZoomFactor = lerp(1, stats.adsFov / this.profile.settings.fov, this.adsAlpha);
      const sens = 0.0022 * this.profile.settings.hipSens * adsFactor * fovZoomFactor;

      this.playerState.yaw += cdx * sens;
      this.playerState.pitch = Math.max(
        -1.52,
        Math.min(1.52, this.playerState.pitch - cdy * sens)
      );
      if (cdy > 0) {
        this.pendingRecoilRecoveryPitch = Math.max(0, this.pendingRecoilRecoveryPitch - cdy * sens);
      }
      this.viewModel.addMouseSway(cdx, cdy);
    };

    this.pointerLockHandler = () => {
      if (document.pointerLockElement === this.app.canvas) {
        this.pointerLockGraceEvents = 2;
      } else {
        this.pointerLockGraceEvents = 0;
        this.clearCombatInputs();
      }
      this.callbacks.onPointerCaptureError("");
    };

    this.contextMenuHandler = (e: MouseEvent) => e.preventDefault();
    this.wheelHandler = (e: WheelEvent) => {
      if (!e.deltaY || this.paused || this.loadoutOpen || !this.net.connected ||
        document.pointerLockElement !== this.app.canvas) return;
      e.preventDefault();
      const now = performance.now();
      const sinceLast = now - this.lastWeaponScroll;
      this.lastWeaponScroll = now;
      if (sinceLast >= 140) this.switchWeaponSlot(this.activeSlot === 0 ? 1 : 0);
    };

    window.addEventListener("keydown", this.keyDownHandler);
    window.addEventListener("keyup", this.keyUpHandler);
    this.app.canvas.addEventListener("mousedown", this.mouseDownHandler);
    window.addEventListener("mouseup", this.mouseUpHandler);
    window.addEventListener("mousemove", this.mouseMoveHandler);
    window.addEventListener("blur", this.lostFocusHandler);
    document.addEventListener("visibilitychange", this.lostFocusHandler);
    document.addEventListener("pointerlockchange", this.pointerLockHandler);
    this.app.canvas.addEventListener("contextmenu", this.contextMenuHandler);
    this.app.canvas.addEventListener("wheel", this.wheelHandler, { passive: false });
  }

  private switchWeaponSlot(slot: 0 | 1): void {
    this.viewModel.cancelInspect();
    this.cancelGrenadePreview();
    if (this.activeSlot === slot) return;
    this.audio.playWeaponSwitch();
    this.activeSlot = slot;
    this.reloadTimer = 0;
    this.reloadRequested = false;
    this.burstRemaining = 0;
    this.fireModeIndex = 0;
    this.equipViewModel(this.getActiveWeaponConfig());
  }

  private equipViewModel(config: PlayerWeaponConfig): void {
    this.adsAlpha = 0;
    this.breathSteady = 0;
    this.recoilOffsetPitch = 0;
    this.recoilOffsetYaw = 0;
    this.pendingRecoilRecoveryPitch = 0;
    this.recoilShotCount = 0;
    this.viewModel.equip(config);
  }

  private cycleFireMode(): void {
    const modes = this.getActiveWeaponStats().blueprint.stats.fireModes;
    this.fireModeIndex = (this.fireModeIndex + 1) % modes.length;
  }

  /** V: cycle through the optics this weapon can mount (none -> red dot -> 2x -> 6x ...). Keeps ammo. */
  private cycleOptic(): void {
    if (this.room.mode === "2v2" || this.cookingGrenade || this.reloadTimer > 0 || this.paused || this.loadoutOpen) return;
    const now = performance.now();
    if (now - this.lastOpticSwapMs < 350) return;
    const cfg = this.getActiveWeaponConfig();
    const category = computeEffectiveWeaponStats(cfg.weaponId, cfg.attachments).blueprint.category;
    const options: (string | null)[] = [null, ...getAttachmentsForWeaponSlot(category, "optic").map((a) => a.id)];
    if (options.length < 2) return;
    this.lastOpticSwapMs = now;
    const current = cfg.attachments.optic ?? null;
    const next = options[(Math.max(0, options.indexOf(current)) + 1) % options.length];
    this.mouseDownRight = false;
    this.net.send({ type: "SET_OPTIC", slot: this.activeSlot === 0 ? 0 : 1, optic: next });

    // Remember the choice for future matches when this is the same weapon as the saved loadout.
    const saved = this.activeSlot === 0 ? this.profile.loadout.primary : this.profile.loadout.secondary;
    if (saved.weaponId === cfg.weaponId) {
      if (next === null) delete saved.attachments.optic;
      else saved.attachments.optic = next;
      saveGuestProfile(this.profile);
    }
  }

  private grenadesAvailable(throwable = this.activeThrowable): number {
    return this.room.mode !== "WARMUP" ? this.throwableStock[throwable] : this.throwablesLeft;
  }

  private canThrowGrenade(): boolean {
    return this.movementEpoch !== null && this.net.latestLocalState?.alive === true &&
      isCombatPhase(this.room.phase) && this.grenadesAvailable() > 0;
  }

  private cancelGrenadePreview(): void {
    this.cookingGrenade = false;
    this.cookElapsedSec = 0;
  }

  private startReload(): void {
    if (this.reloadTimer > 0) return;
    const stats = this.getActiveWeaponStats();
    if (this.ammoInMag[this.activeSlot] >= stats.magSize) return;
    if (this.ammoReserve[this.activeSlot] <= 0) return;

    const isDry = this.ammoInMag[this.activeSlot] === 0;
    this.reloadTimer = isDry ? stats.reloadEmptySec : stats.reloadTacticalSec;
    this.reloadRequested = true;
    this.audio.playReloadClick(isDry, this.reloadTimer);
  }

  private quickMelee(): void {
    const now = performance.now();
    if (!this.net.latestLocalState?.alive || !isCombatPhase(this.room.phase) || this.cookingGrenade ||
      now - this.lastMelee < MELEE_COOLDOWN_MS || this.movementEpoch === null) return;
    this.lastMelee = now;
    this.mouseDownLeft = this.mouseDownRight = this.justFiredTrigger = false;
    this.burstRemaining = 0;
    this.viewModel.swingKnife();
    this.audio.playKnifeSwing();
    this.net.send({ type: "MELEE", movementEpoch: this.movementEpoch });
  }

  private releaseThrowGrenade(): void {
    const cookElapsedSec = this.cookElapsedSec;
    this.cancelGrenadePreview();
    if (!this.canThrowGrenade() || this.movementEpoch === null) return;
    if (this.room.mode === "WARMUP") this.throwablesLeft--;
    this.viewModel.notifyThrow();

    const eye = getCameraEyePosition(this.playerState);
    const dir = this.getGrenadeAim();

    this.net.send({
      type: "THROW_GRENADE",
      throwable: this.activeThrowable,
      origin: eye,
      dir,
      cookElapsedSec,
      movementEpoch: this.movementEpoch,
    });
  }

  private getGrenadeAim(): Vec3 {
    return yawPitchToDir({ x: 0, y: 0, z: 1 }, this.playerState.yaw, this.playerState.pitch + this.recoilOffsetPitch);
  }

  private updateGrenadePreview(visible: boolean): void {
    if (!visible) {
      this.vfx.updateThrowArc([]);
      return;
    }
    const spec = THROWABLE_REGISTRY[this.activeThrowable];
    const position = getCameraEyePosition(this.playerState);
    const dir = this.getGrenadeAim();
    const velocity = { x: dir.x * spec.throwSpeed, y: dir.y * spec.throwSpeed + 2.8, z: dir.z * spec.throwSpeed };
    const points: Vec3[] = [];
    const fuse = Math.max(0.15, spec.fuseSec - this.cookElapsedSec);
    const sampleStep = 5 * FIXED_DT;
    for (let i = 1; i <= 18 && i * sampleStep < fuse; i++) {
      if (this.physWorld.stepThrowable(position, velocity, spec.restitution, sampleStep)) {
        this.vfx.updateThrowArc(points, position);
        return;
      }
      points.push({ ...position });
    }
    this.vfx.updateThrowArc(points);
  }

  private sendDangerPing(): void {
    const alive = this.net.latestLocalState?.alive ?? this.getLocalPlayerSummary()?.alive;
    const now = performance.now();
    if (!alive || now - this.lastDangerPingAt < 800) return;
    this.lastDangerPingAt = now;
    const eye = getCameraEyePosition(this.playerState);
    const dir = yawPitchToDir({ x: 0, y: 0, z: 1 }, this.playerState.yaw, this.playerState.pitch);
    const worldHit = this.physWorld.castBallisticWorldRay(eye, dir, 85, 0);
    const pos = worldHit.primaryHit
      ? worldHit.primaryHit.hitPoint
      : { x: eye.x + dir.x * 35, y: Math.max(0.2, eye.y + dir.y * 35), z: eye.z + dir.z * 35 };
    this.net.send({ type: "DANGER_PING", position: pos });
  }

  public handleServerMessage(msg: ServerToClientMessage): void {
    switch (msg.type) {
      case "ROOM_STATE": {
        const oldMap = this.currentMapId;
        const wasWarmup = this.room.phase === "WARMUP";
        const nextRoom = msg.room;
        const matchRestarted = this.room.phase !== "COUNTDOWN" && nextRoom.phase === "COUNTDOWN";
        this.room = nextRoom;
        this.pickupView.sync(nextRoom.pickups ?? []);

        if (nextRoom.mapId !== oldMap) {
          this.currentMapId = nextRoom.mapId;
          this.map = MAP_REGISTRY[this.currentMapId] ?? MAP_REGISTRY.cargo_docks;
          this.rebuildMapScene();
        } else if (wasWarmup !== (nextRoom.phase === "WARMUP")) {
          const showPracticeTargets = nextRoom.phase === "WARMUP";
          for (const target of this.warmupTargetMeshes) target.mesh.setEnabled(showPracticeTargets);
          for (const post of this.warmupPostMeshes) post.setEnabled(showPracticeTargets);
        }

        if (matchRestarted) {
          this.audio.playCountdown(COUNTDOWN_SEC);
          this.deathCamera.stop();
          this.throwablesLeft = 2;
          this.reloadTimer = 0;
          this.recoilOffsetPitch = 0;
          this.recoilOffsetYaw = 0;
          this.pendingRecoilRecoveryPitch = 0;
          this.recoilShotCount = 0;
          this.cameraRoll = 0;
          this.camera.rotation.z = 0;
          this.predictedTracerSeqs.clear();
          this.slowMoTimer = 0;
          this.syncEquippedWeapons(true);
          this.resetRoundEntities();
        } else {
          this.syncEquippedWeapons(false);
        }

        this.syncRemotePlayers();
        this.updateSpawnBanners();
        this.callbacks.onRoomUpdate(nextRoom);
        break;
      }

      case "SHOT_FIRED": {
        const isLocal = msg.shooterId === this.localPlayerId;
        const skipLocalTracer = isLocal && this.predictedTracerSeqs.delete(msg.seq);
        const shooterSoldier = this.remoteSoldiers.get(msg.shooterId);
        const localMuzzle = isLocal ? this.pendingShots.find((shot) => shot.seq === msg.seq)?.muzzle : undefined;
        const tracerOrigin = localMuzzle ?? shooterSoldier?.getMuzzleWorldPos() ?? msg.origin;
        if (!isLocal) {
          this.audio.playWeaponFire(msg.weaponId, msg.suppressed, msg.origin);

          const localTeam = this.getLocalPlayerSummary()?.team;
          const shooterSummary = this.room.players.find((p) => p.id === msg.shooterId);
          if (shooterSummary && shooterSummary.team !== localTeam) {
            this.enemyBlips.push({ x: msg.origin.x, z: msg.origin.z, ttl: 2.5 });
          }

        }
        const eye = isLocal ? null : getCameraEyePosition(this.playerState);
        let whizzed = false;
        let practiceHit = false;
        for (const [index, path] of msg.paths.entries()) {
          const dx = path.end.x - msg.origin.x;
          const dy = path.end.y - msg.origin.y;
          const dz = path.end.z - msg.origin.z;
          const length = Math.hypot(dx, dy, dz);
          if (!skipLocalTracer && index < 2 && length > 1.2) this.vfx.spawnMovingTracer(tracerOrigin, path.end, path.bends);
          if (eye && !whizzed && !msg.suppressed && length > 0.001) {
            const ray = { x: dx / length, y: dy / length, z: dz / length };
            const along = (eye.x - msg.origin.x) * ray.x + (eye.y - msg.origin.y) * ray.y + (eye.z - msg.origin.z) * ray.z;
            if (along > 0 && along < length && distPointToRay(eye, msg.origin, ray) < 1.55) {
              this.audio.playSupersonicWhiz(eye);
              this.damageVignetteAlpha = Math.max(this.damageVignetteAlpha, 0.35);
              whizzed = true;
            }
          }
          for (const surface of path.surfaces) {
            const mesh = this.blockMeshes.get(surface.blockId) ?? this.blockProps.get(surface.blockId)?.meshes[0];
            this.vfx.spawnBulletImpact(surface.point, surface.normal, surface.material, false, mesh);
          }
          if (path.playerId && path.playerId !== this.localPlayerId) {
            this.remoteSoldiers.get(path.playerId)?.triggerHitFlinch();
            if (length > 0.001) this.vfx.spawnBulletImpact(path.end, { x: -dx / length, y: -dy / length, z: -dz / length }, "BODY", true);
          }
          if (path.practiceTarget !== undefined) {
            const target = this.warmupTargetMeshes[path.practiceTarget];
            if (target) {
              target.flashTimer = 0.22;
              target.mat.emissiveColor = Color3.FromHexString("#facc15");
              practiceHit = true;
            }
          }
        }
        if (isLocal && practiceHit) this.audio.playPracticeTarget();
        break;
      }

      case "HIT_CONFIRM": {
        this.audio.playHitMarker(msg.tier, msg.isHeadshot ?? msg.hitZone === "HEAD");
        this.callbacks.onHitConfirm(msg.tier, msg.damage, msg.isWallbang);
        break;
      }

      case "DAMAGE_TAKEN": {
        this.damageVignetteAlpha = 0.85;
        this.cameraShakeIntensity = Math.max(this.cameraShakeIntensity, 0.04);
        const dx = msg.attackerPosition.x - this.playerState.position.x;
        const dz = msg.attackerPosition.z - this.playerState.position.z;
        const worldAngle = Math.atan2(dx, dz);
        const relAngle = worldAngle - this.playerState.yaw;
        this.audio.playHurt();
        this.callbacks.onDamageTaken(relAngle);
        break;
      }

      case "DAMAGE_BREAKDOWN": {
        this.callbacks.onDamageBreakdown(msg.breakdown);
        break;
      }

      case "DEATH_REPLAY":
        this.deathCamera.start(msg);
        break;

      case "COMBAT_STREAK":
      case "PICKUP_COLLECTED":
      case "MATCH_RESULTS":
        if (msg.type === "MATCH_RESULTS") this.deathCamera.stop();
        if (msg.type === "COMBAT_STREAK" && msg.multi >= 2) this.audio.playMultiKill();
        if (msg.type === "PICKUP_COLLECTED") this.audio.playPickup(msg.kind);
        this.callbacks.onArenaEvent(msg);
        break;

      case "KILL_FEED": {
        if (msg.weaponId === "knife" && (msg.killerName === this.profile.callsign || msg.victimName === this.profile.callsign)) {
          this.audio.playKnifeHit();
        }
        if (msg.isMatchWinningKill) {
          this.slowMoTimer = 1.5;
          this.audio.playSlowMoSweep(1.5);
        }
        this.callbacks.onKillFeed(msg);
        break;
      }

      case "PROP_DESTROYED": {
        const m = this.blockMeshes.get(msg.blockId);
        if (m) m.setEnabled(false);
        const prop = this.blockProps.get(msg.blockId);
        if (prop) prop.root.setEnabled(false);
        this.physWorld.destroyBlock(msg.blockId);
        if (msg.material === "EXPLOSIVE_BARREL") {
          this.vfx.clearBarrelDamage(msg.blockId);
          this.vfx.spawnExplosionVfx(msg.position, 1.25, msg.position.y - 0.65);
          this.audio.playExplosion(msg.position);
          const dist = Math.hypot(
            msg.position.x - this.playerState.position.x,
            msg.position.z - this.playerState.position.z
          );
          if (dist < 22) {
            this.cameraShakeIntensity = Math.max(this.cameraShakeIntensity, (1 - dist / 22) * 0.2);
          }
        } else if (msg.material === "GLASS") {
          const spec = this.map.blocks.find((b) => b.id === msg.blockId);
          this.vfx.spawnGlassShatter(msg.position, spec?.size ?? { x: 2.5, y: 1.8, z: 0.2 });
          this.audio.playGlassShatter(msg.position);
        }
        break;
      }

      case "PROP_DAMAGED": {
        if (msg.material === "EXPLOSIVE_BARREL") {
          this.vfx.setBarrelDamage(msg.blockId, msg.position, msg.hpFraction);
        }
        break;
      }

      case "THROWABLE_SPAWNED": {
        this.audio.playGrenadeThrow(msg.position);
        const spec = THROWABLE_REGISTRY[msg.throwable];
        const model = createGrenadeModel(this.scene, msg.throwable, `gren_${msg.id}`);
        const m = model.root;
        m.position.set(msg.position.x, msg.position.y, msg.position.z);
        m.scaling.setAll(1.7); // exaggerated a little so it reads at range
        model.lever.setEnabled(false); // spoon is released the moment it leaves the hand
        model.pin.setEnabled(false);
        model.ring.setEnabled(false);

        const trailColors = grenadeTrailColor(msg.throwable);
        const trail = new ParticleSystem(`gren_trail_${msg.id}`, 60, this.scene);
        trail.particleTexture = this.vfx.getSoftParticleTexture();
        trail.emitter = m;
        trail.minEmitBox = Vector3.Zero();
        trail.maxEmitBox = Vector3.Zero();
        trail.color1 = new Color4(trailColors.c1[0], trailColors.c1[1], trailColors.c1[2], 0.5);
        trail.color2 = new Color4(trailColors.c2[0], trailColors.c2[1], trailColors.c2[2], 0.35);
        trail.colorDead = new Color4(trailColors.c2[0], trailColors.c2[1], trailColors.c2[2], 0);
        trail.minSize = 0.06;
        trail.maxSize = 0.16;
        trail.minLifeTime = 0.25;
        trail.maxLifeTime = 0.55;
        trail.emitRate = 55;
        trail.direction1 = new Vector3(-0.15, 0.1, -0.15);
        trail.direction2 = new Vector3(0.15, 0.3, 0.15);
        trail.gravity = new Vector3(0, 0.3, 0);
        trail.start();

        this.grenadeVisuals.push({
          id: msg.id,
          mesh: m,
          vel: new Vector3(msg.velocity.x, msg.velocity.y, msg.velocity.z),
          ttl: msg.fuseRemainingSec + 0.15,
          restitution: spec.restitution,
          elapsed: 0,
          trail,
          spin: new Vector3(7 + Math.random() * 4, 2, 9 + Math.random() * 4),
        });
        break;
      }

      case "THROWABLE_DETONATED": {
        const idx = this.grenadeVisuals.findIndex((g) => g.id === msg.id);
        if (idx >= 0) {
          this.disposeGrenadeVisual(this.grenadeVisuals[idx]);
          this.grenadeVisuals.splice(idx, 1);
        }
        if (msg.throwable === "smoke") this.audio.playSmokePop(msg.position);
        else if (msg.throwable === "flashbang") this.audio.playFlashbangBang(msg.position);
        if (msg.throwable === "frag") {
          this.vfx.spawnExplosionVfx(msg.position, 0.9, msg.position.y - 0.12);
          this.audio.playExplosion(msg.position);
          const dist = Math.hypot(
            msg.position.x - this.playerState.position.x,
            msg.position.z - this.playerState.position.z
          );
          if (dist < 16) {
            this.cameraShakeIntensity = Math.max(this.cameraShakeIntensity, (1 - dist / 16) * 0.16);
          }
        } else if (msg.throwable === "smoke") {
          const smokeRoot = new TransformNode(`smoke_cluster_${msg.id}`, this.scene);
          smokeRoot.position.set(msg.position.x, msg.position.y, msg.position.z);
          smokeRoot.scaling.setAll(0.15);

          const sMat = new StandardMaterial(`smat_${msg.id}`, this.scene);
          sMat.diffuseTexture = this.vfx.getSoftParticleTexture();
          sMat.useAlphaFromDiffuseTexture = true;
          sMat.diffuseColor = new Color3(0.76, 0.8, 0.85);
          sMat.emissiveColor = new Color3(0.18, 0.2, 0.24);
          sMat.alpha = 0.84;

          const puffs: Mesh[] = [];
          for (let i = 0; i < 14; i++) {
            const puffSize = msg.radius * (0.72 + ((i * 19) % 10) * 0.045);
            const p = MeshBuilder.CreatePlane(`smoke_puff_${msg.id}_${i}`, { size: puffSize }, this.scene);
            p.parent = smokeRoot;
            const ang = (i / 14) * Math.PI * 2;
            const rad = i < 3 ? 0.3 : msg.radius * (0.28 + ((i * 7) % 5) * 0.09);
            p.position.set(
              Math.cos(ang) * rad,
              0.75 + (i % 4) * 0.52,
              Math.sin(ang) * rad
            );
            p.billboardMode = Mesh.BILLBOARDMODE_ALL;
            p.material = sMat;
            p.isPickable = false;
            puffs.push(p);
          }
          this.smokeVisuals.push({
            root: smokeRoot,
            meshes: puffs,
            mat: sMat,
            ttl: msg.durationSec,
            maxTtl: msg.durationSec,
          });
        } else if (msg.throwable === "flashbang") {
          this.vfx.spawnFlashbangVfx(msg.position);
          this.audio.playExplosion(msg.position);
        }
        break;
      }

      case "FLASHED": {
        this.flashAlpha = Math.max(this.flashAlpha, Math.min(1, msg.intensity * 1.25));
        // Stay fully white for the first third of the effect, then fade over the rest.
        this.flashHoldSec = Math.max(this.flashHoldSec, msg.durationSec * 0.35);
        this.flashFadePerSec = 1 / Math.max(0.4, msg.durationSec * 0.65);
        this.audio.playFlashbangEffect(msg.intensity, msg.durationSec);
        break;
      }

      case "DANGER_PING": {
        this.audio.playPing(msg.playerId === this.localPlayerId ? undefined : msg.position);
        if (msg.enemySpotted) this.audio.playEnemySpotted();
        if (![msg.position.x, msg.position.y, msg.position.z].every(Number.isFinite)) break;
        const previous = this.pingMarkers.findIndex((marker) => marker.playerId === msg.playerId);
        if (previous >= 0) {
          this.pingMarkers[previous].mesh.dispose();
          this.pingMarkers.splice(previous, 1);
        }
        const ping = MeshBuilder.CreateCylinder(
          `ping_${msg.playerId}`,
          { diameterTop: 0.08, diameterBottom: 0.24, height: 5, tessellation: 8 },
          this.scene
        );
        ping.position.set(msg.position.x, msg.position.y + 2.5, msg.position.z);
        ping.isPickable = false;
        if (!this.pingMaterial) {
          this.pingMaterial = new StandardMaterial("danger_ping", this.scene);
          this.pingMaterial.emissiveColor = Color3.FromHexString("#f59e0b");
          this.pingMaterial.disableLighting = true;
          this.pingMaterial.alpha = 0.66;
        }
        ping.material = this.pingMaterial;
        this.pingMarkers.push({
          playerId: msg.playerId,
          mesh: ping,
          worldPos: { x: msg.position.x, y: msg.position.y + 2.2, z: msg.position.z },
          label: msg.playerId === this.localPlayerId ? "You" : msg.callsign,
          ttl: 5.0,
        });
        this.callbacks.onDangerPing(msg);
        break;
      }

      case "MATCH_ENDED": {
        const localTeam = this.getLocalPlayerSummary()?.team;
        this.audio.playMatchEnd(msg.winnerTeam === "DRAW" || !localTeam ? null : msg.winnerTeam === localTeam);
        this.callbacks.onMatchEnded(msg);
        break;
      }
    }
  }

  private disposeGrenadeVisual(g: ActiveGrenadeVisual): void {
    g.trail.stop();
    g.trail.dispose();
    g.mesh.dispose(false, false); // materials are shared per scene
  }

  private resetRoundEntities(): void {
    this.physWorld.resetDestructibles();
    this.vfx.clearBarrelDamage();
    for (const [id, mesh] of this.blockMeshes.entries()) {
      mesh.setEnabled(true);
      void id;
    }
    for (const prop of this.blockProps.values()) {
      prop.root.setEnabled(true);
    }
    for (const s of this.smokeVisuals) {
      for (const pm of s.meshes) pm.dispose();
      s.mat.dispose();
      s.root.dispose();
    }
    this.smokeVisuals.length = 0;
    for (const grenade of this.grenadeVisuals) this.disposeGrenadeVisual(grenade);
    this.grenadeVisuals.length = 0;
    this.enemyBlips.length = 0;

    this.net.clearSnapshots();
  }

  private rebuildMapScene(): void {
    for (const s of this.smokeVisuals) {
      for (const pm of s.meshes) pm.dispose();
      s.mat.dispose();
      s.root.dispose();
    }
    this.smokeVisuals.length = 0;
    for (const g of this.grenadeVisuals) this.disposeGrenadeVisual(g);
    this.grenadeVisuals.length = 0;
    for (const p of this.pingMarkers) p.mesh.dispose();
    this.pingMarkers.length = 0;
    this.enemyBlips.length = 0;

    destroyCharacterPhysics(this.physWorld, this.playerPhysics);
    this.physWorld.dispose();

    this.scene.clearColor = Color4.FromHexString(`${this.map.skyColorHex}ff`);
    this.scene.fogColor = Color3.FromHexString(this.map.fogColorHex);
    this.scene.fogDensity = this.map.fogDensity;
    this.scene.environmentTexture = this.texGen.createEnvironmentCubeTexture(this.map.theme);

    this.physWorld = new PhysicsWorld(this.map);
    const local = this.getLocalPlayerSummary();
    const sp = local?.team === "B" ? this.map.spawnsB[0] : this.map.spawnsA[0];
    this.playerPhysics = createCharacterPhysics(this.physWorld, sp.position);
    teleportCharacterPhysics(this.playerPhysics, this.playerState, sp.position, sp.yaw);
    this.prevPosition = { ...this.playerState.position };

    if (this.assetsReady) {
      this.buildEnvironment();
    }
  }

  /** Ids of skins in use (by you or anyone in the room) that bring their own 3D model. */
  private modelSkinIds(): string[] {
    const ids = new Set<string>();
    for (const kit of [this.profile.loadout, ...this.room.players.map((p) => p.loadout)]) {
      for (const config of [kit.primary, kit.secondary]) if (SKIN_REGISTRY[config.skinId]?.model) ids.add(config.skinId);
    }
    return [...ids];
  }

  /** Downloads any skin models a newly joined or re-kitted player needs, then rebuilds the affected weapons. */
  private loadMissingSkinModels(): void {
    const missing = this.modelSkinIds().filter((id) => !this.modelCache.has(skinModelKey(id)));
    if (!missing.length) return;
    void this.modelCache.preloadSkinModels(missing).then((loaded) => {
      if (!loaded.length) return;
      this.viewModel.refreshModel();
      for (const soldier of this.remoteSoldiers.values()) soldier.refreshWeaponModel();
    });
  }

  private syncRemotePlayers(): void {
    if (!this.assetsReady) return;
    this.loadMissingSkinModels();
    const localTeam = this.getLocalPlayerSummary()?.team ?? "A";
    const activeIds = new Set<string>();
    for (const p of this.room.players) {
      if (p.id === this.localPlayerId) continue;
      activeIds.add(p.id);
      const kit = p.loadout;
      const isAlly = p.team === localTeam;
      const existing = this.remoteSoldiers.get(p.id);
      if (!existing) {
        const soldier = new RemoteSoldier(
          this.scene,
          p.id,
          p.playerIndex,
          p.team,
          kit,
          this.shadowGen ?? undefined,
          this.modelCache,
          this.texGen
        );
        soldier.setRelation(isAlly);
        this.remoteSoldiers.set(p.id, soldier);
      } else {
        existing.setTeam(p.team);
        existing.setRelation(isAlly);
        existing.setShadowGenerator(this.shadowGen);
        existing.setLoadout(kit);
      }
    }
    for (const [id, soldier] of this.remoteSoldiers.entries()) {
      if (!activeIds.has(id)) {
        soldier.dispose();
        this.remoteSoldiers.delete(id);
      }
    }
  }

  private buildInputCommand(): InputCommand {
    let flags = 0;
    if (this.keys.has("KeyW") || this.keys.has("ArrowUp")) flags |= INPUT_FLAG_FORWARD;
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown")) flags |= INPUT_FLAG_BACK;
    if (this.keys.has("KeyA") || this.keys.has("ArrowLeft")) flags |= INPUT_FLAG_LEFT;
    if (this.keys.has("KeyD") || this.keys.has("ArrowRight")) flags |= INPUT_FLAG_RIGHT;
    if (this.keys.has("ShiftLeft")) flags |= INPUT_FLAG_SPRINT;
    const crouchKey = combatKey(this.profile.settings.combatBindings, "crouch");
    const wantsCrouch = this.profile.settings.toggleCrouch
      ? this.crouchLatched
      : this.keys.has(crouchKey) || (crouchKey === "KeyC" && this.keys.has("ControlLeft"));
    if (this.crouchPressed || wantsCrouch) flags |= INPUT_FLAG_CROUCH;
    if (this.jumpPressed) flags |= INPUT_FLAG_JUMP;
    this.crouchPressed = false;
    this.jumpPressed = false;
    if (this.keys.has("KeyQ")) flags |= INPUT_FLAG_LEAN_LEFT;
    if (this.keys.has("KeyE")) flags |= INPUT_FLAG_LEAN_RIGHT;
    if (this.mouseDownRight) flags |= INPUT_FLAG_ADS;
    if (this.keys.has("ShiftLeft") && this.mouseDownRight) flags |= INPUT_FLAG_HOLD_BREATH;
    if (this.reloadRequested) {
      flags |= INPUT_FLAG_RELOAD;
      this.reloadRequested = false;
      this.reloadInputSequence = this.inputSequence + 1;
    }

    return {
      seq: ++this.inputSequence,
      flags,
      yaw: this.playerState.yaw,
      pitch: this.playerState.pitch,
      dt: FIXED_DT,
      activeSlot: this.activeSlot,
    };
  }

  private applyAuthoritativeState(): void {
    const snap = this.net.latestLocalState;
    if (!snap || snap.serverTick <= this.lastStateTick) return;
    const firstState = this.lastStateTick < 0;
    this.lastStateTick = snap.serverTick;
    const changedEpoch = this.movementEpoch !== snap.movementEpoch;
    const acknowledged = this.predictedMovement.find((entry) => entry.input.seq === snap.inputAck);
    this.movementEpoch = snap.movementEpoch;
    this.inputSequence = Math.max(this.inputSequence, snap.inputAck);
    this.shotSequence = Math.max(this.shotSequence, snap.shotAck);
    if (snap.throwableStock) {
      this.throwableStock = snap.throwableStock;
      if (this.grenadesAvailable() <= 0 && !this.cookingGrenade) {
        this.activeThrowable = THROWABLE_ORDER.find((kind) => this.grenadesAvailable(kind) > 0) ?? this.activeThrowable;
      }
    }
    if (!snap.alive) this.cancelGrenadePreview();

    if (changedEpoch) {
      this.deathCamera.stop();
      this.predictedMovement.length = 0;
      this.pendingShots.length = 0;
      this.predictedTracerSeqs.clear();
      this.reloadRequested = false;
      this.reloadInputSequence = -1;
      this.switchWeaponSlot(snap.activeSlot);
      if (!firstState) this.clearCombatInputs(true);
      this.renderCorrection.x = this.renderCorrection.y = this.renderCorrection.z = 0;
      this.cameraRoll = 0;
      this.pendingRecoilRecoveryPitch = 0;
      this.recoilOffsetPitch = 0;
      this.recoilOffsetYaw = 0;
      this.recoilShotCount = 0;
      if (this.camera.rotationQuaternion) {
        (this.camera as unknown as { rotationQuaternion: null }).rotationQuaternion = null;
      }
      this.camera.rotation.z = 0;
      this.camera.upVector.set(0, 1, 0);
      restoreCharacterPhysics(this.playerPhysics, this.playerState, snap.movement);
      this.prevPosition = { ...this.playerState.position };
      this.prevEyeHeight = this.playerState.eyeHeight;
      this.stepPhase = 0;
      this.crouchLatched = this.profile.settings.toggleCrouch && snap.movement.crouching && !snap.movement.sliding;
      this.airborneSeconds = 0;
      this.landDipOffset = 0;
    } else {
      while (this.predictedMovement.length && this.predictedMovement[0].input.seq <= snap.inputAck) {
        this.predictedMovement.shift();
      }
      if (snap.alive && acknowledged && !statesAgree(acknowledged.result, snap.movement)) {
        const previous = this.playerState.position;
        const { yaw, pitch } = this.playerState;
        restoreCharacterPhysics(this.playerPhysics, this.playerState, snap.movement);
        for (const entry of this.predictedMovement) {
          stepFpsCharacter(this.physWorld, this.playerPhysics, this.playerState,
            entry.input, entry.speed, FIXED_DT, entry.canMove);
          entry.result = structuredClone(this.playerState);
        }
        this.playerState.yaw = yaw;
        this.playerState.pitch = pitch;
        const corrected = this.playerState.position;
        const distance = Math.hypot(previous.x - corrected.x, previous.y - corrected.y, previous.z - corrected.z);
        if (distance > 0.015) {
          this.movementCorrections++;
          this.renderCorrection.x += previous.x - corrected.x;
          this.renderCorrection.y += previous.y - corrected.y;
          this.renderCorrection.z += previous.z - corrected.z;
          const offset = Math.hypot(this.renderCorrection.x, this.renderCorrection.y, this.renderCorrection.z);
          if (offset > 0.45) {
            this.renderCorrection.x *= 0.45 / offset;
            this.renderCorrection.y *= 0.45 / offset;
            this.renderCorrection.z *= 0.45 / offset;
          }
        }
      }
    }

    while (this.pendingShots.length && this.pendingShots[0].seq <= snap.shotAck) this.pendingShots.shift();
    this.ammoInMag = [...snap.ammoInMag];
    this.ammoReserve = [...snap.ammoReserve];
    for (const { slot } of this.pendingShots) this.ammoInMag[slot] = Math.max(0, this.ammoInMag[slot] - 1);
    if (!this.reloadRequested && this.reloadInputSequence <= snap.inputAck) {
      this.reloadTimer = snap.activeSlot === this.activeSlot ? snap.reloadSeconds : 0;
    }
  }

  private fixedTick(dt: number): void {
    if (!this.net.connected) return;
    this.applyAuthoritativeState();
    if (this.movementEpoch === null) return;
    const local = this.getLocalPlayerSummary();
    const isAlive = this.net.latestLocalState?.alive ?? local?.alive ?? true;
    const canMove = this.room.phase !== "COUNTDOWN" && this.room.phase !== "MATCH_END" && isAlive;
    const canShoot = isAlive && isCombatPhase(this.room.phase);

    // Save previous transform for render interpolation
    this.prevPosition.x = this.playerState.position.x;
    this.prevPosition.y = this.playerState.position.y;
    this.prevPosition.z = this.playerState.position.z;
    this.prevEyeHeight = this.playerState.eyeHeight;

    if (!isAlive) return;
    const input = this.buildInputCommand();
    const stats = this.getActiveWeaponStats();
    const verticalSpeed = this.playerState.velocity.y;

    stepFpsCharacter(
      this.physWorld,
      this.playerPhysics,
      this.playerState,
      input,
      stats.moveSpeedMultiplier,
      dt,
      canMove
    );
    if (this.playerState.grounded || this.playerState.vaulting || !canMove) {
      if (canMove && this.playerState.grounded && this.airborneSeconds >= 0.12 && verticalSpeed < -2) {
        this.landDipOffset = -Math.min(0.07, -verticalSpeed * 0.009);
      }
      this.airborneSeconds = 0;
    } else {
      this.airborneSeconds += dt;
    }

    this.predictedMovement.push({
      input, speed: stats.moveSpeedMultiplier, canMove, result: structuredClone(this.playerState),
    });
    if (this.predictedMovement.length > 120) this.predictedMovement.shift();

    this.net.send({
      type: "INPUT",
      seq: input.seq,
      flags: input.flags,
      yaw: input.yaw,
      pitch: input.pitch,
      activeSlot: this.activeSlot,
      clientTimeMs: Date.now(),
      movementEpoch: this.movementEpoch,
    });

    // Reload progression
    if (this.reloadTimer > 0) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) {
        const needed = stats.magSize - this.ammoInMag[this.activeSlot];
        const take = Math.min(needed, this.ammoReserve[this.activeSlot]);
        this.ammoInMag[this.activeSlot] += take;
        this.ammoReserve[this.activeSlot] -= take;
      }
    }

    // Grenade cooking
    if (this.cookingGrenade && this.room.mode === "WARMUP") {
      this.cookElapsedSec += dt;
      const spec = THROWABLE_REGISTRY[this.activeThrowable];
      if (spec.cookable && this.cookElapsedSec >= spec.fuseSec - 0.1) {
        this.releaseThrowGrenade();
      }
    }

    // Firing check (AUTO, 3-Round BURST, SINGLE)
    const modes = stats.blueprint.stats.fireModes;
    const currentFireMode = modes[this.fireModeIndex % modes.length];
    if (currentFireMode === "BURST" && this.justFiredTrigger && this.burstRemaining <= 0) {
      this.burstRemaining = 3;
    }
    const wantsTrigger =
      currentFireMode === "AUTO"
        ? this.mouseDownLeft || this.justFiredTrigger
        : currentFireMode === "BURST"
          ? this.burstRemaining > 0
          : this.justFiredTrigger;
    this.justFiredTrigger = false;

    if (canShoot && wantsTrigger && !this.paused && !this.loadoutOpen && !this.cookingGrenade) {
      if (this.tryFireLocalWeapon(stats) && currentFireMode === "BURST") {
        this.burstRemaining = Math.max(0, this.burstRemaining - 1);
      }
    }

    // Recoil recovery (PUBG/CoD style: camera itself kicks up; gentle recovery only when trigger is released and player didn't pull down)
    this.recoilOffsetPitch = 0;
    this.recoilOffsetYaw = 0;
    if (!this.mouseDownLeft) {
      this.recoilShotCount = Math.max(0, this.recoilShotCount - dt * 12);
      if (performance.now() - this.lastShotAtMs > 90 && this.pendingRecoilRecoveryPitch > 0.0001) {
        const next = damp(this.pendingRecoilRecoveryPitch, 0, stats.recoilRecoverySpeed * 0.55, dt);
        const recoverDelta = this.pendingRecoilRecoveryPitch - next;
        this.playerState.pitch = Math.max(-1.52, this.playerState.pitch - recoverDelta);
        this.pendingRecoilRecoveryPitch = next;
      }
    }

    this.updateHoldBreath(stats, dt);

    // Landing thud after a real fall (not stepping off a curb)
    if (canMove && !this.wasGroundedAudio && this.playerState.grounded && this.fallSpeedAudio < -5) this.audio.playLand();
    this.wasGroundedAudio = this.playerState.grounded;
    this.fallSpeedAudio = this.playerState.velocity.y;

    // Footstep cadence audio
    const distance = Math.hypot(this.playerState.position.x - this.prevPosition.x, this.playerState.position.z - this.prevPosition.z);
    if (canMove && this.playerState.grounded && !this.playerState.sliding && !this.playerState.vaulting && distance > 0.005) {
      const phase = advanceStepPhase(this.stepPhase, distance, distance / dt, this.playerState.crouching);
      if (Math.floor(phase) !== Math.floor(this.stepPhase)) this.audio.playFootstep(this.footstepSurface(this.playerState.position), undefined,
        this.playerState.crouching ? "crouch" : distance / dt > 5.8 ? "sprint" : "walk");
      this.stepPhase = phase;
    }
  }

  private updateHoldBreath(stats: EffectiveWeaponStats, dt: number): void {
    const holdingShift = this.keys.has("ShiftLeft");
    if (!this.mouseDownRight || !holdingShift) this.holdBreathExhausted = false;
    const holdingBreath = this.mouseDownRight && holdingShift &&
      this.adsAlpha >= ADS_READY_THRESHOLD && this.getScopeLevel(stats) === "6X";
    if (holdingBreath && !this.holdBreathExhausted) {
      this.holdBreathRemaining = Math.max(0, this.holdBreathRemaining - dt);
      this.holdBreathExhausted = this.holdBreathRemaining <= 0;
    } else if (!holdingBreath && !this.holdBreathExhausted) {
      this.holdBreathRemaining = Math.min(HOLD_BREATH_SECONDS, this.holdBreathRemaining + dt * 0.8);
    }
    const steady = holdingBreath && !this.holdBreathExhausted;
    this.breathSteady = damp(this.breathSteady, steady ? 1 : 0, 18, dt);
  }

  private getAimAngles(stats: EffectiveWeaponStats, now: number): { yaw: number; pitch: number } {
    let swayYaw = 0;
    let swayPitch = 0;
    if (this.getScopeLevel(stats) === "6X") {
      const amount = 0.004 * this.adsAlpha * (1 - this.breathSteady);
      swayYaw = Math.sin(now * 0.0028) * amount;
      swayPitch = Math.cos(now * 0.0038) * amount;
    }
    return {
      yaw: this.playerState.yaw + this.recoilOffsetYaw + swayYaw,
      pitch: Math.max(-1.55, Math.min(1.55, this.playerState.pitch + this.recoilOffsetPitch + swayPitch)),
    };
  }

  private getAimDirection(stats: EffectiveWeaponStats, now: number): Vec3 {
    const { yaw, pitch } = this.getAimAngles(stats, now);
    return yawPitchToDir({ x: 0, y: 0, z: 1 }, yaw, pitch);
  }

  private getScopeLevel(stats: EffectiveWeaponStats): HudLiveSnapshot["adsScopeLevel"] {
    switch (stats.equippedAttachments.optic) {
      case "optic_red_dot": return "RED_DOT";
      case "optic_2x_acog": return "2X";
      case "optic_6x_sniper": return "6X";
      default: return "NONE";
    }
  }

  private tryFireLocalWeapon(stats: EffectiveWeaponStats): boolean {
    if (performance.now() - this.lastMelee < 350) return false;
    const now = performance.now();
    if (this.reloadTimer > 0 || now < this.nextShotAllowedMs) return false;
    if (this.ammoInMag[this.activeSlot] <= 0) {
      this.burstRemaining = 0;
      this.startReload();
      return false;
    }

    this.ammoInMag[this.activeSlot]--;
    this.nextShotAllowedMs = now + stats.shotIntervalSec * 1000;

    const isAds = this.adsAlpha >= ADS_READY_THRESHOLD;
    const dir = this.getAimDirection(stats, now);
    const eye = getCameraEyePosition(this.playerState);
    const muzzlePos = this.viewModel.getMuzzleWorldPosition();

    const seq = ++this.shotSequence;
    this.viewModel.cancelInspect();
    this.pendingShots.push({ seq, slot: this.activeSlot, muzzle: muzzlePos });
    if (this.pendingShots.length > 120) this.pendingShots.shift();
    this.net.send({
      type: "FIRE_SHOT",
      seq,
      origin: eye,
      dir,
      activeSlot: this.activeSlot,
      ads: isAds,
      adsAlpha: this.adsAlpha,
      crouching: this.playerState.crouching,
      grounded: this.playerState.grounded,
      clientTimeMs: Date.now(),
      movementEpoch: this.movementEpoch ?? undefined,
    });

    if (stats.pellets === 1) {
      const localCast = this.physWorld.castBallisticWorldRay(eye, dir, stats.maxRangeMeters, 0);
      const maxRayDist = Math.min(stats.maxRangeMeters, 90);
      const endPos = localCast.primaryHit?.hitPoint ?? {
        x: eye.x + dir.x * maxRayDist,
        y: eye.y + dir.y * maxRayDist,
        z: eye.z + dir.z * maxRayDist,
      };
      const dist = Math.hypot(endPos.x - eye.x, endPos.y - eye.y, endPos.z - eye.z);
      if (dist > 1.2) {
        this.vfx.spawnMovingTracer(muzzlePos, endPos);
        this.predictedTracerSeqs.add(seq);
        if (this.predictedTracerSeqs.size > 120) {
          const oldest = this.predictedTracerSeqs.values().next().value;
          if (oldest !== undefined) this.predictedTracerSeqs.delete(oldest);
        }
      }
    }

    // Local VFX & audio immediately (0ms latency feel)
    this.viewModel.triggerFire(stats);
    this.audio.playWeaponFire(stats.weaponId, stats.useSuppressedAudio);

    const ejectPos = this.viewModel.getEjectWorldPosition();
    const right = this.camera.getDirection(Vector3.Right());
    const up = this.camera.getDirection(Vector3.Up());
    this.pools.spawnShellCasing(ejectPos, right, up);
    this.cameraShakeIntensity = Math.min(0.035, this.cameraShakeIntensity + stats.recoilVertical * (isAds ? 0.002 : 0.005));

    // Deterministic learnable PUBG/CoD camera recoil kick
    const crouchRecoilMult = this.playerState.crouching ? 0.72 : 1.0;
    const adsRecoilMult = isAds ? 0.85 : 1.0;
    const mult = crouchRecoilMult * adsRecoilMult;
    const pat = stats.blueprint.recoilPattern.patternX;
    const xKick = pat[Math.floor(this.recoilShotCount) % pat.length] ?? 0;
    this.recoilShotCount += 1;
    const pitchKick = stats.recoilVertical * 0.0115 * mult;
    const yawKick = (xKick * 0.0085 + (Math.random() - 0.5) * stats.recoilHorizontal * 0.009) * mult;
    this.playerState.pitch = Math.min(1.52, this.playerState.pitch + pitchKick);
    this.playerState.yaw += yawKick;
    this.pendingRecoilRecoveryPitch = Math.min(0.16, this.pendingRecoilRecoveryPitch + pitchKick);
    this.lastShotAtMs = now;
    return true;
  }

  private footstepSurface(position: Readonly<Vec3>): string {
    return this.physWorld.castBallisticWorldRay({ x: position.x, y: position.y + 0.22, z: position.z },
      { x: 0, y: -1, z: 0 }, 0.72, 0).primaryHit?.material ?? this.map.floorMaterial;
  }

  private updateReplayVictim(dt: number, visible: boolean): void {
    if (!visible) {
      this.replayVictim?.root.setEnabled(false);
      return;
    }
    const local = this.getLocalPlayerSummary();
    if (!local) return;
    if (!this.replayVictim) {
      this.replayVictim = new RemoteSoldier(this.scene, "replay_victim", -1, local.team, local.loadout,
        undefined, this.modelCache, this.texGen);
      this.replayVictim.setRelation(true);
    }
    const { x, y, z } = this.deathCamera.victim;
    const yaw = Math.atan2(this.camera.position.x - x, this.camera.position.z - z);
    const alive = !this.deathCamera.reachedElimination;
    this.replayVictim.applySnapshot({ x, y, z, yaw, pitch: 0, lean: 0, crouching: false, sliding: false, vaulting: false,
      alive, ads: false, activeSlot: 0, grounded: true, hp: alive ? 100 : 0, armor: 0, vx: 0, vz: 0 }, dt);
  }

  private setCameraEuler(pitch: number, yaw: number, roll: number): void {
    if (this.camera.rotationQuaternion) {
      (this.camera as unknown as { rotationQuaternion: null }).rotationQuaternion = null;
    }
    this.camera.rotation.set(-pitch, yaw, roll);
  }

  private renderTick(alpha: number, rawDt: number): void {
    const dt = rawDt;
    this.slowMoTimer = Math.max(0, this.slowMoTimer - dt);
    const effectsDt = this.slowMoTimer > 0 ? dt * 0.25 : dt;
    this.renderCorrection.x = damp(this.renderCorrection.x, 0, 17, dt);
    this.renderCorrection.y = damp(this.renderCorrection.y, 0, 17, dt);
    this.renderCorrection.z = damp(this.renderCorrection.z, 0, 17, dt);

    const local = this.getLocalPlayerSummary();
    const authoritative = this.net.latestLocalState;
    const isAlive = authoritative?.alive ?? local?.alive ?? true;
    if (this.audioWasAlive && !isAlive) this.audio.playDeath();
    else if (!this.audioWasAlive && isAlive && this.room.phase === "LIVE") this.audio.playRespawn();
    this.audioWasAlive = isAlive;
    const lowHp = authoritative?.hp ?? local?.hp ?? 100;
    if (isAlive && lowHp > 0 && lowHp <= 30 && isCombatPhase(this.room.phase) && performance.now() >= this.nextHeartbeatAtMs) {
      this.audio.playHeartbeat();
      this.nextHeartbeatAtMs = performance.now() + (lowHp <= 15 ? 750 : 1100);
    }
    const stats = this.getActiveWeaponStats();
    const scopeLevel = this.getScopeLevel(stats);

    const speedXZ = Math.hypot(this.playerState.velocity.x, this.playerState.velocity.z);
    const isSprinting =
      this.keys.has("ShiftLeft") &&
      !this.mouseDownRight &&
      !this.playerState.crouching &&
      !this.playerState.sliding &&
      speedXZ > 5.4 &&
      isAlive;

    // Update ADS + Sprint FOV interpolation & camera transform
    const targetAds = this.mouseDownRight && isAlive && this.reloadTimer <= 0 && !this.cookingGrenade ? 1 : 0;
    this.adsAlpha = damp(this.adsAlpha, targetAds, (1 / Math.max(0.06, stats.adsTimeSec)) * 3, dt);
    this.sprintFovKick = damp(this.sprintFovKick, isSprinting ? (5 * Math.PI) / 180 : 0, 10, dt);
    this.landDipOffset = damp(this.landDipOffset, 0, 14, dt);
    this.cameraShakeIntensity = damp(this.cameraShakeIntensity, 0, 14, dt);

    const baseFovRad = (this.profile.settings.fov * Math.PI) / 180 + this.sprintFovKick;
    const adsFovRad = (stats.adsFov * Math.PI) / 180;
    this.camera.fov = lerp(baseFovRad, adsFovRad, this.adsAlpha);

    const lookAngles = this.getAimAngles(stats, performance.now());
    const inAds = isAlive && this.adsAlpha >= ADS_READY_THRESHOLD;
    const scoped = isAlive && this.adsAlpha >= 0.50 && (scopeLevel === "2X" || scopeLevel === "6X");

    const playingReplay = !isAlive && this.deathCamera.tick(dt, this.camera);
    this.updateReplayVictim(dt, playingReplay);
    let spectatingName: string | null = null;
    if (isAlive) {
      this.viewModel.setVisible(!scoped);
      const interpPos: Vec3 = {
        x: lerp(this.prevPosition.x, this.playerState.position.x, alpha) + this.renderCorrection.x,
        y: lerp(this.prevPosition.y, this.playerState.position.y, alpha) + this.renderCorrection.y,
        z: lerp(this.prevPosition.z, this.playerState.position.z, alpha) + this.renderCorrection.z,
      };
      const rightX = Math.cos(this.playerState.yaw);
      const rightZ = -Math.sin(this.playerState.yaw);
      const leanShift = this.playerState.lean * 0.38;
      const eyeH = lerp(this.prevEyeHeight, this.playerState.eyeHeight, alpha);

      const shakeX = this.cameraShakeIntensity > 0.0005 ? (Math.random() - 0.5) * this.cameraShakeIntensity : 0;
      const shakeY = this.cameraShakeIntensity > 0.0005 ? (Math.random() - 0.5) * this.cameraShakeIntensity : 0;

      this.camera.position.set(
        interpPos.x + rightX * leanShift + shakeX,
        interpPos.y + eyeH - Math.abs(this.playerState.lean) * 0.04 + this.landDipOffset + shakeY,
        interpPos.z + rightZ * leanShift
      );

      this.cameraRoll = damp(
        this.cameraRoll,
        (-this.playerState.lean * LEAN_ROLL_DEG * Math.PI) / 180 + (this.playerState.sliding ? -0.09 : 0),
        16,
        dt
      );
      this.setCameraEuler(lookAngles.pitch, lookAngles.yaw, this.cameraRoll);
    } else if (playingReplay) {
      this.cameraRoll = 0;
      this.viewModel.setVisible(false);
    } else {
      // Teammate 1st-person spectator camera
      this.cameraRoll = 0;
      this.viewModel.setVisible(false);
      const aliveMates = this.room.players.filter(
        (p) => p.team === local?.team && p.alive && p.id !== this.localPlayerId
      );
      const candidates = aliveMates;
      if (candidates.length > 0) {
        const specTarget = candidates[this.spectatorIndex % candidates.length];
        spectatingName = specTarget.callsign;
        const snap = this.net.getInterpolatedPlayerState(specTarget.playerIndex);
        if (snap) {
          const eyeHeight = snap.sliding ? 0.92 : snap.crouching ? 1.1 : 1.58;
          this.camera.position.set(snap.x, snap.y + eyeHeight, snap.z);
          this.setCameraEuler(Math.max(-1.52, Math.min(1.52, snap.pitch)), snap.yaw, 0);
        } else {
          this.setCameraEuler(-this.camera.rotation.x, this.camera.rotation.y, 0);
        }
      } else if (authoritative) {
        const { x, y, z } = authoritative.movement.position;
        this.camera.position.set(x, y + 1.8, z);
        this.setCameraEuler(-0.22, lookAngles.yaw, 0);
      } else {
        this.setCameraEuler(-this.camera.rotation.x, this.camera.rotation.y, 0);
      }
    }

    // Update ViewModel & Live Grenade Trajectory Arc
    this.viewModel.update({
      dt,
      ads: targetAds === 1,
      adsAlpha: this.adsAlpha,
      speedXZ,
      strideAngle: this.stepPhase * Math.PI,
      sprinting: isSprinting,
      grounded: this.playerState.grounded,
      sliding: this.playerState.sliding,
      reloading: this.reloadTimer > 0,
      reloadProgress: this.reloadTimer > 0 ? Math.max(0, 1 - this.reloadTimer /
        (this.ammoInMag[this.activeSlot] === 0 ? stats.reloadEmptySec : stats.reloadTacticalSec)) : 0,
      cookingGrenade: this.cookingGrenade,
      grenadeType: this.activeThrowable,
      cookFraction: Math.min(1, this.cookElapsedSec / THROWABLE_REGISTRY[this.activeThrowable].fuseSec),
    });

    this.updateGrenadePreview(this.cookingGrenade && isAlive);

    // Update Remote Soldiers from 100ms interpolation buffer
    for (const soldier of this.remoteSoldiers.values()) {
      if (playingReplay) {
        soldier.root.setEnabled(false);
        continue;
      }
      const snap = this.net.getInterpolatedPlayerState(soldier.playerIndex);
      if (snap) {
        if (soldier.applySnapshot(snap, dt) && Vector3.DistanceSquared(soldier.root.position, this.camera.position) < 45 ** 2) {
          this.audio.playFootstep(this.footstepSurface(soldier.root.position), soldier.root.position,
            soldier.lastStepCrouching ? "crouch" : soldier.lastStepSpeed > 5.8 ? "sprint" : "walk");
        }
      }
    }

    // Update Particle VFX, Shell Casings & Audio Listener
    this.vfx.update(effectsDt);
    this.pools.update(effectsDt, (pos) => this.audio.playShellClink(pos));
    const camFwd = this.camera.getDirection(Vector3.Forward());
    const camUp = this.camera.getDirection(Vector3.Up());
    this.audio.updateListener(this.camera.position, camFwd, camUp);

    // Update Grenades, Volumetric Smokes, Pings, Blips & Warm-up Targets
    for (let i = this.grenadeVisuals.length - 1; i >= 0; i--) {
      const g = this.grenadeVisuals[i];
      g.elapsed += dt;
      let landed = false;
      while (g.elapsed >= FIXED_DT) {
        if (this.physWorld.stepThrowable(g.mesh.position, g.vel, g.restitution, FIXED_DT)) landed = true;
        g.elapsed -= FIXED_DT;
      }
      // Tumble in flight; settle once it has almost stopped.
      const speed = g.vel.length();
      const spinK = Math.min(1, speed / 6);
      g.mesh.rotation.x += g.spin.x * dt * spinK;
      g.mesh.rotation.y += g.spin.y * dt * spinK;
      g.mesh.rotation.z += g.spin.z * dt * spinK;
      g.trail.emitRate = landed || speed < 1 ? 0 : 55;
      g.ttl -= dt;
      if (g.ttl <= 0) {
        this.disposeGrenadeVisual(g);
        this.grenadeVisuals.splice(i, 1);
      }
    }
    for (let i = this.smokeVisuals.length - 1; i >= 0; i--) {
      const s = this.smokeVisuals[i];
      s.ttl -= dt;
      const elapsed = s.maxTtl - s.ttl;
      const grow = Math.min(1, 0.15 + (elapsed / 0.6) * 0.85);
      s.root.scaling.setAll(grow);
      if (s.ttl < 1.5) s.mat.alpha = Math.max(0, (s.ttl / 1.5) * 0.84);
      if (s.ttl <= 0) {
        for (const pm of s.meshes) pm.dispose();
        s.mat.dispose();
        s.root.dispose();
        this.smokeVisuals.splice(i, 1);
      }
    }
    for (let i = this.pingMarkers.length - 1; i >= 0; i--) {
      const p = this.pingMarkers[i];
      p.ttl -= dt;
      p.mesh.rotation.y += dt * 3;
      if (p.ttl <= 0) {
        p.mesh.dispose();
        this.pingMarkers.splice(i, 1);
      }
    }
    for (let i = this.enemyBlips.length - 1; i >= 0; i--) {
      this.enemyBlips[i].ttl -= dt;
      if (this.enemyBlips[i].ttl <= 0) this.enemyBlips.splice(i, 1);
    }
    for (const wt of this.warmupTargetMeshes) {
      if (wt.flashTimer > 0) {
        wt.flashTimer -= dt;
        if (wt.flashTimer <= 0) {
          wt.mat.emissiveColor = Color3.FromHexString("#0284c7");
        }
      }
    }

    if (this.flashHoldSec > 0) this.flashHoldSec = Math.max(0, this.flashHoldSec - dt);
    else this.flashAlpha = Math.max(0, this.flashAlpha - dt * this.flashFadePerSec);
    this.damageVignetteAlpha = Math.max(0, this.damageVignetteAlpha - dt * 1.6);

    // The game drives its own requestAnimationFrame loop, so Babylon never sees a frame boundary on its own.
    // Without begin/endFrame the engine delta-time stays stale and every ParticleSystem (explosions, smoke,
    // sparks, barrel fire) ages almost not at all, which is why blasts looked dead.
    this.app.engine.beginFrame();
    this.scene.render();
    this.app.engine.endFrame();

    // Project 3D Teammate Nameplates & Danger Pings into screen coordinates + Minimap blips
    const minimapTeammates: { x: number; z: number }[] = [];
    const screenMarkers: HudLiveSnapshot["screenMarkers"] = [];
    const localTeam = local?.team;
    const cw = this.app.canvas.clientWidth || 1280;
    const ch = this.app.canvas.clientHeight || 720;
    const vp = this.camera.viewport.toGlobal(cw, ch);
    const transform = this.scene.getTransformMatrix();

    for (const soldier of this.remoteSoldiers.values()) {
      const rp = this.room.players.find((p) => p.id === soldier.playerId);
      if (!rp || !rp.alive || rp.team !== localTeam || !soldier.root.isEnabled()) continue;
      minimapTeammates.push({ x: soldier.root.position.x, z: soldier.root.position.z });
      const headPos = soldier.getHeadWorldPos();
      const proj = Vector3.Project(headPos, Matrix.Identity(), transform, vp);
      if (proj.z >= 0 && proj.z <= 1 && proj.x >= 0 && proj.x <= cw && proj.y >= 0 && proj.y <= ch) {
        screenMarkers.push({
          kind: "TEAMMATE",
          x: Math.round(proj.x),
          y: Math.round(proj.y),
          label: rp.callsign,
          hp: rp.hp,
        });
      }
    }

    for (const pm of this.pingMarkers) {
      const pVec = new Vector3(pm.worldPos.x, pm.worldPos.y, pm.worldPos.z);
      const proj = Vector3.Project(pVec, Matrix.Identity(), transform, vp);
      if (proj.z >= 0 && proj.z <= 1 && proj.x >= 0 && proj.x <= cw && proj.y >= 0 && proj.y <= ch) {
        const distanceM = Math.round(
          Math.hypot(
            pm.worldPos.x - this.playerState.position.x,
            pm.worldPos.z - this.playerState.position.z
          )
        );
        screenMarkers.push({
          kind: "PING",
          x: Math.round(proj.x),
          y: Math.round(proj.y),
          label: pm.label,
          distanceM,
        });
      }
    }

    // Emit HUD state
    const modes = stats.blueprint.stats.fireModes;
    const currentFireMode = modes[this.fireModeIndex % modes.length];

    const cookMax = THROWABLE_REGISTRY[this.activeThrowable].fuseSec;
    this.callbacks.onHudUpdate({
      replayName: playingReplay ? this.deathCamera.name : null,
      hp: Math.ceil(authoritative?.hp ?? local?.hp ?? 100),
      armor: authoritative?.armor ?? local?.armor ?? 50,
      weaponName: stats.name,
      skinName: this.getActiveWeaponConfig().skinId,
      opticName: this.getActiveWeaponConfig().attachments.optic ?? "",
      ammoInMag: this.ammoInMag[this.activeSlot],
      magSize: stats.magSize,
      ammoReserve: this.ammoReserve[this.activeSlot],
      reloading: this.reloadTimer > 0,
      ads: inAds || scoped,
      adsScopeLevel: scopeLevel,
      holdBreathPct: Math.ceil((this.holdBreathRemaining / HOLD_BREATH_SECONDS) * 100),
      spreadBloom: shotSpreadMultiplier({ grounded: this.playerState.grounded, crouching: this.playerState.crouching, speed: speedXZ }),
      lean: this.playerState.lean,
      crouching: this.playerState.crouching,
      sliding: this.playerState.sliding,
      throwable: this.activeThrowable,
      throwablesLeft: this.grenadesAvailable(),
      throwableStock: this.room.mode !== "WARMUP" ? this.throwableStock : null,
      grenadePreviewing: this.cookingGrenade,
      cookingFusePct: this.cookingGrenade ? Math.min(100, Math.round((this.cookElapsedSec / cookMax) * 100)) : 0,
      healingDelaySeconds: isAlive && authoritative && authoritative.hp < 100
        ? authoritative.healingDelaySeconds ?? null : null,
      spawnProtectionSeconds: authoritative?.spawnProtectionSeconds ?? 0,
      fps: this.loop.currentFps,
      pingMs: this.net.currentPingMs,
      snapshotAgeMs: this.net.snapshotAgeMs,
      movementCorrections: this.movementCorrections,
      respawnSeconds: !isAlive && authoritative && (this.room.phase === "WARMUP" || this.room.phase === "LIVE") ? authoritative.respawnSeconds : null,
      alive: isAlive,
      spectatingName,
      activeSlot: this.activeSlot,
      pointerLocked: document.pointerLockElement === this.app.canvas,
      flashAlpha: this.flashAlpha,
      damageVignetteAlpha: this.damageVignetteAlpha,
      fireMode: currentFireMode,
      playerPos: { ...this.playerState.position },
      playerYaw: this.playerState.yaw,
      minimapTeammates,
      minimapEnemyBlips: this.enemyBlips.map((b) => ({ x: b.x, z: b.z })),
      minimapPings: this.pingMarkers.map((p) => ({ x: p.worldPos.x, z: p.worldPos.z })),
      screenMarkers,
    });
  }

  dispose(): void {
    this.audio.setOcclusionTest(null);
    this.replayVictim?.dispose();
    this.pickupView.dispose();
    this.loop.stop();
    window.removeEventListener("keydown", this.keyDownHandler);
    window.removeEventListener("keyup", this.keyUpHandler);
    this.app.canvas.removeEventListener("mousedown", this.mouseDownHandler);
    window.removeEventListener("mouseup", this.mouseUpHandler);
    window.removeEventListener("mousemove", this.mouseMoveHandler);
    window.removeEventListener("blur", this.lostFocusHandler);
    document.removeEventListener("visibilitychange", this.lostFocusHandler);
    document.removeEventListener("pointerlockchange", this.pointerLockHandler);
    this.app.canvas.removeEventListener("contextmenu", this.contextMenuHandler);
    this.app.canvas.removeEventListener("wheel", this.wheelHandler);

    if (document.pointerLockElement === this.app.canvas) {
      document.exitPointerLock();
    }

    for (const s of this.remoteSoldiers.values()) s.dispose();
    this.remoteSoldiers.clear();
    this.disposeSpawnBanners();
    for (const prop of this.blockProps.values()) prop.dispose();
    this.blockProps.clear();
    for (const sm of this.storytellingMeshes) {
      sm.material?.dispose(false, false);
      sm.dispose();
    }
    for (const texture of this.landmarkTextures) texture.dispose();
    for (const s of this.smokeVisuals) {
      for (const pm of s.meshes) pm.dispose();
      s.mat.dispose();
      s.root.dispose();
    }
    for (const g of this.grenadeVisuals) this.disposeGrenadeVisual(g);
    for (const p of this.pingMarkers) p.mesh.dispose();
    this.viewModel.dispose();
    this.pools.dispose();
    this.vfx.dispose();
    this.modelCache.dispose();
    this.shadowGen?.dispose();
    this.ssao?.dispose(true);
    this.pipeline?.dispose();
    this.skyMesh?.dispose();
    this.texGen.dispose();
    this.physWorld.dispose();
    this.scene.dispose();
  }
}
