import {
  AbstractMesh,
  Color3,
  Color4,
  DynamicTexture,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  ParticleSystem,
  PointLight,
  Scene,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";
import { ObjectPool, type Vec3 } from "@game/shared";

interface MovingTracer {
  mesh: Mesh;
  start: Vector3;
  end: Vector3;
  segmentEnd: Vector3;
  bends?: readonly Vec3[];
  segment: number;
  progress: number;
  speed: number;
}

interface GlassShard {
  mesh: Mesh;
  vel: Vector3;
  rotVel: Vector3;
  ttl: number;
}

interface ExpandingFx {
  mesh: Mesh;
  mat: StandardMaterial;
  ttl: number;
  maxTtl: number;
  from: number;
  to: number;
  kind: "flash" | "ring" | "dome";
  ownsMaterial: boolean;
}

interface DebrisChunk {
  mesh: Mesh;
  vel: Vector3;
  rot: Vector3;
  ttl: number;
  floor: number;
}

interface BurningBarrel {
  smoke: ParticleSystem;
  fire: ParticleSystem;
  fuse: boolean;
}

function makeRadialTexture(scene: Scene, name: string, size: number, stops: [number, string][], ring = false): DynamicTexture {
  const tex = new DynamicTexture(name, size, scene, false);
  const ctx = tex.getContext();
  const c = size / 2;
  const grad = ctx.createRadialGradient(c, c, ring ? c * 0.55 : 2, c, c, c - 1);
  for (const [o, col] of stops) grad.addColorStop(o, col);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  tex.update();
  tex.hasAlpha = true;
  return tex;
}

function makeFxMaterial(scene: Scene, name: string, tex: DynamicTexture, additive: boolean): StandardMaterial {
  const mat = new StandardMaterial(name, scene);
  mat.diffuseTexture = tex;
  mat.emissiveTexture = tex;
  mat.opacityTexture = tex;
  mat.disableLighting = true;
  mat.backFaceCulling = false;
  if (additive) mat.alphaMode = 1; // ALPHA_ADD
  return mat;
}

interface BurstDef {
  capacity: number;
  color1: Color4;
  color2: Color4;
  colorDead: Color4;
  size: [number, number];
  life: [number, number];
  dir1: Vector3;
  dir2: Vector3;
  gravity: Vector3;
  box: number;
  additive: boolean;
}

const BURST_DEFS: Record<string, BurstDef> = {
  exp_fire: {
    capacity: 220, additive: true, box: 0.5,
    color1: new Color4(1.0, 0.92, 0.5, 1.0), color2: new Color4(1.0, 0.4, 0.06, 0.95), colorDead: new Color4(0.3, 0.08, 0.0, 0.0),
    size: [1.4, 3.8], life: [0.45, 1.15], dir1: new Vector3(-3.2, 1.0, -3.2), dir2: new Vector3(3.2, 7.5, 3.2), gravity: new Vector3(0, 2.2, 0),
  },
  exp_smoke: {
    capacity: 140, additive: false, box: 0.6,
    color1: new Color4(0.22, 0.2, 0.19, 0.85), color2: new Color4(0.1, 0.1, 0.1, 0.75), colorDead: new Color4(0.05, 0.05, 0.05, 0.0),
    size: [2.0, 5.0], life: [1.8, 3.6], dir1: new Vector3(-1.4, 2.2, -1.4), dir2: new Vector3(1.4, 5.5, 1.4), gravity: new Vector3(0, 0.6, 0),
  },
  exp_ember: {
    capacity: 90, additive: true, box: 0.3,
    color1: new Color4(1.0, 0.9, 0.45, 1.0), color2: new Color4(1.0, 0.45, 0.1, 1.0), colorDead: new Color4(0.6, 0.1, 0.0, 0.0),
    size: [0.06, 0.16], life: [0.9, 1.9], dir1: new Vector3(-7, 4, -7), dir2: new Vector3(7, 13, 7), gravity: new Vector3(0, -14, 0),
  },
  fb_spark: {
    capacity: 80, additive: true, box: 0.1,
    color1: new Color4(1, 1, 0.92, 1), color2: new Color4(0.85, 0.92, 1, 1), colorDead: new Color4(1, 1, 1, 0),
    size: [0.05, 0.14], life: [0.3, 0.8], dir1: new Vector3(-8, -1, -8), dir2: new Vector3(8, 9, 8), gravity: new Vector3(0, -9, 0),
  },
  fb_puff: {
    capacity: 30, additive: false, box: 0.2,
    color1: new Color4(0.95, 0.95, 1, 0.55), color2: new Color4(0.8, 0.85, 0.95, 0.4), colorDead: new Color4(0.8, 0.85, 0.95, 0),
    size: [1.2, 2.6], life: [0.5, 1.1], dir1: new Vector3(-1.5, 0.2, -1.5), dir2: new Vector3(1.5, 1.5, 1.5), gravity: new Vector3(0, 0.2, 0),
  },
};

/**
 * Upgraded Real VFX System:
 * - Soft radial sprite ParticleSystems (metal sparks, concrete dust, blood mist, explosions)
 * - Fast-traveling short bullet tracer streaks (no more full-length laser rods)
 * - Oriented bullet hole decals (`MeshBuilder.CreateDecal`) on map cover
 * - Shattering glass shards with gravity bounce
 * - 3D Grenade Throw Trajectory Arc + Landing Ring
 */
export class VfxSystem {
  private readonly softParticleTex: DynamicTexture;
  private readonly decalMat: StandardMaterial;
  private readonly glassShardMat: PBRMaterial;
  private readonly tracerMat: StandardMaterial;
  private readonly tracerPool: ObjectPool<MovingTracer>;
  private readonly decals: Mesh[] = [];
  private readonly impactPools = new Map<string, { ps: ParticleSystem; emitter: Vector3 }[]>();
  private readonly impactNormal = new Vector3();
  private readonly shards: GlassShard[] = [];
  private readonly fx: ExpandingFx[] = [];
  private readonly debris: DebrisChunk[] = [];
  private readonly scorches: { mesh: Mesh; ttl: number }[] = [];
  private readonly burningBarrels = new Map<string, BurningBarrel>();
  private readonly flashSpriteMat: StandardMaterial;
  private readonly flashbangSpriteMat: StandardMaterial;
  private readonly ringMat: StandardMaterial;
  private readonly flashbangRingMat: StandardMaterial;
  private readonly domeMat: StandardMaterial;
  private readonly debrisMat: StandardMaterial;
  private readonly scorchMat: StandardMaterial;
  private readonly fxTextures: DynamicTexture[] = [];
  /** One persistent light reused by every blast so spawning explosions never recompiles shaders. */
  private readonly blastLight: PointLight;
  private blastLightTtl = 0;
  private blastLightMaxTtl = 1;
  private blastLightPeak = 0;
  private fxId = 0;

  private readonly arcDots: Mesh[] = [];
  private readonly arcLandingRing: Mesh;

  constructor(private readonly scene: Scene) {
    // Soft radial sprite texture for fireballs, smoke plumes, sparks & blood mist
    this.softParticleTex = new DynamicTexture("vfx_soft_sprite", 128, scene, false);
    const ctx = this.softParticleTex.getContext();
    const grad = ctx.createRadialGradient(64, 64, 2, 64, 64, 62);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.35, "rgba(255,255,255,0.75)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);
    this.softParticleTex.update();
    this.softParticleTex.hasAlpha = true;

    const flashTex = makeRadialTexture(scene, "vfx_blast_flash", 128, [
      [0, "rgba(255,255,255,1)"], [0.25, "rgba(255,236,170,0.95)"], [0.6, "rgba(255,140,40,0.45)"], [1, "rgba(255,90,0,0)"],
    ]);
    const fbFlashTex = makeRadialTexture(scene, "vfx_flashbang_flash", 128, [
      [0, "rgba(255,255,255,1)"], [0.4, "rgba(235,245,255,0.85)"], [1, "rgba(220,235,255,0)"],
    ]);
    const ringTex = makeRadialTexture(scene, "vfx_shock_ring", 128, [
      [0, "rgba(255,200,120,0)"], [0.55, "rgba(255,200,120,0)"], [0.8, "rgba(255,220,160,0.9)"], [0.93, "rgba(255,150,60,0.4)"], [1, "rgba(255,120,0,0)"],
    ], true);
    const fbRingTex = makeRadialTexture(scene, "vfx_flashbang_ring", 128, [
      [0, "rgba(255,255,255,0)"], [0.55, "rgba(255,255,255,0)"], [0.82, "rgba(255,255,255,0.95)"], [1, "rgba(255,255,255,0)"],
    ], true);
    const domeTex = makeRadialTexture(scene, "vfx_shock_dome", 64, [
      [0, "rgba(255,230,190,0.0)"], [0.7, "rgba(255,200,130,0.12)"], [1, "rgba(255,190,110,0.5)"],
    ]);
    const scorchTex = makeRadialTexture(scene, "vfx_scorch", 128, [
      [0, "rgba(6,5,5,0.95)"], [0.5, "rgba(14,12,11,0.8)"], [1, "rgba(20,18,16,0)"],
    ]);
    this.fxTextures.push(flashTex, fbFlashTex, ringTex, fbRingTex, domeTex, scorchTex);
    this.flashSpriteMat = makeFxMaterial(scene, "vfx_blast_flash_mat", flashTex, true);
    this.flashbangSpriteMat = makeFxMaterial(scene, "vfx_flashbang_flash_mat", fbFlashTex, true);
    this.ringMat = makeFxMaterial(scene, "vfx_shock_ring_mat", ringTex, true);
    this.flashbangRingMat = makeFxMaterial(scene, "vfx_flashbang_ring_mat", fbRingTex, true);
    this.domeMat = makeFxMaterial(scene, "vfx_shock_dome_mat", domeTex, true);
    this.scorchMat = makeFxMaterial(scene, "vfx_scorch_mat", scorchTex, false);
    this.scorchMat.zOffset = -2;
    this.debrisMat = new StandardMaterial("vfx_debris_mat", scene);
    this.debrisMat.diffuseColor = new Color3(0.2, 0.12, 0.1);
    this.debrisMat.emissiveColor = new Color3(0.28, 0.1, 0.03);

    this.blastLight = new PointLight("vfx_blast_light", Vector3.Zero(), scene);
    this.blastLight.intensity = 0;
    this.blastLight.range = 26;

    for (const name of Object.keys(BURST_DEFS)) this.createBurstSystem(name);
    for (const kind of ["blood", "metal", "dust"]) {
      this.impactPools.set(kind, Array.from({ length: 4 }, (_, index) => this.createImpactSystem(kind, index)));
    }

    // Bullet hole decal texture
    const holeTex = new DynamicTexture("vfx_bullet_hole", 64, scene, false);
    const hctx = holeTex.getContext();
    const hg = hctx.createRadialGradient(32, 32, 3, 32, 32, 26);
    hg.addColorStop(0, "rgba(5,5,8,0.98)");
    hg.addColorStop(0.45, "rgba(25,25,30,0.8)");
    hg.addColorStop(1, "rgba(25,25,30,0)");
    hctx.fillStyle = hg;
    hctx.fillRect(0, 0, 64, 64);
    holeTex.update();
    holeTex.hasAlpha = true;

    this.decalMat = new StandardMaterial("vfx_decal_mat", scene);
    this.decalMat.diffuseTexture = holeTex;
    this.decalMat.useAlphaFromDiffuseTexture = true;
    this.decalMat.zOffset = -2;
    this.decalMat.roughness = 1;

    this.glassShardMat = new PBRMaterial("vfx_shard_mat", scene);
    this.glassShardMat.albedoColor = Color3.FromHexString("#a5f3fc");
    this.glassShardMat.alpha = 0.55;
    this.glassShardMat.roughness = 0.05;
    this.glassShardMat.metallic = 0.3;

    this.tracerMat = new StandardMaterial("vfx_tracer_mat", scene);
    this.tracerMat.emissiveColor = new Color3(1.0, 0.85, 0.42);
    this.tracerMat.disableLighting = true;
    this.tracerMat.alpha = 0.92;

    this.tracerPool = new ObjectPool<MovingTracer>(36, (i) => {
      const mesh = MeshBuilder.CreateBox(
        `vfx_tracer_${i}`,
        { width: 0.024, height: 0.024, depth: 2.2 },
        scene
      );
      mesh.material = this.tracerMat;
      mesh.isPickable = false;
      mesh.setEnabled(false);
      return {
        mesh,
        start: new Vector3(),
        end: new Vector3(),
        segmentEnd: new Vector3(),
        segment: 0,
        progress: 0,
        speed: 140,
      };
    });

    // Pre-allocate 18 trajectory arc dots + landing ring for Cookable Grenade preview
    const arcMat = new StandardMaterial("vfx_arc_mat", scene);
    arcMat.emissiveColor = Color3.FromHexString("#38bdf8");
    arcMat.disableLighting = true;
    arcMat.alpha = 0.8;

    for (let i = 0; i < 18; i++) {
      const dot = MeshBuilder.CreateSphere(`arc_dot_${i}`, { diameter: 0.075, segments: 6 }, scene);
      dot.material = arcMat;
      dot.isPickable = false;
      dot.setEnabled(false);
      this.arcDots.push(dot);
    }

    this.arcLandingRing = MeshBuilder.CreateTorus(
      "arc_landing_ring",
      { diameter: 0.9, thickness: 0.04, tessellation: 20 },
      scene
    );
    this.arcLandingRing.material = arcMat;
    this.arcLandingRing.isPickable = false;
    this.arcLandingRing.setEnabled(false);
  }

  getSoftParticleTexture(): DynamicTexture {
    return this.softParticleTex;
  }

  spawnMovingTracer(from: Readonly<Vec3>, to: Readonly<Vec3>, bends?: readonly Vec3[]): void {
    const t = this.tracerPool.acquire();
    if (!t) return;
    t.start.set(from.x, from.y, from.z);
    t.end.set(to.x, to.y, to.z);
    t.segment = 0;
    t.bends = bends;
    t.mesh.position.copyFrom(t.start);
    this.setTracerSegment(t);
    t.progress = 0;
    const dist = Math.max(1, Vector3.Distance(t.start, t.end));
    t.speed = Math.max(95, dist * 16);
    t.mesh.setEnabled(true);
  }

  private setTracerSegment(tracer: MovingTracer): void {
    const end = tracer.bends?.[tracer.segment] ?? tracer.end;
    tracer.segmentEnd.set(end.x, end.y, end.z);
    tracer.mesh.lookAt(tracer.segmentEnd);
  }

  spawnBulletImpact(
    point: Readonly<Vec3>,
    normal: Readonly<Vec3>,
    material: string,
    isBlood: boolean,
    targetMesh?: AbstractMesh
  ): void {
    const nrm = this.impactNormal.set(normal.x, normal.y, normal.z).normalize();

    if (targetMesh && !isBlood) {
      try {
        const decal = MeshBuilder.CreateDecal(`hole_${Date.now()}_${Math.random()}`, targetMesh, {
          position: new Vector3(point.x, point.y, point.z),
          normal: nrm,
          size: new Vector3(0.16, 0.16, 0.16),
        });
        decal.material = this.decalMat;
        decal.isPickable = false;
        this.decals.push(decal);
        if (this.decals.length > 65) {
          this.decals.shift()?.dispose();
        }
      } catch {
        // Fallback smoothly if mesh has no geometry normals
      }
    }

    const kind = isBlood ? "blood" : material === "METAL" || material === "SHEET_METAL" || material === "EXPLOSIVE_BARREL" ? "metal" : "dust";
    const item = this.impactPools.get(kind)?.find(({ ps }) => ps.manualEmitCount <= 0);
    if (!item) return;
    const { ps, emitter } = item;
    emitter.set(point.x + nrm.x * 0.05, point.y + nrm.y * 0.05, point.z + nrm.z * 0.05);
    ps.direction1.set(nrm.x * 2.5 - 1.4, nrm.y * 2.5 - 0.8, nrm.z * 2.5 - 1.4);
    ps.direction2.set(nrm.x * 4.5 + 1.4, nrm.y * 4.5 + 1.8, nrm.z * 4.5 + 1.4);
    ps.manualEmitCount = isBlood ? 14 : 10;
  }

  private createImpactSystem(kind: string, index: number): { ps: ParticleSystem; emitter: Vector3 } {
    const ps = new ParticleSystem(`impact_${kind}_${index}`, 48, this.scene);
    const emitter = new Vector3();
    ps.particleTexture = this.softParticleTex;
    ps.emitter = emitter;
    ps.minEmitBox = new Vector3(-0.04, -0.04, -0.04);
    ps.maxEmitBox = new Vector3(0.04, 0.04, 0.04);

    if (kind === "blood") {
      ps.color1 = new Color4(0.75, 0.05, 0.08, 0.9);
      ps.color2 = new Color4(0.45, 0.02, 0.04, 0.8);
      ps.colorDead = new Color4(0.2, 0.0, 0.0, 0);
      ps.minSize = 0.12;
      ps.maxSize = 0.28;
      ps.minLifeTime = 0.16;
      ps.maxLifeTime = 0.34;
      ps.gravity = new Vector3(0, -4.5, 0);
    } else if (kind === "metal") {
      ps.color1 = new Color4(1.0, 0.85, 0.3, 1.0);
      ps.color2 = new Color4(1.0, 0.45, 0.1, 0.95);
      ps.colorDead = new Color4(0.8, 0.2, 0.0, 0);
      ps.minSize = 0.04;
      ps.maxSize = 0.1;
      ps.minLifeTime = 0.12;
      ps.maxLifeTime = 0.28;
      ps.gravity = new Vector3(0, -12, 0);
    } else {
      ps.color1 = new Color4(0.78, 0.74, 0.68, 0.65);
      ps.color2 = new Color4(0.55, 0.52, 0.48, 0.5);
      ps.colorDead = new Color4(0.4, 0.38, 0.35, 0);
      ps.minSize = 0.14;
      ps.maxSize = 0.34;
      ps.minLifeTime = 0.2;
      ps.maxLifeTime = 0.48;
      ps.gravity = new Vector3(0, -2.0, 0);
    }

    ps.blendMode = kind === "metal" ? ParticleSystem.BLENDMODE_ONEONE : ParticleSystem.BLENDMODE_STANDARD;
    ps.emitRate = 0;
    ps.manualEmitCount = 0;
    ps.start();
    return { ps, emitter };
  }

  private burstSystems = new Map<string, { ps: ParticleSystem; emitter: Vector3; size: [number, number] }>();

  /**
   * Burst systems are created once at startup (so their shaders are compiled before the first blast) and
   * re-triggered with manualEmitCount. Creating a fresh system per explosion made the first blasts fizzle:
   * the system only became ready after its short emit window had already elapsed.
   */
  private createBurstSystem(name: string): void {
    const def = BURST_DEFS[name];
    const emitter = new Vector3();
    const ps = new ParticleSystem(`burst_${name}`, def.capacity, this.scene);
    ps.particleTexture = this.softParticleTex;
    ps.emitter = emitter;
    ps.minEmitBox = new Vector3(-def.box, -def.box * 0.5, -def.box);
    ps.maxEmitBox = new Vector3(def.box, def.box, def.box);
    ps.color1 = def.color1;
    ps.color2 = def.color2;
    ps.colorDead = def.colorDead;
    ps.minSize = def.size[0];
    ps.maxSize = def.size[1];
    ps.minLifeTime = def.life[0];
    ps.maxLifeTime = def.life[1];
    ps.direction1 = def.dir1;
    ps.direction2 = def.dir2;
    ps.gravity = def.gravity;
    ps.emitRate = 0;
    ps.manualEmitCount = 0;
    ps.minAngularSpeed = -2;
    ps.maxAngularSpeed = 2;
    ps.blendMode = def.additive ? ParticleSystem.BLENDMODE_ONEONE : ParticleSystem.BLENDMODE_STANDARD;
    ps.start();
    this.burstSystems.set(name, { ps, emitter, size: def.size });
  }

  private emitBurst(name: string, center: Vector3, count: number, sizeScale: number): void {
    const b = this.burstSystems.get(name);
    if (!b) return;
    b.emitter.copyFrom(center);
    b.ps.minSize = b.size[0] * sizeScale;
    b.ps.maxSize = b.size[1] * sizeScale;
    b.ps.manualEmitCount = Math.max(0, b.ps.manualEmitCount) + count;
  }

  private flashLight(position: Vector3, color: string, intensity: number, ttl: number): void {
    this.blastLight.position.copyFrom(position);
    this.blastLight.diffuse = Color3.FromHexString(color);
    this.blastLight.intensity = intensity;
    this.blastLightPeak = intensity;
    this.blastLightTtl = ttl;
    this.blastLightMaxTtl = ttl;
  }

  private addFx(mesh: Mesh, mat: StandardMaterial, ttl: number, from: number, to: number, kind: ExpandingFx["kind"], ownsMaterial = false): void {
    mesh.isPickable = false;
    this.fx.push({ mesh, mat, ttl, maxTtl: ttl, from, to, kind, ownsMaterial });
  }

  /**
   * Full explosion: white-hot flash, fireball, rolling smoke column, embers, ground shockwave ring,
   * flying debris, a lingering scorch mark and a dynamic light pulse.
   */
  spawnExplosionVfx(position: Readonly<Vec3>, scale = 1, groundY = position.y - 0.3): void {
    const center = new Vector3(position.x, position.y + 0.3, position.z);

    this.emitBurst("exp_fire", center, Math.round(70 * Math.min(1.4, scale)), scale);
    this.emitBurst("exp_smoke", center, Math.round(42 * Math.min(1.4, scale)), scale);
    this.emitBurst("exp_ember", center, 40, 1);

    // Blinding flash sprite, expanding shockwave dome + ground ring
    const flash = MeshBuilder.CreatePlane(`exp_flash_${this.fxId++}`, { size: 1 }, this.scene);
    flash.billboardMode = Mesh.BILLBOARDMODE_ALL;
    flash.position.copyFrom(center);
    flash.material = this.flashSpriteMat;
    this.addFx(flash, this.flashSpriteMat, 0.28, 3 * scale, 11 * scale, "flash");

    const ring = MeshBuilder.CreateDisc(`exp_ring_${this.fxId++}`, { radius: 0.5, tessellation: 40 }, this.scene);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(position.x, groundY + 0.06, position.z);
    ring.material = this.ringMat;
    this.addFx(ring, this.ringMat, 0.55, 1.5 * scale, 15 * scale, "ring");

    const dome = MeshBuilder.CreateSphere(`exp_dome_${this.fxId++}`, { diameter: 1, segments: 12 }, this.scene);
    dome.position.copyFrom(center);
    dome.material = this.domeMat;
    this.addFx(dome, this.domeMat, 0.3, 1.5 * scale, 11 * scale, "dome");

    // Chunky debris that flies out and bounces
    for (let i = 0; i < Math.round(12 * scale); i++) {
      const s = 0.08 + Math.random() * 0.16;
      const chunk = MeshBuilder.CreateBox(`exp_debris_${this.fxId++}`, { width: s, height: s * (0.5 + Math.random()), depth: s }, this.scene);
      chunk.position.copyFrom(center);
      chunk.material = this.debrisMat;
      chunk.isPickable = false;
      const a = Math.random() * Math.PI * 2;
      const speed = (5 + Math.random() * 8) * scale;
      this.debris.push({
        mesh: chunk,
        vel: new Vector3(Math.cos(a) * speed, 5 + Math.random() * 7, Math.sin(a) * speed),
        rot: new Vector3(Math.random() * 14, Math.random() * 14, Math.random() * 14),
        ttl: 2.2 + Math.random() * 0.8,
        floor: groundY + s * 0.4,
      });
    }

    // Scorch mark on the ground that slowly fades
    const scorch = MeshBuilder.CreateDisc(`exp_scorch_${this.fxId++}`, { radius: 0.5, tessellation: 32 }, this.scene);
    scorch.rotation.x = Math.PI / 2;
    scorch.position.set(position.x, groundY + 0.025, position.z);
    scorch.scaling.setAll(4.2 * scale);
    scorch.material = this.scorchMat;
    scorch.isPickable = false;
    scorch.visibility = 0.9;
    this.scorches.push({ mesh: scorch, ttl: 40 });
    if (this.scorches.length > 10) this.scorches.shift()?.mesh.dispose();

    this.flashLight(center.add(new Vector3(0, 0.8, 0)), "#ffb15a", 26 * scale, 0.5);
  }

  /** Flashbang pop: instant white burst, bright light and a shower of sparks (no fire, no damage). */
  spawnFlashbangVfx(position: Readonly<Vec3>): void {
    const center = new Vector3(position.x, position.y + 0.15, position.z);
    const flash = MeshBuilder.CreatePlane(`fb_flash_${this.fxId++}`, { size: 1 }, this.scene);
    flash.billboardMode = Mesh.BILLBOARDMODE_ALL;
    flash.position.copyFrom(center);
    flash.material = this.flashbangSpriteMat;
    this.addFx(flash, this.flashbangSpriteMat, 0.4, 2, 14, "flash");

    const ring = MeshBuilder.CreateDisc(`fb_ring_${this.fxId++}`, { radius: 0.5, tessellation: 36 }, this.scene);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(position.x, position.y + 0.06, position.z);
    ring.material = this.flashbangRingMat;
    this.addFx(ring, this.flashbangRingMat, 0.5, 1, 11, "ring");

    this.emitBurst("fb_spark", center, 50, 1);
    this.emitBurst("fb_puff", center, 12, 1);
    this.flashLight(center, "#eef6ff", 40, 0.35);
  }

  /**
   * Visual state of a damaged explosive barrel: leaking smoke at first, open flames once below 60%,
   * raging fire (about to blow) at 0%.
   */
  setBarrelDamage(blockId: string, position: Readonly<Vec3>, hpFraction: number): void {
    let state = this.burningBarrels.get(blockId);
    const top = new Vector3(position.x, position.y + 0.72, position.z);
    if (!state) {
      const smoke = this.makeContinuousPs(`barrel_smoke_${blockId}`, top, 40);
      smoke.color1 = new Color4(0.16, 0.16, 0.16, 0.7);
      smoke.color2 = new Color4(0.28, 0.27, 0.26, 0.55);
      smoke.colorDead = new Color4(0.1, 0.1, 0.1, 0);
      smoke.minSize = 0.35;
      smoke.maxSize = 0.9;
      smoke.minLifeTime = 0.9;
      smoke.maxLifeTime = 1.8;
      smoke.direction1 = new Vector3(-0.3, 1.4, -0.3);
      smoke.direction2 = new Vector3(0.3, 2.4, 0.3);
      smoke.gravity = new Vector3(0, 0.5, 0);
      const fire = this.makeContinuousPs(`barrel_fire_${blockId}`, top, 50);
      fire.blendMode = ParticleSystem.BLENDMODE_ONEONE;
      fire.color1 = new Color4(1.0, 0.7, 0.2, 0.55);
      fire.color2 = new Color4(0.9, 0.3, 0.05, 0.45);
      fire.colorDead = new Color4(0.3, 0.05, 0.0, 0);
      fire.minSize = 0.18;
      fire.maxSize = 0.45;
      fire.minLifeTime = 0.25;
      fire.maxLifeTime = 0.55;
      fire.direction1 = new Vector3(-0.35, 2.4, -0.35);
      fire.direction2 = new Vector3(0.35, 3.8, 0.35);
      fire.gravity = new Vector3(0, 1.5, 0);
      fire.minEmitBox = new Vector3(-0.22, 0, -0.22);
      fire.maxEmitBox = new Vector3(0.22, 0.05, 0.22);
      state = { smoke, fire, fuse: false };
      this.burningBarrels.set(blockId, state);
    }
    const damage = 1 - Math.max(0, Math.min(1, hpFraction));
    state.smoke.emitRate = 14 + damage * 40;
    state.fire.emitRate = hpFraction <= 0.6 ? 18 + damage * 40 : 0;
    if (hpFraction <= 0) {
      state.fuse = true;
      state.fire.emitRate = 70;
      state.fire.minSize = 0.3;
      state.fire.maxSize = 0.7;
      state.smoke.emitRate = 70;
    }
  }

  clearBarrelDamage(blockId?: string): void {
    const ids = blockId ? [blockId] : [...this.burningBarrels.keys()];
    for (const id of ids) {
      const s = this.burningBarrels.get(id);
      if (!s) continue;
      s.smoke.dispose();
      s.fire.dispose();
      this.burningBarrels.delete(id);
    }
  }

  private makeContinuousPs(name: string, emitter: Vector3, capacity: number): ParticleSystem {
    const ps = new ParticleSystem(name, capacity, this.scene);
    ps.particleTexture = this.softParticleTex;
    ps.emitter = emitter;
    ps.minEmitBox = new Vector3(-0.12, 0, -0.12);
    ps.maxEmitBox = new Vector3(0.12, 0.05, 0.12);
    ps.emitRate = 0;
    ps.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    ps.start();
    return ps;
  }

  spawnGlassShatter(center: Readonly<Vec3>, size: Readonly<Vec3>): void {
    for (let i = 0; i < 18; i++) {
      const shard = MeshBuilder.CreateBox(
        `shard_${Date.now()}_${i}`,
        {
          width: 0.14 + Math.random() * 0.2,
          height: 0.14 + Math.random() * 0.24,
          depth: 0.03,
        },
        this.scene
      );
      shard.position.set(
        center.x + (Math.random() - 0.5) * size.x * 0.8,
        center.y + (Math.random() - 0.5) * size.y * 0.8,
        center.z + (Math.random() - 0.5) * 0.2
      );
      shard.material = this.glassShardMat;
      shard.isPickable = false;
      this.shards.push({
        mesh: shard,
        vel: new Vector3((Math.random() - 0.5) * 6, 1 + Math.random() * 3.5, (Math.random() - 0.5) * 6),
        rotVel: new Vector3(Math.random() * 12, Math.random() * 12, Math.random() * 12),
        ttl: 1.8,
      });
    }
  }

  updateThrowArc(points: readonly Readonly<Vec3>[], contact?: Readonly<Vec3>): void {
    for (const [i, dot] of this.arcDots.entries()) {
      const point = points[i];
      if (point) dot.position.set(point.x, point.y, point.z);
      dot.setEnabled(!!point);
    }
    if (contact) this.arcLandingRing.position.set(contact.x, contact.y, contact.z);
    this.arcLandingRing.setEnabled(!!contact);
  }

  update(dt: number): void {
    this.tracerPool.forEachActive((t) => {
      t.progress += t.speed * dt;
      let length = Math.max(0.01, Vector3.Distance(t.start, t.segmentEnd));
      while (t.progress >= length) {
        if (t.segment >= (t.bends?.length ?? 0)) {
          t.mesh.setEnabled(false);
          t.bends = undefined;
          this.tracerPool.release(t);
          return;
        }
        t.progress -= length;
        t.start.copyFrom(t.segmentEnd);
        t.mesh.position.copyFrom(t.start);
        t.segment++;
        this.setTracerSegment(t);
        length = Math.max(0.01, Vector3.Distance(t.start, t.segmentEnd));
      }
      Vector3.LerpToRef(t.start, t.segmentEnd, t.progress / length, t.mesh.position);
    });

    for (let i = this.shards.length - 1; i >= 0; i--) {
      const s = this.shards[i];
      s.ttl -= dt;
      if (s.ttl <= 0) {
        s.mesh.dispose();
        this.shards.splice(i, 1);
        continue;
      }
      s.vel.y -= 14 * dt;
      s.mesh.position.addInPlaceFromFloats(s.vel.x * dt, s.vel.y * dt, s.vel.z * dt);
      s.mesh.rotation.addInPlaceFromFloats(s.rotVel.x * dt, s.rotVel.y * dt, s.rotVel.z * dt);
      if (s.mesh.position.y < 0.05) {
        s.mesh.position.y = 0.05;
        s.vel.y = Math.abs(s.vel.y) * 0.35;
        s.vel.x *= 0.6;
        s.vel.z *= 0.6;
      }
    }

    if (this.blastLightTtl > 0) {
      this.blastLightTtl -= dt;
      const k = Math.max(0, this.blastLightTtl / this.blastLightMaxTtl);
      this.blastLight.intensity = this.blastLightPeak * k * k;
    } else if (this.blastLight.intensity !== 0) {
      this.blastLight.intensity = 0;
    }

    for (let i = this.fx.length - 1; i >= 0; i--) {
      const f = this.fx[i];
      f.ttl -= dt;
      if (f.ttl <= 0) {
        f.mesh.dispose();
        this.fx.splice(i, 1);
        continue;
      }
      const t = 1 - f.ttl / f.maxTtl;
      const eased = 1 - (1 - t) * (1 - t) * (1 - t);
      f.mesh.scaling.setAll(f.from + (f.to - f.from) * eased);
      f.mesh.visibility = f.kind === "flash" ? (1 - t) * (1 - t) : f.kind === "dome" ? (1 - t) * 0.3 : 1 - t;
    }

    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.ttl -= dt;
      if (d.ttl <= 0) {
        d.mesh.dispose();
        this.debris.splice(i, 1);
        continue;
      }
      d.vel.y -= 18 * dt;
      d.mesh.position.addInPlaceFromFloats(d.vel.x * dt, d.vel.y * dt, d.vel.z * dt);
      d.mesh.rotation.addInPlaceFromFloats(d.rot.x * dt, d.rot.y * dt, d.rot.z * dt);
      if (d.mesh.position.y < d.floor) {
        d.mesh.position.y = d.floor;
        d.vel.y = Math.abs(d.vel.y) * 0.3;
        d.vel.x *= 0.55;
        d.vel.z *= 0.55;
        d.rot.scaleInPlace(0.5);
      }
      if (d.ttl < 0.5) d.mesh.scaling.setAll(Math.max(0.01, d.ttl / 0.5));
    }

    for (let i = this.scorches.length - 1; i >= 0; i--) {
      const s = this.scorches[i];
      s.ttl -= dt;
      if (s.ttl <= 0) {
        s.mesh.dispose();
        this.scorches.splice(i, 1);
      } else if (s.ttl < 8) {
        s.mesh.visibility = (s.ttl / 8) * 0.9;
      }
    }
  }

  dispose(): void {
    for (const pool of this.impactPools.values()) for (const { ps } of pool) ps.dispose(false);
    this.softParticleTex.dispose();
    this.decalMat.dispose();
    this.glassShardMat.dispose();
    this.tracerMat.dispose();
    for (const d of this.decals) d.dispose();
    for (const s of this.shards) s.mesh.dispose();
    for (const b of this.burstSystems.values()) b.ps.dispose();
    this.burstSystems.clear();
    this.blastLight.dispose();
    this.clearBarrelDamage();
    for (const f of this.fx) f.mesh.dispose();
    for (const d of this.debris) d.mesh.dispose();
    for (const s of this.scorches) s.mesh.dispose();
    for (const m of [this.flashSpriteMat, this.flashbangSpriteMat, this.ringMat, this.flashbangRingMat, this.domeMat, this.scorchMat, this.debrisMat]) m.dispose();
    for (const t of this.fxTextures) t.dispose();
    for (const d of this.arcDots) d.dispose();
    this.arcLandingRing.dispose();
    for (const t of this.tracerPool.getAll()) t.mesh.dispose();
  }
}
