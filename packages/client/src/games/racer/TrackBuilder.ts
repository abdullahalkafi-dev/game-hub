import {
  Camera,
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
  PBRMaterial,
  PointLight,
  Quaternion,
  Scene,
  ShadowGenerator,
  StandardMaterial,
  Texture,
  TransformNode,
  Vector3,
  VertexData,
} from "@babylonjs/core";
import {
  getTrackBlueprint,
  getTrackLength,
  getTrackStartGrid,
  sampleTrackAtDistance,
  sampleTrackFrames,
  type TrackBlueprint,
  type TrackFrame,
  type TrackId,
  type TrackTheme,
} from "@game/shared";
import type { RaceAssetCache } from "./RaceAssetCache.js";

export type TrackGraphicsQuality = "LOW" | "MEDIUM" | "HIGH" | "ULTRA";

export interface TrackBuilderOptions {
  camera: Camera;
  quality?: TrackGraphicsQuality;
}

export interface BuiltTrackEnvironment {
  track: TrackBlueprint;
  frames: readonly TrackFrame[];
  totalLength: number;
  root: TransformNode;
  skyDome: Mesh;
  sunLight: DirectionalLight;
  hemiLight: HemisphericLight;
  shadowGenerator: ShadowGenerator | null;
  pipeline: DefaultRenderingPipeline;
  setCountdownLight: (value: number) => void;
  dispose: () => void;
}

interface ProfilePoint {
  /** Lateral offset from centerline (or reference offset) along frame.right */
  lat: number;
  /** Vertical offset along frame.up */
  up: number;
  /** Normal component along frame.right */
  nLat: number;
  /** Normal component along frame.up */
  nUp: number;
  /** Transverse texture U coordinate */
  u: number;
}

interface BuildContext {
  scene: Scene;
  bp: TrackBlueprint;
  frames: readonly TrackFrame[];
  totalLength: number;
  root: TransformNode;
  assets: RaceAssetCache;
  shadowGen: ShadowGenerator | null;
  disposableMeshes: Mesh[];
  disposableMaterials: (PBRMaterial | StandardMaterial)[];
  disposableTextures: Texture[];
  disposableLights: PointLight[];
}

function addMat<T extends PBRMaterial | StandardMaterial>(ctx: BuildContext, m: T): T {
  ctx.disposableMaterials.push(m);
  return m;
}

function addTex<T extends Texture>(ctx: BuildContext, t: T): T {
  ctx.disposableTextures.push(t);
  return t;
}

function addMesh(ctx: BuildContext, m: Mesh, castShadow = false, receiveShadow = true): Mesh {
  m.parent = ctx.root;
  m.isPickable = false;
  m.receiveShadows = receiveShadow;
  if (castShadow && ctx.shadowGen) {
    ctx.shadowGen.addShadowCaster(m);
  }
  ctx.disposableMeshes.push(m);
  return m;
}

/**
 * Checks whether a world XZ location maintains at least `minClearanceM` distance
 * from every point along the track spline so scenery never clips onto any road turn.
 */
function isClearOfTrack(x: number, z: number, minClearanceM: number, frames: readonly TrackFrame[]): boolean {
  const minSq = minClearanceM * minClearanceM;
  for (let i = 0; i < frames.length; i += 2) {
    const p = frames[i].position;
    const dx = x - p.x;
    const dz = z - p.z;
    if (dx * dx + dz * dz < minSq) return false;
  }
  return true;
}

/**
 * Builds a custom smooth `VertexData` ribbon extruded along a slice of track frames.
 * Winding follows Babylon LH CCW front-face convention:
 *   cross(forward, profileStep) points along front-facing surface normal.
 */
function buildExtrudedTrackMesh(
  ctx: BuildContext,
  name: string,
  frameIndices: readonly number[],
  closedLoop: boolean,
  profileAt: (frame: TrackFrame, rowIdx: number) => readonly ProfilePoint[],
  vScalePerMeter: number,
  material: PBRMaterial | StandardMaterial,
  opts?: { backFaceCulling?: boolean; castShadow?: boolean; receiveShadow?: boolean }
): Mesh {
  const rowCount = closedLoop ? frameIndices.length + 1 : frameIndices.length;
  const firstProfile = profileAt(ctx.frames[frameIndices[0]], 0);
  const cols = firstProfile.length;

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let r = 0; r < rowCount; r++) {
    const isClosingRow = closedLoop && r === frameIndices.length;
    const fIdx = isClosingRow ? frameIndices[0] : frameIndices[r];
    const frame = ctx.frames[fIdx];
    const distM = isClosingRow ? ctx.totalLength : frame.distanceM;
    const vCoord = distM * vScalePerMeter;
    const profile = profileAt(frame, r);

    for (let c = 0; c < cols; c++) {
      const pt = profile[c];
      const px = frame.position.x + frame.right.x * pt.lat + frame.up.x * pt.up;
      const py = frame.position.y + frame.right.y * pt.lat + frame.up.y * pt.up;
      const pz = frame.position.z + frame.right.z * pt.lat + frame.up.z * pt.up;

      let nx = frame.right.x * pt.nLat + frame.up.x * pt.nUp;
      let ny = frame.right.y * pt.nLat + frame.up.y * pt.nUp;
      let nz = frame.right.z * pt.nLat + frame.up.z * pt.nUp;
      const nLen = Math.hypot(nx, ny, nz);
      if (nLen > 1e-6) {
        nx /= nLen;
        ny /= nLen;
        nz /= nLen;
      } else {
        nx = frame.up.x;
        ny = frame.up.y;
        nz = frame.up.z;
      }

      positions.push(px, py, pz);
      normals.push(nx, ny, nz);
      uvs.push(pt.u, vCoord);
    }
  }

  for (let r = 0; r < rowCount - 1; r++) {
    const rowA = r * cols;
    const rowB = (r + 1) * cols;
    for (let c = 0; c < cols - 1; c++) {
      const a0 = rowA + c;
      const a1 = rowA + c + 1;
      const b0 = rowB + c;
      const b1 = rowB + c + 1;
      // Babylon LH front-face winding (CCW looking against normal)
      indices.push(a0, a1, b1);
      indices.push(a0, b1, b0);
    }
  }

  const mesh = new Mesh(name, ctx.scene);
  const vd = new VertexData();
  vd.positions = positions;
  vd.normals = normals;
  vd.uvs = uvs;
  vd.indices = indices;
  vd.applyToMesh(mesh);

  material.backFaceCulling = opts?.backFaceCulling ?? true;
  mesh.material = material;
  return addMesh(ctx, mesh, opts?.castShadow ?? false, opts?.receiveShadow ?? true);
}

/**
 * Generates crisp painted asphalt road albedo with aggregate micro-texture,
 * subtle worn tire tracks, continuous edge white lines, and dashed centerline.
 */
function createPaintedRoadTexture(ctx: BuildContext): DynamicTexture {
  const tex = addTex(
    ctx,
    new DynamicTexture(`road_albedo_${ctx.bp.id}`, { width: 1024, height: 1024 }, ctx.scene, true)
  );
  const g = tex.getContext();
  const theme = ctx.bp.theme;

  // Base dark asphalt color tuned per environment
  const baseFill =
    theme === "TOKYO_MIDNIGHT" ? "#1e222b" : theme === "COASTAL_SUNSET" ? "#34353a" : "#2b2f38";
  g.fillStyle = baseFill;
  g.fillRect(0, 0, 1024, 1024);

  // Fine asphalt stone aggregate grain (deterministic pseudo-random)
  let seed = theme === "TOKYO_MIDNIGHT" ? 1337 : theme === "COASTAL_SUNSET" ? 4201 : 7891;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < 16000; i++) {
    const x = Math.floor(rand() * 1024);
    const y = Math.floor(rand() * 1024);
    const bright = rand() > 0.5;
    const sz = rand() > 0.85 ? 3 : 2;
    g.fillStyle = bright ? "rgba(255,255,255,0.045)" : "rgba(0,0,0,0.09)";
    g.fillRect(x, y, sz, sz);
  }

  // Subtle longitudinal tire-wear dark rubber grooves along both lanes
  for (const laneCenter of [268, 756]) {
    const wearGrad = g.createLinearGradient(laneCenter - 150, 0, laneCenter + 150, 0);
    wearGrad.addColorStop(0, "rgba(0,0,0,0)");
    wearGrad.addColorStop(0.28, "rgba(0,0,0,0.14)");
    wearGrad.addColorStop(0.5, "rgba(0,0,0,0.06)");
    wearGrad.addColorStop(0.72, "rgba(0,0,0,0.14)");
    wearGrad.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = wearGrad;
    g.fillRect(laneCenter - 150, 0, 300, 1024);
  }

  // Subtle edge gutter darkening
  const edgeL = g.createLinearGradient(0, 0, 64, 0);
  edgeL.addColorStop(0, "rgba(0,0,0,0.28)");
  edgeL.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = edgeL;
  g.fillRect(0, 0, 64, 1024);

  const edgeR = g.createLinearGradient(960, 0, 1024, 0);
  edgeR.addColorStop(0, "rgba(0,0,0,0)");
  edgeR.addColorStop(1, "rgba(0,0,0,0.28)");
  g.fillStyle = edgeR;
  g.fillRect(960, 0, 64, 1024);

  // Continuous solid white outer edge lines (high readability at 300 km/h!)
  g.fillStyle = theme === "COASTAL_SUNSET" ? "rgba(245,240,230,0.88)" : "rgba(244,248,255,0.92)";
  g.fillRect(36, 0, 16, 1024);
  g.fillRect(972, 0, 16, 1024);

  // Center lane markings
  if (theme === "COASTAL_SUNSET") {
    // Classic golden canyon double-dashed highway centerline
    g.fillStyle = "rgba(250,185,55,0.9)";
    g.fillRect(496, 80, 11, 440);
    g.fillRect(517, 80, 11, 440);
    g.fillRect(496, 592, 11, 350);
    g.fillRect(517, 592, 11, 350);
  } else if (theme === "TOKYO_MIDNIGHT") {
    // Crisp urban expressway dashed center line + secondary lane dashes
    g.fillStyle = "rgba(245,250,255,0.92)";
    g.fillRect(504, 100, 16, 430);
    g.fillRect(504, 620, 16, 310);

    g.fillStyle = "rgba(200,220,245,0.45)";
    g.fillRect(262, 180, 8, 280);
    g.fillRect(754, 180, 8, 280);
    g.fillRect(262, 700, 8, 260);
    g.fillRect(754, 700, 8, 260);

    // Subtle glowing blue/cyan cats-eye road studs along edges
    g.fillStyle = "rgba(56,220,255,0.85)";
    g.fillRect(40, 220, 8, 20);
    g.fillRect(976, 220, 8, 20);
    g.fillRect(40, 732, 8, 20);
    g.fillRect(976, 732, 8, 20);
  } else {
    // Harbor GP: subtle center dashed reference + crisp racing track-limit border accents
    g.fillStyle = "rgba(235,242,252,0.52)";
    g.fillRect(506, 120, 12, 340);
    g.fillRect(506, 632, 12, 300);
    g.fillStyle = "rgba(255,255,255,0.96)";
    g.fillRect(28, 0, 22, 1024);
    g.fillRect(974, 0, 22, 1024);
  }

  tex.update(true);
  tex.wrapU = Texture.CLAMP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;
  tex.anisotropicFilteringLevel = 8;
  return tex;
}

function createKerbTexture(ctx: BuildContext): DynamicTexture {
  const tex = addTex(
    ctx,
    new DynamicTexture(`kerb_tex_${ctx.bp.id}`, { width: 256, height: 256 }, ctx.scene, true)
  );
  const g = tex.getContext();
  // Alternating vibrant motorsport red & crisp white apex blocks
  g.fillStyle = "#e11d2e";
  g.fillRect(0, 0, 256, 128);
  g.fillStyle = "#f4f7fb";
  g.fillRect(0, 128, 256, 128);

  // Subtle concrete joint groove & tire-scuff wear along inner face
  g.fillStyle = "rgba(0,0,0,0.22)";
  g.fillRect(0, 124, 256, 6);
  g.fillRect(0, 250, 256, 6);
  const scuff = g.createLinearGradient(0, 0, 90, 0);
  scuff.addColorStop(0, "rgba(10,12,16,0.34)");
  scuff.addColorStop(1, "rgba(10,12,16,0)");
  g.fillStyle = scuff;
  g.fillRect(0, 0, 90, 256);

  tex.update(true);
  tex.wrapU = Texture.CLAMP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;
  tex.anisotropicFilteringLevel = 8;
  return tex;
}

function createCheckeredLineTexture(ctx: BuildContext): DynamicTexture {
  const tex = addTex(
    ctx,
    new DynamicTexture(`finish_line_${ctx.bp.id}`, { width: 512, height: 128 }, ctx.scene, true)
  );
  const g = tex.getContext();
  const cols = 16;
  const rows = 4;
  const cw = 512 / cols;
  const ch = 128 / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      g.fillStyle = (r + c) % 2 === 0 ? "#f8fafc" : "#11141c";
      g.fillRect(c * cw, r * ch, cw, ch);
    }
  }
  tex.update(true);
  tex.anisotropicFilteringLevel = 8;
  return tex;
}

function createBannerTexture(
  ctx: BuildContext,
  name: string,
  title: string,
  subtitle: string,
  bgHex: string,
  accentHex: string
): DynamicTexture {
  const tex = addTex(ctx, new DynamicTexture(name, { width: 1024, height: 256 }, ctx.scene, true));
  const g = tex.getContext() as unknown as CanvasRenderingContext2D;

  g.fillStyle = bgHex;
  g.fillRect(0, 0, 1024, 256);

  // Diagonal motorsport speed stripes
  g.fillStyle = accentHex;
  g.fillRect(0, 0, 1024, 16);
  g.fillRect(0, 240, 1024, 16);
  g.globalAlpha = 0.22;
  for (let x = -40; x < 1080; x += 120) {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x + 42, 0);
    g.lineTo(x - 18, 256);
    g.lineTo(x - 60, 256);
    g.closePath();
    g.fill();
  }
  g.globalAlpha = 1;

  g.fillStyle = "#ffffff";
  g.font = "900 78px Impact, Arial Black, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(title, 512, 104);

  g.fillStyle = accentHex;
  g.font = "700 34px Arial, sans-serif";
  g.fillText(subtitle, 512, 184);

  tex.update(true);
  tex.anisotropicFilteringLevel = 8;
  return tex;
}

function createSkyscraperFacadeTexture(
  ctx: BuildContext,
  name: string,
  baseHex: string,
  glowPrimary: string,
  glowSecondary: string,
  seedStart: number
): DynamicTexture {
  const tex = addTex(ctx, new DynamicTexture(name, { width: 256, height: 512 }, ctx.scene, true));
  const g = tex.getContext();
  g.fillStyle = baseHex;
  g.fillRect(0, 0, 256, 512);

  let s = seedStart;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };

  // Vertical glass mullion ribs
  g.fillStyle = "rgba(255,255,255,0.04)";
  for (let x = 0; x < 256; x += 32) {
    g.fillRect(x, 0, 3, 512);
  }

  // Lit skyscraper windows
  for (let row = 8; row < 500; row += 16) {
    const floorLit = rand() > 0.25;
    for (let col = 8; col < 248; col += 24) {
      if (!floorLit && rand() > 0.3) continue;
      if (rand() < 0.38) continue;
      const pick = rand();
      g.fillStyle =
        pick < 0.52 ? glowPrimary : pick < 0.8 ? glowSecondary : "rgba(255,232,185,0.88)";
      g.fillRect(col, row, 16, 9);
    }
  }

  // Glowing horizontal architectural neon accent bands
  g.fillStyle = glowPrimary;
  g.fillRect(0, 24, 256, 5);
  g.fillRect(0, 252, 256, 4);

  tex.update(true);
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;
  return tex;
}

/**
 * Helper to stamp an array of Matrix transforms onto a single mesh via ThinInstances (1 draw call!).
 */
function applyThinInstanceMatrices(mesh: Mesh, matrices: readonly Matrix[]): void {
  if (matrices.length === 0) {
    mesh.setEnabled(false);
    return;
  }
  const buf = new Float32Array(matrices.length * 16);
  for (let i = 0; i < matrices.length; i++) {
    matrices[i].copyToArray(buf, i * 16);
  }
  mesh.thinInstanceSetBuffer("matrix", buf, 16, true);
  mesh.alwaysSelectAsActiveMesh = true;
}

function buildTransformMatrix(pos: Vector3, yaw: number, scale: Vector3, pitch = 0, roll = 0): Matrix {
  const q = Quaternion.RotationYawPitchRoll(yaw, pitch, roll);
  return Matrix.Compose(scale, q, pos);
}

/**
 * Builds complete 3D spline tracks (road ribbon, painted lines, 2K Poly Haven PBR maps,
 * 3D red/white apex kerbs, shoulders, W-beam guardrails, Start/Finish countdown gantry,
 * concrete tunnels with ceiling LED strips, theme scenery, lighting, and ACES post-processing).
 */
export class TrackBuilder {
  static build(
    scene: Scene,
    trackIdOrBp: TrackBlueprint | TrackId | string,
    assets: RaceAssetCache,
    opts: TrackBuilderOptions
  ): BuiltTrackEnvironment {
    const bp = typeof trackIdOrBp === "string" ? getTrackBlueprint(trackIdOrBp) : trackIdOrBp;
    const frames = sampleTrackFrames(bp, bp.sampleCount);
    const totalLength = getTrackLength(bp);
    const quality = opts.quality ?? "HIGH";

    const root = new TransformNode(`track_root_${bp.id}`, scene);

    // 1. Environment HDR IBL, Sky Dome, Lights, Fog & Shadows
    scene.environmentTexture = assets.getEnvironmentTexture(bp.theme);
    const skyDome = assets.createRaceSkyDome(bp.theme);
    skyDome.parent = root;

    const { hemiLight, sunLight, shadowGen } = TrackBuilder.setupLightingAndAtmosphere(
      scene,
      bp,
      quality
    );

    const ctx: BuildContext = {
      scene,
      bp,
      frames,
      totalLength,
      root,
      assets,
      shadowGen,
      disposableMeshes: [],
      disposableMaterials: [],
      disposableTextures: [],
      disposableLights: [],
    };

    // 2. Main Road Surface Ribbon (Banked Spline + Painted Markings + 2K Asphalt Normal/ARM)
    TrackBuilder.buildRoadSurface(ctx);

    // 3. Checkered Start/Finish Strip + 8 Painted Grid Boxes
    TrackBuilder.buildStartLineAndGridBoxes(ctx);

    // 4. Outer Gravel / Concrete Shoulders + Under-road Deck/Embankment Skirt
    TrackBuilder.buildShouldersAndDeck(ctx);

    // 5. Alternating Red/White 3D Apex Kerbs on Curves
    TrackBuilder.buildApexKerbs(ctx);

    // 6. Continuous Metallic W-Beam Guardrails + ThinInstanced Posts & Reflectors
    TrackBuilder.buildGuardrails(ctx);

    // 7. Overhead Start/Finish Gantry with Live 3-2-1-GO Signal Lights
    const setCountdownLight = TrackBuilder.buildStartFinishGantry(ctx);

    // 8. Concrete Tunnel Arches with Glowing Ceiling Strip Lights (wherever frame.isTunnel)
    TrackBuilder.buildTunnels(ctx);

    // 9. Track-Themed Environmental Scenery (ThinInstanced for 60+ FPS)
    if (bp.theme === "TOKYO_MIDNIGHT") {
      TrackBuilder.buildTokyoScenery(ctx);
    } else if (bp.theme === "COASTAL_SUNSET") {
      TrackBuilder.buildCoastalScenery(ctx);
    } else {
      TrackBuilder.buildHarborScenery(ctx);
    }

    // 10. Post-Processing Pipeline (ACES tone mapping, FXAA, balanced bloom)
    const pipeline = TrackBuilder.createRenderingPipeline(scene, opts.camera, bp.theme, quality);

    return {
      track: bp,
      frames,
      totalLength,
      root,
      skyDome,
      sunLight,
      hemiLight,
      shadowGenerator: shadowGen,
      pipeline,
      setCountdownLight,
      dispose: () => {
        pipeline.dispose();
        shadowGen?.dispose();
        hemiLight.dispose();
        sunLight.dispose();
        for (const l of ctx.disposableLights) l.dispose();
        for (const m of ctx.disposableMeshes) m.dispose();
        skyDome.material?.dispose();
        skyDome.dispose();
        for (const mat of ctx.disposableMaterials) mat.dispose();
        for (const tex of ctx.disposableTextures) tex.dispose();
        root.dispose();
      },
    };
  }

  private static setupLightingAndAtmosphere(
    scene: Scene,
    bp: TrackBlueprint,
    quality: TrackGraphicsQuality
  ): {
    hemiLight: HemisphericLight;
    sunLight: DirectionalLight;
    shadowGen: ShadowGenerator | null;
  } {
    const hemiLight = new HemisphericLight(`track_hemi_${bp.id}`, new Vector3(0, 1, 0), scene);
    let sunDir = new Vector3(0.42, -0.78, -0.45).normalize();
    const sunLight = new DirectionalLight(`track_sun_${bp.id}`, sunDir, scene);
    sunLight.position = new Vector3(160, 220, 80);

    if (bp.theme === "TOKYO_MIDNIGHT") {
      scene.clearColor = new Color4(0.018, 0.028, 0.07, 1);
      scene.environmentIntensity = 0.85;
      hemiLight.intensity = 0.62;
      hemiLight.diffuse = Color3.FromHexString("#5080d0");
      hemiLight.groundColor = Color3.FromHexString("#0d152a");

      sunDir = new Vector3(-0.35, -0.72, 0.55).normalize();
      sunLight.direction = sunDir;
      sunLight.diffuse = Color3.FromHexString("#9ecbff");
      sunLight.specular = Color3.FromHexString("#bae6fd");
      sunLight.intensity = 0.95;

      scene.fogMode = Scene.FOGMODE_EXP2;
      scene.fogDensity = 0.0012;
      scene.fogColor = Color3.FromHexString("#0a1126");
    } else if (bp.theme === "COASTAL_SUNSET") {
      scene.clearColor = new Color4(0.24, 0.14, 0.18, 1);
      scene.environmentIntensity = 0.92;
      hemiLight.intensity = 0.68;
      hemiLight.diffuse = Color3.FromHexString("#ffd4a8");
      hemiLight.groundColor = Color3.FromHexString("#4b332a");

      sunDir = new Vector3(-0.68, -0.34, 0.65).normalize();
      sunLight.direction = sunDir;
      sunLight.position = new Vector3(360, 165, -240);
      sunLight.diffuse = Color3.FromHexString("#ffb870");
      sunLight.specular = Color3.FromHexString("#ffe6c4");
      sunLight.intensity = 2.15;

      scene.fogMode = Scene.FOGMODE_EXP2;
      scene.fogDensity = 0.00072;
      scene.fogColor = Color3.FromHexString("#c97e5d");
    } else {
      // HARBOR_GP
      scene.clearColor = new Color4(0.32, 0.58, 0.86, 1);
      scene.environmentIntensity = 0.95;
      hemiLight.intensity = 0.8;
      hemiLight.diffuse = Color3.FromHexString("#dbeeff");
      hemiLight.groundColor = Color3.FromHexString("#475569");

      sunDir = new Vector3(0.42, -0.78, -0.45).normalize();
      sunLight.direction = sunDir;
      sunLight.position = new Vector3(120, 260, 140);
      sunLight.diffuse = Color3.FromHexString("#fff9ec");
      sunLight.specular = Color3.FromHexString("#ffffff");
      sunLight.intensity = 2.05;

      scene.fogMode = Scene.FOGMODE_EXP2;
      scene.fogDensity = 0.00048;
      scene.fogColor = Color3.FromHexString("#aacbe8");
    }

    let shadowGen: ShadowGenerator | null = null;
    if (quality !== "LOW") {
      const mapSize = quality === "ULTRA" ? 2048 : 1024;
      shadowGen = new ShadowGenerator(mapSize, sunLight);
      shadowGen.usePercentageCloserFiltering = true;
      shadowGen.filteringQuality = ShadowGenerator.QUALITY_LOW;
      shadowGen.bias = 0.0008;
      shadowGen.normalBias = 0.02;
    }

    return { hemiLight, sunLight, shadowGen };
  }

  private static createRenderingPipeline(
    scene: Scene,
    camera: Camera,
    theme: TrackTheme,
    quality: TrackGraphicsQuality
  ): DefaultRenderingPipeline {
    const pipeline = new DefaultRenderingPipeline(`race_pipe_${theme}`, true, scene, [camera]);
    pipeline.fxaaEnabled = quality !== "LOW";
    pipeline.imageProcessingEnabled = true;
    pipeline.imageProcessing.toneMappingEnabled = true;
    pipeline.imageProcessing.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;

    if (theme === "TOKYO_MIDNIGHT") {
      pipeline.imageProcessing.exposure = 1.08;
      pipeline.imageProcessing.contrast = 1.18;
      pipeline.bloomEnabled = quality !== "LOW";
      pipeline.bloomThreshold = 0.84;
      pipeline.bloomWeight = 0.3;
      pipeline.bloomKernel = 48;
      pipeline.bloomScale = 0.5;
    } else if (theme === "COASTAL_SUNSET") {
      pipeline.imageProcessing.exposure = 1.02;
      pipeline.imageProcessing.contrast = 1.16;
      pipeline.bloomEnabled = quality !== "LOW";
      pipeline.bloomThreshold = 0.92;
      pipeline.bloomWeight = 0.22;
      pipeline.bloomKernel = 48;
      pipeline.bloomScale = 0.5;
    } else {
      pipeline.imageProcessing.exposure = 0.98;
      pipeline.imageProcessing.contrast = 1.14;
      pipeline.bloomEnabled = quality !== "LOW";
      pipeline.bloomThreshold = 0.96;
      pipeline.bloomWeight = 0.16;
      pipeline.bloomKernel = 40;
      pipeline.bloomScale = 0.5;
    }

    return pipeline;
  }

  private static buildRoadSurface(ctx: BuildContext): void {
    const allIndices = ctx.frames.map((_, i) => i);
    const roadAlbedo = createPaintedRoadTexture(ctx);
    const asphaltDetail = ctx.assets.getTrackPbrTextureSet("asphalt", 3, 2);

    const roadMat = addMat(ctx, new PBRMaterial(`road_pbr_${ctx.bp.id}`, ctx.scene));
    roadMat.albedoTexture = roadAlbedo;
    roadMat.bumpTexture = asphaltDetail.bump;
    if (roadMat.bumpTexture) {
      roadMat.bumpTexture.level = ctx.bp.theme === "TOKYO_MIDNIGHT" ? 0.58 : 0.82;
    }
    roadMat.metallicTexture = asphaltDetail.arm;
    roadMat.useAmbientOcclusionFromMetallicTextureRed = true;
    roadMat.useRoughnessFromMetallicTextureGreen = true;
    roadMat.useMetallnessFromMetallicTextureBlue = true;

    if (ctx.bp.theme === "TOKYO_MIDNIGHT") {
      // Wet midnight asphalt: crisp streetlamp, neon, and headlight specular reflections!
      roadMat.roughness = 0.36;
      roadMat.metallic = 0.24;
      roadMat.environmentIntensity = 1.25;
      roadMat.clearCoat.isEnabled = true;
      roadMat.clearCoat.intensity = 0.55;
      roadMat.clearCoat.roughness = 0.15;
    } else if (ctx.bp.theme === "COASTAL_SUNSET") {
      roadMat.roughness = 0.78;
      roadMat.metallic = 0.08;
      roadMat.environmentIntensity = 0.75;
    } else {
      roadMat.roughness = 0.64;
      roadMat.metallic = 0.1;
      roadMat.environmentIntensity = 0.85;
    }

    // 1 tile in V = 12 meters along track (matches painted lane dashes cleanly, while 2K bump/ARM tiles 3x2 = ~6m x 6m!)
    const vPerMeter = 1 / 12;
    buildExtrudedTrackMesh(
      ctx,
      `road_surface_${ctx.bp.id}`,
      allIndices,
      true,
      (frame) => {
        const hw = frame.roadWidth * 0.5;
        return [
          { lat: -hw, up: 0, nLat: 0, nUp: 1, u: 0.0 },
          { lat: -hw * 0.36, up: 0.015, nLat: 0, nUp: 1, u: 0.32 },
          { lat: hw * 0.36, up: 0.015, nLat: 0, nUp: 1, u: 0.68 },
          { lat: hw, up: 0, nLat: 0, nUp: 1, u: 1.0 },
        ];
      },
      vPerMeter,
      roadMat,
      { backFaceCulling: true, castShadow: false, receiveShadow: true }
    );
  }

  private static buildStartLineAndGridBoxes(ctx: BuildContext): void {
    // Checkered Start/Finish strip flush on asphalt at distanceM = 0
    const startFrame = sampleTrackAtDistance(ctx.bp, 0);
    const checkTex = createCheckeredLineTexture(ctx);
    const checkMat = addMat(ctx, new StandardMaterial(`finish_line_mat_${ctx.bp.id}`, ctx.scene));
    checkMat.diffuseTexture = checkTex;
    checkMat.specularColor = new Color3(0.18, 0.18, 0.18);
    checkMat.emissiveColor = ctx.bp.isNight ? new Color3(0.18, 0.18, 0.2) : new Color3(0.05, 0.05, 0.05);
    checkMat.zOffset = -2;

    const strip = MeshBuilder.CreateGround(
      `finish_line_strip_${ctx.bp.id}`,
      { width: startFrame.roadWidth * 0.92, height: 2.8 },
      ctx.scene
    );
    strip.position.set(
      startFrame.position.x + startFrame.up.x * 0.025,
      startFrame.position.y + startFrame.up.y * 0.025,
      startFrame.position.z + startFrame.up.z * 0.025
    );
    strip.rotation.y = startFrame.yaw;
    strip.rotation.x = -startFrame.pitch;
    strip.rotation.z = startFrame.bankRad;
    strip.material = checkMat;
    addMesh(ctx, strip, false, true);

    // 8 painted white starting grid brackets behind the start line (ThinInstanced!)
    const gridTex = addTex(
      ctx,
      new DynamicTexture(`grid_box_tex_${ctx.bp.id}`, { width: 128, height: 256 }, ctx.scene, false)
    );
    const gg = gridTex.getContext();
    gg.clearRect(0, 0, 128, 256);
    gg.fillStyle = "rgba(248,250,252,0.88)";
    // Front bracket bar + left & right side bars
    gg.fillRect(8, 8, 112, 18);
    gg.fillRect(8, 8, 14, 150);
    gg.fillRect(106, 8, 14, 150);
    gridTex.update();
    gridTex.hasAlpha = true;

    const gridMat = addMat(ctx, new StandardMaterial(`grid_box_mat_${ctx.bp.id}`, ctx.scene));
    gridMat.diffuseTexture = gridTex;
    gridMat.useAlphaFromDiffuseTexture = true;
    gridMat.emissiveColor = new Color3(0.22, 0.25, 0.3);
    gridMat.zOffset = -2;
    gridMat.backFaceCulling = false;

    const gridBoxMaster = MeshBuilder.CreateGround(
      `grid_boxes_${ctx.bp.id}`,
      { width: 2.7, height: 5.2 },
      ctx.scene
    );
    gridBoxMaster.material = gridMat;
    addMesh(ctx, gridBoxMaster, false, false);

    const slots = getTrackStartGrid(ctx.bp, 8);
    const matrices: Matrix[] = [];
    for (const slot of slots) {
      const f = sampleTrackAtDistance(ctx.bp, ctx.totalLength - slot.distanceBehindStartM);
      const pos = new Vector3(
        slot.position.x + f.up.x * 0.03,
        slot.position.y + f.up.y * 0.03,
        slot.position.z + f.up.z * 0.03
      );
      matrices.push(buildTransformMatrix(pos, slot.yaw, Vector3.One(), -slot.pitch, f.bankRad));
    }
    applyThinInstanceMatrices(gridBoxMaster, matrices);
  }

  private static buildShouldersAndDeck(ctx: BuildContext): void {
    const allIndices = ctx.frames.map((_, i) => i);
    const usesGravel = ctx.bp.theme === "COASTAL_SUNSET";

    const shoulderMat = ctx.assets.getTrackPbrMaterial(
      `shoulder_${ctx.bp.id}`,
      usesGravel ? "gravel" : "asphalt",
      1,
      1,
      usesGravel
        ? { tintHex: "#bfa282", roughness: 0.92, metallic: 0.02, bumpLevel: 1.0 }
        : {
            tintHex: ctx.bp.theme === "TOKYO_MIDNIGHT" ? "#3c4352" : "#5b6472",
            roughness: 0.78,
            metallic: 0.06,
            bumpLevel: 0.7,
          }
    );

    const vPerMeter = 0.25; // 4m world repeat

    // Left shoulder
    buildExtrudedTrackMesh(
      ctx,
      `shoulder_left_${ctx.bp.id}`,
      allIndices,
      true,
      (frame) => {
        const hw = frame.roadWidth * 0.5;
        const sw = frame.shoulderWidth + 0.35;
        return [
          { lat: -(hw + sw), up: -0.04, nLat: 0, nUp: 1, u: 0 },
          { lat: -hw, up: 0.0, nLat: 0, nUp: 1, u: sw / 4 },
        ];
      },
      vPerMeter,
      shoulderMat
    );

    // Right shoulder
    buildExtrudedTrackMesh(
      ctx,
      `shoulder_right_${ctx.bp.id}`,
      allIndices,
      true,
      (frame) => {
        const hw = frame.roadWidth * 0.5;
        const sw = frame.shoulderWidth + 0.35;
        return [
          { lat: hw, up: 0.0, nLat: 0, nUp: 1, u: 0 },
          { lat: hw + sw, up: -0.04, nLat: 0, nUp: 1, u: sw / 4 },
        ];
      },
      vPerMeter,
      shoulderMat
    );

    // Concrete viaduct side deck walls / mountain embankment skirt descending from road edges
    const skirtSlug = ctx.bp.theme === "COASTAL_SUNSET" ? "cliff_rock" : "concrete_wall_005";
    const skirtDepth = ctx.bp.theme === "COASTAL_SUNSET" ? 28 : ctx.bp.theme === "TOKYO_MIDNIGHT" ? 15 : 4.5;
    const skirtFlare = ctx.bp.theme === "COASTAL_SUNSET" ? 18 : ctx.bp.theme === "TOKYO_MIDNIGHT" ? 0.5 : 3.2;

    const skirtMat = ctx.assets.getTrackPbrMaterial(
      `road_skirt_${ctx.bp.id}`,
      skirtSlug,
      1,
      1,
      ctx.bp.theme === "COASTAL_SUNSET"
        ? { tintHex: "#b08463", roughness: 0.94, metallic: 0.02, bumpLevel: 1.1 }
        : { tintHex: "#555d6b", roughness: 0.86, metallic: 0.05, bumpLevel: 0.75 }
    );

    // Left embankment/viaduct outer skirt (normal points -right & slightly +up)
    buildExtrudedTrackMesh(
      ctx,
      `deck_skirt_left_${ctx.bp.id}`,
      allIndices,
      true,
      (frame) => {
        const outer = frame.roadWidth * 0.5 + frame.shoulderWidth + 0.32;
        return [
          { lat: -(outer + skirtFlare), up: -skirtDepth, nLat: -0.85, nUp: 0.5, u: 0 },
          { lat: -outer, up: -0.04, nLat: -0.85, nUp: 0.5, u: skirtDepth / 8 },
        ];
      },
      1 / 10,
      skirtMat,
      { backFaceCulling: false }
    );

    // Right embankment/viaduct outer skirt (normal points +right & slightly +up)
    buildExtrudedTrackMesh(
      ctx,
      `deck_skirt_right_${ctx.bp.id}`,
      allIndices,
      true,
      (frame) => {
        const outer = frame.roadWidth * 0.5 + frame.shoulderWidth + 0.32;
        return [
          { lat: outer, up: -0.04, nLat: 0.85, nUp: 0.5, u: 0 },
          { lat: outer + skirtFlare, up: -skirtDepth, nLat: 0.85, nUp: 0.5, u: skirtDepth / 8 },
        ];
      },
      1 / 10,
      skirtMat,
      { backFaceCulling: false }
    );
  }

  private static buildApexKerbs(ctx: BuildContext): void {
    const kerbTex = createKerbTexture(ctx);
    const kerbMat = addMat(ctx, new PBRMaterial(`kerb_pbr_${ctx.bp.id}`, ctx.scene));
    kerbMat.albedoTexture = kerbTex;
    kerbMat.roughness = 0.72;
    kerbMat.metallic = 0.04;
    if (ctx.bp.isNight) {
      kerbMat.emissiveTexture = kerbTex;
      kerbMat.emissiveColor = new Color3(0.22, 0.22, 0.24);
    }

    const extractSpans = (predicate: (f: TrackFrame) => boolean): number[][] => {
      const n = ctx.frames.length;
      const flags = ctx.frames.map(predicate);
      const spans: number[][] = [];
      let i = 0;
      while (i < n) {
        if (!flags[i]) {
          i++;
          continue;
        }
        const span: number[] = [];
        // Lead-in taper frame
        span.push((i - 1 + n) % n);
        while (i < n && flags[i]) {
          span.push(i);
          i++;
        }
        // Lead-out taper frame
        span.push(i % n);
        if (span.length >= 4) spans.push(span);
      }
      return spans;
    };

    const leftSpans = extractSpans((f) => f.kerbLeft);
    const rightSpans = extractSpans((f) => f.kerbRight);

    const vPerMeter = 1 / 3.4; // 1.7m red + 1.7m white blocks!

    for (let s = 0; s < leftSpans.length; s++) {
      const span = leftSpans[s];
      buildExtrudedTrackMesh(
        ctx,
        `kerb_left_${s}`,
        span,
        false,
        (frame, rowIdx) => {
          const hw = frame.roadWidth * 0.5;
          const h = rowIdx === 0 || rowIdx === span.length - 1 ? 0.01 : 0.095;
          return [
            { lat: -(hw + 1.12), up: 0.0, nLat: -0.5, nUp: 0.86, u: 1.0 },
            { lat: -(hw + 0.94), up: h, nLat: -0.15, nUp: 0.99, u: 0.8 },
            { lat: -(hw + 0.08), up: h * 0.75, nLat: 0.25, nUp: 0.97, u: 0.15 },
            { lat: -(hw - 0.12), up: 0.01, nLat: 0.4, nUp: 0.92, u: 0.0 },
          ];
        },
        vPerMeter,
        kerbMat
      );
    }

    for (let s = 0; s < rightSpans.length; s++) {
      const span = rightSpans[s];
      buildExtrudedTrackMesh(
        ctx,
        `kerb_right_${s}`,
        span,
        false,
        (frame, rowIdx) => {
          const hw = frame.roadWidth * 0.5;
          const h = rowIdx === 0 || rowIdx === span.length - 1 ? 0.01 : 0.095;
          return [
            { lat: hw - 0.12, up: 0.01, nLat: -0.4, nUp: 0.92, u: 0.0 },
            { lat: hw + 0.08, up: h * 0.75, nLat: -0.25, nUp: 0.97, u: 0.15 },
            { lat: hw + 0.94, up: h, nLat: 0.15, nUp: 0.99, u: 0.8 },
            { lat: hw + 1.12, up: 0.0, nLat: 0.5, nUp: 0.86, u: 1.0 },
          ];
        },
        vPerMeter,
        kerbMat
      );
    }
  }

  private static buildGuardrails(ctx: BuildContext): void {
    const allIndices = ctx.frames.map((_, i) => i);
    const steelMat = ctx.assets.getTrackPbrMaterial(
      `guardrail_steel_${ctx.bp.id}`,
      "barrier_steel",
      1,
      1,
      { tintHex: "#c8d1dc", roughness: 0.38, metallic: 0.78, bumpLevel: 0.7 }
    );

    const vPerMeter = 0.25;

    // Left continuous W-beam metallic rail (faces inward toward +right)
    buildExtrudedTrackMesh(
      ctx,
      `guardrail_left_${ctx.bp.id}`,
      allIndices,
      true,
      (frame) => {
        const edge = -(frame.roadWidth * 0.5 + frame.shoulderWidth + 0.08);
        return [
          { lat: edge - 0.16, up: 0.92, nLat: 0, nUp: 1, u: 0.0 },
          { lat: edge + 0.02, up: 0.9, nLat: 0.85, nUp: 0.5, u: 0.2 },
          { lat: edge + 0.12, up: 0.78, nLat: 1, nUp: 0, u: 0.4 },
          { lat: edge + 0.02, up: 0.65, nLat: 1, nUp: 0, u: 0.58 },
          { lat: edge + 0.12, up: 0.52, nLat: 1, nUp: 0, u: 0.76 },
          { lat: edge - 0.02, up: 0.42, nLat: 0.7, nUp: -0.7, u: 1.0 },
        ];
      },
      vPerMeter,
      steelMat,
      { backFaceCulling: false, castShadow: true }
    );

    // Right continuous W-beam metallic rail (faces inward toward -right)
    buildExtrudedTrackMesh(
      ctx,
      `guardrail_right_${ctx.bp.id}`,
      allIndices,
      true,
      (frame) => {
        const edge = frame.roadWidth * 0.5 + frame.shoulderWidth + 0.08;
        return [
          { lat: edge + 0.02, up: 0.42, nLat: -0.7, nUp: -0.7, u: 1.0 },
          { lat: edge - 0.12, up: 0.52, nLat: -1, nUp: 0, u: 0.76 },
          { lat: edge - 0.02, up: 0.65, nLat: -1, nUp: 0, u: 0.58 },
          { lat: edge - 0.12, up: 0.78, nLat: -1, nUp: 0, u: 0.4 },
          { lat: edge - 0.02, up: 0.9, nLat: -0.85, nUp: 0.5, u: 0.2 },
          { lat: edge + 0.16, up: 0.92, nLat: 0, nUp: 1, u: 0.0 },
        ];
      },
      vPerMeter,
      steelMat,
      { backFaceCulling: false, castShadow: true }
    );

    // ThinInstanced vertical steel guardrail posts + luminous reflectors (2 draw calls total!)
    const postMat = addMat(ctx, new PBRMaterial(`guardrail_post_mat_${ctx.bp.id}`, ctx.scene));
    postMat.albedoColor = Color3.FromHexString("#525d6b");
    postMat.metallic = 0.72;
    postMat.roughness = 0.48;

    const postMaster = MeshBuilder.CreateBox(
      `guardrail_posts_${ctx.bp.id}`,
      { width: 0.14, height: 1.02, depth: 0.16 },
      ctx.scene
    );
    postMaster.material = postMat;
    addMesh(ctx, postMaster, false, true);

    const reflMat = addMat(ctx, new StandardMaterial(`guardrail_refl_mat_${ctx.bp.id}`, ctx.scene));
    reflMat.emissiveColor =
      ctx.bp.theme === "TOKYO_MIDNIGHT"
        ? Color3.FromHexString("#00e5ff")
        : ctx.bp.theme === "COASTAL_SUNSET"
          ? Color3.FromHexString("#ffaa2b")
          : Color3.FromHexString("#ff3b4e");
    reflMat.disableLighting = true;

    const reflMaster = MeshBuilder.CreateBox(
      `guardrail_reflectors_${ctx.bp.id}`,
      { width: 0.06, height: 0.16, depth: 0.32 },
      ctx.scene
    );
    reflMaster.material = reflMat;
    addMesh(ctx, reflMaster, false, false);

    const postMats: Matrix[] = [];
    const reflMats: Matrix[] = [];
    const postScale = Vector3.One();
    const reflScale = Vector3.One();

    for (let i = 0; i < ctx.frames.length; i += 2) {
      const f = ctx.frames[i];
      const lat = f.roadWidth * 0.5 + f.shoulderWidth + 0.22;
      for (const side of [-1, 1]) {
        const px = f.position.x + f.right.x * (side * lat) + f.up.x * 0.44;
        const py = f.position.y + f.right.y * (side * lat) + f.up.y * 0.44;
        const pz = f.position.z + f.right.z * (side * lat) + f.up.z * 0.44;
        postMats.push(buildTransformMatrix(new Vector3(px, py, pz), f.yaw, postScale, -f.pitch, f.bankRad));

        if (i % 4 === 0) {
          const rLat = f.roadWidth * 0.5 + f.shoulderWidth - 0.02;
          const rx = f.position.x + f.right.x * (side * rLat) + f.up.x * 0.72;
          const ry = f.position.y + f.right.y * (side * rLat) + f.up.y * 0.72;
          const rz = f.position.z + f.right.z * (side * rLat) + f.up.z * 0.72;
          reflMats.push(buildTransformMatrix(new Vector3(rx, ry, rz), f.yaw, reflScale, -f.pitch, f.bankRad));
        }
      }
    }

    applyThinInstanceMatrices(postMaster, postMats);
    applyThinInstanceMatrices(reflMaster, reflMats);
  }

  /**
   * Builds the glowing overhead Start/Finish Gantry at distanceM = 0 with live 3-2-1-GO signal pods.
   */
  private static buildStartFinishGantry(ctx: BuildContext): (value: number) => void {
    const f = sampleTrackAtDistance(ctx.bp, 0);
    const gantryRoot = new TransformNode(`start_gantry_root_${ctx.bp.id}`, ctx.scene);
    gantryRoot.parent = ctx.root;
    gantryRoot.position.set(f.position.x, f.position.y, f.position.z);
    gantryRoot.rotation.y = f.yaw;
    gantryRoot.rotation.x = -f.pitch;
    gantryRoot.rotation.z = f.bankRad;

    const halfSpan = f.roadWidth * 0.5 + f.shoulderWidth + 1.5;
    const height = 8.8;

    const steelMat = addMat(ctx, new PBRMaterial(`gantry_steel_${ctx.bp.id}`, ctx.scene));
    steelMat.albedoColor = Color3.FromHexString("#202632");
    steelMat.metallic = 0.78;
    steelMat.roughness = 0.34;

    const accentHex =
      ctx.bp.theme === "TOKYO_MIDNIGHT"
        ? "#00f0ff"
        : ctx.bp.theme === "COASTAL_SUNSET"
          ? "#ff8a2b"
          : "#38bdf8";

    const accentStripMat = addMat(ctx, new StandardMaterial(`gantry_accent_${ctx.bp.id}`, ctx.scene));
    accentStripMat.emissiveColor = Color3.FromHexString(accentHex).scale(1.6);
    accentStripMat.disableLighting = true;

    const attachPart = (mesh: Mesh, castShadow = true) => {
      mesh.parent = gantryRoot;
      mesh.isPickable = false;
      mesh.receiveShadows = true;
      if (castShadow && ctx.shadowGen) ctx.shadowGen.addShadowCaster(mesh);
      ctx.disposableMeshes.push(mesh);
      return mesh;
    };

    // Dual left & right steel gantry support towers
    for (const side of [-1, 1]) {
      const pillar = MeshBuilder.CreateBox(
        `gantry_pillar_${side}`,
        { width: 1.05, height: height + 1.2, depth: 1.35 },
        ctx.scene
      );
      pillar.position.set(side * halfSpan, (height - 0.6) * 0.5, 0);
      pillar.material = steelMat;
      attachPart(pillar);

      const ledBar = MeshBuilder.CreateBox(
        `gantry_pillar_led_${side}`,
        { width: 0.14, height: height - 1.0, depth: 1.42 },
        ctx.scene
      );
      ledBar.position.set(side * (halfSpan - 0.52), height * 0.5, 0);
      ledBar.material = accentStripMat;
      attachPart(ledBar, false);
    }

    // Overhead main steel truss bridge
    const bridgeW = halfSpan * 2 + 1.4;
    const bridge = MeshBuilder.CreateBox(
      `gantry_bridge_${ctx.bp.id}`,
      { width: bridgeW, height: 1.9, depth: 1.45 },
      ctx.scene
    );
    bridge.position.set(0, height, 0);
    bridge.material = steelMat;
    attachPart(bridge);

    // Glowing overhead header signage on both front & rear faces
    const bannerTex = createBannerTexture(
      ctx,
      `gantry_banner_${ctx.bp.id}`,
      "APEXDRIVE",
      ctx.bp.name.toUpperCase(),
      "#0b1020",
      accentHex
    );
    const bannerMat = addMat(ctx, new StandardMaterial(`gantry_banner_mat_${ctx.bp.id}`, ctx.scene));
    bannerMat.diffuseTexture = bannerTex;
    bannerMat.emissiveTexture = bannerTex;
    bannerMat.emissiveColor = new Color3(0.85, 0.9, 1.0);
    bannerMat.disableLighting = true;

    for (const zSign of [-1, 1]) {
      const board = MeshBuilder.CreatePlane(
        `gantry_board_${zSign}`,
        { width: bridgeW - 2.2, height: 1.65 },
        ctx.scene
      );
      board.position.set(0, height, zSign * 0.76);
      if (zSign > 0) board.rotation.y = Math.PI;
      board.material = bannerMat;
      attachPart(board, false);
    }

    // Hanging 3-2-1-GO Motorsport Signal Light Pods (facing grid behind start line, -Z side)
    const housing = MeshBuilder.CreateBox(
      `gantry_light_housing_${ctx.bp.id}`,
      { width: 8.6, height: 1.25, depth: 0.65 },
      ctx.scene
    );
    housing.position.set(0, height - 1.55, -0.35);
    housing.material = steelMat;
    attachPart(housing, false);

    const podMats: StandardMaterial[] = [];
    const podXs = [-2.7, -0.9, 0.9, 2.7];
    for (let i = 0; i < 4; i++) {
      const pMat = addMat(ctx, new StandardMaterial(`gantry_pod_mat_${i}_${ctx.bp.id}`, ctx.scene));
      pMat.diffuseColor = new Color3(0.08, 0.08, 0.1);
      pMat.emissiveColor = new Color3(0.08, 0.04, 0.04);
      pMat.disableLighting = true;
      podMats.push(pMat);

      const pod = MeshBuilder.CreateCylinder(
        `gantry_pod_${i}_${ctx.bp.id}`,
        { diameter: 0.72, height: 0.2, tessellation: 18 },
        ctx.scene
      );
      pod.rotation.x = Math.PI / 2;
      pod.position.set(podXs[i], height - 1.55, -0.68);
      pod.material = pMat;
      attachPart(pod, false);
    }

    // Subtle start-line pool light on night track so grid cars gleam dramatically
    if (ctx.bp.isNight) {
      const startLight = new PointLight(
        `gantry_pool_light_${ctx.bp.id}`,
        new Vector3(f.position.x, f.position.y + 8.0, f.position.z - 12),
        ctx.scene
      );
      startLight.diffuse = Color3.FromHexString("#d8eeff");
      startLight.intensity = 18;
      startLight.range = 42;
      ctx.disposableLights.push(startLight);
    }

    const setCountdownLight = (value: number) => {
      if (value === 0) {
        // GO! All 4 pods blaze crisp motorsport green!
        for (const m of podMats) {
          m.emissiveColor.set(0.18, 2.8, 0.65);
        }
      } else if (value >= 1 && value <= 3) {
        // 3 => 1 lit red, 2 => 2 lit red, 1 => 3 lit red
        const litCount = 4 - value;
        for (let i = 0; i < podMats.length; i++) {
          if (i < litCount) {
            podMats[i].emissiveColor.set(2.9, 0.12, 0.1);
          } else {
            podMats[i].emissiveColor.set(0.12, 0.03, 0.03);
          }
        }
      } else {
        // Idle standby
        for (const m of podMats) {
          m.emissiveColor.set(0.08, 0.08, 0.1);
        }
      }
    };

    setCountdownLight(-1);
    return setCountdownLight;
  }

  /**
   * Builds concrete tunnel vaults + glowing ceiling LED light strips wherever `frame.isTunnel` is true.
   */
  private static buildTunnels(ctx: BuildContext): void {
    const n = ctx.frames.length;
    const spans: number[][] = [];
    let i = 0;
    while (i < n) {
      if (!ctx.frames[i].isTunnel) {
        i++;
        continue;
      }
      const span: number[] = [];
      while (i < n && ctx.frames[i].isTunnel) {
        span.push(i);
        i++;
      }
      if (span.length >= 3) spans.push(span);
    }

    if (spans.length === 0) return;

    const concreteMat = ctx.assets.getTrackPbrMaterial(
      `tunnel_concrete_${ctx.bp.id}`,
      "concrete_wall_005",
      1,
      1,
      { tintHex: "#6f7785", roughness: 0.85, metallic: 0.06, bumpLevel: 0.9 }
    );

    const outerShellMat = addMat(ctx, new PBRMaterial(`tunnel_outer_${ctx.bp.id}`, ctx.scene));
    outerShellMat.albedoColor = Color3.FromHexString("#282f3c");
    outerShellMat.roughness = 0.9;
    outerShellMat.metallic = 0.08;

    const stripMat = addMat(ctx, new StandardMaterial(`tunnel_led_strip_${ctx.bp.id}`, ctx.scene));
    stripMat.emissiveColor = Color3.FromHexString("#fff1d6").scale(2.1);
    stripMat.disableLighting = true;

    const sideAccentMat = addMat(ctx, new StandardMaterial(`tunnel_side_neon_${ctx.bp.id}`, ctx.scene));
    sideAccentMat.emissiveColor = Color3.FromHexString("#00e5ff").scale(1.8);
    sideAccentMat.disableLighting = true;

    for (let s = 0; s < spans.length; s++) {
      const span = spans[s];
      const archSegs = 10;
      const wallH = 3.2;
      const archH = 4.6; // Total crown clearance = 7.8m (plenty for ChaseCamera!)

      // 1. Inner concrete arch lining (profile goes RIGHT base -> ceiling -> LEFT base so cross(fwd, step) points INWARD!)
      buildExtrudedTrackMesh(
        ctx,
        `tunnel_inner_${s}`,
        span,
        false,
        (frame) => {
          const halfW = frame.roadWidth * 0.5 + frame.shoulderWidth + 0.55;
          const pts: ProfilePoint[] = [];
          pts.push({ lat: halfW, up: -0.2, nLat: -1, nUp: 0, u: 0 });
          pts.push({ lat: halfW, up: wallH, nLat: -1, nUp: 0, u: 0.16 });
          for (let k = 1; k < archSegs; k++) {
            const ang = (k / archSegs) * Math.PI; // 0 (right) -> PI (left)
            const c = Math.cos(ang);
            const sn = Math.sin(ang);
            pts.push({
              lat: halfW * c,
              up: wallH + archH * sn,
              nLat: -c,
              nUp: -sn,
              u: 0.16 + (k / archSegs) * 0.68,
            });
          }
          pts.push({ lat: -halfW, up: wallH, nLat: 1, nUp: 0, u: 0.84 });
          pts.push({ lat: -halfW, up: -0.2, nLat: 1, nUp: 0, u: 1.0 });
          return pts;
        },
        1 / 8,
        concreteMat,
        { backFaceCulling: false, castShadow: false, receiveShadow: true }
      );

      // 2. Outer structural concrete shell so tunnel looks solid from outside approach!
      buildExtrudedTrackMesh(
        ctx,
        `tunnel_outer_shell_${s}`,
        span,
        false,
        (frame) => {
          const halfW = frame.roadWidth * 0.5 + frame.shoulderWidth + 1.45;
          return [
            { lat: -halfW, up: -0.4, nLat: -1, nUp: 0, u: 0 },
            { lat: -halfW, up: wallH + 1.2, nLat: -0.8, nUp: 0.6, u: 0.25 },
            { lat: 0, up: wallH + archH + 1.0, nLat: 0, nUp: 1, u: 0.5 },
            { lat: halfW, up: wallH + 1.2, nLat: 0.8, nUp: 0.6, u: 0.75 },
            { lat: halfW, up: -0.4, nLat: 1, nUp: 0, u: 1 },
          ];
        },
        1 / 12,
        outerShellMat,
        { backFaceCulling: false }
      );

      // 3. Glowing dual ceiling LED light strips running full length of tunnel
      for (const offsetX of [-2.4, 2.4]) {
        buildExtrudedTrackMesh(
          ctx,
          `tunnel_ceiling_led_${s}_${offsetX < 0 ? "l" : "r"}`,
          span,
          false,
          (frame) => {
            const halfW = frame.roadWidth * 0.5 + frame.shoulderWidth + 0.55;
            const ratio = Math.min(0.85, Math.abs(offsetX) / halfW);
            const y = wallH + archH * Math.sqrt(Math.max(0.1, 1 - ratio * ratio)) - 0.16;
            return [
              { lat: offsetX + 0.24, up: y, nLat: 0, nUp: -1, u: 0 },
              { lat: offsetX - 0.24, up: y, nLat: 0, nUp: -1, u: 1 },
            ];
          },
          1 / 6,
          stripMat,
          { backFaceCulling: false, receiveShadow: false }
        );
      }

      // 4. Lower cyber-cyan tunnel wall guide strips
      for (const side of [-1, 1]) {
        buildExtrudedTrackMesh(
          ctx,
          `tunnel_guide_led_${s}_${side < 0 ? "l" : "r"}`,
          span,
          false,
          (frame) => {
            const wallX = side * (frame.roadWidth * 0.5 + frame.shoulderWidth + 0.44);
            return side > 0
              ? [
                  { lat: wallX, up: 1.45, nLat: -1, nUp: 0, u: 0 },
                  { lat: wallX, up: 1.65, nLat: -1, nUp: 0, u: 1 },
                ]
              : [
                  { lat: wallX, up: 1.65, nLat: 1, nUp: 0, u: 0 },
                  { lat: wallX, up: 1.45, nLat: 1, nUp: 0, u: 1 },
                ];
          },
          1 / 6,
          sideAccentMat,
          { backFaceCulling: false, receiveShadow: false }
        );
      }

      // 5. Tunnel portal header signs at entry & exit + interior illumination lights
      for (const endIdx of [span[0], span[span.length - 1]]) {
        const ef = ctx.frames[endIdx];
        const portal = MeshBuilder.CreateBox(
          `tunnel_portal_${s}_${endIdx}`,
          { width: ef.roadWidth + ef.shoulderWidth * 2 + 3.2, height: 1.8, depth: 1.4 },
          ctx.scene
        );
        portal.position.set(
          ef.position.x + ef.up.x * (wallH + archH + 0.4),
          ef.position.y + ef.up.y * (wallH + archH + 0.4),
          ef.position.z + ef.up.z * (wallH + archH + 0.4)
        );
        portal.rotation.y = ef.yaw;
        portal.material = outerShellMat;
        addMesh(ctx, portal, false, false);
      }

      const lightCount = Math.min(4, Math.max(2, Math.floor(span.length / 10)));
      for (let li = 0; li < lightCount; li++) {
        const fIdx = span[Math.floor(((li + 0.5) / lightCount) * span.length)];
        const lf = ctx.frames[fIdx];
        const ptLight = new PointLight(
          `tunnel_light_${s}_${li}`,
          new Vector3(
            lf.position.x + lf.up.x * 6.0,
            lf.position.y + lf.up.y * 6.0,
            lf.position.z + lf.up.z * 6.0
          ),
          ctx.scene
        );
        ptLight.diffuse = Color3.FromHexString("#ffefd2");
        ptLight.intensity = 22;
        ptLight.range = 46;
        ctx.disposableLights.push(ptLight);
      }
    }
  }

  /**
   * Tokyo Midnight Expressway Scenery:
   * - Glowing cyan/magenta skyscrapers, neon highway billboards, overhead streetlamp poles, viaduct piers
   */
  private static buildTokyoScenery(ctx: BuildContext): void {
    // 1. Dark reflective Tokyo bay/city floor plane far below the elevated highway
    const ground = MeshBuilder.CreateGround("tokyo_city_floor", { width: 1600, height: 1600 }, ctx.scene);
    ground.position.set(170, -12, 30);
    const groundMat = addMat(ctx, new PBRMaterial("tokyo_floor_mat", ctx.scene));
    groundMat.albedoColor = Color3.FromHexString("#070b15");
    groundMat.roughness = 0.28;
    groundMat.metallic = 0.35;
    ground.material = groundMat;
    addMesh(ctx, ground, false, false);

    // 2. Concrete expressway viaduct piers under elevated road sections (ThinInstanced)
    const pierMat = addMat(ctx, new PBRMaterial("tokyo_pier_mat", ctx.scene));
    pierMat.albedoColor = Color3.FromHexString("#2f3644");
    pierMat.roughness = 0.88;
    pierMat.metallic = 0.06;

    const pierMaster = MeshBuilder.CreateBox("tokyo_viaduct_piers", { width: 4.5, height: 1, depth: 2.4 }, ctx.scene);
    pierMaster.material = pierMat;
    addMesh(ctx, pierMaster, false, false);

    const pierMats: Matrix[] = [];
    for (let i = 0; i < ctx.frames.length; i += 8) {
      const f = ctx.frames[i];
      const h = Math.max(4, f.position.y + 12);
      pierMats.push(
        buildTransformMatrix(
          new Vector3(f.position.x, f.position.y - h * 0.5 - 0.5, f.position.z),
          f.yaw,
          new Vector3(1, h, 1)
        )
      );
    }
    applyThinInstanceMatrices(pierMaster, pierMats);

    // 3. Overhead Streetlamp Poles & Glowing Lamp Heads along non-tunnel expressway (ThinInstanced!)
    const poleMat = addMat(ctx, new PBRMaterial("tokyo_lamp_pole_mat", ctx.scene));
    poleMat.albedoColor = Color3.FromHexString("#475569");
    poleMat.metallic = 0.78;
    poleMat.roughness = 0.35;

    const poleMaster = MeshBuilder.CreateCylinder(
      "tokyo_lamp_poles",
      { diameterTop: 0.16, diameterBottom: 0.24, height: 8.6, tessellation: 8 },
      ctx.scene
    );
    poleMaster.material = poleMat;
    addMesh(ctx, poleMaster, false, false);

    const armMaster = MeshBuilder.CreateBox(
      "tokyo_lamp_arms",
      { width: 3.4, height: 0.14, depth: 0.16 },
      ctx.scene
    );
    armMaster.material = poleMat;
    addMesh(ctx, armMaster, false, false);

    const bulbMat = addMat(ctx, new StandardMaterial("tokyo_lamp_bulb_mat", ctx.scene));
    bulbMat.emissiveColor = Color3.FromHexString("#ffd89b").scale(2.4);
    bulbMat.disableLighting = true;

    const bulbMaster = MeshBuilder.CreateBox(
      "tokyo_lamp_bulbs",
      { width: 1.25, height: 0.14, depth: 0.38 },
      ctx.scene
    );
    bulbMaster.material = bulbMat;
    addMesh(ctx, bulbMaster, false, false);

    const poleMats: Matrix[] = [];
    const armMats: Matrix[] = [];
    const bulbMats: Matrix[] = [];

    for (let i = 4; i < ctx.frames.length; i += 7) {
      const f = ctx.frames[i];
      if (f.isTunnel) continue;
      const side = (Math.floor(i / 7) % 2 === 0 ? 1 : -1);
      const lat = side * (f.roadWidth * 0.5 + f.shoulderWidth + 0.55);

      const baseX = f.position.x + f.right.x * lat;
      const baseY = f.position.y + f.right.y * lat;
      const baseZ = f.position.z + f.right.z * lat;

      poleMats.push(
        buildTransformMatrix(new Vector3(baseX, baseY + 4.3, baseZ), f.yaw, Vector3.One())
      );

      const armX = baseX - f.right.x * (side * 1.65);
      const armZ = baseZ - f.right.z * (side * 1.65);
      armMats.push(
        buildTransformMatrix(new Vector3(armX, baseY + 8.5, armZ), f.yaw, Vector3.One())
      );

      const bulbX = baseX - f.right.x * (side * 3.1);
      const bulbZ = baseZ - f.right.z * (side * 3.1);
      bulbMats.push(
        buildTransformMatrix(new Vector3(bulbX, baseY + 8.35, bulbZ), f.yaw, Vector3.One())
      );
    }
    applyThinInstanceMatrices(poleMaster, poleMats);
    applyThinInstanceMatrices(armMaster, armMats);
    applyThinInstanceMatrices(bulbMaster, bulbMats);

    // 4. Glowing Cyan / Magenta Tokyo Skyscraper Facades (3 ThinInstanced tower styles!)
    const facadeDefs = [
      { name: "tokyo_tower_cyan", base: "#0a1020", c1: "rgba(0,240,255,0.88)", c2: "rgba(110,205,255,0.75)", seed: 101 },
      { name: "tokyo_tower_mag", base: "#120a1f", c1: "rgba(255,40,165,0.86)", c2: "rgba(180,95,255,0.75)", seed: 202 },
      { name: "tokyo_tower_gold", base: "#0d121c", c1: "rgba(255,205,115,0.82)", c2: "rgba(0,225,255,0.7)", seed: 303 },
    ];

    const towerBuckets: Matrix[][] = [[], [], []];
    let bSeed = 9001;
    const rand = () => {
      bSeed = (bSeed * 1664525 + 1013904223) >>> 0;
      return bSeed / 4294967296;
    };

    for (let i = 0; i < ctx.frames.length; i += 6) {
      const f = ctx.frames[i];
      for (const side of [-1, 1]) {
        const distOut = 26 + rand() * 34;
        const bx = f.position.x + f.right.x * side * distOut;
        const bz = f.position.z + f.right.z * side * distOut;
        if (!isClearOfTrack(bx, bz, 22, ctx.frames)) continue;

        const w = 13 + rand() * 14;
        const d = 13 + rand() * 14;
        const h = 42 + rand() * 98;
        const bucket = Math.floor(rand() * 3) % 3;
        towerBuckets[bucket].push(
          buildTransformMatrix(
            new Vector3(bx, -13 + h * 0.5, bz),
            f.yaw + (rand() - 0.5) * 0.25,
            new Vector3(w, h, d)
          )
        );
      }
    }

    for (let b = 0; b < facadeDefs.length; b++) {
      const def = facadeDefs[b];
      const tex = createSkyscraperFacadeTexture(ctx, `${def.name}_tex`, def.base, def.c1, def.c2, def.seed);
      const mat = addMat(ctx, new PBRMaterial(`${def.name}_mat`, ctx.scene));
      mat.albedoTexture = tex;
      mat.emissiveTexture = tex;
      mat.emissiveColor = new Color3(0.92, 0.92, 0.98);
      mat.roughness = 0.28;
      mat.metallic = 0.55;

      const box = MeshBuilder.CreateBox(def.name, { size: 1 }, ctx.scene);
      box.material = mat;
      addMesh(ctx, box, false, false);
      applyThinInstanceMatrices(box, towerBuckets[b]);
    }

    // 5. Neon Highway Billboards on elevated trusses
    const billboardSpecs = [
      { frameIdx: 24, side: 1, title: "WANGAN NIGHTS", sub: "TOKYO EXPRESSWAY", accent: "#00f0ff" },
      { frameIdx: 62, side: -1, title: "APEXDRIVE", sub: "TURBO DRIFT CLUB", accent: "#ff26a8" },
      { frameIdx: 112, side: 1, title: "NITRO SPEC", sub: "300+ KM/H ZONE", accent: "#00f59b" },
      { frameIdx: 235, side: -1, title: "MIDNIGHT GT", sub: "SHUTO LOOP C1", accent: "#ff26a8" },
      { frameIdx: 282, side: 1, title: "FINAL SECTOR", sub: "FULL BOOST", accent: "#00f0ff" },
    ];

    const bbFrameMat = addMat(ctx, new PBRMaterial("tokyo_bb_frame", ctx.scene));
    bbFrameMat.albedoColor = Color3.FromHexString("#1e2533");
    bbFrameMat.metallic = 0.75;
    bbFrameMat.roughness = 0.4;

    for (let k = 0; k < billboardSpecs.length; k++) {
      const spec = billboardSpecs[k];
      const f = ctx.frames[spec.frameIdx % ctx.frames.length];
      if (f.isTunnel) continue;
      const lat = spec.side * (f.roadWidth * 0.5 + f.shoulderWidth + 4.8);
      const bx = f.position.x + f.right.x * lat;
      const by = f.position.y + 6.8;
      const bz = f.position.z + f.right.z * lat;

      const bbTex = createBannerTexture(
        ctx,
        `tokyo_bb_tex_${k}`,
        spec.title,
        spec.sub,
        "#060916",
        spec.accent
      );
      const bbMat = addMat(ctx, new StandardMaterial(`tokyo_bb_mat_${k}`, ctx.scene));
      bbMat.diffuseTexture = bbTex;
      bbMat.emissiveTexture = bbTex;
      bbMat.emissiveColor = new Color3(1.15, 1.15, 1.2);
      bbMat.disableLighting = true;

      const panel = MeshBuilder.CreateBox(`tokyo_bb_panel_${k}`, { width: 11.5, height: 3.4, depth: 0.45 }, ctx.scene);
      panel.position.set(bx, by, bz);
      // Angle billboard cleanly toward oncoming drivers!
      panel.rotation.y = f.yaw - spec.side * 0.45;
      panel.material = bbMat;
      addMesh(ctx, panel, false, false);

      const post = MeshBuilder.CreateBox(`tokyo_bb_post_${k}`, { width: 0.55, height: 8.5, depth: 0.55 }, ctx.scene);
      post.position.set(bx, by - 5.2, bz);
      post.material = bbFrameMat;
      addMesh(ctx, post, false, false);
    }
  }

  /**
   * Coastal Sunset Canyon Scenery:
   * - Golden-hour ocean bay below, sculpted 2K cliff_rock mountain walls, boulders, roadside pines & coastal palms
   */
  private static buildCoastalScenery(ctx: BuildContext): void {
    // 1. Shimmering golden-hour Pacific ocean plane below the canyon road
    const ocean = MeshBuilder.CreateGround("coastal_ocean", { width: 2200, height: 2200 }, ctx.scene);
    ocean.position.set(170, -16, 20);
    const oceanMat = addMat(ctx, new PBRMaterial("coastal_ocean_mat", ctx.scene));
    oceanMat.albedoColor = Color3.FromHexString("#163954");
    oceanMat.roughness = 0.14;
    oceanMat.metallic = 0.42;
    oceanMat.environmentIntensity = 1.15;
    ocean.material = oceanMat;
    addMesh(ctx, ocean, false, false);

    // 2. Sculpted Rocky Canyon Cliff Wall along inner mountain side (using real 2K cliff_rock PBR!)
    const cliffMat = ctx.assets.getTrackPbrMaterial("coastal_cliff_mat", "cliff_rock", 1, 1, {
      tintHex: "#c99672",
      roughness: 0.92,
      metallic: 0.04,
      bumpLevel: 1.15,
    });

    const allIndices = ctx.frames.map((_, i) => i);
    // Rising mountain ridge on the left (inland) side of the pass
    buildExtrudedTrackMesh(
      ctx,
      "coastal_canyon_cliff_wall",
      allIndices,
      true,
      (frame, rowIdx) => {
        const edge = -(frame.roadWidth * 0.5 + frame.shoulderWidth + 2.2);
        const ridgeWave = Math.sin(rowIdx * 0.17) * 7.5 + Math.cos(rowIdx * 0.07) * 6.0;
        const cliffH = 22 + Math.max(0, ridgeWave);
        return [
          { lat: edge - 30, up: cliffH - 6, nLat: 0.3, nUp: 0.95, u: 4.5 },
          { lat: edge - 14, up: cliffH, nLat: 0.65, nUp: 0.75, u: 2.8 },
          { lat: edge - 6.5, up: cliffH * 0.52, nLat: 0.9, nUp: 0.42, u: 1.4 },
          { lat: edge, up: -0.6, nLat: 0.94, nUp: 0.34, u: 0.0 },
        ];
      },
      1 / 14,
      cliffMat,
      { backFaceCulling: false }
    );

    // 3. ThinInstanced Rocky Canyon Boulders
    const boulderMaster = MeshBuilder.CreatePolyhedron(
      "coastal_boulders",
      { type: 1, size: 1.0 },
      ctx.scene
    );
    boulderMaster.material = cliffMat;
    addMesh(ctx, boulderMaster, true, true);

    // 4. Stylized Roadside Pines & Coastal Palms (ThinInstanced trunks + foliage crowns = 2 draw calls!)
    const trunkMat = addMat(ctx, new PBRMaterial("coastal_trunk_mat", ctx.scene));
    trunkMat.albedoColor = Color3.FromHexString("#593e2b");
    trunkMat.roughness = 0.92;
    trunkMat.metallic = 0.02;

    const foliageMat = addMat(ctx, new PBRMaterial("coastal_foliage_mat", ctx.scene));
    foliageMat.albedoColor = Color3.FromHexString("#2f5d38");
    foliageMat.roughness = 0.78;
    foliageMat.metallic = 0.02;

    const trunkMaster = MeshBuilder.CreateCylinder(
      "coastal_tree_trunks",
      { diameterTop: 0.24, diameterBottom: 0.48, height: 1, tessellation: 7 },
      ctx.scene
    );
    trunkMaster.material = trunkMat;
    addMesh(ctx, trunkMaster, true, true);

    const canopyMaster = MeshBuilder.CreateCylinder(
      "coastal_tree_canopies",
      { diameterTop: 0.1, diameterBottom: 3.4, height: 1, tessellation: 8 },
      ctx.scene
    );
    canopyMaster.material = foliageMat;
    addMesh(ctx, canopyMaster, true, true);

    const boulderMats: Matrix[] = [];
    const trunkMats: Matrix[] = [];
    const canopyMats: Matrix[] = [];

    let seed = 4455;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };

    for (let i = 0; i < ctx.frames.length; i += 3) {
      const f = ctx.frames[i];
      // Place rugged canyon boulders & pine trees along outer shoulders & hillsides
      for (const side of [-1, 1]) {
        const latDist = f.roadWidth * 0.5 + f.shoulderWidth + 3.2 + rand() * 8.5;
        const px = f.position.x + f.right.x * side * latDist;
        const pz = f.position.z + f.right.z * side * latDist;
        if (!isClearOfTrack(px, pz, f.roadWidth * 0.5 + f.shoulderWidth + 2.0, ctx.frames)) continue;

        const baseH = f.position.y + (side < 0 ? 0.6 + rand() * 3.5 : -0.6 - rand() * 2.5);

        if (rand() < 0.65) {
          const treeH = 5.5 + rand() * 4.8;
          trunkMats.push(
            buildTransformMatrix(
              new Vector3(px, baseH + treeH * 0.35, pz),
              rand() * Math.PI * 2,
              new Vector3(1, treeH * 0.7, 1)
            )
          );
          canopyMats.push(
            buildTransformMatrix(
              new Vector3(px, baseH + treeH * 0.78, pz),
              rand() * Math.PI * 2,
              new Vector3(0.85 + rand() * 0.55, treeH * 0.75, 0.85 + rand() * 0.55)
            )
          );
          // Secondary upper tier for stylized pine silhouette
          canopyMats.push(
            buildTransformMatrix(
              new Vector3(px, baseH + treeH * 1.05, pz),
              rand() * Math.PI * 2,
              new Vector3(0.6 + rand() * 0.35, treeH * 0.5, 0.6 + rand() * 0.35)
            )
          );
        } else {
          const rScale = 1.6 + rand() * 3.4;
          boulderMats.push(
            buildTransformMatrix(
              new Vector3(px, baseH + rScale * 0.35, pz),
              rand() * Math.PI * 2,
              new Vector3(rScale * 1.25, rScale * 0.85, rScale)
            )
          );
        }
      }
    }

    applyThinInstanceMatrices(boulderMaster, boulderMats);
    applyThinInstanceMatrices(trunkMaster, trunkMats);
    applyThinInstanceMatrices(canopyMaster, canopyMats);

    // 5. Scenic Coastal Overlook Sign Arch on crest straight
    const crestFrame = ctx.frames[95];
    if (crestFrame) {
      TrackBuilder.buildSponsorArch(
        ctx,
        "coastal_overlook_arch",
        crestFrame,
        "PACIFIC CANYON",
        "SUNSET CREST OVERLOOK",
        "#2b1a14",
        "#ff9b30"
      );
    }
  }

  /**
   * Harbor Grand Prix Circuit Scenery:
   * - Infield grass apron, harbor ocean water, grandstands, pit garages, tire stacks, sponsor arches & port cranes
   */
  private static buildHarborScenery(ctx: BuildContext): void {
    // 1. Sunlit harbor sea water surrounding the peninsula
    const sea = MeshBuilder.CreateGround("harbor_sea", { width: 2400, height: 2400 }, ctx.scene);
    sea.position.set(160, -2.2, 40);
    const seaMat = addMat(ctx, new PBRMaterial("harbor_sea_mat", ctx.scene));
    seaMat.albedoColor = Color3.FromHexString("#14588a");
    seaMat.roughness = 0.16;
    seaMat.metallic = 0.32;
    seaMat.environmentIntensity = 1.1;
    sea.material = seaMat;
    addMesh(ctx, sea, false, false);

    // 2. Circuit Peninsula Infield Lawn & Concrete Apron
    const peninsula = MeshBuilder.CreateGround("harbor_infield_lawn", { width: 520, height: 740 }, ctx.scene);
    peninsula.position.set(150, -0.38, 46);
    const lawnMat = addMat(ctx, new PBRMaterial("harbor_lawn_mat", ctx.scene));
    lawnMat.albedoColor = Color3.FromHexString("#3f6f3b");
    lawnMat.roughness = 0.92;
    lawnMat.metallic = 0.02;
    peninsula.material = lawnMat;
    addMesh(ctx, peninsula, false, true);

    // 3. Main Motorsport Grandstands (along left of main straight + corner overlook!)
    TrackBuilder.buildGrandstand(ctx, "harbor_grandstand_main", sampleTrackAtDistance(ctx.bp, 35), -1, 56);
    TrackBuilder.buildGrandstand(ctx, "harbor_grandstand_straight", sampleTrackAtDistance(ctx.bp, 145), -1, 48);
    TrackBuilder.buildGrandstand(ctx, "harbor_grandstand_hairpin", ctx.frames[102], 1, 40);

    // 4. Pit Lane Garage Building Complex (right side of Start/Finish straight)
    const pitFrame = sampleTrackAtDistance(ctx.bp, 20);
    const pitRoot = new TransformNode("harbor_pit_complex", ctx.scene);
    pitRoot.parent = ctx.root;
    const pitLat = pitFrame.roadWidth * 0.5 + pitFrame.shoulderWidth + 9.5;
    pitRoot.position.set(
      pitFrame.position.x + pitFrame.right.x * pitLat,
      pitFrame.position.y,
      pitFrame.position.z + pitFrame.right.z * pitLat
    );
    pitRoot.rotation.y = pitFrame.yaw;

    const pitWallMat = addMat(ctx, new PBRMaterial("harbor_pit_wall_mat", ctx.scene));
    pitWallMat.albedoColor = Color3.FromHexString("#e2e8f0");
    pitWallMat.roughness = 0.45;
    pitWallMat.metallic = 0.18;

    const pitDarkMat = addMat(ctx, new PBRMaterial("harbor_pit_bay_mat", ctx.scene));
    pitDarkMat.albedoColor = Color3.FromHexString("#161b26");
    pitDarkMat.roughness = 0.85;

    const pitAccentMat = addMat(ctx, new StandardMaterial("harbor_pit_accent_mat", ctx.scene));
    pitAccentMat.emissiveColor = Color3.FromHexString("#e11d48");
    pitAccentMat.disableLighting = true;

    const pitBody = MeshBuilder.CreateBox("harbor_pit_body", { width: 10, height: 6.4, depth: 62 }, ctx.scene);
    pitBody.parent = pitRoot;
    pitBody.position.set(0, 3.2, 0);
    pitBody.material = pitWallMat;
    pitBody.isPickable = false;
    pitBody.receiveShadows = true;
    ctx.shadowGen?.addShadowCaster(pitBody);
    ctx.disposableMeshes.push(pitBody);

    const pitStripe = MeshBuilder.CreateBox("harbor_pit_stripe", { width: 10.3, height: 0.65, depth: 62.2 }, ctx.scene);
    pitStripe.parent = pitRoot;
    pitStripe.position.set(0, 5.6, 0);
    pitStripe.material = pitAccentMat;
    pitStripe.isPickable = false;
    ctx.disposableMeshes.push(pitStripe);

    for (let b = -24; b <= 24; b += 8) {
      const bay = MeshBuilder.CreateBox(`harbor_pit_bay_${b}`, { width: 0.4, height: 3.4, depth: 5.2 }, ctx.scene);
      bay.parent = pitRoot;
      bay.position.set(-4.95, 1.7, b);
      bay.material = pitDarkMat;
      bay.isPickable = false;
      ctx.disposableMeshes.push(bay);
    }

    // 5. Red & White Motorsport Tire Barrier Stacks along corner runoffs (ThinInstanced!)
    const tireRedMat = addMat(ctx, new PBRMaterial("harbor_tire_red", ctx.scene));
    tireRedMat.albedoColor = Color3.FromHexString("#dc2626");
    tireRedMat.roughness = 0.85;

    const tireWhiteMat = addMat(ctx, new PBRMaterial("harbor_tire_white", ctx.scene));
    tireWhiteMat.albedoColor = Color3.FromHexString("#f1f5f9");
    tireWhiteMat.roughness = 0.82;

    const tireRedMaster = MeshBuilder.CreateCylinder(
      "harbor_tires_red",
      { diameter: 0.92, height: 1.05, tessellation: 12 },
      ctx.scene
    );
    tireRedMaster.material = tireRedMat;
    addMesh(ctx, tireRedMaster, true, true);

    const tireWhiteMaster = MeshBuilder.CreateCylinder(
      "harbor_tires_white",
      { diameter: 0.92, height: 1.05, tessellation: 12 },
      ctx.scene
    );
    tireWhiteMaster.material = tireWhiteMat;
    addMesh(ctx, tireWhiteMaster, true, true);

    const redMatrices: Matrix[] = [];
    const whiteMatrices: Matrix[] = [];
    for (let i = 0; i < ctx.frames.length; i += 2) {
      const f = ctx.frames[i];
      if (Math.abs(f.curvature) < 0.0055) continue;
      // Place tire stacks on the OUTSIDE of high-speed corners
      const outSide = f.curvature > 0 ? -1 : 1;
      const lat = outSide * (f.roadWidth * 0.5 + f.shoulderWidth + 0.72);
      const pos = new Vector3(
        f.position.x + f.right.x * lat,
        f.position.y + 0.52,
        f.position.z + f.right.z * lat
      );
      const m = buildTransformMatrix(pos, f.yaw, Vector3.One());
      if (Math.floor(i / 2) % 2 === 0) redMatrices.push(m);
      else whiteMatrices.push(m);
    }
    applyThinInstanceMatrices(tireRedMaster, redMatrices);
    applyThinInstanceMatrices(tireWhiteMaster, whiteMatrices);

    // 6. Overhead Motorsport Sponsor Arches around the circuit
    TrackBuilder.buildSponsorArch(ctx, "harbor_arch_1", ctx.frames[56], "HARBOR GRAND PRIX", "SLIPSTREAM STRAIGHT", "#0f172a", "#38bdf8");
    TrackBuilder.buildSponsorArch(ctx, "harbor_arch_2", ctx.frames[172], "APEXDRIVE GP", "PRO RACING SERIES", "#1e1b4b", "#f43f5e");
    TrackBuilder.buildSponsorArch(ctx, "harbor_arch_3", ctx.frames[260], "NITRO MOTORSPORT", "FINAL CHICANE", "#0b132b", "#f59e0b");

    // 7. Harbor Shipping Containers & Distant Gantry Cranes around the port waterfront
    const containerColors = ["#dc2626", "#2563eb", "#f59e0b", "#0d9488"];
    const containerBuckets: Matrix[][] = [[], [], [], []];
    const clusterCenters = [
      { x: -65, z: 120, yaw: 0.1 },
      { x: -68, z: -40, yaw: 0.05 },
      { x: 365, z: 140, yaw: -0.2 },
      { x: 355, z: -120, yaw: 0.3 },
    ];
    for (let c = 0; c < clusterCenters.length; c++) {
      const cc = clusterCenters[c];
      for (let row = 0; row < 4; row++) {
        for (let stack = 0; stack < 2; stack++) {
          const cx = cc.x + row * 4.2;
          const cz = cc.z + (row % 2) * 14;
          if (!isClearOfTrack(cx, cz, 24, ctx.frames)) continue;
          const bucket = (c + row + stack) % 4;
          containerBuckets[bucket].push(
            buildTransformMatrix(
              new Vector3(cx, 1.3 + stack * 2.8, cz),
              cc.yaw,
              new Vector3(3.1, 2.75, 11.5)
            )
          );
        }
      }
    }
    for (let b = 0; b < containerColors.length; b++) {
      const mat = addMat(ctx, new PBRMaterial(`harbor_container_mat_${b}`, ctx.scene));
      mat.albedoColor = Color3.FromHexString(containerColors[b]);
      mat.roughness = 0.65;
      mat.metallic = 0.35;
      const box = MeshBuilder.CreateBox(`harbor_containers_${b}`, { size: 1 }, ctx.scene);
      box.material = mat;
      addMesh(ctx, box, true, true);
      applyThinInstanceMatrices(box, containerBuckets[b]);
    }
  }

  private static buildGrandstand(
    ctx: BuildContext,
    name: string,
    frame: TrackFrame,
    side: -1 | 1,
    length: number
  ): void {
    const lat = side * (frame.roadWidth * 0.5 + frame.shoulderWidth + 11.5);
    const gx = frame.position.x + frame.right.x * lat;
    const gz = frame.position.z + frame.right.z * lat;
    if (!isClearOfTrack(gx, gz, frame.roadWidth * 0.5 + frame.shoulderWidth + 6.5, ctx.frames)) return;

    const root = new TransformNode(name, ctx.scene);
    root.parent = ctx.root;
    root.position.set(gx, frame.position.y, gz);
    root.rotation.y = frame.yaw;

    const concreteMat = addMat(ctx, new PBRMaterial(`${name}_conc`, ctx.scene));
    concreteMat.albedoColor = Color3.FromHexString("#cbd5e1");
    concreteMat.roughness = 0.72;

    const roofMat = addMat(ctx, new PBRMaterial(`${name}_roof`, ctx.scene));
    roofMat.albedoColor = Color3.FromHexString("#f8fafc");
    roofMat.roughness = 0.4;
    roofMat.metallic = 0.2;

    const seatColors = ["#ef4444", "#2563eb", "#f59e0b", "#e2e8f0"];
    const seatMats = seatColors.map((hex, idx) => {
      const m = addMat(ctx, new PBRMaterial(`${name}_seat_${idx}`, ctx.scene));
      m.albedoColor = Color3.FromHexString(hex);
      m.roughness = 0.65;
      return m;
    });

    // Stepped spectator tiers rising away from the track
    for (let t = 0; t < 5; t++) {
      const step = MeshBuilder.CreateBox(
        `${name}_tier_${t}`,
        { width: 2.1, height: 0.95, depth: length },
        ctx.scene
      );
      step.parent = root;
      step.position.set(side * (-4.0 + t * 1.9), 0.9 + t * 1.05, 0);
      step.material = seatMats[t % seatMats.length];
      step.isPickable = false;
      step.receiveShadows = true;
      ctx.shadowGen?.addShadowCaster(step);
      ctx.disposableMeshes.push(step);
    }

    // Back wall + cantilevered canopy roof
    const backWall = MeshBuilder.CreateBox(`${name}_back`, { width: 0.7, height: 9.2, depth: length }, ctx.scene);
    backWall.parent = root;
    backWall.position.set(side * 5.2, 4.6, 0);
    backWall.material = concreteMat;
    backWall.isPickable = false;
    ctx.shadowGen?.addShadowCaster(backWall);
    ctx.disposableMeshes.push(backWall);

    const roof = MeshBuilder.CreateBox(`${name}_canopy`, { width: 12.2, height: 0.45, depth: length + 2 }, ctx.scene);
    roof.parent = root;
    roof.position.set(side * 0.2, 9.5, 0);
    roof.rotation.z = side * -0.1;
    roof.material = roofMat;
    roof.isPickable = false;
    ctx.shadowGen?.addShadowCaster(roof);
    ctx.disposableMeshes.push(roof);
  }

  private static buildSponsorArch(
    ctx: BuildContext,
    name: string,
    frame: TrackFrame,
    title: string,
    subtitle: string,
    bgHex: string,
    accentHex: string
  ): void {
    const archRoot = new TransformNode(name, ctx.scene);
    archRoot.parent = ctx.root;
    archRoot.position.set(frame.position.x, frame.position.y, frame.position.z);
    archRoot.rotation.y = frame.yaw;

    const halfSpan = frame.roadWidth * 0.5 + frame.shoulderWidth + 1.3;
    const h = 8.4;

    const steelMat = addMat(ctx, new PBRMaterial(`${name}_steel`, ctx.scene));
    steelMat.albedoColor = Color3.FromHexString("#1e293b");
    steelMat.metallic = 0.72;
    steelMat.roughness = 0.38;

    for (const side of [-1, 1]) {
      const col = MeshBuilder.CreateBox(`${name}_col_${side}`, { width: 0.9, height: h, depth: 0.9 }, ctx.scene);
      col.parent = archRoot;
      col.position.set(side * halfSpan, h * 0.5, 0);
      col.material = steelMat;
      col.isPickable = false;
      ctx.shadowGen?.addShadowCaster(col);
      ctx.disposableMeshes.push(col);
    }

    const tex = createBannerTexture(ctx, `${name}_tex`, title, subtitle, bgHex, accentHex);
    const mat = addMat(ctx, new StandardMaterial(`${name}_mat`, ctx.scene));
    mat.diffuseTexture = tex;
    mat.emissiveTexture = tex;
    mat.emissiveColor = new Color3(0.75, 0.75, 0.8);
    mat.disableLighting = true;

    const span = MeshBuilder.CreateBox(
      `${name}_span`,
      { width: halfSpan * 2 + 1.2, height: 1.9, depth: 0.9 },
      ctx.scene
    );
    span.parent = archRoot;
    span.position.set(0, h + 0.5, 0);
    span.material = mat;
    span.isPickable = false;
    ctx.shadowGen?.addShadowCaster(span);
    ctx.disposableMeshes.push(span);
  }
}
