import {
  Color3,
  Color4,
  DynamicTexture,
  Mesh,
  MeshBuilder,
  ParticleSystem,
  PointLight,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import { clamp } from "@game/shared";

export interface DriftVfxCarRigLike {
  exhaustTips: readonly TransformNode[];
  rearTireNodes: readonly TransformNode[];
}

export interface DriftVfxUpdateParams {
  carId: string;
  carPos: Vector3;
  carForward: Vector3;
  carUp: Vector3;
  velocity: Vector3;
  speedKmh: number;
  driftSlip: number;          // 0..1 normalized drift slip intensity
  drifting: boolean;
  launchWheelspin: boolean;
  hardBraking: boolean;
  nitroActive: boolean;
  onGravel: boolean;
  wallScrapeIntensity: number; // 0..1
  wallScrapeSide: number;      // -1 left, +1 right, 0 unknown
  slipstreamActive: boolean;
  rig: DriftVfxCarRigLike;
  isPlayer: boolean;
  dt: number;
}

interface SkidTrackState {
  prevLeft: Vector3;
  prevRight: Vector3;
  hasLeft: boolean;
  hasRight: boolean;
}

interface ExhaustFlameRig {
  pivot: TransformNode;
  outerCone: Mesh;
  innerCone: Mesh;
  backfireCone: Mesh;
}

const MAX_SKID_MARKS = 500;
const SKID_MIN_SEG_LEN = 0.22;
const SKID_MAX_SEG_LEN = 4.2;
const SKID_SURFACE_LIFT = 0.035;

function createSoftPuffTexture(scene: Scene, name: string): DynamicTexture {
  const tex = new DynamicTexture(name, 128, scene, false);
  const ctx = tex.getContext();
  const grad = ctx.createRadialGradient(64, 64, 4, 64, 64, 60);
  grad.addColorStop(0, "rgba(255,255,255,0.95)");
  grad.addColorStop(0.35, "rgba(245,248,255,0.62)");
  grad.addColorStop(0.72, "rgba(220,228,240,0.22)");
  grad.addColorStop(1, "rgba(200,210,225,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  tex.update();
  tex.hasAlpha = true;
  return tex;
}

function createSparkTexture(scene: Scene, name: string): DynamicTexture {
  const tex = new DynamicTexture(name, 64, scene, false);
  const ctx = tex.getContext();
  const grad = ctx.createRadialGradient(32, 32, 1, 32, 32, 28);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.28, "rgba(255,230,145,0.95)");
  grad.addColorStop(0.65, "rgba(255,130,30,0.55)");
  grad.addColorStop(1, "rgba(255,80,0,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  tex.update();
  tex.hasAlpha = true;
  return tex;
}

function createSkidMarkTexture(scene: Scene, name: string): DynamicTexture {
  const tex = new DynamicTexture(name, 64, scene, false);
  const ctx = tex.getContext();
  ctx.clearRect(0, 0, 64, 64);

  // Realistic dual-channel performance tire rubber tread print
  const grad = ctx.createLinearGradient(0, 0, 64, 0);
  grad.addColorStop(0, "rgba(8,9,12,0)");
  grad.addColorStop(0.14, "rgba(8,9,12,0.72)");
  grad.addColorStop(0.36, "rgba(12,13,16,0.78)");
  grad.addColorStop(0.45, "rgba(12,13,16,0.28)");
  grad.addColorStop(0.55, "rgba(12,13,16,0.28)");
  grad.addColorStop(0.64, "rgba(12,13,16,0.78)");
  grad.addColorStop(0.86, "rgba(8,9,12,0.72)");
  grad.addColorStop(1, "rgba(8,9,12,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);

  // Subtle vertical tread texture
  ctx.fillStyle = "rgba(4,5,7,0.22)";
  for (let y = 0; y < 64; y += 8) {
    ctx.fillRect(8, y, 48, 3);
  }

  tex.update();
  tex.hasAlpha = true;
  return tex;
}

/**
 * High-performance automotive VFX system:
 * - Persistent 500-quad ThinInstance road skid marks (1 draw call!)
 * - Rear-tire drift smoke & gravel dust ParticleSystems
 * - 3D Nitro plasma exhaust cones + plasma ember trail + orange shift backfire flashes
 * - Guardrail scrape sparks & collision spark bursts
 * - Slipstream wind streaks at high velocity
 */
export class DriftVfxSystem {
  private readonly softSmokeTex: DynamicTexture;
  private readonly sparkTex: DynamicTexture;
  private readonly skidTex: DynamicTexture;

  // Persistent Skid Mark ThinInstance ring buffer
  private readonly skidMesh: Mesh;
  private readonly skidMat: StandardMaterial;
  private readonly skidBuffer: Float32Array;
  private skidWriteIdx = 0;
  private skidDirty = false;
  private readonly skidStates = new Map<string, SkidTrackState>();

  // Tire Smoke & Gravel Dust ParticleSystems
  private readonly leftSmokePs: ParticleSystem;
  private readonly rightSmokePs: ParticleSystem;
  private readonly leftSmokeEmitter = new Vector3();
  private readonly rightSmokeEmitter = new Vector3();

  private readonly gravelDustPs: ParticleSystem;
  private readonly gravelEmitter = new Vector3();

  private readonly rivalSmokePs: ParticleSystem;
  private readonly rivalSmokeEmitter = new Vector3();

  // Nitro plasma trail & Backfire burst
  private readonly nitroTrailPs: ParticleSystem;
  private readonly nitroEmitter = new Vector3();
  private readonly backfirePs: ParticleSystem;
  private readonly backfireEmitter = new Vector3();

  // Guardrail Scrape & Collision Sparks
  private readonly scrapeSparksPs: ParticleSystem;
  private readonly scrapeEmitter = new Vector3();
  private readonly collisionSparksPs: ParticleSystem;
  private readonly collisionEmitter = new Vector3();

  // Slipstream speed streaks
  private readonly slipstreamPs: ParticleSystem;
  private readonly slipstreamEmitter = new Vector3();

  // 3D Exhaust Flame Cones (pool of up to 4 tips)
  private readonly nitroOuterMat: StandardMaterial;
  private readonly nitroInnerMat: StandardMaterial;
  private readonly backfireMat: StandardMaterial;
  private readonly exhaustFlames: ExhaustFlameRig[] = [];

  // Reusable dynamic tail-glow light (avoids shader recompilation)
  private readonly exhaustLight: PointLight;
  private backfireTimer = 0;
  private backfireDuration = 0.14;
  private flameClock = 0;

  // Scratch vectors (zero per-frame allocations)
  private readonly _right = new Vector3();
  private readonly _leftTire = new Vector3();
  private readonly _rightTire = new Vector3();
  private readonly _segDir = new Vector3();
  private readonly _segRight = new Vector3();
  private readonly _segMid = new Vector3();
  private readonly _tipPos = new Vector3();
  private readonly _lookBehind = new Vector3();

  constructor(private readonly scene: Scene) {
    this.softSmokeTex = createSoftPuffTexture(scene, "race_vfx_smoke_tex");
    this.sparkTex = createSparkTexture(scene, "race_vfx_spark_tex");
    this.skidTex = createSkidMarkTexture(scene, "race_vfx_skid_tex");

    // 1. Skid Marks Master Mesh + 500 ThinInstance Ring Buffer
    this.skidMesh = MeshBuilder.CreateGround("race_skid_marks_master", { width: 1, height: 1 }, scene);
    this.skidMesh.isPickable = false;
    this.skidMesh.alwaysSelectAsActiveMesh = true;
    this.skidMesh.receiveShadows = false;

    this.skidMat = new StandardMaterial("race_skid_marks_mat", scene);
    this.skidMat.diffuseTexture = this.skidTex;
    this.skidMat.useAlphaFromDiffuseTexture = true;
    this.skidMat.disableLighting = true;
    this.skidMat.backFaceCulling = false;
    this.skidMat.zOffset = -2.5;
    this.skidMesh.material = this.skidMat;

    this.skidBuffer = new Float32Array(MAX_SKID_MARKS * 16);
    this.zeroAllSkidMatrices();
    this.skidMesh.thinInstanceSetBuffer("matrix", this.skidBuffer, 16, false);

    // 2. Player Rear-Tire Drift Smoke (Left & Right)
    this.leftSmokePs = this.createSmokeSystem("race_smoke_left", this.leftSmokeEmitter, 160);
    this.rightSmokePs = this.createSmokeSystem("race_smoke_right", this.rightSmokeEmitter, 160);
    this.rivalSmokePs = this.createSmokeSystem("race_smoke_rival", this.rivalSmokeEmitter, 120);

    // 3. Gravel Shoulder Dust
    this.gravelDustPs = new ParticleSystem("race_gravel_dust", 110, scene);
    this.gravelDustPs.particleTexture = this.softSmokeTex;
    this.gravelDustPs.emitter = this.gravelEmitter;
    this.gravelDustPs.minEmitBox = new Vector3(-0.75, 0.05, -0.3);
    this.gravelDustPs.maxEmitBox = new Vector3(0.75, 0.2, 0.3);
    this.gravelDustPs.color1 = new Color4(0.72, 0.61, 0.45, 0.55);
    this.gravelDustPs.color2 = new Color4(0.58, 0.48, 0.36, 0.42);
    this.gravelDustPs.colorDead = new Color4(0.5, 0.44, 0.34, 0.0);
    this.gravelDustPs.minSize = 0.35;
    this.gravelDustPs.maxSize = 1.15;
    this.gravelDustPs.minLifeTime = 0.35;
    this.gravelDustPs.maxLifeTime = 0.85;
    this.gravelDustPs.direction1 = new Vector3(-1.2, 1.2, -1.2);
    this.gravelDustPs.direction2 = new Vector3(1.2, 2.8, 1.2);
    this.gravelDustPs.gravity = new Vector3(0, -1.5, 0);
    this.gravelDustPs.emitRate = 0;
    this.gravelDustPs.start();

    // 4. Nitro Exhaust Plasma Particles
    this.nitroTrailPs = new ParticleSystem("race_nitro_trail", 140, scene);
    this.nitroTrailPs.particleTexture = this.sparkTex;
    this.nitroTrailPs.emitter = this.nitroEmitter;
    this.nitroTrailPs.minEmitBox = new Vector3(-0.35, -0.06, -0.1);
    this.nitroTrailPs.maxEmitBox = new Vector3(0.35, 0.06, 0.1);
    this.nitroTrailPs.color1 = new Color4(0.35, 0.94, 1.0, 1.0);
    this.nitroTrailPs.color2 = new Color4(0.06, 0.55, 1.0, 0.92);
    this.nitroTrailPs.colorDead = new Color4(0.02, 0.18, 0.65, 0.0);
    this.nitroTrailPs.minSize = 0.14;
    this.nitroTrailPs.maxSize = 0.38;
    this.nitroTrailPs.minLifeTime = 0.07;
    this.nitroTrailPs.maxLifeTime = 0.18;
    this.nitroTrailPs.blendMode = ParticleSystem.BLENDMODE_ONEONE;
    this.nitroTrailPs.emitRate = 0;
    this.nitroTrailPs.start();

    // 5. Orange Shift Backfire Burst Particles
    this.backfirePs = new ParticleSystem("race_backfire_burst", 64, scene);
    this.backfirePs.particleTexture = this.sparkTex;
    this.backfirePs.emitter = this.backfireEmitter;
    this.backfirePs.minEmitBox = new Vector3(-0.3, -0.06, -0.06);
    this.backfirePs.maxEmitBox = new Vector3(0.3, 0.06, 0.06);
    this.backfirePs.color1 = new Color4(1.0, 0.92, 0.55, 1.0);
    this.backfirePs.color2 = new Color4(1.0, 0.42, 0.05, 0.95);
    this.backfirePs.colorDead = new Color4(0.45, 0.08, 0.0, 0.0);
    this.backfirePs.minSize = 0.16;
    this.backfirePs.maxSize = 0.44;
    this.backfirePs.minLifeTime = 0.06;
    this.backfirePs.maxLifeTime = 0.17;
    this.backfirePs.blendMode = ParticleSystem.BLENDMODE_ONEONE;
    this.backfirePs.emitRate = 0;
    this.backfirePs.manualEmitCount = 0;
    this.backfirePs.start();

    // 6. Guardrail Scrape Sparks
    this.scrapeSparksPs = new ParticleSystem("race_scrape_sparks", 200, scene);
    this.scrapeSparksPs.particleTexture = this.sparkTex;
    this.scrapeSparksPs.emitter = this.scrapeEmitter;
    this.scrapeSparksPs.minEmitBox = new Vector3(-0.12, -0.12, -0.55);
    this.scrapeSparksPs.maxEmitBox = new Vector3(0.12, 0.18, 0.55);
    this.scrapeSparksPs.color1 = new Color4(1.0, 0.96, 0.72, 1.0);
    this.scrapeSparksPs.color2 = new Color4(1.0, 0.54, 0.12, 1.0);
    this.scrapeSparksPs.colorDead = new Color4(0.8, 0.2, 0.02, 0.0);
    this.scrapeSparksPs.minSize = 0.06;
    this.scrapeSparksPs.maxSize = 0.17;
    this.scrapeSparksPs.minLifeTime = 0.14;
    this.scrapeSparksPs.maxLifeTime = 0.42;
    this.scrapeSparksPs.gravity = new Vector3(0, -14.5, 0);
    this.scrapeSparksPs.blendMode = ParticleSystem.BLENDMODE_ONEONE;
    this.scrapeSparksPs.emitRate = 0;
    this.scrapeSparksPs.start();

    // 7. Collision Sparks (one-shot bursts)
    this.collisionSparksPs = new ParticleSystem("race_collision_sparks", 120, scene);
    this.collisionSparksPs.particleTexture = this.sparkTex;
    this.collisionSparksPs.emitter = this.collisionEmitter;
    this.collisionSparksPs.minEmitBox = new Vector3(-0.25, -0.1, -0.25);
    this.collisionSparksPs.maxEmitBox = new Vector3(0.25, 0.25, 0.25);
    this.collisionSparksPs.color1 = new Color4(1.0, 0.95, 0.65, 1.0);
    this.collisionSparksPs.color2 = new Color4(1.0, 0.48, 0.08, 1.0);
    this.collisionSparksPs.colorDead = new Color4(0.6, 0.15, 0.0, 0.0);
    this.collisionSparksPs.minSize = 0.07;
    this.collisionSparksPs.maxSize = 0.19;
    this.collisionSparksPs.minLifeTime = 0.18;
    this.collisionSparksPs.maxLifeTime = 0.5;
    this.collisionSparksPs.direction1 = new Vector3(-6, 1.5, -6);
    this.collisionSparksPs.direction2 = new Vector3(6, 7.5, 6);
    this.collisionSparksPs.gravity = new Vector3(0, -15, 0);
    this.collisionSparksPs.blendMode = ParticleSystem.BLENDMODE_ONEONE;
    this.collisionSparksPs.emitRate = 0;
    this.collisionSparksPs.manualEmitCount = 0;
    this.collisionSparksPs.start();

    // 8. Slipstream Drafting Wind Streaks
    this.slipstreamPs = new ParticleSystem("race_slipstream_wind", 80, scene);
    this.slipstreamPs.particleTexture = this.softSmokeTex;
    this.slipstreamPs.emitter = this.slipstreamEmitter;
    this.slipstreamPs.minEmitBox = new Vector3(-1.35, 0.35, -0.5);
    this.slipstreamPs.maxEmitBox = new Vector3(1.35, 1.45, 0.5);
    this.slipstreamPs.color1 = new Color4(0.75, 0.94, 1.0, 0.32);
    this.slipstreamPs.color2 = new Color4(0.5, 0.85, 1.0, 0.22);
    this.slipstreamPs.colorDead = new Color4(0.4, 0.8, 1.0, 0.0);
    this.slipstreamPs.minSize = 0.08;
    this.slipstreamPs.maxSize = 0.2;
    this.slipstreamPs.minLifeTime = 0.14;
    this.slipstreamPs.maxLifeTime = 0.28;
    this.slipstreamPs.blendMode = ParticleSystem.BLENDMODE_ONEONE;
    this.slipstreamPs.emitRate = 0;
    this.slipstreamPs.start();

    // 9. 3D Additive Exhaust Flame Cones (up to 4 tips)
    this.nitroOuterMat = new StandardMaterial("race_nitro_outer_mat", scene);
    this.nitroOuterMat.emissiveColor = Color3.FromHexString("#00d4ff");
    this.nitroOuterMat.disableLighting = true;
    this.nitroOuterMat.alpha = 0.72;
    this.nitroOuterMat.alphaMode = 1; // ALPHA_ADD
    this.nitroOuterMat.backFaceCulling = false;

    this.nitroInnerMat = new StandardMaterial("race_nitro_inner_mat", scene);
    this.nitroInnerMat.emissiveColor = Color3.FromHexString("#e8fdff");
    this.nitroInnerMat.disableLighting = true;
    this.nitroInnerMat.alpha = 0.92;
    this.nitroInnerMat.alphaMode = 1;
    this.nitroInnerMat.backFaceCulling = false;

    this.backfireMat = new StandardMaterial("race_backfire_cone_mat", scene);
    this.backfireMat.emissiveColor = Color3.FromHexString("#ff7a18");
    this.backfireMat.disableLighting = true;
    this.backfireMat.alpha = 0.92;
    this.backfireMat.alphaMode = 1;
    this.backfireMat.backFaceCulling = false;

    for (let i = 0; i < 4; i++) {
      const pivot = new TransformNode(`race_exhaust_pivot_${i}`, scene);

      const outerCone = MeshBuilder.CreateCylinder(
        `race_nitro_outer_${i}`,
        { diameterTop: 0.01, diameterBottom: 0.24, height: 1.0, tessellation: 12 },
        scene
      );
      outerCone.parent = pivot;
      outerCone.rotation.x = Math.PI / 2;
      outerCone.position.z = 0.5;
      outerCone.material = this.nitroOuterMat;
      outerCone.isPickable = false;
      outerCone.setEnabled(false);

      const innerCone = MeshBuilder.CreateCylinder(
        `race_nitro_inner_${i}`,
        { diameterTop: 0.008, diameterBottom: 0.13, height: 0.65, tessellation: 10 },
        scene
      );
      innerCone.parent = pivot;
      innerCone.rotation.x = Math.PI / 2;
      innerCone.position.z = 0.325;
      innerCone.material = this.nitroInnerMat;
      innerCone.isPickable = false;
      innerCone.setEnabled(false);

      const backfireCone = MeshBuilder.CreateCylinder(
        `race_backfire_cone_${i}`,
        { diameterTop: 0.01, diameterBottom: 0.3, height: 0.72, tessellation: 12 },
        scene
      );
      backfireCone.parent = pivot;
      backfireCone.rotation.x = Math.PI / 2;
      backfireCone.position.z = 0.36;
      backfireCone.material = this.backfireMat;
      backfireCone.isPickable = false;
      backfireCone.setEnabled(false);

      this.exhaustFlames.push({ pivot, outerCone, innerCone, backfireCone });
    }

    // 10. Single reusable tail-glow PointLight (Nitro blue or Backfire orange)
    this.exhaustLight = new PointLight("race_exhaust_glow_light", Vector3.Zero(), scene);
    this.exhaustLight.intensity = 0;
    this.exhaustLight.range = 10;
  }

  private createSmokeSystem(name: string, emitter: Vector3, capacity: number): ParticleSystem {
    const ps = new ParticleSystem(name, capacity, this.scene);
    ps.particleTexture = this.softSmokeTex;
    ps.emitter = emitter;
    ps.minEmitBox = new Vector3(-0.16, 0.02, -0.16);
    ps.maxEmitBox = new Vector3(0.16, 0.14, 0.16);
    ps.color1 = new Color4(0.9, 0.92, 0.96, 0.42);
    ps.color2 = new Color4(0.72, 0.76, 0.82, 0.34);
    ps.colorDead = new Color4(0.65, 0.68, 0.74, 0.0);
    ps.minSize = 0.42;
    ps.maxSize = 1.05;
    ps.addSizeGradient(0, 0.4);
    ps.addSizeGradient(0.45, 1.15);
    ps.addSizeGradient(1.0, 2.05);
    ps.minLifeTime = 0.45;
    ps.maxLifeTime = 1.05;
    ps.direction1 = new Vector3(-0.7, 0.45, -0.7);
    ps.direction2 = new Vector3(0.7, 1.35, 0.7);
    ps.gravity = new Vector3(0, 0.95, 0);
    ps.minAngularSpeed = -1.6;
    ps.maxAngularSpeed = 1.6;
    ps.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    ps.emitRate = 0;
    ps.start();
    return ps;
  }

  private zeroAllSkidMatrices(): void {
    this.skidBuffer.fill(0);
    for (let i = 0; i < MAX_SKID_MARKS; i++) {
      this.skidBuffer[i * 16 + 15] = 1;
    }
  }

  clearSkidMarks(): void {
    this.zeroAllSkidMatrices();
    this.skidWriteIdx = 0;
    this.skidStates.clear();
    this.skidMesh.thinInstanceBufferUpdated("matrix");
    this.skidDirty = false;
  }

  /**
   * Triggers a crisp orange exhaust backfire pop on gear upshift/downshift or garage rev.
   */
  triggerShiftBackfire(exhaustTips: readonly TransformNode[], carForward: Vector3, duration = 0.14): void {
    this.backfireTimer = duration;
    this.backfireDuration = duration;
    if (exhaustTips.length === 0) return;

    const tipPos = exhaustTips[0].getAbsolutePosition();
    this.backfireEmitter.copyFrom(tipPos);
    this.backfirePs.direction1.set(
      -carForward.x * 7 - 0.8,
      -carForward.y * 7 - 0.4,
      -carForward.z * 7 - 0.8
    );
    this.backfirePs.direction2.set(
      -carForward.x * 13 + 0.8,
      -carForward.y * 13 + 0.6,
      -carForward.z * 13 + 0.8
    );
    this.backfirePs.manualEmitCount = 16;
  }

  spawnCollisionSparks(worldPos: Vector3, intensity = 1): void {
    this.collisionEmitter.copyFrom(worldPos);
    this.collisionSparksPs.manualEmitCount = Math.round(clamp(intensity, 0.3, 1.5) * 26);
  }

  updateCar(params: DriftVfxUpdateParams): void {
    const dt = Math.min(0.05, Math.max(0.001, params.dt));

    // LH cross product: Up x Forward = Right
    Vector3.CrossToRef(params.carUp, params.carForward, this._right);
    if (this._right.lengthSquared() < 1e-5) this._right.set(1, 0, 0);
    else this._right.normalize();

    // Resolve rear tire contact points (use rig rearTireNodes if present, fallback to car geometry)
    const tires = params.rig.rearTireNodes;
    if (tires.length >= 2) {
      this._leftTire.copyFrom(tires[0].getAbsolutePosition());
      this._rightTire.copyFrom(tires[1].getAbsolutePosition());
      // Ensure contact sits at road height near carPos.y
      this._leftTire.y = params.carPos.y + SKID_SURFACE_LIFT;
      this._rightTire.y = params.carPos.y + SKID_SURFACE_LIFT;
    } else {
      this._leftTire.set(
        params.carPos.x - params.carForward.x * 1.35 - this._right.x * 0.84,
        params.carPos.y + SKID_SURFACE_LIFT,
        params.carPos.z - params.carForward.z * 1.35 - this._right.z * 0.84
      );
      this._rightTire.set(
        params.carPos.x - params.carForward.x * 1.35 + this._right.x * 0.84,
        params.carPos.y + SKID_SURFACE_LIFT,
        params.carPos.z - params.carForward.z * 1.35 + this._right.z * 0.84
      );
    }

    // 1. Stamp Persistent Road Skid Marks
    const shouldLeaveSkid =
      !params.onGravel &&
      params.speedKmh > 12 &&
      (params.drifting || params.driftSlip > 0.16 || params.launchWheelspin || (params.hardBraking && params.speedKmh > 65));

    let skidState = this.skidStates.get(params.carId);
    if (!skidState) {
      skidState = {
        prevLeft: new Vector3(),
        prevRight: new Vector3(),
        hasLeft: false,
        hasRight: false,
      };
      this.skidStates.set(params.carId, skidState);
    }

    if (shouldLeaveSkid) {
      const tireWidth = 0.28 + clamp(params.driftSlip, 0, 1) * 0.11;
      this.tryStampSkidSegment(skidState.prevLeft, this._leftTire, skidState.hasLeft, params.carUp, tireWidth, (ok) => {
        skidState!.hasLeft = ok;
      });
      this.tryStampSkidSegment(skidState.prevRight, this._rightTire, skidState.hasRight, params.carUp, tireWidth, (ok) => {
        skidState!.hasRight = ok;
      });
    } else {
      skidState.hasLeft = false;
      skidState.hasRight = false;
    }

    // Rival drift smoke (lightweight shared pool)
    if (!params.isPlayer) {
      if ((params.drifting || params.driftSlip > 0.25) && params.speedKmh > 25) {
        this.rivalSmokeEmitter.copyFrom(this._leftTire);
        this.rivalSmokePs.manualEmitCount = Math.min(20, this.rivalSmokePs.manualEmitCount + 2);
      }
      return;
    }

    // --- PLAYER-SPECIFIC RICH VFX ---
    this.flameClock += dt;

    // 2. Tire Drift Smoke (scaled by drift slip + launch wheelspin)
    const smokeIntensity = clamp(
      (params.drifting ? 0.45 + params.driftSlip * 0.75 : params.driftSlip * 0.85) +
        (params.launchWheelspin ? 0.9 : 0) +
        (params.hardBraking && params.speedKmh > 70 ? 0.35 : 0),
      0,
      1.2
    );

    this.leftSmokeEmitter.copyFrom(this._leftTire);
    this.rightSmokeEmitter.copyFrom(this._rightTire);
    const smokeRate = !params.onGravel && smokeIntensity > 0.12 && params.speedKmh > 8
      ? Math.round(14 + smokeIntensity * 68)
      : 0;
    this.leftSmokePs.emitRate = smokeRate;
    this.rightSmokePs.emitRate = smokeRate;

    const backDriftX = -params.velocity.x * 0.16;
    const backDriftZ = -params.velocity.z * 0.16;
    this.leftSmokePs.direction1.set(backDriftX - 0.85, 0.35, backDriftZ - 0.85);
    this.leftSmokePs.direction2.set(backDriftX + 0.85, 1.45, backDriftZ + 0.85);
    this.rightSmokePs.direction1.set(backDriftX - 0.85, 0.35, backDriftZ - 0.85);
    this.rightSmokePs.direction2.set(backDriftX + 0.85, 1.45, backDriftZ + 0.85);

    // 3. Gravel Shoulder Dust
    if (params.onGravel && params.speedKmh > 18) {
      this.gravelEmitter.set(
        params.carPos.x - params.carForward.x * 1.4,
        params.carPos.y + 0.15,
        params.carPos.z - params.carForward.z * 1.4
      );
      this.gravelDustPs.emitRate = Math.round(clamp(params.speedKmh / 140, 0.2, 1) * 75);
    } else {
      this.gravelDustPs.emitRate = 0;
    }

    // 4. Nitro Exhaust Flames + Orange Shift Backfire Flash
    if (this.backfireTimer > 0) {
      this.backfireTimer = Math.max(0, this.backfireTimer - dt);
    }
    const backfireAlpha = this.backfireDuration > 0 ? this.backfireTimer / this.backfireDuration : 0;

    const tips = params.rig.exhaustTips;
    const activeTipCount = Math.min(tips.length, this.exhaustFlames.length);
    const flicker = 0.82 + Math.sin(this.flameClock * 78) * 0.18 + Math.cos(this.flameClock * 131) * 0.12;

    for (let i = 0; i < this.exhaustFlames.length; i++) {
      const f = this.exhaustFlames[i];
      if (i < activeTipCount && (params.nitroActive || backfireAlpha > 0.02)) {
        this._tipPos.copyFrom(tips[i].getAbsolutePosition());
        f.pivot.position.copyFrom(this._tipPos);
        this._lookBehind.set(
          this._tipPos.x - params.carForward.x * 4,
          this._tipPos.y - params.carForward.y * 4,
          this._tipPos.z - params.carForward.z * 4
        );
        f.pivot.lookAt(this._lookBehind);

        if (params.nitroActive) {
          const speedBoost = 0.9 + clamp(params.speedKmh / 280, 0, 1) * 0.65;
          f.outerCone.setEnabled(true);
          f.innerCone.setEnabled(true);
          f.outerCone.scaling.set(0.95 * flicker, 0.95 * flicker, speedBoost * (1.05 + flicker * 0.35));
          f.innerCone.scaling.set(0.9 * flicker, 0.9 * flicker, speedBoost * (0.85 + flicker * 0.3));
        } else {
          f.outerCone.setEnabled(false);
          f.innerCone.setEnabled(false);
        }

        if (backfireAlpha > 0.02) {
          f.backfireCone.setEnabled(true);
          const popScale = 0.6 + backfireAlpha * 1.15;
          f.backfireCone.scaling.set(popScale, popScale, 0.7 + backfireAlpha * 1.3);
        } else {
          f.backfireCone.setEnabled(false);
        }
      } else {
        f.outerCone.setEnabled(false);
        f.innerCone.setEnabled(false);
        f.backfireCone.setEnabled(false);
      }
    }

    // Nitro exhaust particle trail & rear glow light
    if (params.nitroActive && activeTipCount > 0) {
      this._tipPos.copyFrom(tips[0].getAbsolutePosition());
      if (activeTipCount >= 2) {
        const second = tips[activeTipCount - 1].getAbsolutePosition();
        this._tipPos.addInPlace(second).scaleInPlace(0.5);
      }
      this.nitroEmitter.copyFrom(this._tipPos);
      this.nitroTrailPs.direction1.set(
        -params.carForward.x * 12 - 0.9,
        -params.carForward.y * 12 - 0.4,
        -params.carForward.z * 12 - 0.9
      );
      this.nitroTrailPs.direction2.set(
        -params.carForward.x * 20 + 0.9,
        -params.carForward.y * 20 + 0.5,
        -params.carForward.z * 20 + 0.9
      );
      this.nitroTrailPs.emitRate = 125;

      this.exhaustLight.position.set(
        this._tipPos.x - params.carForward.x * 0.65,
        this._tipPos.y + 0.2,
        this._tipPos.z - params.carForward.z * 0.65
      );
      this.exhaustLight.diffuse.set(0.12, 0.78, 1.0);
      this.exhaustLight.intensity = 6.5 * flicker;
    } else if (backfireAlpha > 0.05 && activeTipCount > 0) {
      this.nitroTrailPs.emitRate = 0;
      this._tipPos.copyFrom(tips[0].getAbsolutePosition());
      this.exhaustLight.position.set(
        this._tipPos.x - params.carForward.x * 0.5,
        this._tipPos.y + 0.25,
        this._tipPos.z - params.carForward.z * 0.5
      );
      this.exhaustLight.diffuse.set(1.0, 0.52, 0.12);
      this.exhaustLight.intensity = 9.0 * backfireAlpha;
    } else {
      this.nitroTrailPs.emitRate = 0;
      this.exhaustLight.intensity = 0;
    }

    // 5. Guardrail Scrape Sparks (bursting when wallScrapeIntensity > 0.1)
    if (params.wallScrapeIntensity > 0.1 && params.speedKmh > 15) {
      const side = params.wallScrapeSide !== 0 ? Math.sign(params.wallScrapeSide) : 1;
      this.scrapeEmitter.set(
        params.carPos.x + this._right.x * side * 1.02 + params.carUp.x * 0.45,
        params.carPos.y + 0.45,
        params.carPos.z + this._right.z * side * 1.02 + params.carUp.z * 0.45
      );
      const backX = -params.carForward.x * (5 + params.speedKmh * 0.07);
      const backZ = -params.carForward.z * (5 + params.speedKmh * 0.07);
      const outX = -this._right.x * side * 3.0;
      const outZ = -this._right.z * side * 3.0;
      this.scrapeSparksPs.direction1.set(backX + outX - 1.5, 1.2, backZ + outZ - 1.5);
      this.scrapeSparksPs.direction2.set(backX + outX + 1.5, 5.2, backZ + outZ + 1.5);
      this.scrapeSparksPs.emitRate = Math.round(45 + clamp(params.wallScrapeIntensity, 0, 1) * 185);
    } else {
      this.scrapeSparksPs.emitRate = 0;
    }

    // 6. Slipstream / High-speed Aerodynamic Wind Streaks
    if (params.slipstreamActive || params.speedKmh > 235) {
      this.slipstreamEmitter.set(
        params.carPos.x + params.carForward.x * 3.2,
        params.carPos.y + 0.65,
        params.carPos.z + params.carForward.z * 3.2
      );
      this.slipstreamPs.direction1.set(
        -params.carForward.x * 26 - 0.6,
        -0.3,
        -params.carForward.z * 26 - 0.6
      );
      this.slipstreamPs.direction2.set(
        -params.carForward.x * 34 + 0.6,
        0.5,
        -params.carForward.z * 34 + 0.6
      );
      this.slipstreamPs.emitRate = params.slipstreamActive ? 68 : 28;
    } else {
      this.slipstreamPs.emitRate = 0;
    }
  }

  private tryStampSkidSegment(
    prev: Vector3,
    curr: Vector3,
    hasPrev: boolean,
    roadNormal: Vector3,
    width: number,
    setHasPrev: (ok: boolean) => void
  ): void {
    if (!hasPrev) {
      prev.copyFrom(curr);
      setHasPrev(true);
      return;
    }

    this._segDir.set(curr.x - prev.x, curr.y - prev.y, curr.z - prev.z);
    const len = this._segDir.length();
    if (len < SKID_MIN_SEG_LEN) {
      return;
    }
    if (len > SKID_MAX_SEG_LEN) {
      // Teleport / reset gap — restart strip cleanly without huge stretched polygon
      prev.copyFrom(curr);
      setHasPrev(true);
      return;
    }

    const invLen = 1 / len;
    this._segDir.scaleInPlace(invLen);

    Vector3.CrossToRef(roadNormal, this._segDir, this._segRight);
    if (this._segRight.lengthSquared() < 1e-5) {
      prev.copyFrom(curr);
      return;
    }
    this._segRight.normalize();

    this._segMid.set(
      (prev.x + curr.x) * 0.5,
      (prev.y + curr.y) * 0.5,
      (prev.z + curr.z) * 0.5
    );

    const drawLen = len + 0.06; // Tiny overlap eliminates hairline seams between segments
    const off = this.skidWriteIdx * 16;

    // Column-major 4x4 matrix (Babylon ThinInstance layout):
    // Col 0 = right * width, Col 1 = roadNormal, Col 2 = dir * drawLen, Col 3 = mid
    this.skidBuffer[off + 0] = this._segRight.x * width;
    this.skidBuffer[off + 1] = this._segRight.y * width;
    this.skidBuffer[off + 2] = this._segRight.z * width;
    this.skidBuffer[off + 3] = 0;

    this.skidBuffer[off + 4] = roadNormal.x;
    this.skidBuffer[off + 5] = roadNormal.y;
    this.skidBuffer[off + 6] = roadNormal.z;
    this.skidBuffer[off + 7] = 0;

    this.skidBuffer[off + 8] = this._segDir.x * drawLen;
    this.skidBuffer[off + 9] = this._segDir.y * drawLen;
    this.skidBuffer[off + 10] = this._segDir.z * drawLen;
    this.skidBuffer[off + 11] = 0;

    this.skidBuffer[off + 12] = this._segMid.x;
    this.skidBuffer[off + 13] = this._segMid.y;
    this.skidBuffer[off + 14] = this._segMid.z;
    this.skidBuffer[off + 15] = 1;

    this.skidWriteIdx = (this.skidWriteIdx + 1) % MAX_SKID_MARKS;
    this.skidDirty = true;

    prev.copyFrom(curr);
  }

  /**
   * Flushes batched ThinInstance skid-mark matrix updates once per frame.
   */
  flushFrame(): void {
    if (this.skidDirty) {
      this.skidMesh.thinInstanceBufferUpdated("matrix");
      this.skidDirty = false;
    }
  }

  dispose(): void {
    this.skidMesh.dispose();
    this.skidMat.dispose();
    this.leftSmokePs.dispose(false);
    this.rightSmokePs.dispose(false);
    this.rivalSmokePs.dispose(false);
    this.gravelDustPs.dispose(false);
    this.nitroTrailPs.dispose(false);
    this.backfirePs.dispose(false);
    this.scrapeSparksPs.dispose(false);
    this.collisionSparksPs.dispose(false);
    this.slipstreamPs.dispose(false);

    for (const f of this.exhaustFlames) {
      f.outerCone.dispose();
      f.innerCone.dispose();
      f.backfireCone.dispose();
      f.pivot.dispose();
    }
    this.exhaustFlames.length = 0;

    this.nitroOuterMat.dispose();
    this.nitroInnerMat.dispose();
    this.backfireMat.dispose();
    this.exhaustLight.dispose();

    this.softSmokeTex.dispose();
    this.sparkTex.dispose();
    this.skidTex.dispose();
    this.skidStates.clear();
  }
}
