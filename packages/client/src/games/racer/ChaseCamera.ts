import { FreeCamera, Scene, Vector3 } from "@babylonjs/core";
import { clamp, damp } from "@game/shared";

export type RaceCameraMode = "DYNAMIC_CHASE" | "FAR_CHASE" | "HOOD" | "BUMPER";

export const RACE_CAMERA_MODES: readonly RaceCameraMode[] = [
  "DYNAMIC_CHASE",
  "FAR_CHASE",
  "HOOD",
  "BUMPER",
];

const CAMERA_MODE_LABELS: Record<RaceCameraMode, string> = {
  DYNAMIC_CHASE: "Chase",
  FAR_CHASE: "Far Chase",
  HOOD: "Hood",
  BUMPER: "Bumper",
};

export function getCameraModeLabel(mode: RaceCameraMode): string {
  return CAMERA_MODE_LABELS[mode];
}

export interface ChaseCameraUpdateParams {
  carPos: Vector3;
  carForward: Vector3;
  carUp: Vector3;
  velocity: Vector3;
  speedKmh: number;
  driftAngleRad: number;
  steerInput: number;
  nitroActive: boolean;
  lookBack: boolean;
  launchBoostActive?: boolean;
  inTunnel?: boolean;
  wallScrapeIntensity?: number;
  dt: number;
}

const DEG_TO_RAD = Math.PI / 180;
const WORLD_UP = new Vector3(0, 1, 0);

/**
 * Spring-damped automotive racing camera with:
 * - 4 selectable camera modes (DYNAMIC_CHASE, FAR_CHASE, HOOD, BUMPER) + B Look-Back
 * - Lateral drift swing & heading lag so power-slides show off the car's side profile
 * - Dynamic FOV warp (64 deg cruising -> 90 deg under Nitro)
 * - Speed / Nitro / Guardrail-scrape micro-vibration
 * - Cinematic Finish-Line Orbit & 3D Podium camera
 */
export class ChaseCamera {
  public readonly camera: FreeCamera;
  private _mode: RaceCameraMode = "DYNAMIC_CHASE";

  private initialized = false;
  private wasLookBack = false;
  private orbiting = false;
  private orbitAngle = 0;
  private orbitRadius = 7.2;
  private orbitHeight = 2.05;
  private readonly orbitTarget = new Vector3();

  private readonly smoothedForward = new Vector3(0, 0, 1);
  private readonly currentPos = new Vector3(0, 2.2, -6.2);
  private readonly currentTarget = new Vector3(0, 1.0, 5.0);
  private readonly currentUp = new Vector3(0, 1, 0);

  private currentFovDeg = 64;
  private readonly reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  private currentDist = 6.1;
  private currentDriftSwing = 0;
  private shakeClock = 0;
  private impactShake = 0;

  // Scratch vectors (zero per-frame heap allocations)
  private readonly _fwd = new Vector3();
  private readonly _up = new Vector3();
  private readonly _right = new Vector3();
  private readonly _smoothRight = new Vector3();
  private readonly _desiredPos = new Vector3();
  private readonly _desiredTarget = new Vector3();
  private readonly _desiredUp = new Vector3();
  private readonly _velDir = new Vector3();

  constructor(scene: Scene, name = "racer_chase_cam") {
    this.camera = new FreeCamera(name, new Vector3(0, 2.5, -6.5), scene);
    this.camera.minZ = 0.14;
    this.camera.maxZ = 2400;
    this.camera.inertia = 0;
    this.camera.fov = 64 * DEG_TO_RAD;
    this.camera.inputs.clear();
  }

  get mode(): RaceCameraMode {
    return this._mode;
  }

  get modeLabel(): string {
    return CAMERA_MODE_LABELS[this._mode];
  }

  setMode(mode: RaceCameraMode): void {
    this._mode = mode;
  }

  cycleMode(): RaceCameraMode {
    const idx = RACE_CAMERA_MODES.indexOf(this._mode);
    this._mode = RACE_CAMERA_MODES[(idx + 1) % RACE_CAMERA_MODES.length];
    return this._mode;
  }

  isOrbiting(): boolean {
    return this.orbiting;
  }

  triggerImpactShake(intensity: number): void {
    this.impactShake = Math.min(1, Math.max(this.impactShake, intensity));
  }

  /**
   * Immediately snaps the chase camera behind the car with zero spring lag.
   * Call on grid spawn, track restart, or [R] car reset.
   */
  snapToCar(carPos: Vector3, carForward: Vector3, carUp: Vector3 = WORLD_UP): void {
    this.orbiting = false;
    this.wasLookBack = false;
    this.impactShake = 0;
    this.currentDriftSwing = 0;

    this._fwd.copyFrom(carForward);
    if (this._fwd.lengthSquared() < 1e-5) this._fwd.set(0, 0, 1);
    else this._fwd.normalize();

    this._up.copyFrom(carUp);
    if (this._up.lengthSquared() < 1e-5) this._up.set(0, 1, 0);
    else this._up.normalize();

    this.smoothedForward.copyFrom(this._fwd);
    this.currentUp.copyFrom(this._up);

    const dist = this._mode === "FAR_CHASE" ? 8.1 : 6.1;
    const height = this._mode === "FAR_CHASE" ? 3.0 : 2.15;
    this.currentDist = dist;
    this.currentFovDeg = this._mode === "BUMPER" ? 74 : this._mode === "HOOD" ? 70 : 64;

    if (this._mode === "HOOD") {
      this.currentPos.set(
        carPos.x + this._fwd.x * 0.55 + this._up.x * 1.18,
        carPos.y + this._fwd.y * 0.55 + this._up.y * 1.18,
        carPos.z + this._fwd.z * 0.55 + this._up.z * 1.18
      );
      this.currentTarget.set(
        carPos.x + this._fwd.x * 22 + this._up.x * 0.95,
        carPos.y + this._fwd.y * 22 + this._up.y * 0.95,
        carPos.z + this._fwd.z * 22 + this._up.z * 0.95
      );
    } else if (this._mode === "BUMPER") {
      this.currentPos.set(
        carPos.x + this._fwd.x * 2.25 + this._up.x * 0.58,
        carPos.y + this._fwd.y * 2.25 + this._up.y * 0.58,
        carPos.z + this._fwd.z * 2.25 + this._up.z * 0.58
      );
      this.currentTarget.set(
        carPos.x + this._fwd.x * 26 + this._up.x * 0.56,
        carPos.y + this._fwd.y * 26 + this._up.y * 0.56,
        carPos.z + this._fwd.z * 26 + this._up.z * 0.56
      );
    } else {
      this.currentPos.set(
        carPos.x - this._fwd.x * dist + this._up.x * height,
        carPos.y - this._fwd.y * dist + this._up.y * height,
        carPos.z - this._fwd.z * dist + this._up.z * height
      );
      this.currentTarget.set(
        carPos.x + this._fwd.x * 6.5 + this._up.x * 1.05,
        carPos.y + this._fwd.y * 6.5 + this._up.y * 1.05,
        carPos.z + this._fwd.z * 6.5 + this._up.z * 1.05
      );
    }

    this.camera.fov = this.currentFovDeg * DEG_TO_RAD;
    this.camera.position.copyFrom(this.currentPos);
    this.camera.upVector.copyFrom(WORLD_UP);
    this.camera.setTarget(this.currentTarget);
    this.initialized = true;
  }

  /**
   * Transitions smoothly into a cinematic 360-degree Finish-Line / 3D Podium orbit.
   */
  enterFinishOrbit(targetPos: Vector3, carForward?: Vector3, radius = 7.4, height = 2.05): void {
    this.orbiting = true;
    this.orbitTarget.copyFrom(targetPos);
    this.orbitRadius = radius;
    this.orbitHeight = height;
    if (carForward && carForward.lengthSquared() > 1e-4) {
      // Start from dramatic front-3/4 hero angle
      this.orbitAngle = Math.atan2(carForward.x, carForward.z) + 0.65;
    } else {
      const dx = this.camera.position.x - targetPos.x;
      const dz = this.camera.position.z - targetPos.z;
      this.orbitAngle = Math.atan2(dx, dz);
    }
  }

  exitFinishOrbit(): void {
    this.orbiting = false;
  }

  updateOrbit(dt: number, liveTargetPos?: Vector3): void {
    const safeDt = Math.min(0.05, Math.max(0.001, dt));
    if (liveTargetPos) {
      this.orbitTarget.x = damp(this.orbitTarget.x, liveTargetPos.x, 6, safeDt);
      this.orbitTarget.y = damp(this.orbitTarget.y, liveTargetPos.y, 6, safeDt);
      this.orbitTarget.z = damp(this.orbitTarget.z, liveTargetPos.z, 6, safeDt);
    }

    this.orbitAngle += safeDt * 0.36;
    const desiredX = this.orbitTarget.x + Math.sin(this.orbitAngle) * this.orbitRadius;
    const desiredZ = this.orbitTarget.z + Math.cos(this.orbitAngle) * this.orbitRadius;
    const desiredY = this.orbitTarget.y + this.orbitHeight + Math.sin(this.orbitAngle * 1.4) * 0.32;

    this.currentPos.x = damp(this.currentPos.x, desiredX, 4.5, safeDt);
    this.currentPos.y = damp(this.currentPos.y, desiredY, 4.5, safeDt);
    this.currentPos.z = damp(this.currentPos.z, desiredZ, 4.5, safeDt);

    this.currentTarget.x = damp(this.currentTarget.x, this.orbitTarget.x, 7.5, safeDt);
    this.currentTarget.y = damp(this.currentTarget.y, this.orbitTarget.y + 0.85, 7.5, safeDt);
    this.currentTarget.z = damp(this.currentTarget.z, this.orbitTarget.z, 7.5, safeDt);

    this.currentFovDeg = damp(this.currentFovDeg, 54, 4.5, safeDt);
    this.camera.fov = this.currentFovDeg * DEG_TO_RAD;
    this.camera.position.copyFrom(this.currentPos);
    this.camera.upVector.set(0, 1, 0);
    this.camera.setTarget(this.currentTarget);
  }

  update(params: ChaseCameraUpdateParams): void {
    if (this.orbiting) {
      this.updateOrbit(params.dt, params.carPos);
      return;
    }

    const dt = Math.min(0.05, Math.max(0.001, params.dt));
    if (!this.initialized) {
      this.snapToCar(params.carPos, params.carForward, params.carUp);
    }

    this._fwd.copyFrom(params.carForward);
    if (this._fwd.lengthSquared() < 1e-5) this._fwd.set(0, 0, 1);
    else this._fwd.normalize();

    this._up.copyFrom(params.carUp);
    if (this._up.lengthSquared() < 1e-5) this._up.set(0, 1, 0);
    else this._up.normalize();

    // LH coordinate system: Cross(Up, Forward) = Right
    Vector3.CrossToRef(this._up, this._fwd, this._right);
    if (this._right.lengthSquared() < 1e-5) this._right.set(1, 0, 0);
    else this._right.normalize();

    const speedNorm = clamp(params.speedKmh / 310, 0, 1);
    const lookBackToggled = params.lookBack !== this.wasLookBack;
    this.wasLookBack = params.lookBack;

    this.shakeClock += dt;
    this.impactShake = Math.max(0, this.impactShake - dt * 2.8);

    // Subtle speed/nitro/scrape vibration
    const speedShake = Math.max(0, (params.speedKmh - 145) / 170) * 0.018;
    const nitroShake = params.nitroActive ? 0.036 : params.launchBoostActive ? 0.025 : 0;
    const scrapeShake = (params.wallScrapeIntensity ?? 0) * 0.075;
    const totalShake = this.reducedMotion.matches ? 0 : speedShake + nitroShake + scrapeShake + this.impactShake * 0.14;
    const shakeX = totalShake > 0.001
      ? (Math.sin(this.shakeClock * 53.1) * 0.65 + Math.cos(this.shakeClock * 89.7) * 0.35) * totalShake
      : 0;
    const shakeY = totalShake > 0.001
      ? (Math.cos(this.shakeClock * 61.3) * 0.65 + Math.sin(this.shakeClock * 97.9) * 0.35) * totalShake * 0.8
      : 0;

    // Look-Back mode overrides framing cleanly without spinning through the car
    if (params.lookBack) {
      const isCockpit = this._mode === "HOOD" || this._mode === "BUMPER";
      if (isCockpit) {
        this._desiredPos.set(
          params.carPos.x - this._fwd.x * 1.5 + this._up.x * 1.38,
          params.carPos.y - this._fwd.y * 1.5 + this._up.y * 1.38,
          params.carPos.z - this._fwd.z * 1.5 + this._up.z * 1.38
        );
        this._desiredTarget.set(
          params.carPos.x - this._fwd.x * 24 + this._up.x * 1.05,
          params.carPos.y - this._fwd.y * 24 + this._up.y * 1.05,
          params.carPos.z - this._fwd.z * 24 + this._up.z * 1.05
        );
      } else {
        this._desiredPos.set(
          params.carPos.x + this._fwd.x * 5.9 + this._up.x * 1.95,
          params.carPos.y + this._fwd.y * 5.9 + this._up.y * 1.95,
          params.carPos.z + this._fwd.z * 5.9 + this._up.z * 1.95
        );
        this._desiredTarget.set(
          params.carPos.x - this._fwd.x * 10.0 + this._up.x * 1.0,
          params.carPos.y - this._fwd.y * 10.0 + this._up.y * 1.0,
          params.carPos.z - this._fwd.z * 10.0 + this._up.z * 1.0
        );
      }

      this.currentPos.copyFrom(this._desiredPos);
      this.currentTarget.copyFrom(this._desiredTarget);
      this.camera.position.set(
        this.currentPos.x + this._right.x * shakeX,
        this.currentPos.y + shakeY,
        this.currentPos.z + this._right.z * shakeX
      );
      this.camera.upVector.set(0, 1, 0);
      this.camera.setTarget(this.currentTarget);
      return;
    }

    // Dynamic FOV warp (64 deg cruising -> 90 deg under Nitro)
    let targetFov = 64;
    if (this._mode === "DYNAMIC_CHASE") {
      targetFov = 64 + speedNorm * 14 + (params.nitroActive ? 12 : 0) + (params.launchBoostActive ? 5 : 0);
    } else if (this._mode === "FAR_CHASE") {
      targetFov = 62 + speedNorm * 12 + (params.nitroActive ? 10 : 0) + (params.launchBoostActive ? 4 : 0);
    } else if (this._mode === "HOOD") {
      targetFov = 70 + speedNorm * 10 + (params.nitroActive ? 12 : 0);
    } else {
      targetFov = 74 + speedNorm * 10 + (params.nitroActive ? 12 : 0);
    }
    if (this.reducedMotion.matches) {
      targetFov = this._mode === "BUMPER" ? 74 : this._mode === "HOOD" ? 70 : 64;
    }
    targetFov = clamp(targetFov, 60, 96);
    const fovLambda = params.nitroActive ? 6.8 : 4.2;
    this.currentFovDeg = damp(this.currentFovDeg, targetFov, fovLambda, dt);
    this.camera.fov = this.currentFovDeg * DEG_TO_RAD;

    // Rigid cockpit-mounted cameras (HOOD / BUMPER)
    if (this._mode === "HOOD" || this._mode === "BUMPER") {
      const fwdOffset = this._mode === "HOOD" ? 0.55 : 2.25;
      const upOffset = this._mode === "HOOD" ? 1.18 : 0.58;
      const lookDist = this._mode === "HOOD" ? 24 : 26;
      const lookUp = this._mode === "HOOD" ? 0.96 : 0.56;

      this.currentPos.set(
        params.carPos.x + this._fwd.x * fwdOffset + this._up.x * upOffset + this._right.x * shakeX * 0.5,
        params.carPos.y + this._fwd.y * fwdOffset + this._up.y * upOffset + shakeY * 0.5,
        params.carPos.z + this._fwd.z * fwdOffset + this._up.z * upOffset + this._right.z * shakeX * 0.5
      );
      this.currentTarget.set(
        params.carPos.x + this._fwd.x * lookDist + this._up.x * lookUp,
        params.carPos.y + this._fwd.y * lookDist + this._up.y * lookUp,
        params.carPos.z + this._fwd.z * lookDist + this._up.z * lookUp
      );

      this.smoothedForward.copyFrom(this._fwd);
      Vector3.LerpToRef(WORLD_UP, this._up, 0.72, this._desiredUp);
      this._desiredUp.normalize();
      this.currentUp.x = damp(this.currentUp.x, this._desiredUp.x, 12, dt);
      this.currentUp.y = damp(this.currentUp.y, this._desiredUp.y, 12, dt);
      this.currentUp.z = damp(this.currentUp.z, this._desiredUp.z, 12, dt);
      this.currentUp.normalize();

      this.camera.position.copyFrom(this.currentPos);
      this.camera.upVector.copyFrom(this.currentUp);
      this.camera.setTarget(this.currentTarget);
      return;
    }

    // Chase cameras (DYNAMIC_CHASE & FAR_CHASE)
    // Blend velocity heading slightly into follow direction during high-speed drifts so the car's
    // sweeping tail angle is showcased dramatically without losing sight of the corner apex.
    const velHorizSq = params.velocity.x * params.velocity.x + params.velocity.z * params.velocity.z;
    if (velHorizSq > 25 && params.speedKmh > 25) {
      this._velDir.copyFrom(params.velocity).normalize();
      const dot = Vector3.Dot(this._velDir, this._fwd);
      if (dot > 0.25) {
        // Blend 35% velocity vector + 65% car heading
        this._velDir.scaleInPlace(0.35);
        this._velDir.addInPlaceFromFloats(this._fwd.x * 0.65, this._fwd.y * 0.65, this._fwd.z * 0.65);
        this._velDir.normalize();
      } else {
        this._velDir.copyFrom(this._fwd);
      }
    } else {
      this._velDir.copyFrom(this._fwd);
    }

    const driftMag = Math.abs(params.driftAngleRad);
    const headingLambda = clamp(7.2 - driftMag * 2.2 + speedNorm * 1.4, 3.8, 9.5);
    if (lookBackToggled) {
      this.smoothedForward.copyFrom(this._velDir);
    } else {
      this.smoothedForward.x = damp(this.smoothedForward.x, this._velDir.x, headingLambda, dt);
      this.smoothedForward.y = damp(this.smoothedForward.y, this._velDir.y, headingLambda, dt);
      this.smoothedForward.z = damp(this.smoothedForward.z, this._velDir.z, headingLambda, dt);
      if (this.smoothedForward.lengthSquared() < 1e-5) this.smoothedForward.copyFrom(this._fwd);
      else this.smoothedForward.normalize();
    }

    Vector3.CrossToRef(WORLD_UP, this.smoothedForward, this._smoothRight);
    if (this._smoothRight.lengthSquared() < 1e-5) this._smoothRight.copyFrom(this._right);
    else this._smoothRight.normalize();

    const isFar = this._mode === "FAR_CHASE";
    const baseDist = isFar ? 8.1 : 6.05;
    const speedStretch = isFar ? speedNorm * 1.15 : speedNorm * 0.95;
    const boostPullback = params.nitroActive ? (isFar ? 0.75 : 0.68) : params.launchBoostActive ? 0.42 : 0;
    const targetDist = baseDist + speedStretch + boostPullback;
    this.currentDist = damp(this.currentDist, targetDist, params.nitroActive ? 5.5 : 4.2, dt);

    const tunnelDrop = params.inTunnel ? (isFar ? 0.55 : 0.28) : 0;
    const height = (isFar ? 3.05 : 2.18) + speedNorm * 0.12 - tunnelDrop;

    const targetDriftSwing =
      clamp(params.driftAngleRad, -0.78, 0.78) * (isFar ? 1.15 : 1.55) +
      clamp(params.steerInput, -1, 1) * (isFar ? 0.25 : 0.42) * speedNorm;
    this.currentDriftSwing = damp(this.currentDriftSwing, targetDriftSwing, 5.2, dt);

    this._desiredPos.set(
      params.carPos.x - this.smoothedForward.x * this.currentDist + this._smoothRight.x * this.currentDriftSwing,
      params.carPos.y - this.smoothedForward.y * this.currentDist * 0.45 + height,
      params.carPos.z - this.smoothedForward.z * this.currentDist + this._smoothRight.z * this.currentDriftSwing
    );

    // Never clip below the road plane on crests
    const minCamY = params.carPos.y + 0.85;
    if (this._desiredPos.y < minCamY) this._desiredPos.y = minCamY;

    const lookAhead = isFar ? 7.8 : 6.2 + speedNorm * 2.4;
    this._desiredTarget.set(
      params.carPos.x + this._fwd.x * lookAhead + this._smoothRight.x * (this.currentDriftSwing * 0.24),
      params.carPos.y + this._fwd.y * lookAhead * 0.5 + (isFar ? 1.15 : 1.05),
      params.carPos.z + this._fwd.z * lookAhead + this._smoothRight.z * (this.currentDriftSwing * 0.24)
    );

    if (lookBackToggled) {
      this.currentPos.copyFrom(this._desiredPos);
      this.currentTarget.copyFrom(this._desiredTarget);
    } else {
      const posLambda = isFar ? 11.5 : 13.5;
      this.currentPos.x = damp(this.currentPos.x, this._desiredPos.x, posLambda, dt);
      this.currentPos.y = damp(this.currentPos.y, this._desiredPos.y, posLambda * 0.85, dt);
      this.currentPos.z = damp(this.currentPos.z, this._desiredPos.z, posLambda, dt);

      const targetLambda = 16.0;
      this.currentTarget.x = damp(this.currentTarget.x, this._desiredTarget.x, targetLambda, dt);
      this.currentTarget.y = damp(this.currentTarget.y, this._desiredTarget.y, targetLambda, dt);
      this.currentTarget.z = damp(this.currentTarget.z, this._desiredTarget.z, targetLambda, dt);
    }

    // Subtle track-banking + drift horizon tilt
    const bankTilt = this.reducedMotion.matches ? 0 : clamp(params.driftAngleRad * 0.045, -0.04, 0.04);
    Vector3.LerpToRef(WORLD_UP, this._up, 0.36, this._desiredUp);
    this._desiredUp.addInPlaceFromFloats(
      this._smoothRight.x * bankTilt,
      0,
      this._smoothRight.z * bankTilt
    );
    this._desiredUp.normalize();
    this.currentUp.x = damp(this.currentUp.x, this._desiredUp.x, 7.5, dt);
    this.currentUp.y = damp(this.currentUp.y, this._desiredUp.y, 7.5, dt);
    this.currentUp.z = damp(this.currentUp.z, this._desiredUp.z, 7.5, dt);
    this.currentUp.normalize();

    this.camera.position.set(
      this.currentPos.x + this._smoothRight.x * shakeX,
      this.currentPos.y + shakeY,
      this.currentPos.z + this._smoothRight.z * shakeX
    );
    this.camera.upVector.copyFrom(this.currentUp);
    this.camera.setTarget(this.currentTarget);
  }

  dispose(): void {
    this.camera.dispose();
  }
}
