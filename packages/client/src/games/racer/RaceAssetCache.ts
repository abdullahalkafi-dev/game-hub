import "@babylonjs/loaders/glTF";
import {
  AssetContainer,
  Color3,
  CubeTexture,
  DracoCompression,
  DracoDecoder,
  DynamicTexture,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  Scene,
  SceneLoader,
  ShadowGenerator,
  StandardMaterial,
  Texture,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import type { LiveryDefinition, TrackTheme } from "@game/shared";

export type RacePbrKey = "asphalt" | "cliff_rock" | "gravel" | "barrier_steel";

export type RaceEnvTheme = TrackTheme | "GARAGE";

export interface RacePbrTextureSet {
  albedo: Texture;
  bump: Texture;
  arm: Texture;
}

export interface TrackPbrMaterialOptions {
  tintHex?: string;
  roughness?: number;
  metallic?: number;
  bumpLevel?: number;
  directIntensity?: number;
  environmentIntensity?: number;
}

export interface CarLiveryVisual {
  bodyHex: string;
  clearcoat: number;
  metallic: number;
  roughness: number;
  accentHex: string;
  caliperHex: string;
  rimHex: string;
  stripeStyle: string;
}

export interface BuildCarRigOptions {
  vehicleId: string;
  livery: CarLiveryVisual | LiveryDefinition;
  spoilerId: string;
  rimId: string;
  underglowHex: string | null;
  isNight: boolean;
  shadowGen?: ShadowGenerator;
  idSuffix: string;
}

export interface CarVisualRig {
  root: TransformNode;
  chassisNode: TransformNode;
  wheelSpinNodes: TransformNode[];
  frontSteerNodes: TransformNode[];
  exhaustTips: TransformNode[];
  rearTireNodes: [TransformNode, TransformNode];
  setBrakeLight: (intensity: number) => void;
  setReverseLight: (on: boolean) => void;
  setHeadlights: (on: boolean) => void;
  setUnderglow: (hex: string | null) => void;
  setBrakeDiscGlow: (heat: number) => void;
  applyLivery: (livery: CarLiveryVisual | LiveryDefinition, rimId?: string) => void;
  dispose: () => void;
}

interface SculptStation {
  z: number;
  wBot: number;
  wMid: number;
  wMax: number;
  wTop: number;
  wDeck: number;
  yBot: number;
  yLow: number;
  yBelt: number;
  yTop: number;
  crown: number;
}

interface SculptCarSpec {
  length: number;
  wheelRadius: number;
  frontWheelZ: number;
  rearWheelZ: number;
  frontTrackHalf: number;
  rearTrackHalf: number;
  tireWidthFront: number;
  tireWidthRear: number;
  cabinStartZ: number;
  cabinEndZ: number;
  roofHeight: number;
  roofWidth: number;
  spoilerY: number;
  spoilerZ: number;
  spoilerWidth: number;
  exhaustY: number;
  exhaustZ: number;
  exhaustOffsetsX: readonly number[];
  headlightZ: number;
  headlightY: number;
  headlightSpreadX: number;
  taillightZ: number;
  taillightY: number;
  taillightStyle: "QUAD_RING" | "LIGHTBAR" | "RALLY_CLUSTER";
  hasIntercooler: boolean;
  hasHoodScoop: boolean;
  hasRoofScoop: boolean;
  hasRallyFogPods: boolean;
  hasMudflaps: boolean;
  stations: readonly SculptStation[];
}

const RACE_BASE_URL = "/assets/racing/";

const ENV_URLS: Record<RaceEnvTheme, string> = {
  TOKYO_MIDNIGHT: `${RACE_BASE_URL}env/night.env`,
  COASTAL_SUNSET: `${RACE_BASE_URL}env/sunset.env`,
  HARBOR_GP: `${RACE_BASE_URL}env/daylight.env`,
  GARAGE: `${RACE_BASE_URL}env/studio.env`,
};

const RACING_TEXTURE_PATHS: Record<RacePbrKey, string> = {
  asphalt: `${RACE_BASE_URL}textures/asphalt`,
  cliff_rock: `${RACE_BASE_URL}textures/cliff_rock`,
  gravel: `${RACE_BASE_URL}textures/gravel`,
  barrier_steel: `${RACE_BASE_URL}textures/barrier_steel`,
};

const LEGACY_SLUG_ALIASES: Record<string, string> = {
  asphalt: RACING_TEXTURE_PATHS.asphalt,
  asphalt_04: RACING_TEXTURE_PATHS.asphalt,
  asphalt_01: RACING_TEXTURE_PATHS.asphalt,
  cliff_rock: RACING_TEXTURE_PATHS.cliff_rock,
  rock_wall_02: RACING_TEXTURE_PATHS.cliff_rock,
  aerial_rocks_02: RACING_TEXTURE_PATHS.cliff_rock,
  cliff_side: RACING_TEXTURE_PATHS.cliff_rock,
  gravel: RACING_TEXTURE_PATHS.gravel,
  gravel_road: RACING_TEXTURE_PATHS.gravel,
  gravel_embedded_concrete: RACING_TEXTURE_PATHS.gravel,
  barrier_steel: RACING_TEXTURE_PATHS.barrier_steel,
  metal_plate_02: RACING_TEXTURE_PATHS.barrier_steel,
  // Existing shared Game 1 textures (also guaranteed present in /assets/textures/)
  asphalt_02: "/assets/textures/asphalt_02",
  concrete_wall_005: "/assets/textures/concrete_wall_005",
  corrugated_iron_02: "/assets/textures/corrugated_iron_02",
  sandstone_blocks_05: "/assets/textures/sandstone_blocks_05",
  rusty_metal_02: "/assets/textures/rusty_metal_02",
  coast_sand_01: "/assets/textures/coast_sand_01",
};

const RIM_TINT_OVERRIDES: Record<string, string | null> = {
  rim_sport: null,
  rim_mesh_gold: "#e3b549",
  rim_aero_carbon: "#1e232d",
};

let dracoConfigured = false;

function configureLocalDracoDecoder(): void {
  if (dracoConfigured || typeof window === "undefined") return;
  const origin = window.location.origin;
  const decoder = {
    wasmUrl: `${origin}${RACE_BASE_URL}draco/draco_wasm_wrapper_gltf.js`,
    wasmBinaryUrl: `${origin}${RACE_BASE_URL}draco/draco_decoder_gltf.wasm`,
    fallbackUrl: `${origin}${RACE_BASE_URL}draco/draco_decoder_gltf.js`,
  };
  DracoCompression.Configuration = { decoder };
  DracoDecoder.DefaultConfiguration = { ...decoder };
  dracoConfigured = true;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function safeColor3(hex: string, fallback = "#ffffff"): Color3 {
  try {
    return Color3.FromHexString(hex);
  } catch {
    return Color3.FromHexString(fallback);
  }
}

/**
 * Scene-scoped high-detail racing asset cache:
 * - Preloads real multi-mesh `ferrari.glb` (with local Draco WASM decoder),
 *   prefiltered HDR `.env` IBL environments, and 2K Poly Haven PBR track textures.
 * - Builds photorealistic clearcoat PBR car rigs for all 4 archetypes (`apex_gt`,
 *   `skyline_r34`, `viper_v8`, `rally_rs`) with rotating/steering wheels, glowing
 *   brake rotors, dynamic headlights/taillights/underglow, spoilers, rims, and liveries.
 * - Provides 2K PBR track materials and right-side-up racing sky domes.
 */
export class RaceAssetCache {
  private ferrariContainer: AssetContainer | null = null;
  private readonly envCache = new Map<RaceEnvTheme, CubeTexture>();
  private readonly pbrTexCache = new Map<string, RacePbrTextureSet>();
  private readonly pbrMatCache = new Map<string, PBRMaterial>();
  private readonly ownedTextures: Texture[] = [];
  private carbonWeaveTex: DynamicTexture | null = null;
  private underglowPoolTex: DynamicTexture | null = null;
  private headlightPoolTex: DynamicTexture | null = null;
  private modelLoad: Promise<void> | null = null;

  constructor(private readonly scene: Scene) {
    configureLocalDracoDecoder();
  }

  hasFerrariModel(): boolean {
    return this.ferrariContainer !== null;
  }

  async preload(theme: RaceEnvTheme, onProgress?: (pct: number, detail: string) => void): Promise<void> {
    onProgress?.(15, "Loading circuit lighting and car models");
    this.getEnvironmentTexture(theme);
    this.modelLoad ??= this.loadFerrari();
    await this.modelLoad;
    onProgress?.(100, this.hasFerrariModel() ? "Car models ready" : "Using the sculpted GT chassis");
  }

  private async loadFerrari(): Promise<void> {
    try {
      const container = await SceneLoader.LoadAssetContainerAsync(RACE_BASE_URL, "ferrari.glb", this.scene);
      if (this.scene.isDisposed) {
        container.dispose();
      } else {
        this.ferrariContainer = container;
      }
    } catch (err) {
      if (!this.scene.isDisposed) {
        console.warn("[RaceAssetCache] Failed to load Apex GT, using the sculpted chassis:", err);
      }
    }
  }

  getEnvironmentTexture(theme: RaceEnvTheme): CubeTexture {
    const existing = this.envCache.get(theme);
    if (existing) return existing;
    const url = ENV_URLS[theme] ?? ENV_URLS.GARAGE;
    const env = CubeTexture.CreateFromPrefilteredData(url, this.scene);
    this.envCache.set(theme, env);
    return env;
  }

  getTrackPbrTextureSet(slug: string, tileU = 1, tileV = 1): RacePbrTextureSet {
    const baseDir = LEGACY_SLUG_ALIASES[slug] ?? RACING_TEXTURE_PATHS.asphalt;
    const cacheKey = `${baseDir}_${tileU.toFixed(3)}_${tileV.toFixed(3)}`;
    const existing = this.pbrTexCache.get(cacheKey);
    if (existing) return existing;

    const albedo = new Texture(`${baseDir}/diff.jpg`, this.scene, false, true, Texture.TRILINEAR_SAMPLINGMODE);
    const bump = new Texture(`${baseDir}/nor_gl.jpg`, this.scene, false, true, Texture.TRILINEAR_SAMPLINGMODE);
    const arm = new Texture(`${baseDir}/arm.jpg`, this.scene, false, true, Texture.TRILINEAR_SAMPLINGMODE);

    for (const tex of [albedo, bump, arm]) {
      tex.wrapU = Texture.WRAP_ADDRESSMODE;
      tex.wrapV = Texture.WRAP_ADDRESSMODE;
      tex.uScale = tileU;
      tex.vScale = tileV;
      tex.anisotropicFilteringLevel = 8;
    }

    const set: RacePbrTextureSet = { albedo, bump, arm };
    this.pbrTexCache.set(cacheKey, set);
    return set;
  }

  getTrackPbrMaterial(
    name: string,
    slug: RacePbrKey | string,
    tileU = 1,
    tileV = 1,
    opts?: TrackPbrMaterialOptions
  ): PBRMaterial {
    const matKey = `${name}_${slug}_${tileU}_${tileV}_${opts?.tintHex ?? ""}_${opts?.roughness ?? ""}_${opts?.metallic ?? ""}`;
    const existing = this.pbrMatCache.get(matKey);
    if (existing) return existing;

    const set = this.getTrackPbrTextureSet(slug, tileU, tileV);
    const mat = new PBRMaterial(name, this.scene);
    mat.albedoTexture = set.albedo;
    mat.bumpTexture = set.bump;
    if (mat.bumpTexture) {
      mat.bumpTexture.level = opts?.bumpLevel ?? 0.85;
    }
    mat.metallicTexture = set.arm;
    mat.useAmbientOcclusionFromMetallicTextureRed = true;
    mat.useRoughnessFromMetallicTextureGreen = true;
    mat.useMetallnessFromMetallicTextureBlue = true;
    mat.roughness = opts?.roughness ?? 1.0;
    mat.metallic = opts?.metallic ?? 1.0;
    if (opts?.tintHex) {
      mat.albedoColor = safeColor3(opts.tintHex);
    }
    if (opts?.directIntensity !== undefined) {
      mat.directIntensity = opts.directIntensity;
    }
    if (opts?.environmentIntensity !== undefined) {
      mat.environmentIntensity = opts.environmentIntensity;
    }

    this.pbrMatCache.set(matKey, mat);
    return mat;
  }

  createRaceSkyDome(theme: TrackTheme): Mesh {
    const sky = MeshBuilder.CreateSphere(
      `race_sky_dome_${theme}`,
      { diameter: 1800, segments: 32, sideOrientation: Mesh.BACKSIDE },
      this.scene
    );
    sky.isPickable = false;
    sky.infiniteDistance = true;
    sky.renderingGroupId = 0;

    const tex = new DynamicTexture(`race_sky_tex_${theme}`, { width: 1024, height: 512 }, this.scene, false);
    this.ownedTextures.push(tex);
    const ctx = tex.getContext();

    // Babylon CreateSphere flips canvas Y: flip context so y=0 is zenith (+Y) and y=256 is horizon!
    ctx.save();
    ctx.translate(0, 512);
    ctx.scale(1, -1);

    const grad = ctx.createLinearGradient(0, 0, 0, 512);
    if (theme === "TOKYO_MIDNIGHT") {
      grad.addColorStop(0.0, "#02040b");
      grad.addColorStop(0.28, "#060d22");
      grad.addColorStop(0.45, "#151234");
      grad.addColorStop(0.505, "#1d274b");
      grad.addColorStop(0.54, "#0b1122");
      grad.addColorStop(1.0, "#03060d");
    } else if (theme === "COASTAL_SUNSET") {
      grad.addColorStop(0.0, "#122146");
      grad.addColorStop(0.22, "#2f3b6e");
      grad.addColorStop(0.38, "#994858");
      grad.addColorStop(0.465, "#f07c3c");
      grad.addColorStop(0.505, "#ffd98a");
      grad.addColorStop(0.54, "#8a4d3f");
      grad.addColorStop(0.7, "#2a2033");
      grad.addColorStop(1.0, "#12101a");
    } else {
      // HARBOR_GP vivid motorsport daylight
      grad.addColorStop(0.0, "#0e4696");
      grad.addColorStop(0.24, "#2d7bd4");
      grad.addColorStop(0.42, "#7cc0f4");
      grad.addColorStop(0.505, "#dceeff");
      grad.addColorStop(0.54, "#4b7da8");
      grad.addColorStop(0.75, "#1e4166");
      grad.addColorStop(1.0, "#102740");
    }
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 1024, 512);

    if (theme === "TOKYO_MIDNIGHT") {
      // Crisp night starfield in upper hemisphere (y = 8..205)
      for (let i = 0; i < 320; i++) {
        const sx = (i * 173 + 31) % 1024;
        const sy = 8 + ((i * 59) % 192);
        const size = i % 9 === 0 ? 2.1 : 1.3;
        ctx.fillStyle =
          i % 7 === 0
            ? "rgba(96,215,255,0.8)"
            : i % 11 === 0
              ? "rgba(255,160,220,0.75)"
              : "rgba(240,248,255,0.65)";
        ctx.fillRect(sx, sy, size, size);
      }

      // Subtle moon halo
      const moonGrad = ctx.createRadialGradient(780, 128, 6, 780, 128, 72);
      moonGrad.addColorStop(0, "rgba(235,246,255,0.92)");
      moonGrad.addColorStop(0.22, "rgba(140,195,255,0.36)");
      moonGrad.addColorStop(1, "rgba(80,120,220,0)");
      ctx.fillStyle = moonGrad;
      ctx.fillRect(700, 50, 160, 160);

      // Cyber cyan & magenta metropolitan horizon haze bands
      const hazeL = ctx.createRadialGradient(260, 256, 10, 260, 256, 220);
      hazeL.addColorStop(0, "rgba(0,240,255,0.22)");
      hazeL.addColorStop(1, "rgba(0,240,255,0)");
      ctx.fillStyle = hazeL;
      ctx.fillRect(40, 140, 440, 200);

      const hazeR = ctx.createRadialGradient(740, 256, 10, 740, 256, 230);
      hazeR.addColorStop(0, "rgba(255,40,160,0.2)");
      hazeR.addColorStop(1, "rgba(255,40,160,0)");
      ctx.fillStyle = hazeR;
      ctx.fillRect(510, 140, 460, 200);

      // Distant Tokyo skyline rising right off horizon (y = 256)
      for (let x = 0; x < 1024; x += 22) {
        const bh = 22 + ((x * 37 + 19) % 74);
        const topY = 262 - bh;
        ctx.fillStyle = "#050914";
        ctx.fillRect(x, topY, 19, bh + 16);
        const neon = x % 66 === 0 ? "rgba(0,240,255,0.62)" : x % 44 === 0 ? "rgba(255,46,160,0.52)" : "rgba(255,212,120,0.42)";
        ctx.fillStyle = neon;
        // Rooftop beacon strip
        ctx.fillRect(x + 2, topY + 2, 15, 2);
        for (let wy = topY + 8; wy < 254; wy += 6) {
          if (((x + wy) % 5) !== 0) ctx.fillRect(x + 3, wy, 4, 2.5);
          if (((x * 3 + wy) % 4) !== 0) ctx.fillRect(x + 11, wy, 4, 2.5);
        }
      }
      // Iconic Tokyo red/orange radio tower silhouette
      ctx.fillStyle = "#0a0d1a";
      ctx.beginPath();
      ctx.moveTo(494, 260);
      ctx.lineTo(506, 142);
      ctx.lineTo(518, 260);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "rgba(255,75,45,0.85)";
      ctx.fillRect(505, 134, 2, 18);
      ctx.fillRect(500, 188, 12, 3);
      ctx.fillRect(497, 218, 18, 3);
    } else if (theme === "COASTAL_SUNSET") {
      // Radiant golden sun just above horizon
      const sunX = 320;
      const sunY = 212;
      const sunHalo = ctx.createRadialGradient(sunX, sunY, 12, sunX, sunY, 190);
      sunHalo.addColorStop(0, "rgba(255,252,235,0.98)");
      sunHalo.addColorStop(0.14, "rgba(255,224,142,0.82)");
      sunHalo.addColorStop(0.4, "rgba(255,134,62,0.34)");
      sunHalo.addColorStop(1, "rgba(255,100,40,0)");
      ctx.fillStyle = sunHalo;
      ctx.fillRect(sunX - 190, sunY - 160, 380, 260);

      // Warm backlit sunset cloud ribbons
      for (let i = 0; i < 38; i++) {
        const cx = (i * 89 + 20) % 1024;
        const cy = 96 + ((i * 23) % 116);
        const w = 75 + ((i * 31) % 90);
        const h = 14 + ((i * 11) % 18);
        const cg = ctx.createRadialGradient(cx, cy, 4, cx, cy, w);
        cg.addColorStop(0, i % 2 === 0 ? "rgba(255,212,150,0.36)" : "rgba(255,138,108,0.28)");
        cg.addColorStop(1, "rgba(255,120,80,0)");
        ctx.fillStyle = cg;
        ctx.fillRect(cx - w, cy - h, w * 2, h * 2);
      }

      // Layered coastal canyon mountain silhouettes along horizon
      ctx.fillStyle = "rgba(68,36,52,0.68)";
      ctx.beginPath();
      ctx.moveTo(0, 272);
      for (let x = 0; x <= 1024; x += 24) {
        const ridge = 242 - Math.abs(Math.sin(x * 0.011)) * 28 - Math.cos(x * 0.029) * 9;
        ctx.lineTo(x, ridge);
      }
      ctx.lineTo(1024, 272);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = "rgba(42,24,34,0.82)";
      ctx.beginPath();
      ctx.moveTo(0, 276);
      for (let x = 0; x <= 1024; x += 32) {
        const mesa = 250 - Math.sin(x * 0.019 + 1.2) * 14 - Math.cos(x * 0.007) * 8;
        ctx.lineTo(x, mesa);
      }
      ctx.lineTo(1024, 276);
      ctx.closePath();
      ctx.fill();
    } else {
      // HARBOR_GP bright sun & drifting cumulus clouds
      const sunX = 240;
      const sunY = 148;
      const sunGrad = ctx.createRadialGradient(sunX, sunY, 8, sunX, sunY, 130);
      sunGrad.addColorStop(0, "rgba(255,255,244,0.98)");
      sunGrad.addColorStop(0.24, "rgba(255,246,214,0.52)");
      sunGrad.addColorStop(1, "rgba(255,246,214,0)");
      ctx.fillStyle = sunGrad;
      ctx.fillRect(sunX - 130, sunY - 130, 260, 260);

      for (let i = 0; i < 42; i++) {
        const cx = (i * 101 + 40) % 1024;
        const cy = 72 + ((i * 27) % 128);
        const rx = 58 + ((i * 23) % 62);
        const cg = ctx.createRadialGradient(cx, cy, 8, cx, cy, rx);
        cg.addColorStop(0, "rgba(255,255,255,0.42)");
        cg.addColorStop(0.6, "rgba(235,245,255,0.18)");
        cg.addColorStop(1, "rgba(235,245,255,0)");
        ctx.fillStyle = cg;
        ctx.fillRect(cx - rx, cy - 26, rx * 2, 52);
      }

      // Distant coastal hills + harbor bridge towers & cranes along horizon
      ctx.fillStyle = "rgba(62,92,126,0.55)";
      ctx.beginPath();
      ctx.moveTo(0, 272);
      for (let x = 0; x <= 1024; x += 32) {
        ctx.lineTo(x, 246 - Math.sin(x * 0.013) * 14 - Math.cos(x * 0.025) * 6);
      }
      ctx.lineTo(1024, 272);
      ctx.closePath();
      ctx.fill();

      // Harbor gantry cranes silhouette
      ctx.fillStyle = "rgba(32,52,78,0.72)";
      for (let x = 80; x < 1024; x += 240) {
        ctx.fillRect(x, 226, 4, 36);
        ctx.fillRect(x + 14, 226, 4, 36);
        ctx.fillRect(x - 16, 232, 52, 3.5);
      }
    }

    ctx.restore();
    tex.update();

    const mat = new StandardMaterial(`race_sky_mat_${theme}`, this.scene);
    mat.emissiveTexture = tex;
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    sky.material = mat;
    return sky;
  }

  buildCarRig(opts: BuildCarRigOptions): CarVisualRig {
    if (opts.vehicleId === "apex_gt" && this.ferrariContainer) {
      return this.buildFerrariRig(opts);
    }
    return this.buildSculptedCarRig(opts);
  }

  // ---------------------------------------------------------------------------
  // 1. REAL MULTI-MESH FERRARI GLB CAR RIG (apex_gt)
  // ---------------------------------------------------------------------------
  private buildFerrariRig(opts: BuildCarRigOptions): CarVisualRig {
    const id = `car_${opts.vehicleId}_${opts.idSuffix}`;
    const root = new TransformNode(`${id}_root`, this.scene);
    const chassisNode = new TransformNode(`${id}_chassis`, this.scene);
    chassisNode.parent = root;

    const disposableMaterials: (PBRMaterial | StandardMaterial)[] = [];
    const disposableTextures: Texture[] = [];
    const registerMat = <T extends PBRMaterial | StandardMaterial>(m: T): T => {
      disposableMaterials.push(m);
      return m;
    };

    const entries = this.ferrariContainer!.instantiateModelsToScene(
      (name) => `${id}_${name}`,
      true,
      { doNotInstantiate: true }
    );

    const modelWrap = new TransformNode(`${id}_glb_wrap`, this.scene);
    modelWrap.parent = chassisNode;
    // Ferrari GLB faces -Z after Babylon's glTF __root__ conversion; rotate PI around Y so nose faces +Z!
    modelWrap.rotation.y = Math.PI;
    for (const rn of entries.rootNodes) {
      rn.parent = modelWrap;
    }

    // Create upgraded automotive PBR materials
    const bodyMat = registerMat(this.createCarPaintMaterial(`${id}_body_paint`, opts.livery));
    const accentMat = registerMat(this.createAccentMaterial(`${id}_accent`, opts.livery.accentHex, opts.livery.stripeStyle));
    const carbonMat = registerMat(this.createCarbonMaterial(`${id}_carbon`));
    const glassMat = registerMat(this.createGlassMaterial(`${id}_glass`));
    const chromeMat = registerMat(this.createChromeMaterial(`${id}_chrome`));
    const rimMat = registerMat(this.createRimMaterial(`${id}_rim`, opts.livery.rimHex, opts.rimId));
    const caliperMat = registerMat(this.createCaliperMaterial(`${id}_caliper`, opts.livery.caliperHex));
    const tireMat = registerMat(this.createTireMaterial(`${id}_tire`));
    const interiorDarkMat = registerMat(this.createInteriorMaterial(`${id}_int_dark`, "#12141a", 0.84));
    const interiorLightMat = registerMat(this.createInteriorMaterial(`${id}_int_light`, "#262a34", 0.8));
    const leatherRedMat = registerMat(this.createInteriorMaterial(`${id}_leather_red`, "#3a1418", 0.72));
    const brakeDiscMat = registerMat(this.createBrakeDiscMaterial(`${id}_brake_disc`));
    const brakeLightMat = registerMat(this.createBrakeLightMaterial(`${id}_brake_light`));
    const headlightMat = registerMat(this.createHeadlightMaterial(`${id}_headlight`));
    const reverseLightMat = registerMat(this.createReverseLightMaterial(`${id}_reverse_light`));

    // Dispose original cloned dull glTF materials after replacing with our upgraded PBR materials
    const originalMats = new Set<PBRMaterial | StandardMaterial>();
    const allMeshes = modelWrap.getChildMeshes(false) as Mesh[];

    for (const mesh of allMeshes) {
      const mName = mesh.name.toLowerCase();
      const origMatName = (mesh.material?.name ?? "").toLowerCase();
      if (mesh.material instanceof PBRMaterial || mesh.material instanceof StandardMaterial) {
        originalMats.add(mesh.material);
      }

      mesh.isPickable = false;
      mesh.receiveShadows = true;
      opts.shadowGen?.addShadowCaster(mesh);

      if (origMatName.includes("body_color") || mName.endsWith("_body")) {
        mesh.material = bodyMat;
      } else if (origMatName.includes("glass_gray") || mName.endsWith("_glass")) {
        mesh.material = glassMat;
      } else if (origMatName.includes("projector_glass") || mName.endsWith("_lights")) {
        mesh.material = headlightMat;
      } else if (
        (origMatName.includes("taillight_glass") || origMatName.includes("turn_signal_led")) &&
        !mName.includes("steering")
      ) {
        mesh.material = brakeLightMat;
      } else if (mName.endsWith("_brake")) {
        mesh.material = brakeDiscMat;
      } else if (mName.includes("rim_") || mName.endsWith("_wheel")) {
        mesh.material = rimMat;
      } else if (origMatName.includes("ferrari_yellow") || mName.endsWith("_centre")) {
        mesh.material = caliperMat;
      } else if (origMatName.includes("carbon_fiber") || mName.includes("carbon")) {
        mesh.material = carbonMat;
      } else if (origMatName.includes("tires") || mName.endsWith("_tire") || mName.endsWith("_grills") || mName.endsWith("_wipers")) {
        mesh.material = tireMat;
      } else if (origMatName.includes("metal_chrome") || mName.endsWith("_chrome")) {
        mesh.material = chromeMat;
      } else if (origMatName.includes("_0098_dodgerblue") || mName.endsWith("_blue")) {
        mesh.material = accentMat;
      } else if (origMatName.includes("leather_red")) {
        mesh.material = leatherRedMat;
      } else if (origMatName.includes("interior_light") || origMatName.includes("carpet")) {
        mesh.material = interiorLightMat;
      } else {
        mesh.material = interiorDarkMat;
      }
    }

    for (const oldMat of originalMats) {
      oldMat.dispose();
    }

    // Compute world transforms down to every Ferrari node so wheel world positions are exact after PI Y-rotation
    root.computeWorldMatrix(true);
    chassisNode.computeWorldMatrix(true);
    modelWrap.computeWorldMatrix(true);
    const descendants = modelWrap.getDescendants(false);
    const findNode = (suffix: string): TransformNode | null => {
      const lower = suffix.toLowerCase();
      for (const n of descendants) {
        if (n instanceof TransformNode && n.name.toLowerCase().endsWith(lower)) {
          return n;
        }
      }
      return null;
    };

    const wheelSpinNodes: TransformNode[] = [];
    const frontSteerNodes: TransformNode[] = [];
    const aeroDiscMeshes: Mesh[] = [];

    const wheelConfigs: {
      key: string;
      isFront: boolean;
      sideSign: number;
      fallbackPos: Vector3;
    }[] = [
      { key: "wheel_fl", isFront: true, sideSign: -1, fallbackPos: new Vector3(-0.84, 0.358, 1.155) },
      { key: "wheel_fr", isFront: true, sideSign: 1, fallbackPos: new Vector3(0.83, 0.358, 1.155) },
      { key: "wheel_rl", isFront: false, sideSign: -1, fallbackPos: new Vector3(-0.82, 0.358, -1.495) },
      { key: "wheel_rr", isFront: false, sideSign: 1, fallbackPos: new Vector3(0.82, 0.358, -1.495) },
    ];

    let rlPos = new Vector3(-0.82, 0.03, -1.495);
    let rrPos = new Vector3(0.82, 0.03, -1.495);

    for (const wc of wheelConfigs) {
      const gltfWheel = findNode(wc.key);
      if (gltfWheel) {
        gltfWheel.computeWorldMatrix(true);
      }
      const wheelPos = gltfWheel ? gltfWheel.getAbsolutePosition().clone() : wc.fallbackPos.clone();

      const hubPivot = new TransformNode(`${id}_${wc.key}_hub`, this.scene);
      hubPivot.parent = root;
      hubPivot.position.copyFrom(wheelPos);
      hubPivot.computeWorldMatrix(true);

      const spinNode = new TransformNode(`${id}_${wc.key}_spin`, this.scene);
      spinNode.parent = hubPivot;
      spinNode.computeWorldMatrix(true);

      if (gltfWheel) {
        // Keep exact world orientation/scale while parenting under clean LH spinNode
        gltfWheel.setParent(spinNode);
      }

      // Add non-spinning motorsport Brembo caliper inside wheel hub
      const caliper = MeshBuilder.CreateBox(
        `${id}_${wc.key}_caliper`,
        { width: 0.075, height: 0.16, depth: 0.11 },
        this.scene
      );
      caliper.parent = hubPivot;
      caliper.position.set(wc.sideSign * 0.04, 0.02, wc.isFront ? -0.14 : 0.14);
      caliper.material = caliperMat;
      caliper.isPickable = false;

      // Optional carbon aero turbine disc overlay (visible when rimId === "rim_aero_carbon")
      const aeroDisc = MeshBuilder.CreateCylinder(
        `${id}_${wc.key}_aero_disc`,
        { diameter: 0.44, height: 0.03, tessellation: 20 },
        this.scene
      );
      aeroDisc.rotation.z = Math.PI / 2;
      aeroDisc.position.set(wc.sideSign * 0.115, 0, 0);
      aeroDisc.parent = spinNode;
      aeroDisc.material = carbonMat;
      aeroDisc.isPickable = false;
      aeroDisc.setEnabled(opts.rimId === "rim_aero_carbon");
      aeroDiscMeshes.push(aeroDisc);

      if (wc.isFront) {
        frontSteerNodes.push(hubPivot);
      }
      wheelSpinNodes.push(spinNode);

      if (wc.key === "wheel_rl") rlPos = new Vector3(wheelPos.x, 0.03, wheelPos.z);
      if (wc.key === "wheel_rr") rrPos = new Vector3(wheelPos.x, 0.03, wheelPos.z);
    }

    // Rear tire contact patch nodes for skid marks & tire smoke
    const rearTireL = new TransformNode(`${id}_rear_tire_l`, this.scene);
    rearTireL.parent = root;
    rearTireL.position.copyFrom(rlPos);
    const rearTireR = new TransformNode(`${id}_rear_tire_r`, this.scene);
    rearTireR.parent = root;
    rearTireR.position.copyFrom(rrPos);

    // Sleek accent aero trim (tucked flush under Ferrari splitter, rockers & rear diffuser)
    this.attachAeroAccentTrim(id, chassisNode, accentMat, carbonMat, {
      frontZ: 2.12,
      rearZ: -2.2,
      halfWidth: 0.9,
      splitterY: 0.145,
      rockerY: 0.15,
      rockerLen: 2.1,
    });

    // Modular spoiler kit mounted flush onto Ferrari rear engine deck
    this.attachSpoiler(id, chassisNode, opts.spoilerId, carbonMat, bodyMat, accentMat, {
      y: 0.86,
      z: -1.92,
      width: 1.76,
      shadowGen: opts.shadowGen,
    });

    // Crisp reverse light LED strips integrated at rear fascia
    for (const side of [-0.5, 0.5]) {
      const revLed = MeshBuilder.CreateBox(
        `${id}_rev_${side < 0 ? "l" : "r"}`,
        { width: 0.17, height: 0.042, depth: 0.03 },
        this.scene
      );
      revLed.parent = chassisNode;
      revLed.position.set(side, 0.68, -2.19);
      revLed.material = reverseLightMat;
      revLed.isPickable = false;
    }

    // Dual center-sport exhaust tip markers (Ferrari 458 style)
    const exhaustTips: TransformNode[] = [];
    for (const ex of [-0.18, 0.18]) {
      const tip = new TransformNode(`${id}_exhaust_${ex < 0 ? "l" : "r"}`, this.scene);
      tip.parent = chassisNode;
      tip.position.set(ex, 0.27, -2.21);
      exhaustTips.push(tip);
    }

    // Headlight projection cones & ground light pool (dramatic at night!)
    const headlightRig = this.attachHeadlightPool(id, root, 2.15);
    disposableMaterials.push(...headlightRig.materials);

    // Underglow LED chassis strips + ground glow pool
    const underglowRig = this.attachUnderglow(id, chassisNode, 1.85, 3.85);
    disposableMaterials.push(...underglowRig.materials);

    // Rig state controllers
    let headlightsOn = opts.isNight;
    let brakeIntensity = 0;

    const updateLights = () => {
      const tailBase = headlightsOn ? 0.62 : 0.2;
      const b = Math.max(tailBase, clamp01(brakeIntensity) * 3.2);
      brakeLightMat.emissiveColor.set(b, b * 0.04, b * 0.04);

      if (headlightsOn) {
        headlightMat.emissiveColor.set(2.4, 2.55, 2.8);
      } else {
        headlightMat.emissiveColor.set(0.35, 0.38, 0.44);
      }
      headlightRig.setEnabled(headlightsOn);
    };

    const rig: CarVisualRig = {
      root,
      chassisNode,
      wheelSpinNodes,
      frontSteerNodes,
      exhaustTips,
      rearTireNodes: [rearTireL, rearTireR],
      setBrakeLight: (intensity: number) => {
        brakeIntensity = clamp01(intensity);
        updateLights();
      },
      setReverseLight: (on: boolean) => {
        reverseLightMat.emissiveColor.set(on ? 2.6 : 0.08, on ? 2.7 : 0.08, on ? 2.85 : 0.09);
      },
      setHeadlights: (on: boolean) => {
        headlightsOn = on;
        updateLights();
      },
      setUnderglow: (hex: string | null) => {
        underglowRig.setColor(hex);
      },
      setBrakeDiscGlow: (heat: number) => {
        const h = clamp01(heat);
        brakeDiscMat.emissiveColor.set(h * 2.8, h * h * 0.82, h * h * h * 0.14);
      },
      applyLivery: (livery, rimId) => {
        this.updatePaintMaterial(bodyMat, livery);
        this.updateAccentMaterial(accentMat, livery.accentHex, livery.stripeStyle);
        caliperMat.albedoColor = safeColor3(livery.caliperHex, "#f5c400");
        const activeRimId = rimId ?? opts.rimId;
        this.updateRimMaterial(rimMat, livery.rimHex, activeRimId);
        for (const disc of aeroDiscMeshes) {
          disc.setEnabled(activeRimId === "rim_aero_carbon");
        }
      },
      dispose: () => {
        root.dispose();
        for (const m of disposableMaterials) m.dispose();
        for (const t of disposableTextures) t.dispose();
      },
    };

    rig.setHeadlights(opts.isNight);
    rig.setBrakeLight(0);
    rig.setReverseLight(false);
    rig.setUnderglow(opts.underglowHex);
    rig.setBrakeDiscGlow(0);
    return rig;
  }

  // ---------------------------------------------------------------------------
  // 2. SCULPTED LOFTED AUTOMOTIVE RIGS (skyline_r34, viper_v8, rally_rs, + GT fallback)
  // ---------------------------------------------------------------------------
  private buildSculptedCarRig(opts: BuildCarRigOptions): CarVisualRig {
    const id = `car_${opts.vehicleId}_${opts.idSuffix}`;
    const spec = this.getSculptCarSpec(opts.vehicleId);

    const root = new TransformNode(`${id}_root`, this.scene);
    const chassisNode = new TransformNode(`${id}_chassis`, this.scene);
    chassisNode.parent = root;

    const disposableMaterials: (PBRMaterial | StandardMaterial)[] = [];
    const disposableTextures: Texture[] = [];
    const registerMat = <T extends PBRMaterial | StandardMaterial>(m: T): T => {
      disposableMaterials.push(m);
      return m;
    };

    // High-res automotive livery texture baked directly onto sculpted lofted bodywork UVs (ZERO z-fighting!)
    const liveryTex = this.createSculptedLiveryTexture(`${id}_livery_tex`, opts.livery);
    disposableTextures.push(liveryTex);

    const bodyMat = registerMat(this.createCarPaintMaterial(`${id}_body_paint`, opts.livery));
    bodyMat.albedoColor = Color3.White();
    bodyMat.albedoTexture = liveryTex;

    const roofMat = registerMat(this.createCarPaintMaterial(`${id}_roof_paint`, opts.livery));
    const accentMat = registerMat(this.createAccentMaterial(`${id}_accent`, opts.livery.accentHex, opts.livery.stripeStyle));
    const carbonMat = registerMat(this.createCarbonMaterial(`${id}_carbon`));
    const glassMat = registerMat(this.createGlassMaterial(`${id}_glass`));
    const chromeMat = registerMat(this.createChromeMaterial(`${id}_chrome`));
    const rimMat = registerMat(this.createRimMaterial(`${id}_rim`, opts.livery.rimHex, opts.rimId));
    const caliperMat = registerMat(this.createCaliperMaterial(`${id}_caliper`, opts.livery.caliperHex));
    const tireMat = registerMat(this.createTireMaterial(`${id}_tire`));
    const trimDarkMat = registerMat(this.createInteriorMaterial(`${id}_trim`, "#11141c", 0.72));
    const brakeDiscMat = registerMat(this.createBrakeDiscMaterial(`${id}_brake_disc`));
    const brakeLightMat = registerMat(this.createBrakeLightMaterial(`${id}_brake_light`));
    const headlightMat = registerMat(this.createHeadlightMaterial(`${id}_headlight`));
    const reverseLightMat = registerMat(this.createReverseLightMaterial(`${id}_reverse_light`));

    // A. Sculpted Seamless Lofted Lower Body Shell (CreateRibbon, 100% outward LH normals)
    const bodyShell = this.createLoftedBodyMesh(`${id}_body_shell`, spec.stations);
    bodyShell.parent = chassisNode;
    bodyShell.material = bodyMat;
    bodyShell.isPickable = false;
    bodyShell.receiveShadows = true;
    opts.shadowGen?.addShadowCaster(bodyShell);

    // B. Sculpted Curved Cabin Greenhouse (tinted glass + painted roof cap + A/B/C pillars + mirrors)
    this.attachSculptedCabin(id, chassisNode, spec, glassMat, roofMat, trimDarkMat, opts.shadowGen);

    // C. Sculpted Front Fascia (splitter, intake grille, optional JDM intercooler / rally pods, xenon headlights)
    this.attachFrontFascia(id, chassisNode, spec, carbonMat, trimDarkMat, chromeMat, accentMat, headlightMat);

    // D. Sculpted Rear Fascia (diffuser + strakes, iconic vehicle taillights, reverse LEDs, metallic exhaust tips)
    const exhaustTips = this.attachRearFascia(
      id,
      chassisNode,
      spec,
      carbonMat,
      trimDarkMat,
      chromeMat,
      brakeLightMat,
      reverseLightMat
    );

    // E. Vehicle-specific iconic silhouette details (hood scoop, roof scoop, rally mudflaps, side rocker skirts)
    this.attachVehicleSignatureDetails(id, chassisNode, spec, bodyMat, carbonMat, accentMat, trimDarkMat, opts.shadowGen);

    // F. Modular Spoiler Kit
    this.attachSpoiler(id, chassisNode, opts.spoilerId, carbonMat, roofMat, accentMat, {
      y: spec.spoilerY,
      z: spec.spoilerZ,
      width: spec.spoilerWidth,
      shadowGen: opts.shadowGen,
    });

    // G. Recessed dark wheel arch liners so wheels tuck cleanly inside fenders
    const wheelDefs = [
      { key: "fl", x: -spec.frontTrackHalf, z: spec.frontWheelZ, w: spec.tireWidthFront, isFront: true, sideSign: -1 },
      { key: "fr", x: spec.frontTrackHalf, z: spec.frontWheelZ, w: spec.tireWidthFront, isFront: true, sideSign: 1 },
      { key: "rl", x: -spec.rearTrackHalf, z: spec.rearWheelZ, w: spec.tireWidthRear, isFront: false, sideSign: -1 },
      { key: "rr", x: spec.rearTrackHalf, z: spec.rearWheelZ, w: spec.tireWidthRear, isFront: false, sideSign: 1 },
    ];

    const wheelSpinNodes: TransformNode[] = [];
    const frontSteerNodes: TransformNode[] = [];
    const rimVisualGroups: {
      sport: TransformNode;
      meshGold: TransformNode;
      aeroCarbon: TransformNode;
    }[] = [];

    for (const wd of wheelDefs) {
      const liner = MeshBuilder.CreateCylinder(
        `${id}_liner_${wd.key}`,
        { diameter: spec.wheelRadius * 2.12, height: wd.w + 0.14, tessellation: 18 },
        this.scene
      );
      liner.rotation.z = Math.PI / 2;
      liner.position.set(wd.x * 0.9, spec.wheelRadius + 0.02, wd.z);
      liner.parent = chassisNode;
      liner.material = trimDarkMat;
      liner.isPickable = false;

      const hubPivot = new TransformNode(`${id}_wheel_${wd.key}_hub`, this.scene);
      hubPivot.parent = root;
      hubPivot.position.set(wd.x, spec.wheelRadius, wd.z);

      const spinNode = new TransformNode(`${id}_wheel_${wd.key}_spin`, this.scene);
      spinNode.parent = hubPivot;

      const rimGroup = this.buildMultiPartWheel(
        `${id}_wheel_${wd.key}`,
        hubPivot,
        spinNode,
        spec.wheelRadius,
        wd.w,
        wd.sideSign,
        wd.isFront,
        tireMat,
        rimMat,
        carbonMat,
        brakeDiscMat,
        caliperMat,
        opts.rimId,
        opts.shadowGen
      );
      rimVisualGroups.push(rimGroup);

      if (wd.isFront) {
        frontSteerNodes.push(hubPivot);
      }
      wheelSpinNodes.push(spinNode);
    }

    // Rear tire contact patch nodes
    const rearTireL = new TransformNode(`${id}_rear_tire_l`, this.scene);
    rearTireL.parent = root;
    rearTireL.position.set(-spec.rearTrackHalf, 0.03, spec.rearWheelZ);
    const rearTireR = new TransformNode(`${id}_rear_tire_r`, this.scene);
    rearTireR.parent = root;
    rearTireR.position.set(spec.rearTrackHalf, 0.03, spec.rearWheelZ);

    // Headlight beam cones & night pool
    const headlightRig = this.attachHeadlightPool(id, root, spec.headlightZ + 0.04);
    disposableMaterials.push(...headlightRig.materials);

    // Underglow strips + ground light pool
    const underglowRig = this.attachUnderglow(id, chassisNode, spec.frontTrackHalf * 2.0, spec.length * 0.84);
    disposableMaterials.push(...underglowRig.materials);

    let headlightsOn = opts.isNight;
    let brakeIntensity = 0;

    const updateLights = () => {
      const tailBase = headlightsOn ? 0.68 : 0.22;
      const b = Math.max(tailBase, clamp01(brakeIntensity) * 3.3);
      brakeLightMat.emissiveColor.set(b, b * 0.04, b * 0.04);

      if (headlightsOn) {
        headlightMat.emissiveColor.set(2.4, 2.55, 2.8);
      } else {
        headlightMat.emissiveColor.set(0.35, 0.38, 0.44);
      }
      headlightRig.setEnabled(headlightsOn);
    };

    const rig: CarVisualRig = {
      root,
      chassisNode,
      wheelSpinNodes,
      frontSteerNodes,
      exhaustTips,
      rearTireNodes: [rearTireL, rearTireR],
      setBrakeLight: (intensity: number) => {
        brakeIntensity = clamp01(intensity);
        updateLights();
      },
      setReverseLight: (on: boolean) => {
        reverseLightMat.emissiveColor.set(on ? 2.6 : 0.08, on ? 2.7 : 0.08, on ? 2.85 : 0.09);
      },
      setHeadlights: (on: boolean) => {
        headlightsOn = on;
        updateLights();
      },
      setUnderglow: (hex: string | null) => {
        underglowRig.setColor(hex);
      },
      setBrakeDiscGlow: (heat: number) => {
        const h = clamp01(heat);
        brakeDiscMat.emissiveColor.set(h * 2.8, h * h * 0.82, h * h * h * 0.14);
      },
      applyLivery: (livery, rimId) => {
        this.paintSculptedLiveryTexture(liveryTex, livery);
        this.updatePaintMaterial(bodyMat, livery);
        bodyMat.albedoColor = Color3.White();
        this.updatePaintMaterial(roofMat, livery);
        this.updateAccentMaterial(accentMat, livery.accentHex, livery.stripeStyle);
        caliperMat.albedoColor = safeColor3(livery.caliperHex, "#f5c400");
        const activeRimId = rimId ?? opts.rimId;
        this.updateRimMaterial(rimMat, livery.rimHex, activeRimId);
        for (const rg of rimVisualGroups) {
          rg.sport.setEnabled(activeRimId === "rim_sport");
          rg.meshGold.setEnabled(activeRimId === "rim_mesh_gold");
          rg.aeroCarbon.setEnabled(activeRimId === "rim_aero_carbon");
        }
      },
      dispose: () => {
        root.dispose();
        for (const m of disposableMaterials) m.dispose();
        for (const t of disposableTextures) t.dispose();
      },
    };

    rig.setHeadlights(opts.isNight);
    rig.setBrakeLight(0);
    rig.setReverseLight(false);
    rig.setUnderglow(opts.underglowHex);
    rig.setBrakeDiscGlow(0);
    return rig;
  }

  // ---------------------------------------------------------------------------
  // SCULPTED AUTOMOTIVE GEOMETRY BUILDERS
  // ---------------------------------------------------------------------------
  private createLoftedBodyMesh(name: string, stations: readonly SculptStation[]): Mesh {
    const pathArray: Vector3[][] = [];

    const makeRing = (s: SculptStation, scale = 1.0): Vector3[] => {
      const cy = (s.yBot + s.yTop) * 0.5;
      const sc = (x: number, y: number) =>
        new Vector3(x * scale, cy + (y - cy) * scale, s.z);

      // Run from the underside around the right side first so the loft normals point out.
      return [
        sc(0, s.yBot),
        sc(-s.wBot, s.yBot + 0.02),
        sc(-s.wMid, s.yLow),
        sc(-s.wMax, s.yBelt),
        sc(-s.wTop, s.yTop - 0.045),
        sc(-s.wDeck, s.yTop),
        sc(0, s.yTop + s.crown),
        sc(s.wDeck, s.yTop),
        sc(s.wTop, s.yTop - 0.045),
        sc(s.wMax, s.yBelt),
        sc(s.wMid, s.yLow),
        sc(s.wBot, s.yBot + 0.02),
        sc(0, s.yBot),
      ].reverse();
    };

    // Watertight rear end cap
    const first = stations[0];
    pathArray.push(makeRing({ ...first, z: first.z - 0.01 }, 0.02));
    pathArray.push(makeRing(first, 0.88));
    for (const s of stations) {
      pathArray.push(makeRing(s, 1.0));
    }
    // Watertight front nose end cap
    const last = stations[stations.length - 1];
    pathArray.push(makeRing(last, 0.88));
    pathArray.push(makeRing({ ...last, z: last.z + 0.01 }, 0.02));

    const mesh = MeshBuilder.CreateRibbon(
      name,
      {
        pathArray,
        closeArray: false,
        closePath: false,
        sideOrientation: Mesh.FRONTSIDE,
      },
      this.scene
    );
    return mesh;
  }

  private attachSculptedCabin(
    id: string,
    parent: TransformNode,
    spec: SculptCarSpec,
    glassMat: PBRMaterial,
    roofMat: PBRMaterial,
    trimMat: PBRMaterial,
    shadowGen?: ShadowGenerator
  ): void {
    const z0 = spec.cabinStartZ;
    const z1 = spec.cabinEndZ;
    const len = z1 - z0;
    const rw = spec.roofWidth;
    const rh = spec.roofHeight;
    const beltY = 0.84;

    // Lofted curved glass greenhouse
    const glassStations: SculptStation[] = [
      { z: z0, wBot: rw * 0.92, wMid: rw * 0.95, wMax: rw * 0.94, wTop: rw * 0.72, wDeck: rw * 0.45, yBot: beltY, yLow: beltY + 0.04, yBelt: beltY + 0.1, yTop: beltY + 0.14, crown: 0.02 },
      { z: z0 + len * 0.22, wBot: rw * 1.12, wMid: rw * 1.12, wMax: rw * 1.06, wTop: rw * 0.9, wDeck: rw * 0.76, yBot: beltY, yLow: beltY + 0.12, yBelt: rh - 0.12, yTop: rh - 0.03, crown: 0.03 },
      { z: z0 + len * 0.56, wBot: rw * 1.14, wMid: rw * 1.14, wMax: rw * 1.08, wTop: rw * 0.92, wDeck: rw * 0.78, yBot: beltY, yLow: beltY + 0.14, yBelt: rh - 0.1, yTop: rh - 0.02, crown: 0.035 },
      { z: z0 + len * 0.82, wBot: rw * 1.08, wMid: rw * 1.06, wMax: rw * 1.0, wTop: rw * 0.84, wDeck: rw * 0.68, yBot: beltY, yLow: beltY + 0.1, yBelt: beltY + 0.28, yTop: rh - 0.16, crown: 0.02 },
      { z: z1, wBot: rw * 0.98, wMid: rw * 0.95, wMax: rw * 0.9, wTop: rw * 0.76, wDeck: rw * 0.58, yBot: beltY, yLow: beltY + 0.04, yBelt: beltY + 0.08, yTop: beltY + 0.11, crown: 0.015 },
    ];

    const glassMesh = this.createLoftedBodyMesh(`${id}_greenhouse`, glassStations);
    glassMesh.parent = parent;
    glassMesh.material = glassMat;
    glassMesh.isPickable = false;
    shadowGen?.addShadowCaster(glassMesh);

    // Sculpted painted roof cap sitting cleanly atop the greenhouse
    const roofStations: SculptStation[] = [
      { z: z0 + len * 0.18, wBot: rw * 0.78, wMid: rw * 0.8, wMax: rw * 0.8, wTop: rw * 0.74, wDeck: rw * 0.58, yBot: rh - 0.06, yLow: rh - 0.05, yBelt: rh - 0.03, yTop: rh - 0.01, crown: 0.03 },
      { z: z0 + len * 0.42, wBot: rw * 0.88, wMid: rw * 0.9, wMax: rw * 0.89, wTop: rw * 0.84, wDeck: rw * 0.7, yBot: rh - 0.05, yLow: rh - 0.04, yBelt: rh - 0.01, yTop: rh + 0.01, crown: 0.04 },
      { z: z0 + len * 0.66, wBot: rw * 0.86, wMid: rw * 0.88, wMax: rw * 0.87, wTop: rw * 0.82, wDeck: rw * 0.68, yBot: rh - 0.06, yLow: rh - 0.05, yBelt: rh - 0.02, yTop: rh + 0.005, crown: 0.035 },
      { z: z0 + len * 0.78, wBot: rw * 0.74, wMid: rw * 0.76, wMax: rw * 0.76, wTop: rw * 0.7, wDeck: rw * 0.56, yBot: rh - 0.11, yLow: rh - 0.1, yBelt: rh - 0.08, yTop: rh - 0.06, crown: 0.02 },
    ];
    const roofCap = this.createLoftedBodyMesh(`${id}_roof_cap`, roofStations);
    roofCap.parent = parent;
    roofCap.material = roofMat;
    roofCap.isPickable = false;
    roofCap.receiveShadows = true;
    shadowGen?.addShadowCaster(roofCap);

    // Dark interior cabin core (visible subtly through tinted glass)
    const cabinCore = MeshBuilder.CreateBox(
      `${id}_cabin_core`,
      { width: rw * 1.45, height: 0.34, depth: len * 0.55 },
      this.scene
    );
    cabinCore.position.set(0, beltY + 0.14, z0 + len * 0.48);
    cabinCore.parent = parent;
    cabinCore.material = trimMat;
    cabinCore.isPickable = false;

    // Aerodynamic wing mirrors
    for (const side of [-1, 1]) {
      const mirrorStem = MeshBuilder.CreateBox(
        `${id}_mirror_stem_${side < 0 ? "l" : "r"}`,
        { width: 0.14, height: 0.04, depth: 0.07 },
        this.scene
      );
      mirrorStem.position.set(side * (spec.frontTrackHalf + 0.02), beltY + 0.06, z0 + len * 0.66);
      mirrorStem.parent = parent;
      mirrorStem.material = trimMat;
      mirrorStem.isPickable = false;

      const mirrorCap = MeshBuilder.CreateSphere(
        `${id}_mirror_cap_${side < 0 ? "l" : "r"}`,
        { diameterX: 0.16, diameterY: 0.09, diameterZ: 0.14, segments: 10 },
        this.scene
      );
      mirrorCap.position.set(side * (spec.frontTrackHalf + 0.11), beltY + 0.09, z0 + len * 0.65);
      mirrorCap.parent = parent;
      mirrorCap.material = roofMat;
      mirrorCap.isPickable = false;
    }
  }

  private attachFrontFascia(
    id: string,
    parent: TransformNode,
    spec: SculptCarSpec,
    carbonMat: PBRMaterial,
    trimMat: PBRMaterial,
    chromeMat: PBRMaterial,
    accentMat: PBRMaterial,
    headlightMat: PBRMaterial
  ): void {
    const frontZ = spec.length * 0.5;
    const w = spec.frontTrackHalf * 1.98;

    // Carbon front aero splitter blade
    const splitter = MeshBuilder.CreateBox(
      `${id}_front_splitter`,
      { width: w, height: 0.045, depth: 0.38 },
      this.scene
    );
    splitter.position.set(0, 0.13, frontZ - 0.1);
    splitter.parent = parent;
    splitter.material = carbonMat;
    splitter.isPickable = false;

    // Accent pinstripe along splitter leading edge
    const lipAccent = MeshBuilder.CreateBox(
      `${id}_splitter_accent`,
      { width: w * 0.98, height: 0.018, depth: 0.04 },
      this.scene
    );
    lipAccent.position.set(0, 0.132, frontZ + 0.085);
    lipAccent.parent = parent;
    lipAccent.material = accentMat;
    lipAccent.isPickable = false;

    // Lower front intake recess
    const grille = MeshBuilder.CreateBox(
      `${id}_front_grille`,
      { width: w * 0.62, height: 0.24, depth: 0.08 },
      this.scene
    );
    grille.position.set(0, 0.3, frontZ - 0.03);
    grille.parent = parent;
    grille.material = trimMat;
    grille.isPickable = false;

    // JDM visible aluminum front-mount intercooler core (Skyline R34!)
    if (spec.hasIntercooler) {
      const ic = MeshBuilder.CreateBox(
        `${id}_intercooler`,
        { width: w * 0.48, height: 0.18, depth: 0.06 },
        this.scene
      );
      ic.position.set(0, 0.29, frontZ - 0.005);
      ic.parent = parent;
      ic.material = chromeMat;
      ic.isPickable = false;
    }

    // Crisp xenon headlights + dark housings
    for (const side of [-1, 1]) {
      const housing = MeshBuilder.CreateBox(
        `${id}_hl_housing_${side < 0 ? "l" : "r"}`,
        { width: 0.38, height: 0.11, depth: 0.16 },
        this.scene
      );
      housing.position.set(side * spec.headlightSpreadX, spec.headlightY, spec.headlightZ - 0.06);
      housing.rotation.y = side * 0.22;
      housing.parent = parent;
      housing.material = trimMat;
      housing.isPickable = false;

      const lens = MeshBuilder.CreateBox(
        `${id}_hl_lens_${side < 0 ? "l" : "r"}`,
        { width: 0.33, height: 0.075, depth: 0.05 },
        this.scene
      );
      lens.position.set(side * spec.headlightSpreadX, spec.headlightY, spec.headlightZ + 0.01);
      lens.rotation.y = side * 0.22;
      lens.parent = parent;
      lens.material = headlightMat;
      lens.isPickable = false;
    }

    // 4-pod front rally auxiliary fog lights (Rally RS!)
    if (spec.hasRallyFogPods) {
      const podOffsets = [-0.36, -0.13, 0.13, 0.36];
      for (let i = 0; i < podOffsets.length; i++) {
        const px = podOffsets[i];
        const podShell = MeshBuilder.CreateCylinder(
          `${id}_fog_shell_${i}`,
          { diameter: 0.15, height: 0.12, tessellation: 14 },
          this.scene
        );
        podShell.rotation.x = Math.PI / 2;
        podShell.position.set(px, 0.56, frontZ + 0.01);
        podShell.parent = parent;
        podShell.material = trimMat;
        podShell.isPickable = false;

        const podLens = MeshBuilder.CreateCylinder(
          `${id}_fog_lens_${i}`,
          { diameter: 0.125, height: 0.03, tessellation: 14 },
          this.scene
        );
        podLens.rotation.x = Math.PI / 2;
        podLens.position.set(px, 0.56, frontZ + 0.065);
        podLens.parent = parent;
        podLens.material = headlightMat;
        podLens.isPickable = false;
      }
    }
  }

  private attachRearFascia(
    id: string,
    parent: TransformNode,
    spec: SculptCarSpec,
    carbonMat: PBRMaterial,
    trimMat: PBRMaterial,
    chromeMat: PBRMaterial,
    brakeLightMat: PBRMaterial,
    reverseLightMat: PBRMaterial
  ): TransformNode[] {
    const rearZ = -spec.length * 0.5;
    const w = spec.rearTrackHalf * 1.94;

    // Carbon rear aero diffuser + 4 vertical strakes
    const diffuser = MeshBuilder.CreateBox(
      `${id}_diffuser`,
      { width: w * 0.84, height: 0.16, depth: 0.24 },
      this.scene
    );
    diffuser.position.set(0, 0.2, rearZ + 0.08);
    diffuser.parent = parent;
    diffuser.material = carbonMat;
    diffuser.isPickable = false;

    for (const fx of [-0.42, -0.16, 0.16, 0.42]) {
      const fin = MeshBuilder.CreateBox(
        `${id}_diff_fin_${fx}`,
        { width: 0.03, height: 0.15, depth: 0.22 },
        this.scene
      );
      fin.position.set(fx, 0.19, rearZ + 0.05);
      fin.parent = parent;
      fin.material = carbonMat;
      fin.isPickable = false;
    }

    // Rear taillight recess panel
    const tailPanel = MeshBuilder.CreateBox(
      `${id}_tail_panel`,
      { width: w * 0.88, height: 0.2, depth: 0.05 },
      this.scene
    );
    tailPanel.position.set(0, spec.taillightY, spec.taillightZ + 0.03);
    tailPanel.parent = parent;
    tailPanel.material = trimMat;
    tailPanel.isPickable = false;

    // Vehicle-specific iconic taillight clusters!
    if (spec.taillightStyle === "QUAD_RING") {
      // Iconic Skyline R34 Quad Round Afterburner Taillights!
      const ringPositions = [
        { x: -0.66, d: 0.155 },
        { x: -0.45, d: 0.135 },
        { x: 0.45, d: 0.135 },
        { x: 0.66, d: 0.155 },
      ];
      for (let i = 0; i < ringPositions.length; i++) {
        const rp = ringPositions[i];
        const ring = MeshBuilder.CreateTorus(
          `${id}_skyline_ring_${i}`,
          { diameter: rp.d, thickness: 0.036, tessellation: 18 },
          this.scene
        );
        ring.rotation.x = Math.PI / 2;
        ring.position.set(rp.x, spec.taillightY, spec.taillightZ - 0.01);
        ring.parent = parent;
        ring.material = brakeLightMat;
        ring.isPickable = false;
      }
    } else if (spec.taillightStyle === "LIGHTBAR") {
      // Predatory Viper V8 Full-Width Sculpted LED Light Bar
      const bar = MeshBuilder.CreateBox(
        `${id}_tail_bar`,
        { width: w * 0.82, height: 0.085, depth: 0.045 },
        this.scene
      );
      bar.position.set(0, spec.taillightY, spec.taillightZ - 0.005);
      bar.parent = parent;
      bar.material = brakeLightMat;
      bar.isPickable = false;
    } else {
      // Rally RS Sculpted Twin C-Cluster LEDs
      for (const side of [-1, 1]) {
        const cluster = MeshBuilder.CreateBox(
          `${id}_tail_cluster_${side < 0 ? "l" : "r"}`,
          { width: 0.42, height: 0.12, depth: 0.05 },
          this.scene
        );
        cluster.position.set(side * 0.56, spec.taillightY, spec.taillightZ - 0.005);
        cluster.parent = parent;
        cluster.material = brakeLightMat;
        cluster.isPickable = false;
      }
    }

    // Crisp white reverse LEDs
    for (const side of [-0.25, 0.25]) {
      const rev = MeshBuilder.CreateBox(
        `${id}_rev_${side < 0 ? "l" : "r"}`,
        { width: 0.14, height: 0.045, depth: 0.04 },
        this.scene
      );
      rev.position.set(side, spec.taillightY - 0.075, spec.taillightZ - 0.002);
      rev.parent = parent;
      rev.material = reverseLightMat;
      rev.isPickable = false;
    }

    // Metallic Exhaust Tailpipes + Exhaust Tip TransformNodes for VFX flames/backfire!
    const exhaustTips: TransformNode[] = [];
    for (let i = 0; i < spec.exhaustOffsetsX.length; i++) {
      const ex = spec.exhaustOffsetsX[i];
      const pipe = MeshBuilder.CreateCylinder(
        `${id}_exhaust_pipe_${i}`,
        { diameter: 0.11, height: 0.22, tessellation: 14 },
        this.scene
      );
      pipe.rotation.x = Math.PI / 2;
      pipe.position.set(ex, spec.exhaustY, spec.exhaustZ + 0.06);
      pipe.parent = parent;
      pipe.material = chromeMat;
      pipe.isPickable = false;

      const tip = new TransformNode(`${id}_exhaust_tip_${i}`, this.scene);
      tip.parent = parent;
      tip.position.set(ex, spec.exhaustY, spec.exhaustZ - 0.06);
      exhaustTips.push(tip);
    }

    return exhaustTips;
  }

  private attachVehicleSignatureDetails(
    id: string,
    parent: TransformNode,
    spec: SculptCarSpec,
    bodyMat: PBRMaterial,
    carbonMat: PBRMaterial,
    accentMat: PBRMaterial,
    trimMat: PBRMaterial,
    shadowGen?: ShadowGenerator
  ): void {
    // Aerodynamic side rocker skirts with accent pinstripe
    for (const side of [-1, 1]) {
      const skirt = MeshBuilder.CreateBox(
        `${id}_side_skirt_${side < 0 ? "l" : "r"}`,
        { width: 0.12, height: 0.07, depth: spec.frontWheelZ - spec.rearWheelZ - 0.72 },
        this.scene
      );
      skirt.position.set(
        side * (spec.frontTrackHalf + 0.04),
        0.16,
        (spec.frontWheelZ + spec.rearWheelZ) * 0.5
      );
      skirt.parent = parent;
      skirt.material = carbonMat;
      skirt.isPickable = false;
      shadowGen?.addShadowCaster(skirt);

      const stripe = MeshBuilder.CreateBox(
        `${id}_skirt_accent_${side < 0 ? "l" : "r"}`,
        { width: 0.025, height: 0.022, depth: spec.frontWheelZ - spec.rearWheelZ - 0.74 },
        this.scene
      );
      stripe.position.set(
        side * (spec.frontTrackHalf + 0.105),
        0.16,
        (spec.frontWheelZ + spec.rearWheelZ) * 0.5
      );
      stripe.parent = parent;
      stripe.material = accentMat;
      stripe.isPickable = false;
    }

    // Viper V8 sculpted hood intake bulge / scoop
    if (spec.hasHoodScoop) {
      const scoop = MeshBuilder.CreateBox(
        `${id}_hood_scoop`,
        { width: 0.48, height: 0.085, depth: 0.75 },
        this.scene
      );
      scoop.position.set(0, 0.87, 1.05);
      scoop.rotation.x = 0.08;
      scoop.parent = parent;
      scoop.material = carbonMat;
      scoop.isPickable = false;

      const intakeMouth = MeshBuilder.CreateBox(
        `${id}_hood_mouth`,
        { width: 0.4, height: 0.05, depth: 0.05 },
        this.scene
      );
      intakeMouth.position.set(0, 0.84, 1.42);
      intakeMouth.parent = parent;
      intakeMouth.material = trimMat;
      intakeMouth.isPickable = false;
    }

    // Rally RS Roof Air Scoop
    if (spec.hasRoofScoop) {
      const roofScoop = MeshBuilder.CreateBox(
        `${id}_roof_scoop`,
        { width: 0.34, height: 0.11, depth: 0.48 },
        this.scene
      );
      roofScoop.position.set(0, spec.roofHeight + 0.05, 0.2);
      roofScoop.parent = parent;
      roofScoop.material = bodyMat;
      roofScoop.isPickable = false;
      shadowGen?.addShadowCaster(roofScoop);

      const scoopVent = MeshBuilder.CreateBox(
        `${id}_roof_scoop_vent`,
        { width: 0.28, height: 0.075, depth: 0.04 },
        this.scene
      );
      scoopVent.position.set(0, spec.roofHeight + 0.05, 0.44);
      scoopVent.parent = parent;
      scoopVent.material = trimMat;
      scoopVent.isPickable = false;
    }

    // Rally RS Mudflaps behind all 4 tires
    if (spec.hasMudflaps) {
      const flaps = [
        { x: -spec.frontTrackHalf, z: spec.frontWheelZ - spec.wheelRadius - 0.05 },
        { x: spec.frontTrackHalf, z: spec.frontWheelZ - spec.wheelRadius - 0.05 },
        { x: -spec.rearTrackHalf, z: spec.rearWheelZ - spec.wheelRadius - 0.05 },
        { x: spec.rearTrackHalf, z: spec.rearWheelZ - spec.wheelRadius - 0.05 },
      ];
      for (let i = 0; i < flaps.length; i++) {
        const flap = MeshBuilder.CreateBox(
          `${id}_mudflap_${i}`,
          { width: 0.26, height: 0.24, depth: 0.02 },
          this.scene
        );
        flap.position.set(flaps[i].x, 0.2, flaps[i].z);
        flap.parent = parent;
        flap.material = accentMat;
        flap.isPickable = false;
      }
    }
  }

  private buildMultiPartWheel(
    prefix: string,
    hubPivot: TransformNode,
    spinNode: TransformNode,
    radius: number,
    width: number,
    sideSign: number,
    isFront: boolean,
    tireMat: PBRMaterial,
    rimMat: PBRMaterial,
    carbonMat: PBRMaterial,
    brakeDiscMat: PBRMaterial,
    caliperMat: PBRMaterial,
    rimId: string,
    shadowGen?: ShadowGenerator
  ): { sport: TransformNode; meshGold: TransformNode; aeroCarbon: TransformNode } {
    // Tire cylinder + curved outer sidewall ring (looks smooth and beefy!)
    const tire = MeshBuilder.CreateCylinder(
      `${prefix}_tire`,
      { diameter: radius * 2, height: width, tessellation: 24 },
      this.scene
    );
    tire.rotation.z = Math.PI / 2;
    tire.parent = spinNode;
    tire.material = tireMat;
    tire.isPickable = false;
    shadowGen?.addShadowCaster(tire);

    // Outer shoulder torus bevel for realistic rounded tire profile
    const sidewall = MeshBuilder.CreateTorus(
      `${prefix}_sidewall`,
      { diameter: radius * 1.66, thickness: radius * 0.34, tessellation: 22 },
      this.scene
    );
    sidewall.rotation.z = Math.PI / 2;
    sidewall.position.x = sideSign * (width * 0.22);
    sidewall.parent = spinNode;
    sidewall.material = tireMat;
    sidewall.isPickable = false;

    // Deep-dish metallic outer rim barrel lip
    const rimLip = MeshBuilder.CreateTorus(
      `${prefix}_rim_lip`,
      { diameter: radius * 1.32, thickness: 0.05, tessellation: 22 },
      this.scene
    );
    rimLip.rotation.z = Math.PI / 2;
    rimLip.position.x = sideSign * (width * 0.44);
    rimLip.parent = spinNode;
    rimLip.material = rimMat;
    rimLip.isPickable = false;

    // Inner rim drum
    const rimDrum = MeshBuilder.CreateCylinder(
      `${prefix}_rim_drum`,
      { diameter: radius * 1.28, height: width * 0.72, tessellation: 20 },
      this.scene
    );
    rimDrum.rotation.z = Math.PI / 2;
    rimDrum.position.x = sideSign * (width * 0.08);
    rimDrum.parent = spinNode;
    rimDrum.material = rimMat;
    rimDrum.isPickable = false;

    // Center hub cap
    const hubCap = MeshBuilder.CreateCylinder(
      `${prefix}_hub_cap`,
      { diameter: radius * 0.38, height: 0.06, tessellation: 14 },
      this.scene
    );
    hubCap.rotation.z = Math.PI / 2;
    hubCap.position.x = sideSign * (width * 0.45);
    hubCap.parent = spinNode;
    hubCap.material = caliperMat;
    hubCap.isPickable = false;

    // Ventilated glowing brake rotor disc (spins with wheel)
    const rotor = MeshBuilder.CreateCylinder(
      `${prefix}_rotor`,
      { diameter: radius * 1.06, height: 0.036, tessellation: 20 },
      this.scene
    );
    rotor.rotation.z = Math.PI / 2;
    rotor.position.x = sideSign * (width * 0.14);
    rotor.parent = spinNode;
    rotor.material = brakeDiscMat;
    rotor.isPickable = false;

    // Non-spinning painted Brembo brake caliper (parented to hubPivot!)
    const caliper = MeshBuilder.CreateBox(
      `${prefix}_caliper`,
      { width: 0.075, height: radius * 0.52, depth: radius * 0.32 },
      this.scene
    );
    caliper.position.set(sideSign * (width * 0.2), 0.02, isFront ? -radius * 0.36 : radius * 0.36);
    caliper.parent = hubPivot;
    caliper.material = caliperMat;
    caliper.isPickable = false;

    // Rim Style 1: Forged Split 5-Spoke (`rim_sport`)
    const sport = new TransformNode(`${prefix}_rim_sport`, this.scene);
    sport.parent = spinNode;
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const spoke = MeshBuilder.CreateBox(
        `${prefix}_sp5_${i}`,
        { width: 0.04, height: radius * 1.24, depth: 0.055 },
        this.scene
      );
      spoke.position.x = sideSign * (width * 0.4);
      spoke.rotation.x = a;
      spoke.parent = sport;
      spoke.material = rimMat;
      spoke.isPickable = false;
    }

    // Rim Style 2: Motorsport 10-Spoke Gold Y-Mesh (`rim_mesh_gold`)
    const meshGold = new TransformNode(`${prefix}_rim_gold`, this.scene);
    meshGold.parent = spinNode;
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const spoke = MeshBuilder.CreateBox(
        `${prefix}_sp10_${i}`,
        { width: 0.035, height: radius * 1.26, depth: 0.028 },
        this.scene
      );
      spoke.position.x = sideSign * (width * 0.41);
      spoke.rotation.x = a;
      spoke.parent = meshGold;
      spoke.material = rimMat;
      spoke.isPickable = false;
    }

    // Rim Style 3: Aero Carbon Turbine Disc (`rim_aero_carbon`)
    const aeroCarbon = new TransformNode(`${prefix}_rim_aero`, this.scene);
    aeroCarbon.parent = spinNode;
    const disc = MeshBuilder.CreateCylinder(
      `${prefix}_aero_face`,
      { diameter: radius * 1.24, height: 0.04, tessellation: 20 },
      this.scene
    );
    disc.rotation.z = Math.PI / 2;
    disc.position.x = sideSign * (width * 0.42);
    disc.parent = aeroCarbon;
    disc.material = carbonMat;
    disc.isPickable = false;

    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const fin = MeshBuilder.CreateBox(
        `${prefix}_aero_fin_${i}`,
        { width: 0.025, height: radius * 1.12, depth: 0.065 },
        this.scene
      );
      fin.position.x = sideSign * (width * 0.44);
      fin.rotation.x = a;
      fin.parent = aeroCarbon;
      fin.material = rimMat;
      fin.isPickable = false;
    }

    sport.setEnabled(rimId === "rim_sport");
    meshGold.setEnabled(rimId === "rim_mesh_gold");
    aeroCarbon.setEnabled(rimId === "rim_aero_carbon");

    return { sport, meshGold, aeroCarbon };
  }

  private attachAeroAccentTrim(
    id: string,
    parent: TransformNode,
    accentMat: PBRMaterial,
    carbonMat: PBRMaterial,
    dims: {
      frontZ: number;
      rearZ: number;
      halfWidth: number;
      splitterY: number;
      rockerY: number;
      rockerLen: number;
    }
  ): void {
    // Sleek carbon + accent front lip edge
    const frontLip = MeshBuilder.CreateBox(
      `${id}_aero_lip`,
      { width: dims.halfWidth * 1.88, height: 0.032, depth: 0.16 },
      this.scene
    );
    frontLip.position.set(0, dims.splitterY, dims.frontZ - 0.02);
    frontLip.parent = parent;
    frontLip.material = carbonMat;
    frontLip.isPickable = false;

    const frontPinstripe = MeshBuilder.CreateBox(
      `${id}_aero_lip_accent`,
      { width: dims.halfWidth * 1.82, height: 0.014, depth: 0.03 },
      this.scene
    );
    frontPinstripe.position.set(0, dims.splitterY + 0.005, dims.frontZ + 0.055);
    frontPinstripe.parent = parent;
    frontPinstripe.material = accentMat;
    frontPinstripe.isPickable = false;

    // Side rocker accent blades
    for (const side of [-1, 1]) {
      const rocker = MeshBuilder.CreateBox(
        `${id}_aero_rocker_${side < 0 ? "l" : "r"}`,
        { width: 0.06, height: 0.03, depth: dims.rockerLen },
        this.scene
      );
      rocker.position.set(side * (dims.halfWidth + 0.02), dims.rockerY, -0.15);
      rocker.parent = parent;
      rocker.material = accentMat;
      rocker.isPickable = false;
    }

    // Rear diffuser accent line
    const rearAccent = MeshBuilder.CreateBox(
      `${id}_aero_rear_accent`,
      { width: dims.halfWidth * 1.5, height: 0.018, depth: 0.03 },
      this.scene
    );
    rearAccent.position.set(0, 0.22, dims.rearZ - 0.01);
    rearAccent.parent = parent;
    rearAccent.material = accentMat;
    rearAccent.isPickable = false;
  }

  private attachSpoiler(
    id: string,
    parent: TransformNode,
    spoilerId: string,
    carbonMat: PBRMaterial,
    bodyMat: PBRMaterial,
    accentMat: PBRMaterial,
    mount: { y: number; z: number; width: number; shadowGen?: ShadowGenerator }
  ): void {
    if (spoilerId === "spoiler_none") return;

    const group = new TransformNode(`${id}_spoiler`, this.scene);
    group.parent = parent;
    group.position.set(0, mount.y, mount.z);

    if (spoilerId === "spoiler_ducktail") {
      // Sculpted aggressive street ducktail lip
      const lip = MeshBuilder.CreateBox(
        `${id}_ducktail_lip`,
        { width: mount.width * 0.9, height: 0.12, depth: 0.24 },
        this.scene
      );
      lip.rotation.x = -0.45;
      lip.position.set(0, 0.04, -0.06);
      lip.parent = group;
      lip.material = bodyMat;
      lip.isPickable = false;
      mount.shadowGen?.addShadowCaster(lip);

      const trimEdge = MeshBuilder.CreateBox(
        `${id}_ducktail_edge`,
        { width: mount.width * 0.89, height: 0.024, depth: 0.06 },
        this.scene
      );
      trimEdge.rotation.x = -0.45;
      trimEdge.position.set(0, 0.095, -0.14);
      trimEdge.parent = group;
      trimEdge.material = carbonMat;
      trimEdge.isPickable = false;
      return;
    }

    // Default / spoiler_gt_wing: Twin swan-neck carbon GT wing with sculpted endplates!
    const wingH = 0.28;
    const pylonSpread = mount.width * 0.28;
    for (const side of [-1, 1]) {
      const pylon = MeshBuilder.CreateBox(
        `${id}_wing_pylon_${side < 0 ? "l" : "r"}`,
        { width: 0.036, height: wingH + 0.04, depth: 0.16 },
        this.scene
      );
      pylon.position.set(side * pylonSpread, wingH * 0.5, -0.02);
      pylon.rotation.x = -0.22;
      pylon.parent = group;
      pylon.material = carbonMat;
      pylon.isPickable = false;
      mount.shadowGen?.addShadowCaster(pylon);
    }

    // Main airfoil blade
    const blade = MeshBuilder.CreateBox(
      `${id}_wing_blade`,
      { width: mount.width, height: 0.042, depth: 0.28 },
      this.scene
    );
    blade.position.set(0, wingH + 0.01, -0.06);
    blade.rotation.x = -0.14;
    blade.parent = group;
    blade.material = carbonMat;
    blade.isPickable = false;
    mount.shadowGen?.addShadowCaster(blade);

    // Sculpted side endplates with accent trim
    for (const side of [-1, 1]) {
      const plate = MeshBuilder.CreateBox(
        `${id}_wing_plate_${side < 0 ? "l" : "r"}`,
        { width: 0.026, height: 0.19, depth: 0.36 },
        this.scene
      );
      plate.position.set(side * (mount.width * 0.5 + 0.01), wingH + 0.02, -0.06);
      plate.parent = group;
      plate.material = carbonMat;
      plate.isPickable = false;
      mount.shadowGen?.addShadowCaster(plate);

      const plateAccent = MeshBuilder.CreateBox(
        `${id}_wing_plate_acc_${side < 0 ? "l" : "r"}`,
        { width: 0.032, height: 0.026, depth: 0.34 },
        this.scene
      );
      plateAccent.position.set(side * (mount.width * 0.5 + 0.012), wingH + 0.09, -0.06);
      plateAccent.parent = group;
      plateAccent.material = accentMat;
      plateAccent.isPickable = false;
    }
  }

  private attachHeadlightPool(
    id: string,
    parent: TransformNode,
    frontZ: number
  ): { setEnabled: (on: boolean) => void; materials: StandardMaterial[] } {
    const texture = this.getHeadlightPoolTexture();
    const material = new StandardMaterial(`${id}_hl_pool_mat`, this.scene);
    material.emissiveTexture = texture;
    material.opacityTexture = texture;
    material.emissiveColor = new Color3(0.85, 0.9, 1);
    material.alpha = 0.28;
    material.disableLighting = true;

    const pool = MeshBuilder.CreateGround(`${id}_hl_road_pool`, { width: 4.5, height: 14 }, this.scene);
    pool.position.set(0, 0.05, frontZ + 7);
    pool.parent = parent;
    pool.material = material;
    pool.isPickable = false;

    return { materials: [material], setEnabled: (on) => pool.setEnabled(on) };
  }

  private attachUnderglow(
    id: string,
    parent: TransformNode,
    width: number,
    length: number
  ): { setColor: (hex: string | null) => void; materials: StandardMaterial[] } {
    const stripMat = new StandardMaterial(`${id}_ug_strip_mat`, this.scene);
    stripMat.disableLighting = true;

    const poolMat = new StandardMaterial(`${id}_ug_pool_mat`, this.scene);
    poolMat.emissiveTexture = this.getUnderglowPoolTexture();
    poolMat.opacityTexture = this.getUnderglowPoolTexture();
    poolMat.disableLighting = true;
    poolMat.backFaceCulling = false;
    poolMat.alpha = 0.72;

    const meshes: Mesh[] = [];

    // Left & right neon underbody light tubes
    for (const side of [-1, 1]) {
      const tube = MeshBuilder.CreateBox(
        `${id}_ug_side_${side < 0 ? "l" : "r"}`,
        { width: 0.05, height: 0.035, depth: length * 0.72 },
        this.scene
      );
      tube.position.set(side * (width * 0.44), 0.11, -0.05);
      tube.parent = parent;
      tube.material = stripMat;
      tube.isPickable = false;
      meshes.push(tube);
    }

    // Soft radial neon puddle cast onto asphalt beneath the chassis
    const pool = MeshBuilder.CreateGround(
      `${id}_ug_pool`,
      { width: width * 1.55, height: length * 1.24 },
      this.scene
    );
    pool.position.set(0, 0.035, -0.05);
    pool.parent = parent;
    pool.material = poolMat;
    pool.isPickable = false;
    meshes.push(pool);

    return {
      materials: [stripMat, poolMat],
      setColor: (hex: string | null) => {
        if (!hex) {
          for (const m of meshes) m.setEnabled(false);
          return;
        }
        const c = safeColor3(hex, "#00f0ff");
        stripMat.emissiveColor.set(c.r * 2.4, c.g * 2.4, c.b * 2.4);
        poolMat.emissiveColor.set(c.r * 1.45, c.g * 1.45, c.b * 1.45);
        for (const m of meshes) m.setEnabled(true);
      },
    };
  }

  // ---------------------------------------------------------------------------
  // AUTOMOTIVE PBR MATERIAL FACTORIES
  // ---------------------------------------------------------------------------
  private createCarPaintMaterial(name: string, livery: CarLiveryVisual): PBRMaterial {
    const mat = new PBRMaterial(name, this.scene);
    this.updatePaintMaterial(mat, livery);
    return mat;
  }

  private updatePaintMaterial(mat: PBRMaterial, livery: CarLiveryVisual): void {
    mat.albedoColor = safeColor3(livery.bodyHex, "#d61a21");
    mat.metallic = clamp01(livery.metallic);
    mat.roughness = Math.max(0.06, clamp01(livery.roughness));
    mat.clearCoat.isEnabled = livery.clearcoat > 0.05;
    mat.clearCoat.intensity = clamp01(livery.clearcoat);
    mat.clearCoat.roughness = livery.clearcoat > 0.5 ? 0.05 : 0.22;
    mat.clearCoat.indexOfRefraction = 1.56;
    mat.environmentIntensity = 1.25;
  }

  private createAccentMaterial(name: string, accentHex: string, stripeStyle: string): PBRMaterial {
    const mat = new PBRMaterial(name, this.scene);
    this.updateAccentMaterial(mat, accentHex, stripeStyle);
    return mat;
  }

  private updateAccentMaterial(mat: PBRMaterial, accentHex: string, stripeStyle: string): void {
    const c = safeColor3(accentHex, "#181a20");
    mat.albedoColor = c;
    mat.metallic = 0.65;
    mat.roughness = 0.22;
    mat.clearCoat.isEnabled = true;
    mat.clearCoat.intensity = 0.85;
    mat.clearCoat.roughness = 0.08;
    if (stripeStyle === "CYBER_BAND") {
      mat.emissiveColor = new Color3(c.r * 0.9, c.g * 0.9, c.b * 0.9);
    } else {
      mat.emissiveColor = Color3.Black();
    }
  }

  private createCarbonMaterial(name: string): PBRMaterial {
    const mat = new PBRMaterial(name, this.scene);
    mat.albedoColor = new Color3(0.14, 0.16, 0.2);
    mat.albedoTexture = this.getCarbonWeaveTexture();
    mat.metallic = 0.32;
    mat.roughness = 0.34;
    mat.clearCoat.isEnabled = true;
    mat.clearCoat.intensity = 0.72;
    mat.clearCoat.roughness = 0.14;
    return mat;
  }

  private createGlassMaterial(name: string): PBRMaterial {
    const mat = new PBRMaterial(name, this.scene);
    mat.albedoColor = new Color3(0.04, 0.06, 0.1);
    mat.metallic = 0.18;
    mat.roughness = 0.04;
    mat.alpha = 0.52;
    mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
    mat.clearCoat.isEnabled = true;
    mat.clearCoat.intensity = 1.0;
    mat.clearCoat.roughness = 0.02;
    mat.environmentIntensity = 1.45;
    return mat;
  }

  private createChromeMaterial(name: string): PBRMaterial {
    const mat = new PBRMaterial(name, this.scene);
    mat.albedoColor = new Color3(0.88, 0.91, 0.95);
    mat.metallic = 0.96;
    mat.roughness = 0.1;
    mat.environmentIntensity = 1.35;
    return mat;
  }

  private createRimMaterial(name: string, rimHex: string, rimId: string): PBRMaterial {
    const mat = new PBRMaterial(name, this.scene);
    this.updateRimMaterial(mat, rimHex, rimId);
    return mat;
  }

  private updateRimMaterial(mat: PBRMaterial, rimHex: string, rimId: string): void {
    const override = RIM_TINT_OVERRIDES[rimId] ?? null;
    const hex = override ?? rimHex;
    mat.albedoColor = safeColor3(hex, "#c9d1dc");
    if (rimId === "rim_aero_carbon") {
      mat.metallic = 0.45;
      mat.roughness = 0.32;
    } else if (rimId === "rim_mesh_gold") {
      mat.metallic = 0.92;
      mat.roughness = 0.18;
    } else {
      mat.metallic = 0.9;
      mat.roughness = 0.16;
    }
    mat.clearCoat.isEnabled = true;
    mat.clearCoat.intensity = 0.65;
    mat.clearCoat.roughness = 0.1;
  }

  private createCaliperMaterial(name: string, hex: string): PBRMaterial {
    const mat = new PBRMaterial(name, this.scene);
    mat.albedoColor = safeColor3(hex, "#f5c400");
    mat.metallic = 0.55;
    mat.roughness = 0.25;
    mat.clearCoat.isEnabled = true;
    mat.clearCoat.intensity = 0.85;
    return mat;
  }

  private createTireMaterial(name: string): PBRMaterial {
    const mat = new PBRMaterial(name, this.scene);
    mat.albedoColor = new Color3(0.06, 0.065, 0.08);
    mat.metallic = 0.02;
    mat.roughness = 0.84;
    return mat;
  }

  private createInteriorMaterial(name: string, hex: string, roughness: number): PBRMaterial {
    const mat = new PBRMaterial(name, this.scene);
    mat.albedoColor = safeColor3(hex, "#14161d");
    mat.metallic = 0.08;
    mat.roughness = roughness;
    return mat;
  }

  private createBrakeDiscMaterial(name: string): PBRMaterial {
    const mat = new PBRMaterial(name, this.scene);
    mat.albedoColor = new Color3(0.45, 0.48, 0.54);
    mat.metallic = 0.88;
    mat.roughness = 0.32;
    mat.emissiveColor = Color3.Black();
    return mat;
  }

  private createBrakeLightMaterial(name: string): PBRMaterial {
    const mat = new PBRMaterial(name, this.scene);
    mat.albedoColor = new Color3(0.55, 0.02, 0.03);
    mat.metallic = 0.15;
    mat.roughness = 0.12;
    mat.clearCoat.isEnabled = true;
    mat.clearCoat.intensity = 1.0;
    mat.emissiveColor = new Color3(0.35, 0.02, 0.02);
    return mat;
  }

  private createHeadlightMaterial(name: string): PBRMaterial {
    const mat = new PBRMaterial(name, this.scene);
    mat.albedoColor = new Color3(0.92, 0.96, 1.0);
    mat.metallic = 0.2;
    mat.roughness = 0.05;
    mat.clearCoat.isEnabled = true;
    mat.clearCoat.intensity = 1.0;
    mat.emissiveColor = new Color3(2.2, 2.35, 2.6);
    return mat;
  }

  private createReverseLightMaterial(name: string): PBRMaterial {
    const mat = new PBRMaterial(name, this.scene);
    mat.albedoColor = new Color3(0.85, 0.88, 0.92);
    mat.metallic = 0.1;
    mat.roughness = 0.12;
    mat.emissiveColor = new Color3(0.08, 0.08, 0.09);
    return mat;
  }

  // ---------------------------------------------------------------------------
  // PROCEDURAL AUTOMOTIVE TEXTURES (LIVERY STRIPES, CARBON WEAVE, GLOW POOLS)
  // ---------------------------------------------------------------------------
  private createSculptedLiveryTexture(name: string, livery: CarLiveryVisual): DynamicTexture {
    const tex = new DynamicTexture(name, { width: 512, height: 512 }, this.scene, true);
    tex.anisotropicFilteringLevel = 4;
    this.paintSculptedLiveryTexture(tex, livery);
    return tex;
  }

  private paintSculptedLiveryTexture(tex: DynamicTexture, livery: CarLiveryVisual): void {
    const ctx = tex.getContext();
    const W = 512;
    const H = 512;

    // Base clearcoat paint fill
    ctx.fillStyle = livery.bodyHex;
    ctx.fillRect(0, 0, W, H);

    // Subtle panel seam shading (hood shut line & door gaps)
    ctx.strokeStyle = "rgba(0,0,0,0.22)";
    ctx.lineWidth = 2;
    ctx.strokeRect(W * 0.36, H * 0.05, W * 0.28, H * 0.32);

    // Note on DynamicTexture UV mapping for our 13-point lofted ribbon:
    // u = 0.5 (x = 256) is exact top centerline; v = 0 (y = 512) is rear, v = 1 (y = 0) is front nose!
    if (livery.stripeStyle === "CENTER_DUAL") {
      ctx.fillStyle = livery.accentHex;
      ctx.fillRect(W * 0.455, 0, W * 0.034, H);
      ctx.fillRect(W * 0.511, 0, W * 0.034, H);
      ctx.fillStyle = "rgba(255,255,255,0.25)";
      ctx.fillRect(W * 0.448, 0, 3, H);
      ctx.fillRect(W * 0.55, 0, 3, H);
    } else if (livery.stripeStyle === "SIDE_FLASH") {
      ctx.fillStyle = livery.accentHex;
      // Left side flank (u ~ 0.18..0.28) & Right side flank (u ~ 0.72..0.82)
      ctx.beginPath();
      ctx.moveTo(W * 0.16, H * 0.12);
      ctx.lineTo(W * 0.27, H * 0.28);
      ctx.lineTo(W * 0.24, H * 0.88);
      ctx.lineTo(W * 0.17, H * 0.78);
      ctx.closePath();
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(W * 0.84, H * 0.12);
      ctx.lineTo(W * 0.73, H * 0.28);
      ctx.lineTo(W * 0.76, H * 0.88);
      ctx.lineTo(W * 0.83, H * 0.78);
      ctx.closePath();
      ctx.fill();
    } else if (livery.stripeStyle === "CARBON_HOOD") {
      // Exposed woven carbon fiber hood panel (top front section)
      const hx = W * 0.36;
      const hw = W * 0.28;
      const hh = H * 0.38;
      ctx.fillStyle = "#161920";
      ctx.fillRect(hx, 0, hw, hh);
      ctx.fillStyle = "rgba(255,255,255,0.06)";
      for (let y = 0; y < hh; y += 6) {
        for (let x = hx; x < hx + hw; x += 6) {
          if (((x + y) / 6) % 2 === 0) ctx.fillRect(x, y, 3, 3);
        }
      }
      // Gold/accent hood pinstripes
      ctx.fillStyle = livery.accentHex;
      ctx.fillRect(hx - 4, 0, 4, hh);
      ctx.fillRect(hx + hw, 0, 4, hh);
      ctx.fillRect(W * 0.18, H * 0.2, 6, H * 0.65);
      ctx.fillRect(W * 0.82 - 6, H * 0.2, 6, H * 0.65);
    } else if (livery.stripeStyle === "CYBER_BAND") {
      // Tokyo street racing neon cyber stripes along flanks & hood edges
      ctx.fillStyle = livery.accentHex;
      ctx.fillRect(W * 0.19, 0, 12, H);
      ctx.fillRect(W * 0.81 - 12, 0, 12, H);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(W * 0.215, 0, 4, H);
      ctx.fillRect(W * 0.785 - 4, 0, 4, H);
      // Center racing chevron
      ctx.fillStyle = livery.accentHex;
      ctx.fillRect(W * 0.488, 0, W * 0.024, H * 0.4);
    }

    tex.update();
  }

  private getCarbonWeaveTexture(): DynamicTexture {
    if (this.carbonWeaveTex) return this.carbonWeaveTex;
    const tex = new DynamicTexture("race_carbon_weave", 128, this.scene, true);
    const ctx = tex.getContext();
    ctx.fillStyle = "#12151c";
    ctx.fillRect(0, 0, 128, 128);
    for (let y = 0; y < 128; y += 8) {
      for (let x = 0; x < 128; x += 8) {
        const shift = ((y / 8) % 2) * 4;
        ctx.fillStyle = "#222733";
        ctx.fillRect((x + shift) % 128, y, 4, 4);
        ctx.fillStyle = "#191d27";
        ctx.fillRect((x + shift + 4) % 128, y + 4, 4, 4);
      }
    }
    tex.wrapU = Texture.WRAP_ADDRESSMODE;
    tex.wrapV = Texture.WRAP_ADDRESSMODE;
    tex.uScale = 8;
    tex.vScale = 8;
    tex.update();
    this.carbonWeaveTex = tex;
    this.ownedTextures.push(tex);
    return tex;
  }

  private getUnderglowPoolTexture(): DynamicTexture {
    if (this.underglowPoolTex) return this.underglowPoolTex;
    const tex = new DynamicTexture("race_underglow_pool", 256, this.scene, true);
    const ctx = tex.getContext();
    ctx.clearRect(0, 0, 256, 256);
    const grad = ctx.createRadialGradient(128, 128, 18, 128, 128, 122);
    grad.addColorStop(0.0, "rgba(255,255,255,0.95)");
    grad.addColorStop(0.45, "rgba(255,255,255,0.55)");
    grad.addColorStop(0.8, "rgba(255,255,255,0.14)");
    grad.addColorStop(1.0, "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 256, 256);
    tex.hasAlpha = true;
    tex.update();
    this.underglowPoolTex = tex;
    this.ownedTextures.push(tex);
    return tex;
  }

  private getHeadlightPoolTexture(): DynamicTexture {
    if (this.headlightPoolTex) return this.headlightPoolTex;
    const tex = new DynamicTexture("race_headlight_pool", 256, this.scene, true);
    const ctx = tex.getContext();
    ctx.clearRect(0, 0, 256, 256);
    // Two overlapping forward-reaching headlight beams (v=1 near car, v=0 far ahead)
    for (const cx of [92, 164]) {
      const grad = ctx.createRadialGradient(cx, 210, 10, cx, 118, 118);
      grad.addColorStop(0.0, "rgba(255,255,255,0.85)");
      grad.addColorStop(0.5, "rgba(235,245,255,0.34)");
      grad.addColorStop(1.0, "rgba(220,235,255,0)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 256, 256);
    }
    tex.hasAlpha = true;
    tex.update();
    this.headlightPoolTex = tex;
    this.ownedTextures.push(tex);
    return tex;
  }

  // ---------------------------------------------------------------------------
  // SCULPTED AUTOMOTIVE SILHOUETTE PROFILES (skyline_r34, viper_v8, rally_rs, GT)
  // ---------------------------------------------------------------------------
  private getSculptCarSpec(vehicleId: string): SculptCarSpec {
    if (vehicleId === "skyline_r34") {
      // JDM Widebody Skyline R34 Spec-Z: muscular fender flares, crisp deck, quad round taillights
      return {
        length: 4.6,
        wheelRadius: 0.34,
        frontWheelZ: 1.34,
        rearWheelZ: -1.33,
        frontTrackHalf: 0.88,
        rearTrackHalf: 0.9,
        tireWidthFront: 0.27,
        tireWidthRear: 0.3,
        cabinStartZ: -1.35,
        cabinEndZ: 0.85,
        roofHeight: 1.34,
        roofWidth: 0.72,
        spoilerY: 0.93,
        spoilerZ: -2.02,
        spoilerWidth: 1.76,
        exhaustY: 0.24,
        exhaustZ: -2.28,
        exhaustOffsetsX: [-0.46, 0.46],
        headlightZ: 2.24,
        headlightY: 0.64,
        headlightSpreadX: 0.66,
        taillightZ: -2.28,
        taillightY: 0.74,
        taillightStyle: "QUAD_RING",
        hasIntercooler: true,
        hasHoodScoop: false,
        hasRoofScoop: false,
        hasRallyFogPods: false,
        hasMudflaps: false,
        stations: [
          { z: -2.3, wBot: 0.86, wMid: 0.92, wMax: 0.92, wTop: 0.86, wDeck: 0.74, yBot: 0.22, yLow: 0.42, yBelt: 0.74, yTop: 0.92, crown: 0.02 },
          { z: -1.85, wBot: 0.9, wMid: 0.96, wMax: 0.98, wTop: 0.9, wDeck: 0.76, yBot: 0.18, yLow: 0.42, yBelt: 0.76, yTop: 0.94, crown: 0.025 },
          { z: -1.33, wBot: 0.94, wMid: 1.0, wMax: 1.03, wTop: 0.94, wDeck: 0.78, yBot: 0.18, yLow: 0.45, yBelt: 0.78, yTop: 0.94, crown: 0.02 },
          { z: -0.6, wBot: 0.9, wMid: 0.94, wMax: 0.96, wTop: 0.88, wDeck: 0.76, yBot: 0.16, yLow: 0.4, yBelt: 0.74, yTop: 0.9, crown: 0.015 },
          { z: 0.45, wBot: 0.9, wMid: 0.94, wMax: 0.96, wTop: 0.88, wDeck: 0.76, yBot: 0.16, yLow: 0.4, yBelt: 0.74, yTop: 0.88, crown: 0.02 },
          { z: 1.34, wBot: 0.92, wMid: 0.98, wMax: 1.01, wTop: 0.91, wDeck: 0.74, yBot: 0.17, yLow: 0.42, yBelt: 0.72, yTop: 0.84, crown: 0.03 },
          { z: 1.98, wBot: 0.88, wMid: 0.93, wMax: 0.94, wTop: 0.84, wDeck: 0.68, yBot: 0.16, yLow: 0.36, yBelt: 0.62, yTop: 0.74, crown: 0.025 },
          { z: 2.3, wBot: 0.82, wMid: 0.86, wMax: 0.86, wTop: 0.76, wDeck: 0.58, yBot: 0.16, yLow: 0.32, yBelt: 0.52, yTop: 0.62, crown: 0.02 },
        ],
      };
    }

    if (vehicleId === "viper_v8") {
      // Long-Hood Sculpted Muscle GT Coupe: low slung, cab-rearward, wide rear haunches, hood scoop
      return {
        length: 4.72,
        wheelRadius: 0.36,
        frontWheelZ: 1.4,
        rearWheelZ: -1.34,
        frontTrackHalf: 0.92,
        rearTrackHalf: 0.96,
        tireWidthFront: 0.29,
        tireWidthRear: 0.34,
        cabinStartZ: -1.46,
        cabinEndZ: 0.58,
        roofHeight: 1.27,
        roofWidth: 0.7,
        spoilerY: 0.92,
        spoilerZ: -2.06,
        spoilerWidth: 1.86,
        exhaustY: 0.24,
        exhaustZ: -2.34,
        exhaustOffsetsX: [-0.56, -0.4, 0.4, 0.56],
        headlightZ: 2.3,
        headlightY: 0.62,
        headlightSpreadX: 0.7,
        taillightZ: -2.34,
        taillightY: 0.74,
        taillightStyle: "LIGHTBAR",
        hasIntercooler: false,
        hasHoodScoop: true,
        hasRoofScoop: false,
        hasRallyFogPods: false,
        hasMudflaps: false,
        stations: [
          { z: -2.36, wBot: 0.9, wMid: 0.96, wMax: 0.98, wTop: 0.9, wDeck: 0.74, yBot: 0.22, yLow: 0.44, yBelt: 0.74, yTop: 0.91, crown: 0.03 },
          { z: -1.85, wBot: 0.95, wMid: 1.02, wMax: 1.05, wTop: 0.95, wDeck: 0.78, yBot: 0.19, yLow: 0.46, yBelt: 0.78, yTop: 0.94, crown: 0.03 },
          { z: -1.34, wBot: 0.98, wMid: 1.06, wMax: 1.1, wTop: 0.98, wDeck: 0.8, yBot: 0.18, yLow: 0.48, yBelt: 0.8, yTop: 0.95, crown: 0.025 },
          { z: -0.5, wBot: 0.92, wMid: 0.96, wMax: 0.98, wTop: 0.9, wDeck: 0.78, yBot: 0.16, yLow: 0.42, yBelt: 0.74, yTop: 0.88, crown: 0.02 },
          { z: 0.5, wBot: 0.93, wMid: 0.98, wMax: 1.0, wTop: 0.9, wDeck: 0.78, yBot: 0.16, yLow: 0.42, yBelt: 0.74, yTop: 0.87, crown: 0.03 },
          { z: 1.4, wBot: 0.94, wMid: 1.0, wMax: 1.03, wTop: 0.92, wDeck: 0.75, yBot: 0.16, yLow: 0.42, yBelt: 0.72, yTop: 0.84, crown: 0.04 },
          { z: 2.05, wBot: 0.88, wMid: 0.94, wMax: 0.95, wTop: 0.84, wDeck: 0.66, yBot: 0.15, yLow: 0.34, yBelt: 0.58, yTop: 0.7, crown: 0.03 },
          { z: 2.36, wBot: 0.8, wMid: 0.84, wMax: 0.84, wTop: 0.72, wDeck: 0.54, yBot: 0.15, yLow: 0.3, yBelt: 0.48, yTop: 0.56, crown: 0.02 },
        ],
      };
    }

    if (vehicleId === "rally_rs") {
      // Compact Widebody AWD Rally Hatchback/Evo: roof scoop, 4-pod rally lights, mudflaps, tall fast cabin
      return {
        length: 4.38,
        wheelRadius: 0.34,
        frontWheelZ: 1.29,
        rearWheelZ: -1.29,
        frontTrackHalf: 0.89,
        rearTrackHalf: 0.9,
        tireWidthFront: 0.27,
        tireWidthRear: 0.28,
        cabinStartZ: -1.68,
        cabinEndZ: 0.84,
        roofHeight: 1.43,
        roofWidth: 0.76,
        spoilerY: 1.38,
        spoilerZ: -1.9,
        spoilerWidth: 1.66,
        exhaustY: 0.24,
        exhaustZ: -2.18,
        exhaustOffsetsX: [-0.26, 0.26],
        headlightZ: 2.13,
        headlightY: 0.68,
        headlightSpreadX: 0.66,
        taillightZ: -2.18,
        taillightY: 0.8,
        taillightStyle: "RALLY_CLUSTER",
        hasIntercooler: true,
        hasHoodScoop: false,
        hasRoofScoop: true,
        hasRallyFogPods: true,
        hasMudflaps: true,
        stations: [
          { z: -2.19, wBot: 0.86, wMid: 0.92, wMax: 0.93, wTop: 0.88, wDeck: 0.76, yBot: 0.24, yLow: 0.48, yBelt: 0.8, yTop: 0.96, crown: 0.02 },
          { z: -1.78, wBot: 0.91, wMid: 0.97, wMax: 1.0, wTop: 0.92, wDeck: 0.8, yBot: 0.2, yLow: 0.48, yBelt: 0.82, yTop: 0.97, crown: 0.02 },
          { z: -1.29, wBot: 0.95, wMid: 1.01, wMax: 1.04, wTop: 0.94, wDeck: 0.8, yBot: 0.2, yLow: 0.48, yBelt: 0.82, yTop: 0.95, crown: 0.02 },
          { z: -0.45, wBot: 0.9, wMid: 0.94, wMax: 0.96, wTop: 0.89, wDeck: 0.78, yBot: 0.19, yLow: 0.44, yBelt: 0.78, yTop: 0.91, crown: 0.015 },
          { z: 0.55, wBot: 0.9, wMid: 0.94, wMax: 0.96, wTop: 0.89, wDeck: 0.78, yBot: 0.19, yLow: 0.44, yBelt: 0.78, yTop: 0.9, crown: 0.02 },
          { z: 1.29, wBot: 0.93, wMid: 0.99, wMax: 1.02, wTop: 0.92, wDeck: 0.76, yBot: 0.19, yLow: 0.46, yBelt: 0.78, yTop: 0.88, crown: 0.025 },
          { z: 1.9, wBot: 0.88, wMid: 0.93, wMax: 0.94, wTop: 0.85, wDeck: 0.7, yBot: 0.19, yLow: 0.4, yBelt: 0.68, yTop: 0.78, crown: 0.025 },
          { z: 2.19, wBot: 0.82, wMid: 0.86, wMax: 0.86, wTop: 0.76, wDeck: 0.6, yBot: 0.18, yLow: 0.36, yBelt: 0.56, yTop: 0.66, crown: 0.02 },
        ],
      };
    }

    // Fallback sculpted GT supercar (used only if ferrari.glb wasn't preloaded yet)
    return {
      length: 4.54,
      wheelRadius: 0.35,
      frontWheelZ: 1.28,
      rearWheelZ: -1.36,
      frontTrackHalf: 0.92,
      rearTrackHalf: 0.95,
      tireWidthFront: 0.28,
      tireWidthRear: 0.32,
      cabinStartZ: -1.25,
      cabinEndZ: 0.92,
      roofHeight: 1.21,
      roofWidth: 0.68,
      spoilerY: 0.9,
      spoilerZ: -1.96,
      spoilerWidth: 1.8,
      exhaustY: 0.26,
      exhaustZ: -2.24,
      exhaustOffsetsX: [-0.2, 0.2],
      headlightZ: 2.2,
      headlightY: 0.58,
      headlightSpreadX: 0.7,
      taillightZ: -2.24,
      taillightY: 0.72,
      taillightStyle: "QUAD_RING",
      hasIntercooler: false,
      hasHoodScoop: false,
      hasRoofScoop: false,
      hasRallyFogPods: false,
      hasMudflaps: false,
      stations: [
        { z: -2.27, wBot: 0.9, wMid: 0.96, wMax: 0.98, wTop: 0.9, wDeck: 0.74, yBot: 0.2, yLow: 0.42, yBelt: 0.72, yTop: 0.88, crown: 0.025 },
        { z: -1.36, wBot: 0.96, wMid: 1.04, wMax: 1.08, wTop: 0.96, wDeck: 0.78, yBot: 0.16, yLow: 0.44, yBelt: 0.76, yTop: 0.9, crown: 0.025 },
        { z: -0.35, wBot: 0.92, wMid: 0.98, wMax: 1.0, wTop: 0.9, wDeck: 0.74, yBot: 0.14, yLow: 0.38, yBelt: 0.7, yTop: 0.84, crown: 0.02 },
        { z: 0.7, wBot: 0.92, wMid: 0.96, wMax: 0.98, wTop: 0.88, wDeck: 0.72, yBot: 0.14, yLow: 0.36, yBelt: 0.66, yTop: 0.78, crown: 0.02 },
        { z: 1.28, wBot: 0.94, wMid: 1.0, wMax: 1.02, wTop: 0.9, wDeck: 0.72, yBot: 0.14, yLow: 0.38, yBelt: 0.64, yTop: 0.75, crown: 0.03 },
        { z: 1.98, wBot: 0.86, wMid: 0.92, wMax: 0.92, wTop: 0.8, wDeck: 0.62, yBot: 0.13, yLow: 0.3, yBelt: 0.5, yTop: 0.6, crown: 0.02 },
        { z: 2.27, wBot: 0.76, wMid: 0.82, wMax: 0.82, wTop: 0.68, wDeck: 0.5, yBot: 0.13, yLow: 0.24, yBelt: 0.4, yTop: 0.48, crown: 0.015 },
      ],
    };
  }

  dispose(): void {
    this.ferrariContainer?.dispose();
    this.ferrariContainer = null;

    for (const env of this.envCache.values()) env.dispose();
    this.envCache.clear();

    for (const set of this.pbrTexCache.values()) {
      set.albedo.dispose();
      set.bump.dispose();
      set.arm.dispose();
    }
    this.pbrTexCache.clear();

    for (const mat of this.pbrMatCache.values()) mat.dispose();
    this.pbrMatCache.clear();

    for (const tex of this.ownedTextures) tex.dispose();
    this.ownedTextures.length = 0;
    this.carbonWeaveTex = null;
    this.underglowPoolTex = null;
    this.headlightPoolTex = null;
  }
}
