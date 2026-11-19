export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/**
 * Pre-allocated module-level scratch vectors to prevent V8 GC micro-stutters
 * inside 60Hz physics and 144Hz render loops.
 */
export const _v1: Vec3 = { x: 0, y: 0, z: 0 };
export const _v2: Vec3 = { x: 0, y: 0, z: 0 };
export const _v3: Vec3 = { x: 0, y: 0, z: 0 };
export const _v4: Vec3 = { x: 0, y: 0, z: 0 };

export function vec3Create(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function vec3Set(out: Vec3, x: number, y: number, z: number): Vec3 {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function vec3Copy(out: Vec3, a: Readonly<Vec3>): Vec3 {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  return out;
}

export function vec3Add(out: Vec3, a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 {
  out.x = a.x + b.x;
  out.y = a.y + b.y;
  out.z = a.z + b.z;
  return out;
}

export function vec3Sub(out: Vec3, a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 {
  out.x = a.x - b.x;
  out.y = a.y - b.y;
  out.z = a.z - b.z;
  return out;
}

export function vec3Scale(out: Vec3, a: Readonly<Vec3>, s: number): Vec3 {
  out.x = a.x * s;
  out.y = a.y * s;
  out.z = a.z * s;
  return out;
}

export function vec3Dot(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function vec3LenSq(a: Readonly<Vec3>): number {
  return a.x * a.x + a.y * a.y + a.z * a.z;
}

export function vec3Len(a: Readonly<Vec3>): number {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
}

export function vec3Dist(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function vec3Normalize(out: Vec3, a: Readonly<Vec3>): Vec3 {
  const len = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
  if (len > 1e-8) {
    const inv = 1 / len;
    out.x = a.x * inv;
    out.y = a.y * inv;
    out.z = a.z * inv;
  } else {
    out.x = 0;
    out.y = 0;
    out.z = 0;
  }
  return out;
}

export function vec3Lerp(out: Vec3, a: Readonly<Vec3>, b: Readonly<Vec3>, t: number): Vec3 {
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.z = a.z + (b.z - a.z) * t;
  return out;
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

export function yawPitchToDir(out: Vec3, yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  out.x = Math.sin(yaw) * cp;
  out.y = Math.sin(pitch);
  out.z = Math.cos(yaw) * cp;
  return vec3Normalize(out, out);
}

export function distPointToRay(point: Readonly<Vec3>, rayOrigin: Readonly<Vec3>, rayDir: Readonly<Vec3>): number {
  const px = point.x - rayOrigin.x;
  const py = point.y - rayOrigin.y;
  const pz = point.z - rayOrigin.z;
  const proj = px * rayDir.x + py * rayDir.y + pz * rayDir.z;
  if (proj < 0) {
    return Math.sqrt(px * px + py * py + pz * pz);
  }
  const cx = rayOrigin.x + rayDir.x * proj - point.x;
  const cy = rayOrigin.y + rayDir.y * proj - point.y;
  const cz = rayOrigin.z + rayDir.z * proj - point.z;
  return Math.sqrt(cx * cx + cy * cy + cz * cz);
}
