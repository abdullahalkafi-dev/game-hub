import {
  Color3,
  CubeTexture,
  DynamicTexture,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  Scene,
  StandardMaterial,
  Texture,
} from "@babylonjs/core";
import type { MapBlueprint, SurfaceMaterialTag } from "@game/shared";

export interface RealPbrTextureSet {
  albedo: Texture;
  bump: Texture;
  arm: Texture;
}

const SLUG_BY_TAG: Partial<Record<SurfaceMaterialTag, string>> = {
  CONCRETE: "concrete_wall_005",
  METAL: "corrugated_iron_02",
  SHEET_METAL: "metal_plate_02",
  WOOD_THIN: "brown_planks_04",
  SANDSTONE: "sandstone_blocks_05",
  EXPLOSIVE_BARREL: "rusty_metal_02",
};

/**
 * Loads real 1K CC0 Poly Haven photogrammetry PBR texture sets (Diffuse + Normal + ARM)
 * and official Babylon.js prefiltered HDR `.env` IBL environments from `/assets/`.
 */
export class PbrTextureGenerator {
  private readonly realTexCache = new Map<string, RealPbrTextureSet>();
  private readonly neonTexCache = new Map<string, Texture>();
  private readonly envTextures: CubeTexture[] = [];

  constructor(private readonly scene: Scene) {}

  createEnvironmentCubeTexture(theme: MapBlueprint["theme"] | "GUNSMITH"): CubeTexture {
    const url = theme === "GUNSMITH" ? "/assets/env/studio.env" : "/assets/env/outdoor.env";
    const env = CubeTexture.CreateFromPrefilteredData(url, this.scene);
    this.envTextures.push(env);
    return env;
  }

  getPbrTextureSet(slug: string, uScale = 1, vScale = 1): RealPbrTextureSet {
    const key = `${slug}_${uScale}_${vScale}`;
    const existing = this.realTexCache.get(key);
    if (existing) return existing;

    const base = `/assets/textures/${slug}`;
    const albedo = new Texture(`${base}/diff.jpg`, this.scene, false, true, Texture.TRILINEAR_SAMPLINGMODE);
    const bump = new Texture(`${base}/nor_gl.jpg`, this.scene, false, true, Texture.TRILINEAR_SAMPLINGMODE);
    const arm = new Texture(`${base}/arm.jpg`, this.scene, false, true, Texture.TRILINEAR_SAMPLINGMODE);

    for (const tex of [albedo, bump, arm]) {
      tex.wrapU = Texture.WRAP_ADDRESSMODE;
      tex.wrapV = Texture.WRAP_ADDRESSMODE;
      tex.uScale = uScale;
      tex.vScale = vScale;
    }

    const set = { albedo, bump, arm };
    this.realTexCache.set(key, set);
    return set;
  }

  applyRealPbrToMaterial(
    mat: PBRMaterial,
    slug: string,
    uScale = 1,
    vScale = 1,
    tintHex?: string,
    roughnessScale = 1.0,
    metallicScale = 1.0
  ): void {
    const set = this.getPbrTextureSet(slug, uScale, vScale);
    mat.albedoTexture = set.albedo;
    mat.bumpTexture = set.bump;
    mat.metallicTexture = set.arm;
    mat.useAmbientOcclusionFromMetallicTextureRed = true;
    mat.useRoughnessFromMetallicTextureGreen = true;
    mat.useMetallnessFromMetallicTextureBlue = true;
    mat.roughness = roughnessScale;
    mat.metallic = metallicScale;
    if (tintHex) {
      mat.albedoColor = Color3.FromHexString(tintHex);
    }
  }

  getFloorSlug(map: MapBlueprint): string {
    return map.theme === "DESERT_OUTPOST" ? "coast_sand_01" : "asphalt_02";
  }

  getBlockSlug(material: SurfaceMaterialTag): string {
    return SLUG_BY_TAG[material] ?? "concrete_wall_005";
  }

  getNeonBillboardTexture(colorHex: string): Texture {
    const existing = this.neonTexCache.get(colorHex);
    if (existing) return existing;

    const tex = new DynamicTexture(`neon_bb_${colorHex}`, 512, this.scene, true);
    const ctx = tex.getContext();
    ctx.fillStyle = "#070b14";
    ctx.fillRect(0, 0, 512, 512);
    ctx.strokeStyle = colorHex;
    ctx.lineWidth = 10;
    ctx.strokeRect(16, 16, 480, 480);
    ctx.fillStyle = colorHex;
    for (let y = 70; y < 440; y += 92) {
      ctx.fillRect(42, y, 428, 20);
    }
    tex.update();
    this.neonTexCache.set(colorHex, tex);
    return tex;
  }

  createSkyDome(map: MapBlueprint): Mesh {
    const sky = MeshBuilder.CreateSphere(
      "sky_dome",
      { diameter: 320, segments: 24, sideOrientation: Mesh.BACKSIDE },
      this.scene
    );
    sky.isPickable = false;

    const tex = new DynamicTexture(`sky_tex_${map.id}`, { width: 1024, height: 512 }, this.scene, false);
    const ctx = tex.getContext();
    // Babylon Sphere V-coordinates map canvas bottom (y=512) to +Y zenith unless flipped vertically
    ctx.save();
    ctx.translate(0, 512);
    ctx.scale(1, -1);

    const grad = ctx.createLinearGradient(0, 0, 0, 512);
    if (map.theme === "NEON_ROOFTOP") {
      grad.addColorStop(0, "#02050d");
      grad.addColorStop(0.42, "#0b132b");
      grad.addColorStop(0.52, "#1f1235");
      grad.addColorStop(0.65, "#090d16");
      grad.addColorStop(1, "#05070e");
    } else if (map.theme === "DESERT_OUTPOST") {
      grad.addColorStop(0, "#1e3a8a");
      grad.addColorStop(0.32, "#60a5fa");
      grad.addColorStop(0.49, "#fde68a");
      grad.addColorStop(0.54, "#c29b68");
      grad.addColorStop(1, "#8c6b43");
    } else {
      grad.addColorStop(0, "#1e3a5f");
      grad.addColorStop(0.34, "#648cb0");
      grad.addColorStop(0.5, "#cbd5e1");
      grad.addColorStop(0.55, "#334155");
      grad.addColorStop(1, "#1e293b");
    }
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 1024, 512);

    if (map.theme === "NEON_ROOFTOP") {
      for (let i = 0; i < 260; i++) {
        ctx.fillStyle = i % 5 === 0 ? "rgba(56,189,248,0.75)" : "rgba(255,255,255,0.6)";
        ctx.fillRect((i * 137) % 1024, (i * 43) % 210, 1.8, 1.8);
      }
      // Crisp distant skyscraper skyline silhouettes rising just above horizon (y=256)
      for (let x = 0; x < 1024; x += 26) {
        const bh = 28 + ((x * 23) % 68);
        const topY = 264 - bh;
        ctx.fillStyle = "#060914";
        ctx.fillRect(x, topY, 22, bh + 16);
        ctx.fillStyle = x % 52 === 0 ? "rgba(0,240,255,0.52)" : "rgba(255,0,127,0.42)";
        for (let wy = topY + 6; wy < 258; wy += 7) {
          ctx.fillRect(x + 4, wy, 4, 3);
          ctx.fillRect(x + 13, wy, 4, 3);
        }
      }
    } else {
      // Atmospheric sun halo well above horizon + subtle drifting clouds
      const sunGrad = ctx.createRadialGradient(260, 165, 6, 260, 165, 110);
      sunGrad.addColorStop(0, "rgba(255,252,235,0.95)");
      sunGrad.addColorStop(0.28, "rgba(255,220,165,0.42)");
      sunGrad.addColorStop(1, "rgba(255,220,165,0)");
      ctx.fillStyle = sunGrad;
      ctx.fillRect(140, 50, 240, 230);

      for (let i = 0; i < 36; i++) {
        const cx = (i * 97) % 1024;
        const cy = 70 + ((i * 29) % 135);
        const cg = ctx.createRadialGradient(cx, cy, 8, cx, cy, 64);
        cg.addColorStop(0, "rgba(255,255,255,0.2)");
        cg.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = cg;
        ctx.fillRect(cx - 64, cy - 28, 128, 56);
      }

      if (map.theme === "DESERT_OUTPOST") {
        // Low distant desert mesas along horizon (y=242..276)
        ctx.fillStyle = "rgba(156,114,72,0.72)";
        ctx.beginPath();
        ctx.moveTo(0, 276);
        for (let x = 0; x <= 1024; x += 48) {
          ctx.lineTo(x, 246 - Math.sin(x * 0.02) * 12 - Math.cos(x * 0.008) * 9);
        }
        ctx.lineTo(1024, 276);
        ctx.closePath();
        ctx.fill();
      } else {
        // Distant port container gantry cranes silhouetted along harbor horizon (y=215..272)
        ctx.fillStyle = "rgba(30,41,59,0.78)";
        for (let x = 90; x < 1024; x += 250) {
          ctx.fillRect(x, 222, 4, 48);
          ctx.fillRect(x + 14, 222, 4, 48);
          ctx.fillRect(x - 20, 228, 58, 4);
        }
      }
    }

    ctx.restore();
    tex.update();

    const mat = new StandardMaterial(`sky_mat_${map.id}`, this.scene);
    mat.emissiveTexture = tex;
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    sky.material = mat;
    return sky;
  }

  dispose(): void {
    for (const s of this.realTexCache.values()) {
      s.albedo.dispose();
      s.bump.dispose();
      s.arm.dispose();
    }
    this.realTexCache.clear();
    for (const t of this.neonTexCache.values()) t.dispose();
    this.neonTexCache.clear();
    for (const env of this.envTextures) env.dispose();
    this.envTextures.length = 0;
  }
}
