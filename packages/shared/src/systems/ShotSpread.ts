import type { Vec3 } from "../math/ScratchMath.js";
import type { EffectiveWeaponStats } from "./WeaponStatCalculator.js";

export const PRACTICE_TARGET_RADIUS = 0.27;

export function shotSpreadMultiplier(state: { crouching: boolean; grounded: boolean; speed: number }): number {
  return (state.crouching ? 0.7 : 1) * (state.grounded ? 1 : 2.5) * (state.speed > 1.2 ? 1.5 : 1);
}

export function shotSpreadRadians(stats: Pick<EffectiveWeaponStats, "hipSpreadDeg" | "adsSpreadDeg">,
  ads: boolean, state: Parameters<typeof shotSpreadMultiplier>[0]): number {
  return (ads ? stats.adsSpreadDeg : stats.hipSpreadDeg) * shotSpreadMultiplier(state) * Math.PI / 180;
}

/** Sample a circular cone in aim space, including when aiming across the map or vertically. */
export function sampleShotCone(forward: Readonly<Vec3>, angle: number, radial: number, azimuth: number): Vec3 {
  const horizontal = Math.hypot(forward.x, forward.z);
  const rightX = horizontal > 1e-6 ? forward.z / horizontal : 1;
  const rightZ = horizontal > 1e-6 ? -forward.x / horizontal : 0;
  const upX = forward.y * rightZ;
  const upY = forward.z * rightX - forward.x * rightZ;
  const upZ = -forward.y * rightX;
  const radius = Math.tan(Math.min(angle, Math.PI / 4)) * Math.sqrt(radial);
  const xOffset = radius * Math.cos(azimuth * Math.PI * 2);
  const yOffset = radius * Math.sin(azimuth * Math.PI * 2);
  const x = forward.x + rightX * xOffset + upX * yOffset;
  const y = forward.y + upY * yOffset;
  const z = forward.z + rightZ * xOffset + upZ * yOffset;
  const length = Math.hypot(x, y, z) || 1;
  return { x: x / length, y: y / length, z: z / length };
}
