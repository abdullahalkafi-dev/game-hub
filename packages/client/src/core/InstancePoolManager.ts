import {
  Color3,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";
import { ObjectPool, type Vec3 } from "@game/shared";

interface PooledTracer {
  mesh: Mesh;
  ttl: number;
}

interface PooledShell {
  mesh: Mesh;
  vel: Vector3;
  rotSpeed: Vector3;
  ttl: number;
  bounced: boolean;
}

interface PooledImpact {
  mesh: Mesh;
  mat: StandardMaterial;
  ttl: number;
}

/**
 * Zero-GC Combat Visual Pools:
 * - 30 Bullet Tracers
 * - 50 Ejecting Brass Shell Casings
 * - 100 Bullet Impact Marks / Sparks
 */
export class InstancePoolManager {
  private readonly tracerPool: ObjectPool<PooledTracer>;
  private readonly shellPool: ObjectPool<PooledShell>;
  private readonly impactPool: ObjectPool<PooledImpact>;
  private readonly tracerMat: StandardMaterial;
  private readonly shellMat: StandardMaterial;

  constructor(private readonly scene: Scene) {
    this.tracerMat = new StandardMaterial("pool_tracer_mat", scene);
    this.tracerMat.emissiveColor = new Color3(1.0, 0.82, 0.35);
    this.tracerMat.disableLighting = true;
    this.tracerMat.alpha = 0.88;

    this.shellMat = new StandardMaterial("pool_shell_mat", scene);
    this.shellMat.diffuseColor = new Color3(0.88, 0.72, 0.28);
    this.shellMat.specularColor = new Color3(1, 0.9, 0.5);

    this.tracerPool = new ObjectPool<PooledTracer>(30, (i) => {
      const mesh = MeshBuilder.CreateBox(
        `tracer_${i}`,
        { width: 0.028, height: 0.028, depth: 1.0 },
        scene
      );
      mesh.material = this.tracerMat;
      mesh.isPickable = false;
      mesh.setEnabled(false);
      return { mesh, ttl: 0 };
    });

    this.shellPool = new ObjectPool<PooledShell>(50, (i) => {
      const mesh = MeshBuilder.CreateCylinder(
        `shell_${i}`,
        { diameter: 0.016, height: 0.045, tessellation: 6 },
        scene
      );
      mesh.material = this.shellMat;
      mesh.isPickable = false;
      mesh.setEnabled(false);
      return {
        mesh,
        vel: new Vector3(),
        rotSpeed: new Vector3(),
        ttl: 0,
        bounced: false,
      };
    });

    this.impactPool = new ObjectPool<PooledImpact>(100, (i) => {
      const mesh = MeshBuilder.CreateSphere(`impact_${i}`, { diameter: 0.065, segments: 6 }, scene);
      const mat = new StandardMaterial(`impact_mat_${i}`, scene);
      mat.diffuseColor = new Color3(0.15, 0.15, 0.18);
      mat.emissiveColor = new Color3(0.95, 0.65, 0.2);
      mesh.material = mat;
      mesh.isPickable = false;
      mesh.setEnabled(false);
      return { mesh, mat, ttl: 0 };
    });
  }

  spawnTracer(from: Readonly<Vec3>, to: Readonly<Vec3>): void {
    const t = this.tracerPool.acquire();
    if (!t) return;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const dist = Math.max(0.2, Math.hypot(dx, dy, dz));

    t.mesh.position.set((from.x + to.x) * 0.5, (from.y + to.y) * 0.5, (from.z + to.z) * 0.5);
    t.mesh.scaling.set(1, 1, dist);
    t.mesh.lookAt(new Vector3(to.x, to.y, to.z));
    t.mesh.setEnabled(true);
    t.ttl = 0.075;
  }

  spawnShellCasing(origin: Vector3, rightDir: Vector3, upDir: Vector3): void {
    const s = this.shellPool.acquire();
    if (!s) return;
    s.mesh.position.copyFrom(origin);
    s.vel.set(
      rightDir.x * (1.8 + Math.random() * 0.9) + upDir.x * 1.6,
      rightDir.y * 1.2 + upDir.y * (1.7 + Math.random() * 0.6),
      rightDir.z * (1.8 + Math.random() * 0.9) + upDir.z * 1.6
    );
    s.rotSpeed.set(14, 18, 12);
    s.ttl = 1.6;
    s.bounced = false;
    s.mesh.setEnabled(true);
  }

  spawnImpact(point: Readonly<Vec3>, material: string, isBlood = false): void {
    const imp = this.impactPool.acquire();
    if (!imp) return;
    imp.mesh.position.set(point.x, point.y, point.z);
    if (isBlood) {
      imp.mat.diffuseColor.set(0.65, 0.05, 0.08);
      imp.mat.emissiveColor.set(0.55, 0.04, 0.04);
      imp.mesh.scaling.setAll(1.3);
      imp.ttl = 0.35;
    } else if (material === "METAL" || material === "SHEET_METAL") {
      imp.mat.diffuseColor.set(0.95, 0.75, 0.2);
      imp.mat.emissiveColor.set(1.0, 0.65, 0.15);
      imp.mesh.scaling.setAll(0.95);
      imp.ttl = 0.45;
    } else {
      imp.mat.diffuseColor.set(0.14, 0.14, 0.16);
      imp.mat.emissiveColor.set(0.35, 0.3, 0.25);
      imp.mesh.scaling.setAll(0.8);
      imp.ttl = 2.5;
    }
    imp.mesh.setEnabled(true);
  }

  update(dt: number, onShellBounce?: (pos: Vector3) => void): void {
    this.tracerPool.forEachActive((t) => {
      t.ttl -= dt;
      if (t.ttl <= 0) {
        t.mesh.setEnabled(false);
        this.tracerPool.release(t);
      }
    });

    this.shellPool.forEachActive((s) => {
      s.ttl -= dt;
      if (s.ttl <= 0) {
        s.mesh.setEnabled(false);
        this.shellPool.release(s);
        return;
      }
      s.vel.y -= 9.8 * dt;
      s.mesh.position.addInPlaceFromFloats(s.vel.x * dt, s.vel.y * dt, s.vel.z * dt);
      s.mesh.rotation.addInPlaceFromFloats(
        s.rotSpeed.x * dt,
        s.rotSpeed.y * dt,
        s.rotSpeed.z * dt
      );
      if (s.mesh.position.y <= 0.03) {
        s.mesh.position.y = 0.03;
        s.vel.y = Math.abs(s.vel.y) * 0.42;
        s.vel.x *= 0.6;
        s.vel.z *= 0.6;
        if (!s.bounced) {
          s.bounced = true;
          onShellBounce?.(s.mesh.position);
        }
      }
    });

    this.impactPool.forEachActive((imp) => {
      imp.ttl -= dt;
      if (imp.ttl <= 0) {
        imp.mesh.setEnabled(false);
        this.impactPool.release(imp);
      }
    });
  }

  dispose(): void {
    this.tracerMat.dispose();
    this.shellMat.dispose();
    for (const item of this.tracerPool.getAll()) item.mesh.dispose();
    for (const item of this.shellPool.getAll()) item.mesh.dispose();
    for (const item of this.impactPool.getAll()) {
      item.mat.dispose();
      item.mesh.dispose();
    }
  }
}
