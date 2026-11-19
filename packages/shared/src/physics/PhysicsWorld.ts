import RAPIER from "@dimforge/rapier3d-compat";
import type { MapBlockSpec, MapBlueprint, SurfaceMaterialTag } from "../registries/MapRegistry.js";
import type { Vec3 } from "../math/ScratchMath.js";
import { distPointToRay } from "../math/ScratchMath.js";

const RapierApi: typeof RAPIER =
  (RAPIER as unknown as { default?: typeof RAPIER }).default ?? RAPIER;

let rapierInitPromise: Promise<void> | null = null;

export async function initRapier(): Promise<typeof RAPIER> {
  if (!rapierInitPromise) {
    rapierInitPromise = RapierApi.init();
  }
  await rapierInitPromise;
  return RapierApi;
}

export function getRapierSync(): typeof RAPIER {
  return RapierApi;
}

export interface WorldColliderMeta {
  blockId: string;
  material: SurfaceMaterialTag;
  destructible: boolean;
  maxHp: number;
  hp: number;
  thicknessApprox: number;
  spec: MapBlockSpec;
}

export interface SmokeCloudVolume {
  position: Vec3;
  radius: number;
}

export interface BallisticWorldSegment {
  hitPoint: Vec3;
  hitNormal: Vec3;
  distance: number;
  material: SurfaceMaterialTag;
  blockId: string;
  isWallbang: boolean;
  damageMultiplier: number;
}

function eulerXYToQuat(rx = 0, ry = 0): { x: number; y: number; z: number; w: number } {
  const cx = Math.cos(rx * 0.5);
  const sx = Math.sin(rx * 0.5);
  const cy = Math.cos(ry * 0.5);
  const sy = Math.sin(ry * 0.5);
  return {
    x: sx * cy,
    y: cx * sy,
    z: -sx * sy,
    w: cx * cy,
  };
}

/**
 * Shared headless Rapier3D physics world used identically by Client and Server.
 */
export class PhysicsWorld {
  public readonly world: RAPIER.World;
  public readonly map: MapBlueprint;
  private readonly colliderMeta = new Map<number, WorldColliderMeta>();
  private readonly blockIdToCollider = new Map<string, RAPIER.Collider>();
  private readonly playerColliderHandles = new Set<number>();

  constructor(map: MapBlueprint) {
    this.map = map;
    this.world = new RapierApi.World({ x: 0, y: -22.0, z: 0 });
    this.buildMapColliders();
  }

  private buildMapColliders(): void {
    // Solid floor slab
    const floorDesc = RapierApi.ColliderDesc.cuboid(
      this.map.floorSize.width * 0.5,
      0.5,
      this.map.floorSize.depth * 0.5
    ).setTranslation(0, -0.5, 0);
    const floorCollider = this.world.createCollider(floorDesc);
    this.colliderMeta.set(floorCollider.handle, {
      blockId: "floor",
      material: this.map.floorMaterial,
      destructible: false,
      maxHp: 9999,
      hp: 9999,
      thicknessApprox: 1.0,
      spec: {
        id: "floor",
        position: { x: 0, y: -0.5, z: 0 },
        size: { x: this.map.floorSize.width, y: 1, z: this.map.floorSize.depth },
        material: this.map.floorMaterial,
        colorHex: this.map.floorColorHex,
      },
    });

    for (const block of this.map.blocks) {
      if (block.isPuddle) continue;
      this.spawnBlockCollider(block);
    }
    this.world.updateSceneQueries();
  }

  private spawnBlockCollider(block: MapBlockSpec): void {
    if (this.blockIdToCollider.has(block.id)) return;
    const desc = RapierApi.ColliderDesc.cuboid(
      block.size.x * 0.5,
      block.size.y * 0.5,
      block.size.z * 0.5
    ).setTranslation(block.position.x, block.position.y, block.position.z);

    if (block.rotationX || block.rotationY) {
      desc.setRotation(eulerXYToQuat(block.rotationX ?? 0, block.rotationY ?? 0));
    }

    const collider = this.world.createCollider(desc);
    const minSide = Math.min(block.size.x, block.size.y, block.size.z);
    this.colliderMeta.set(collider.handle, {
      blockId: block.id,
      material: block.material,
      destructible: Boolean(block.destructible),
      maxHp: block.maxHp ?? 9999,
      hp: block.maxHp ?? 9999,
      thicknessApprox: minSide,
      spec: block,
    });
    this.blockIdToCollider.set(block.id, collider);
  }

  registerPlayerCollider(handle: number): void {
    this.playerColliderHandles.add(handle);
  }

  unregisterPlayerCollider(handle: number): void {
    this.playerColliderHandles.delete(handle);
  }

  readonly isWorldCollider = (collider: RAPIER.Collider): boolean => !this.playerColliderHandles.has(collider.handle);

  getBlockMeta(colliderHandle: number): WorldColliderMeta | undefined {
    return this.colliderMeta.get(colliderHandle);
  }

  getBlockById(blockId: string): WorldColliderMeta | undefined {
    const col = this.blockIdToCollider.get(blockId);
    if (!col) return undefined;
    return this.colliderMeta.get(col.handle);
  }

  destroyBlock(blockId: string): WorldColliderMeta | null {
    const col = this.blockIdToCollider.get(blockId);
    if (!col) return null;
    const meta = this.colliderMeta.get(col.handle) ?? null;
    this.colliderMeta.delete(col.handle);
    this.blockIdToCollider.delete(blockId);
    this.world.removeCollider(col, false);
    this.world.updateSceneQueries();
    return meta;
  }

  resetDestructibles(): void {
    for (const block of this.map.blocks) {
      if (!block.destructible) continue;
      const existing = this.blockIdToCollider.get(block.id);
      if (existing) {
        const meta = this.colliderMeta.get(existing.handle);
        if (meta) meta.hp = meta.maxHp;
      } else {
        this.spawnBlockCollider(block);
      }
    }
    this.world.updateSceneQueries();
  }

  step(dt: number): void {
    this.world.timestep = dt;
    this.world.step();
  }

  /**
   * Casts a ballistic ray against static/destructible world geometry, supporting
   * thin-cover wallbang penetration through WOOD_THIN and SHEET_METAL (< 0.55m thick).
   */
  castBallisticWorldRay(
    origin: Readonly<Vec3>,
    dir: Readonly<Vec3>,
    maxDistance: number,
    wallbangPower: number
  ): {
    primaryHit: BallisticWorldSegment | null;
    penetrationHit: BallisticWorldSegment | null;
    penetrationExit?: { distance: number; damageMultiplier: number };
  } {
    this.world.updateSceneQueries();
    const ray = new RapierApi.Ray(origin, dir);
    const hit1 = this.world.castRayAndGetNormal(
      ray,
      maxDistance,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      (col) => !this.playerColliderHandles.has(col.handle)
    );

    if (!hit1) {
      return { primaryHit: null, penetrationHit: null };
    }

    const meta1 = this.colliderMeta.get(hit1.collider.handle);
    const hitPoint1: Vec3 = {
      x: origin.x + dir.x * hit1.timeOfImpact,
      y: origin.y + dir.y * hit1.timeOfImpact,
      z: origin.z + dir.z * hit1.timeOfImpact,
    };

    const primaryHit: BallisticWorldSegment = {
      hitPoint: hitPoint1,
      hitNormal: { x: hit1.normal.x, y: hit1.normal.y, z: hit1.normal.z },
      distance: hit1.timeOfImpact,
      material: meta1?.material ?? "CONCRETE",
      blockId: meta1?.blockId ?? "unknown",
      isWallbang: false,
      damageMultiplier: 1.0,
    };

    const canWallbang =
      wallbangPower > 0 &&
      meta1 &&
      (meta1.material === "WOOD_THIN" || meta1.material === "SHEET_METAL") &&
      meta1.thicknessApprox <= 0.55;

    if (!canWallbang) {
      return { primaryHit, penetrationHit: null };
    }

    // Measure thickness along this shot so shallow angles cannot skip through solid cover.
    const entryBias = 0.001;
    const inside = { x: hitPoint1.x + dir.x * entryBias, y: hitPoint1.y + dir.y * entryBias, z: hitPoint1.z + dir.z * entryBias };
    const thickness = hit1.collider.castRay(new RapierApi.Ray(inside, dir), 0.55, false);
    if (thickness < 0) return { primaryHit, penetrationHit: null };
    const stepPast = thickness + entryBias * 2;
    const exitDistance = hit1.timeOfImpact + stepPast;
    const remainingDist = maxDistance - exitDistance;
    if (remainingDist <= 0.25) {
      return { primaryHit, penetrationHit: null };
    }

    const exitOrigin: Vec3 = {
      x: hitPoint1.x + dir.x * stepPast,
      y: hitPoint1.y + dir.y * stepPast,
      z: hitPoint1.z + dir.z * stepPast,
    };
    const exitRay = new RapierApi.Ray(exitOrigin, dir);
    const hit2 = this.world.castRayAndGetNormal(
      exitRay,
      remainingDist,
      true,
      undefined,
      undefined,
      hit1.collider,
      undefined,
      (col) => !this.playerColliderHandles.has(col.handle)
    );

    const penetrationExit = { distance: exitDistance, damageMultiplier: Math.max(0.3, Math.min(0.65, 0.48 * wallbangPower)) };

    if (!hit2) {
      return { primaryHit, penetrationHit: null, penetrationExit };
    }

    const meta2 = this.colliderMeta.get(hit2.collider.handle);
    const totalDist = hit1.timeOfImpact + stepPast + hit2.timeOfImpact;
    const penetrationHit: BallisticWorldSegment = {
      hitPoint: {
        x: exitOrigin.x + dir.x * hit2.timeOfImpact,
        y: exitOrigin.y + dir.y * hit2.timeOfImpact,
        z: exitOrigin.z + dir.z * hit2.timeOfImpact,
      },
      hitNormal: { x: hit2.normal.x, y: hit2.normal.y, z: hit2.normal.z },
      distance: totalDist,
      material: meta2?.material ?? "CONCRETE",
      blockId: meta2?.blockId ?? "unknown",
      isWallbang: true,
      damageMultiplier: penetrationExit.damageMultiplier,
    };

    return { primaryHit, penetrationHit, penetrationExit };
  }

  stepThrowable(position: Vec3, velocity: Vec3, restitution: number, dt: number): boolean {
    const averageY = velocity.y - 9 * dt;
    velocity.y -= 18 * dt;
    const speed = Math.hypot(velocity.x, averageY, velocity.z);
    if (speed < 1e-6) return false;
    const dir = { x: velocity.x / speed, y: averageY / speed, z: velocity.z / speed };
    const hit = this.castBallisticWorldRay(position, dir, speed * dt, 0).primaryHit;
    if (!hit) {
      position.x += velocity.x * dt;
      position.y += averageY * dt;
      position.z += velocity.z * dt;
      return false;
    }

    const normal = hit.hitNormal;
    const dot = velocity.x * normal.x + velocity.y * normal.y + velocity.z * normal.z;
    const impact = Math.min(0, dot);
    const bounce = normal.y > 0.6 && impact > -1.5 ? 0 : restitution;
    velocity.x = (velocity.x - (1 + bounce) * impact * normal.x) * 0.78;
    velocity.y = (velocity.y - (1 + bounce) * impact * normal.y) * 0.78;
    velocity.z = (velocity.z - (1 + bounce) * impact * normal.z) * 0.78;
    position.x = hit.hitPoint.x + normal.x * 0.075;
    position.y = hit.hitPoint.y + normal.y * 0.075;
    position.z = hit.hitPoint.z + normal.z * 0.075;
    return true;
  }

  /**
   * Checks clear line-of-sight between two points against map geometry and active smoke clouds.
   */
  hasLineOfSight(
    from: Readonly<Vec3>,
    to: Readonly<Vec3>,
    activeSmokes: readonly SmokeCloudVolume[] = []
  ): boolean {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < 0.05) return true;

    const dir = { x: dx / dist, y: dy / dist, z: dz / dist };

    for (const smoke of activeSmokes) {
      const smokeDist = distPointToRay(smoke.position, from, dir);
      const distToSmokeCenter = Math.hypot(
        smoke.position.x - from.x,
        smoke.position.y - from.y,
        smoke.position.z - from.z
      );
      if (smokeDist < smoke.radius * 0.88 && distToSmokeCenter < dist + smoke.radius) {
        return false;
      }
    }

    this.world.updateSceneQueries();
    const ray = new RapierApi.Ray(from, dir);
    const hit = this.world.castRay(
      ray,
      dist - 0.15,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      (col) => {
        if (this.playerColliderHandles.has(col.handle)) return false;
        const meta = this.colliderMeta.get(col.handle);
        if (meta && meta.material === "GLASS") return false;
        return true;
      }
    );

    return hit === null;
  }

  dispose(): void {
    this.colliderMeta.clear();
    this.blockIdToCollider.clear();
    this.playerColliderHandles.clear();
    this.world.free();
  }
}
