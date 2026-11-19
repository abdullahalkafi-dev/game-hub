import { clamp, lerp, type Vec3 } from "../math/ScratchMath.js";

export type TrackId = "tokyo_midnight" | "coastal_sunset" | "harbor_gp";
export type TrackTheme = "TOKYO_MIDNIGHT" | "COASTAL_SUNSET" | "HARBOR_GP";

export interface TrackControlPoint {
  x: number;
  y: number;
  z: number;
  /** Paved road width in meters (16..20m) */
  roadWidth?: number;
  /** Banking angle in radians (+ tilts right edge up for left turns, - tilts left edge up for right turns) */
  bankRad?: number;
  /** True when inside a roofed concrete tunnel segment */
  isTunnel?: boolean;
  /** True when outer shoulder has gravel surface */
  hasGravelShoulder?: boolean;
}

export interface TrackBlueprint {
  id: TrackId;
  name: string;
  subtitle: string;
  theme: TrackTheme;
  laps: number;
  defaultRoadWidth: number;
  shoulderWidth: number;
  isNight: boolean;
  asphaltRoughness: number;
  checkpointCount: number;
  sampleCount: number;
  parLapMs: number;
  controlPoints: readonly TrackControlPoint[];
}

export interface TrackFrame {
  index: number;
  /** Normalized arc-length progress [0, 1) */
  t: number;
  /** Arc length in meters from start/finish line */
  distanceM: number;
  position: Vec3;
  /** Unit tangent forward along the track */
  forward: Vec3;
  /** Unit right vector tilted by road bank */
  right: Vec3;
  /** Unit up normal perpendicular to banked road surface */
  up: Vec3;
  /** Horizontal heading yaw in radians (atan2(forward.x, forward.z)) */
  yaw: number;
  /** Longitudinal road slope pitch in radians */
  pitch: number;
  /** Bank angle in radians */
  bankRad: number;
  roadWidth: number;
  shoulderWidth: number;
  /** Signed horizontal curvature in rad/m (+ turning right, - turning left) */
  curvature: number;
  isTunnel: boolean;
  hasGravelShoulder: boolean;
  kerbLeft: boolean;
  kerbRight: boolean;
}

export interface TrackCheckpoint {
  index: number;
  t: number;
  distanceM: number;
  position: Vec3;
  forward: Vec3;
  right: Vec3;
  up: Vec3;
  yaw: number;
  roadWidth: number;
}

export interface TrackGridSlot {
  slotIndex: number;
  position: Vec3;
  yaw: number;
  pitch: number;
  lateralOffset: number;
  distanceBehindStartM: number;
}

export interface TrackProjection {
  t: number;
  distanceM: number;
  frameIndex: number;
  frame: TrackFrame;
  /** Signed lateral distance from centerline (+ right, - left) in meters */
  lateralOffset: number;
  /** Height offset of point above banked road surface */
  verticalOffset: number;
  /** Exact Y height of banked road surface at this lateral offset */
  surfaceY: number;
  surfaceNormal: Vec3;
  roadHalfWidth: number;
  guardrailHalfWidth: number;
  inTunnel: boolean;
  onGravel: boolean;
}

export const TRACK_REGISTRY: Record<TrackId, TrackBlueprint> = {
  tokyo_midnight: {
    id: "tokyo_midnight",
    name: "Tokyo Midnight Expressway",
    subtitle: "Wet neon highway loops with echoing concrete tunnel",
    theme: "TOKYO_MIDNIGHT",
    laps: 2,
    defaultRoadWidth: 18,
    shoulderWidth: 2.6,
    isNight: true,
    asphaltRoughness: 0.25,
    checkpointCount: 16,
    sampleCount: 320,
    parLapMs: 31000,
    controlPoints: [
      { x: 0, y: 0, z: 0, roadWidth: 18, bankRad: 0 },
      { x: 0, y: 0, z: 115, roadWidth: 18, bankRad: 0 },
      { x: 18, y: 2.5, z: 225, roadWidth: 18, bankRad: -0.05 },
      { x: 96, y: 5.5, z: 292, roadWidth: 19, bankRad: -0.1 },
      { x: 205, y: 7.0, z: 300, roadWidth: 19, bankRad: -0.06 },
      { x: 308, y: 5.5, z: 242, roadWidth: 18, bankRad: -0.09 },
      { x: 356, y: 2.5, z: 140, roadWidth: 17, bankRad: -0.05, isTunnel: true },
      { x: 352, y: 1.0, z: 18, roadWidth: 17, bankRad: 0, isTunnel: true },
      { x: 328, y: 1.0, z: -104, roadWidth: 17, bankRad: -0.05, isTunnel: true },
      { x: 256, y: 3.0, z: -206, roadWidth: 19, bankRad: -0.11 },
      { x: 146, y: 3.5, z: -240, roadWidth: 19, bankRad: -0.08 },
      { x: 46, y: 1.5, z: -212, roadWidth: 18, bankRad: -0.04 },
      { x: 0, y: 0, z: -145, roadWidth: 18, bankRad: 0 },
      { x: 0, y: 0, z: -72, roadWidth: 18, bankRad: 0 },
    ],
  },
  coastal_sunset: {
    id: "coastal_sunset",
    name: "Coastal Sunset Canyon",
    subtitle: "Golden-hour mountain pass with elevation crests and gravel shoulders",
    theme: "COASTAL_SUNSET",
    laps: 2,
    defaultRoadWidth: 17,
    shoulderWidth: 3.4,
    isNight: false,
    asphaltRoughness: 0.62,
    checkpointCount: 16,
    sampleCount: 320,
    parLapMs: 33000,
    controlPoints: [
      { x: 0, y: 0, z: 0, roadWidth: 17, bankRad: 0, hasGravelShoulder: true },
      { x: 0, y: 2.0, z: 108, roadWidth: 17, bankRad: 0, hasGravelShoulder: true },
      { x: 24, y: 10.5, z: 215, roadWidth: 17, bankRad: -0.06, hasGravelShoulder: true },
      { x: 104, y: 19.0, z: 292, roadWidth: 17, bankRad: -0.1, hasGravelShoulder: true },
      { x: 218, y: 23.5, z: 312, roadWidth: 17, bankRad: -0.07, hasGravelShoulder: true },
      { x: 326, y: 19.5, z: 256, roadWidth: 17, bankRad: -0.1, hasGravelShoulder: true },
      { x: 368, y: 11.0, z: 146, roadWidth: 17, bankRad: -0.06, hasGravelShoulder: true },
      { x: 314, y: 6.0, z: 42, roadWidth: 17, bankRad: 0.09, hasGravelShoulder: true },
      { x: 366, y: 4.0, z: -72, roadWidth: 17, bankRad: -0.1, hasGravelShoulder: true },
      { x: 322, y: 2.0, z: -186, roadWidth: 17, bankRad: -0.09, hasGravelShoulder: true },
      { x: 214, y: 3.5, z: -256, roadWidth: 18, bankRad: -0.09, hasGravelShoulder: true },
      { x: 92, y: 4.0, z: -246, roadWidth: 17, bankRad: -0.06, hasGravelShoulder: true },
      { x: 10, y: 1.2, z: -186, roadWidth: 17, bankRad: -0.02, hasGravelShoulder: true },
      { x: 0, y: 0, z: -92, roadWidth: 17, bankRad: 0, hasGravelShoulder: true },
    ],
  },
  harbor_gp: {
    id: "harbor_gp",
    name: "Harbor Grand Prix Circuit",
    subtitle: "Technical daylight circuit with chicanes, kerbs & long slipstream straight",
    theme: "HARBOR_GP",
    laps: 3,
    defaultRoadWidth: 20,
    shoulderWidth: 3.0,
    isNight: false,
    asphaltRoughness: 0.5,
    checkpointCount: 16,
    sampleCount: 320,
    parLapMs: 28000,
    controlPoints: [
      { x: 0, y: 0, z: 0, roadWidth: 20, bankRad: 0 },
      { x: 0, y: 0, z: 145, roadWidth: 20, bankRad: 0 },
      { x: 0, y: 0, z: 270, roadWidth: 20, bankRad: 0 },
      { x: 68, y: 1.0, z: 334, roadWidth: 20, bankRad: -0.05 },
      { x: 176, y: 2.0, z: 324, roadWidth: 19, bankRad: -0.04 },
      { x: 244, y: 2.5, z: 248, roadWidth: 19, bankRad: -0.06 },
      { x: 218, y: 1.8, z: 138, roadWidth: 18, bankRad: 0.05 },
      { x: 286, y: 1.0, z: 42, roadWidth: 19, bankRad: -0.06 },
      { x: 304, y: 0.0, z: -72, roadWidth: 20, bankRad: -0.02 },
      { x: 252, y: 0.0, z: -182, roadWidth: 20, bankRad: -0.06 },
      { x: 146, y: 0.0, z: -236, roadWidth: 20, bankRad: -0.05 },
      { x: 42, y: 0.0, z: -214, roadWidth: 20, bankRad: -0.04 },
      { x: 0, y: 0, z: -135, roadWidth: 20, bankRad: 0 },
      { x: 0, y: 0, z: -68, roadWidth: 20, bankRad: 0 },
    ],
  },
};

export const TRACK_LIST: readonly TrackBlueprint[] = Object.values(TRACK_REGISTRY);
export const DEFAULT_TRACK_ID: TrackId = "tokyo_midnight";

export function isTrackId(id: string | undefined): id is TrackId {
  return typeof id === "string" && id in TRACK_REGISTRY;
}

export function getTrackBlueprint(id?: string): TrackBlueprint {
  if (isTrackId(id)) {
    return TRACK_REGISTRY[id];
  }
  return TRACK_REGISTRY[DEFAULT_TRACK_ID];
}

function resolveBlueprint(trackOrId: TrackBlueprint | TrackId | string): TrackBlueprint {
  return typeof trackOrId === "string" ? getTrackBlueprint(trackOrId) : trackOrId;
}

/**
 * Evaluates a closed centripetal Catmull-Rom spline (alpha = 0.5) on a single segment
 * between p1 (u=0) and p2 (u=1) using neighboring control points p0 and p3.
 * Centripetal parameterization guarantees zero cusps or unintended loops.
 */
function evalCentripetalCatmullRomVec3(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, u: number): Vec3 {
  const alpha = 0.5;
  const distAlpha = (a: Vec3, b: Vec3): number => {
    const d = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    return Math.pow(Math.max(d, 1e-4), alpha);
  };

  const t0 = 0;
  const t1 = t0 + distAlpha(p0, p1);
  const t2 = t1 + distAlpha(p1, p2);
  const t3 = t2 + distAlpha(p2, p3);
  const t = lerp(t1, t2, clamp(u, 0, 1));

  const interp = (a: Vec3, b: Vec3, ta: number, tb: number): Vec3 => {
    const denom = Math.max(tb - ta, 1e-6);
    const w1 = (tb - t) / denom;
    const w2 = (t - ta) / denom;
    return {
      x: a.x * w1 + b.x * w2,
      y: a.y * w1 + b.y * w2,
      z: a.z * w1 + b.z * w2,
    };
  };

  const a1 = interp(p0, p1, t0, t1);
  const a2 = interp(p1, p2, t1, t2);
  const a3 = interp(p2, p3, t2, t3);

  const b1 = interp(a1, a2, t0, t2);
  const b2 = interp(a2, a3, t1, t3);

  return interp(b1, b2, t1, t2);
}

function evalCatmullRomScalar(v0: number, v1: number, v2: number, v3: number, u: number): number {
  const u2 = u * u;
  const u3 = u2 * u;
  return (
    0.5 *
    (2 * v1 +
      (-v0 + v2) * u +
      (2 * v0 - 5 * v1 + 4 * v2 - v3) * u2 +
      (-v0 + 3 * v1 - 3 * v2 + v3) * u3)
  );
}

function cross(a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function normalize(v: Readonly<Vec3>): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z);
  if (len < 1e-8) return { x: 0, y: 0, z: 1 };
  const inv = 1 / len;
  return { x: v.x * inv, y: v.y * inv, z: v.z * inv };
}

function wrapAngleRad(a: number): number {
  let r = a;
  while (r > Math.PI) r -= Math.PI * 2;
  while (r < -Math.PI) r += Math.PI * 2;
  return r;
}

interface BuiltTrackCache {
  frames: TrackFrame[];
  totalLength: number;
  checkpoints: TrackCheckpoint[];
}

const trackCache = new Map<string, BuiltTrackCache>();

function buildTrackData(bp: TrackBlueprint, sampleCount: number): BuiltTrackCache {
  const pts = bp.controlPoints;
  const n = pts.length;
  const densePerSeg = 32;
  const denseCount = n * densePerSeg;

  interface DenseSample {
    pos: Vec3;
    roadWidth: number;
    bankRad: number;
    isTunnel: boolean;
    hasGravelShoulder: boolean;
    cumDist: number;
  }

  const dense: DenseSample[] = new Array(denseCount + 1);
  let cumDist = 0;

  for (let i = 0; i <= denseCount; i++) {
    const segIdx = Math.floor(i / densePerSeg) % n;
    const u = i === denseCount ? 0 : (i % densePerSeg) / densePerSeg;

    const p0 = pts[(segIdx - 1 + n) % n];
    const p1 = pts[segIdx];
    const p2 = pts[(segIdx + 1) % n];
    const p3 = pts[(segIdx + 2) % n];

    const pos = evalCentripetalCatmullRomVec3(p0, p1, p2, p3, u);
    const rw0 = p0.roadWidth ?? bp.defaultRoadWidth;
    const rw1 = p1.roadWidth ?? bp.defaultRoadWidth;
    const rw2 = p2.roadWidth ?? bp.defaultRoadWidth;
    const rw3 = p3.roadWidth ?? bp.defaultRoadWidth;
    const roadWidth = clamp(evalCatmullRomScalar(rw0, rw1, rw2, rw3, u), 14, 24);

    const b0 = p0.bankRad ?? 0;
    const b1 = p1.bankRad ?? 0;
    const b2 = p2.bankRad ?? 0;
    const b3 = p3.bankRad ?? 0;
    const bankRad = clamp(evalCatmullRomScalar(b0, b1, b2, b3, u), -0.22, 0.22);

    const isTunnel = Boolean(p1.isTunnel && p2.isTunnel);
    const hasGravelShoulder = Boolean(p1.hasGravelShoulder || p2.hasGravelShoulder);

    if (i > 0) {
      const prev = dense[i - 1].pos;
      cumDist += Math.hypot(pos.x - prev.x, pos.y - prev.y, pos.z - prev.z);
    }
    dense[i] = { pos, roadWidth, bankRad, isTunnel, hasGravelShoulder, cumDist };
  }

  const totalLength = cumDist;
  const rawPositions: Vec3[] = new Array(sampleCount);
  const rawMeta: {
    distanceM: number;
    roadWidth: number;
    bankRad: number;
    isTunnel: boolean;
    hasGravelShoulder: boolean;
  }[] = new Array(sampleCount);

  // Arc-length uniform resampling
  let dCursor = 0;
  for (let i = 0; i < sampleCount; i++) {
    const targetDist = (i / sampleCount) * totalLength;
    while (dCursor < denseCount - 1 && dense[dCursor + 1].cumDist < targetDist) {
      dCursor++;
    }
    const a = dense[dCursor];
    const b = dense[dCursor + 1];
    const span = Math.max(b.cumDist - a.cumDist, 1e-6);
    const alpha = clamp((targetDist - a.cumDist) / span, 0, 1);

    rawPositions[i] = {
      x: lerp(a.pos.x, b.pos.x, alpha),
      y: lerp(a.pos.y, b.pos.y, alpha),
      z: lerp(a.pos.z, b.pos.z, alpha),
    };
    rawMeta[i] = {
      distanceM: targetDist,
      roadWidth: lerp(a.roadWidth, b.roadWidth, alpha),
      bankRad: lerp(a.bankRad, b.bankRad, alpha),
      isTunnel: alpha < 0.5 ? a.isTunnel : b.isTunnel,
      hasGravelShoulder: alpha < 0.5 ? a.hasGravelShoulder : b.hasGravelShoulder,
    };
  }

  const segStepM = totalLength / sampleCount;
  const worldUp: Vec3 = { x: 0, y: 1, z: 0 };
  const frames: TrackFrame[] = new Array(sampleCount);

  for (let i = 0; i < sampleCount; i++) {
    const prev = rawPositions[(i - 1 + sampleCount) % sampleCount];
    const curr = rawPositions[i];
    const next = rawPositions[(i + 1) % sampleCount];
    const meta = rawMeta[i];

    const forward = normalize({
      x: next.x - prev.x,
      y: next.y - prev.y,
      z: next.z - prev.z,
    });

    // Left-handed Y-up: cross(worldUp, forward) = +right
    const flatRight = normalize(cross(worldUp, forward));
    const flatUp = normalize(cross(forward, flatRight));

    const cb = Math.cos(meta.bankRad);
    const sb = Math.sin(meta.bankRad);
    const right = normalize({
      x: flatRight.x * cb + flatUp.x * sb,
      y: flatRight.y * cb + flatUp.y * sb,
      z: flatRight.z * cb + flatUp.z * sb,
    });
    const up = normalize({
      x: flatUp.x * cb - flatRight.x * sb,
      y: flatUp.y * cb - flatRight.y * sb,
      z: flatUp.z * cb - flatRight.z * sb,
    });

    const yaw = Math.atan2(forward.x, forward.z);
    const pitch = Math.asin(clamp(forward.y, -0.95, 0.95));

    // Curvature via yaw difference across neighboring frames
    const prevPrev = rawPositions[(i - 2 + sampleCount) % sampleCount];
    const nextNext = rawPositions[(i + 2) % sampleCount];
    const yawBack = Math.atan2(curr.x - prevPrev.x, curr.z - prevPrev.z);
    const yawFwd = Math.atan2(nextNext.x - curr.x, nextNext.z - curr.z);
    const curvature = wrapAngleRad(yawFwd - yawBack) / Math.max(segStepM * 2, 1e-4);

    // Place apex kerbs on corners (and both sides on Harbor GP sharp chicanes)
    const kerbThreshold = bp.id === "harbor_gp" ? 0.0045 : 0.0065;
    const kerbRight = curvature > kerbThreshold;
    const kerbLeft = curvature < -kerbThreshold;

    frames[i] = {
      index: i,
      t: i / sampleCount,
      distanceM: meta.distanceM,
      position: curr,
      forward,
      right,
      up,
      yaw,
      pitch,
      bankRad: meta.bankRad,
      roadWidth: meta.roadWidth,
      shoulderWidth: bp.shoulderWidth,
      curvature,
      isTunnel: meta.isTunnel,
      hasGravelShoulder: meta.hasGravelShoulder,
      kerbLeft,
      kerbRight,
    };
  }

  const checkpoints: TrackCheckpoint[] = [];
  for (let c = 0; c < bp.checkpointCount; c++) {
    const t = c / bp.checkpointCount;
    const idx = Math.floor(t * sampleCount) % sampleCount;
    const f = frames[idx];
    checkpoints.push({
      index: c,
      t,
      distanceM: f.distanceM,
      position: { ...f.position },
      forward: { ...f.forward },
      right: { ...f.right },
      up: { ...f.up },
      yaw: f.yaw,
      roadWidth: f.roadWidth,
    });
  }

  return { frames, totalLength, checkpoints };
}

function getCache(bp: TrackBlueprint, sampleCount?: number): BuiltTrackCache {
  const count = sampleCount ?? bp.sampleCount;
  const key = `${bp.id}:${count}`;
  let cached = trackCache.get(key);
  if (!cached) {
    cached = buildTrackData(bp, count);
    trackCache.set(key, cached);
  }
  return cached;
}

export function sampleTrackFrames(
  trackOrId: TrackBlueprint | TrackId | string,
  sampleCount?: number
): readonly TrackFrame[] {
  const bp = resolveBlueprint(trackOrId);
  return getCache(bp, sampleCount).frames;
}

export function getTrackLength(trackOrId: TrackBlueprint | TrackId | string): number {
  const bp = resolveBlueprint(trackOrId);
  return getCache(bp).totalLength;
}

export function getTrackCheckpoints(trackOrId: TrackBlueprint | TrackId | string): readonly TrackCheckpoint[] {
  const bp = resolveBlueprint(trackOrId);
  return getCache(bp).checkpoints;
}

export function sampleTrackAtDistance(
  trackOrId: TrackBlueprint | TrackId | string,
  distanceM: number
): TrackFrame {
  const bp = resolveBlueprint(trackOrId);
  const { frames, totalLength } = getCache(bp);
  const wrapped = ((distanceM % totalLength) + totalLength) % totalLength;
  const exactIdx = (wrapped / totalLength) * frames.length;
  const i0 = Math.floor(exactIdx) % frames.length;
  const i1 = (i0 + 1) % frames.length;
  const alpha = exactIdx - Math.floor(exactIdx);
  const a = frames[i0];
  const b = frames[i1];

  const forward = normalize({
    x: lerp(a.forward.x, b.forward.x, alpha),
    y: lerp(a.forward.y, b.forward.y, alpha),
    z: lerp(a.forward.z, b.forward.z, alpha),
  });
  const right = normalize({
    x: lerp(a.right.x, b.right.x, alpha),
    y: lerp(a.right.y, b.right.y, alpha),
    z: lerp(a.right.z, b.right.z, alpha),
  });
  const up = normalize(cross(forward, right));

  return {
    index: i0,
    t: wrapped / totalLength,
    distanceM: wrapped,
    position: {
      x: lerp(a.position.x, b.position.x, alpha),
      y: lerp(a.position.y, b.position.y, alpha),
      z: lerp(a.position.z, b.position.z, alpha),
    },
    forward,
    right,
    up,
    yaw: Math.atan2(forward.x, forward.z),
    pitch: Math.asin(clamp(forward.y, -0.95, 0.95)),
    bankRad: lerp(a.bankRad, b.bankRad, alpha),
    roadWidth: lerp(a.roadWidth, b.roadWidth, alpha),
    shoulderWidth: lerp(a.shoulderWidth, b.shoulderWidth, alpha),
    curvature: lerp(a.curvature, b.curvature, alpha),
    isTunnel: alpha < 0.5 ? a.isTunnel : b.isTunnel,
    hasGravelShoulder: alpha < 0.5 ? a.hasGravelShoulder : b.hasGravelShoulder,
    kerbLeft: alpha < 0.5 ? a.kerbLeft : b.kerbLeft,
    kerbRight: alpha < 0.5 ? a.kerbRight : b.kerbRight,
  };
}

/**
 * Generates clean 2-wide staggered motorsport starting grid slots behind the Start/Finish line.
 */
export function getTrackStartGrid(
  trackOrId: TrackBlueprint | TrackId | string,
  count = 8
): readonly TrackGridSlot[] {
  const bp = resolveBlueprint(trackOrId);
  const totalLength = getTrackLength(bp);
  const slots: TrackGridSlot[] = [];

  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / 2);
    const isRight = i % 2 === 1;
    const distanceBehindStartM = 11 + row * 12 + (isRight ? 5.5 : 0);
    const lateralOffset = isRight ? 3.3 : -3.3;
    const frame = sampleTrackAtDistance(bp, totalLength - distanceBehindStartM);

    slots.push({
      slotIndex: i,
      position: {
        x: frame.position.x + frame.right.x * lateralOffset,
        y: frame.position.y + frame.right.y * lateralOffset,
        z: frame.position.z + frame.right.z * lateralOffset,
      },
      yaw: frame.yaw,
      pitch: frame.pitch,
      lateralOffset,
      distanceBehindStartM,
    });
  }
  return slots;
}

/**
 * Projects any 3D world point onto the nearest point on the track spline, returning exact
 * longitudinal progress, lateral offset, banked road surface height, tunnel/gravel flags,
 * and guardrail containment bounds.
 */
export function projectPointToTrack(
  trackOrId: TrackBlueprint | TrackId | string,
  point: Readonly<Vec3>,
  hintFrameIndex?: number
): TrackProjection {
  const bp = resolveBlueprint(trackOrId);
  const { frames, totalLength } = getCache(bp);
  const n = frames.length;

  let bestIdx = 0;
  let bestDistSq = Infinity;

  if (hintFrameIndex !== undefined && hintFrameIndex >= 0 && hintFrameIndex < n) {
    const window = 18;
    for (let offset = -window; offset <= window; offset++) {
      const idx = (hintFrameIndex + offset + n) % n;
      const p = frames[idx].position;
      const dx = point.x - p.x;
      const dz = point.z - p.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestDistSq) {
        bestDistSq = d2;
        bestIdx = idx;
      }
    }
    // Fall back to full scan if car jumped far away from hint
    if (bestDistSq > 900) {
      bestDistSq = Infinity;
      for (let i = 0; i < n; i++) {
        const p = frames[i].position;
        const dx = point.x - p.x;
        const dz = point.z - p.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestDistSq) {
          bestDistSq = d2;
          bestIdx = i;
        }
      }
    }
  } else {
    for (let i = 0; i < n; i++) {
      const p = frames[i].position;
      const dx = point.x - p.x;
      const dz = point.z - p.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestDistSq) {
        bestDistSq = d2;
        bestIdx = i;
      }
    }
  }

  // Refine continuously along the two neighboring segments around bestIdx
  const baseFrame = frames[bestIdx];
  const segLen = totalLength / n;
  const dx0 = point.x - baseFrame.position.x;
  const dy0 = point.y - baseFrame.position.y;
  const dz0 = point.z - baseFrame.position.z;
  const along = clamp(
    dx0 * baseFrame.forward.x + dy0 * baseFrame.forward.y + dz0 * baseFrame.forward.z,
    -segLen,
    segLen
  );

  const exactDist = ((baseFrame.distanceM + along) % totalLength + totalLength) % totalLength;
  const frame = sampleTrackAtDistance(bp, exactDist);

  const rx = point.x - frame.position.x;
  const ry = point.y - frame.position.y;
  const rz = point.z - frame.position.z;

  const lateralOffset = rx * frame.right.x + ry * frame.right.y + rz * frame.right.z;
  const surfaceY = frame.position.y + frame.right.y * lateralOffset;
  const verticalOffset = point.y - surfaceY;
  const roadHalfWidth = frame.roadWidth * 0.5;
  const guardrailHalfWidth = roadHalfWidth + frame.shoulderWidth;
  const onGravel = frame.hasGravelShoulder && Math.abs(lateralOffset) > roadHalfWidth;

  return {
    t: frame.t,
    distanceM: exactDist,
    frameIndex: frame.index,
    frame,
    lateralOffset,
    verticalOffset,
    surfaceY,
    surfaceNormal: frame.up,
    roadHalfWidth,
    guardrailHalfWidth,
    inTunnel: frame.isTunnel,
    onGravel,
  };
}
