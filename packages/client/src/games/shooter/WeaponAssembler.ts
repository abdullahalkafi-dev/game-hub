import {
  Color3,
  DynamicTexture,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  Scene,
  StandardMaterial,
  Texture,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import {
  SKIN_REGISTRY,
  computeEffectiveWeaponStats,
  type CamoPatternType,
  type MaterialZoneOverride,
  type PlayerWeaponConfig,
} from "@game/shared";
import type { ModelAssetCache } from "./ModelAssetCache.js";
import { buildProceduralGun } from "./ProceduralGuns.js";
import type { PbrTextureGenerator } from "./PbrTextureGenerator.js";

export interface AssembledWeapon {
  root: TransformNode;
  muzzleNode: TransformNode;
  ejectNode: TransformNode;
  boltNode: TransformNode;
  /** local z the bolt returns to after the recoil kick */
  boltRestZ: number;
  magNode: TransformNode;
  firingGrip: Vector3;
  supportGrip: Vector3;
  adsAlignOffset: Vector3;
  dispose: () => void;
}

const patternTextureCache = new WeakMap<Scene, Map<string, Texture>>();

function getOrCreateCamoTexture(
  scene: Scene,
  pattern: CamoPatternType,
  baseHex: string,
  accentHex: string | undefined,
  uvScale: number
): Texture | null {
  if (!pattern || pattern === "NONE") return null;
  let textures = patternTextureCache.get(scene);
  if (!textures) {
    textures = new Map();
    patternTextureCache.set(scene, textures);
  }
  const cacheKey = `${pattern}_${baseHex}_${accentHex ?? ""}_${uvScale}`;
  const existing = textures.get(cacheKey);
  if (existing) return existing;

  const tex = new DynamicTexture(`camo_${cacheKey}`, 256, scene, false);
  const ctx = tex.getContext();
  ctx.fillStyle = baseHex;
  ctx.fillRect(0, 0, 256, 256);

  if (pattern === "CARBON") {
    for (let y = 0; y < 256; y += 8) {
      for (let x = 0; x < 256; x += 8) {
        ctx.fillStyle = (x + y) % 16 === 0 ? "#303642" : "#15181f";
        ctx.fillRect(x, y, 6, 6);
      }
    }
  } else if (pattern === "CYBER_GRID") {
    ctx.strokeStyle = accentHex ?? "#00f0ff";
    ctx.lineWidth = 2;
    for (let i = 0; i <= 256; i += 24) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i, 256);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, i);
      ctx.lineTo(256, i);
      ctx.stroke();
    }
  } else if (pattern === "DESERT_DIGITAL") {
    const colors = ["#b89463", "#8c693e", "#dec39b", "#5c4529"];
    for (let i = 0; i < 320; i++) {
      ctx.fillStyle = colors[(i * 7) % colors.length];
      const rx = ((i * 37) % 32) * 8;
      const ry = ((i * 53) % 32) * 8;
      ctx.fillRect(rx, ry, 16, 8);
    }
  } else if (pattern === "BRUSHED_METAL") {
    for (let y = 0; y < 256; y += 2) {
      ctx.fillStyle = y % 4 === 0 ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.1)";
      ctx.fillRect(0, y, 256, 1);
    }
  }

  tex.update();
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;
  tex.uScale = uvScale;
  tex.vScale = uvScale;
  textures.set(cacheKey, tex);
  return tex;
}

function buildZoneMaterial(
  scene: Scene,
  name: string,
  zone: MaterialZoneOverride,
  texGen?: PbrTextureGenerator
): PBRMaterial {
  const mat = new PBRMaterial(name, scene);
  const baseHex = zone.baseColorHex ?? "#334155";
  mat.albedoColor = Color3.FromHexString(baseHex);
  mat.roughness = zone.roughness ?? 0.38;
  mat.metallic = zone.metallic ?? 0.55;
  mat.environmentIntensity = 0.65;

  // Apply real micro-metal bump/roughness detail when available
  if (texGen) {
    const gunMetal = texGen.getPbrTextureSet("metal_plate_02", 3, 3);
    mat.bumpTexture = gunMetal.bump;
    mat.bumpTexture.level = 0.45;
  }

  if (zone.emissiveHex) {
    mat.emissiveColor = Color3.FromHexString(zone.emissiveHex).scale(zone.emissiveIntensity ?? 0.7);
  }

  if (zone.patternType && zone.patternType !== "NONE") {
    mat.albedoTexture = getOrCreateCamoTexture(scene, zone.patternType, baseHex, zone.emissiveHex, zone.uvScale ?? 3);
  }
  return mat;
}

/**
 * Modular Weapon Assembler:
 * - Uses real CC0 photogrammetry glTF models for `kar98k`/`awm` (`bolt_action_rifle_7_62`) and `deagle` (`service_pistol`)
 * - Uses real Poly Haven metallic PBR normal maps + glowing Holo/Scope reticle glass on all tactical weapons
 * - Exposes `boltNode` and `magNode` for live recoil bolt cycling and drop-in reload animations
 */
export function assembleWeaponMesh(
  scene: Scene,
  config: PlayerWeaponConfig,
  idSuffix = "vm",
  modelCache?: ModelAssetCache,
  texGen?: PbrTextureGenerator
): AssembledWeapon {
  const { blueprint, equippedAttachments: attachments } = computeEffectiveWeaponStats(config.weaponId, config.attachments);
  const skin = SKIN_REGISTRY[config.skinId] ?? SKIN_REGISTRY.standard_issue;
  const firstPerson = idSuffix === "fp";

  const root = new TransformNode(`weapon_${blueprint.id}_${idSuffix}`, scene);
  const meshes: Mesh[] = [];

  const matPrimary = buildZoneMaterial(scene, `Mat_Body_Primary_${idSuffix}`, skin.materials.primary, texGen);
  const matSecondary = buildZoneMaterial(scene, `Mat_Metal_Secondary_${idSuffix}`, skin.materials.secondary, texGen);
  const matAccent = buildZoneMaterial(scene, `Mat_Grip_Accent_${idSuffix}`, skin.materials.accent, texGen);

  const matDark = new PBRMaterial(`Mat_Dark_${idSuffix}`, scene);
  matDark.albedoColor = Color3.FromHexString("#14171b");
  matDark.metallic = 0.45;
  matDark.roughness = 0.52;
  matDark.environmentIntensity = 0.5;

  const glassMat = new PBRMaterial(`optic_glass_${idSuffix}`, scene);
  let dotMat: StandardMaterial | undefined;
  glassMat.albedoColor = new Color3(0.08, 0.25, 0.38);
  glassMat.alpha = 0.28;
  glassMat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
  glassMat.disableDepthWrite = true;
  glassMat.roughness = 0.04;
  glassMat.metallic = 0.15;

  const cat = blueprint.category;
  const isPistol = cat === "PISTOL";
  const isSniper = cat === "SNIPER";
  const isSmg = cat === "SMG";
  const isShotgun = cat === "SHOTGUN";
  const isAkm = blueprint.id === "akm";
  const isVector = blueprint.id === "vector";

  const bodyLen = isPistol ? 0.21 : isSniper ? 0.54 : isSmg ? 0.31 : isShotgun ? 0.44 : 0.40;
  const barrelLen = isPistol ? 0.13 : isSniper ? 0.58 : isSmg ? 0.17 : isShotgun ? 0.46 : 0.32;

  let proceduralGrips: { firing: Vector3; support: Vector3; eject: Vector3 } | null = null;
  let stockGrips: { firing: Vector3; support: Vector3 } | null = null;
  const boltNode = new TransformNode(`bolt_${idSuffix}`, scene);
  boltNode.parent = root;
  boltNode.position.set(0.022, 0.014, 0.045);

  const socketOptic = new TransformNode(`socket_optic_${idSuffix}`, scene);
  socketOptic.parent = root;
  socketOptic.position.set(0, 0.05, isPistol ? -0.02 : 0.01);

  const socketMuzzle = new TransformNode(`socket_muzzle_${idSuffix}`, scene);
  socketMuzzle.parent = root;
  socketMuzzle.position.set(0, 0.014, bodyLen * 0.5 + barrelLen);

  const socketUnderbarrel = new TransformNode(`socket_underbarrel_${idSuffix}`, scene);
  socketUnderbarrel.parent = root;
  socketUnderbarrel.position.set(0, -0.035, bodyLen * 0.5 + 0.11);

  const socketMag = new TransformNode(`socket_mag_${idSuffix}`, scene);
  socketMag.parent = root;
  socketMag.position.set(0, -0.042, isPistol ? -0.055 : 0.075);

  const magNode = new TransformNode(`mag_anim_${idSuffix}`, scene);
  magNode.parent = socketMag;

  // Check if a real photogrammetry glTF model is cached for Sniper / Pistol
  // The bundled pistol glTF is an exploded parts sheet (slide/frame/mag float apart), so pistols use the procedural build.
  const realKey = isSniper ? "sniper" : null;
  const realGlb = realKey ? modelCache?.instantiateRawModel(realKey, `glb_${idSuffix}`, skin.id !== "standard_issue") : null;

  if (realGlb) {
    realGlb.root.parent = root;
    realGlb.root.computeWorldMatrix(true);
    // Imported weapons can include a separate baked optic. It must not stack with a socket attachment.
    const bakedOptic = realGlb.root.getDescendants(false, (node) => node.name.endsWith("_scope"))[0];
    if (attachments.optic) bakedOptic?.setEnabled(false);
    const getWeaponBounds = () => realGlb.root.getHierarchyBoundingVectors(true, (mesh) =>
      !bakedOptic || (mesh !== bakedOptic && !mesh.isDescendantOf(bakedOptic))
    );
    const b = getWeaponBounds();
    const ext = b.max.subtract(b.min);
    const targetLen = isSniper ? 1.08 : 0.25;
    const maxDim = Math.max(ext.x, ext.y, ext.z, 0.001);
    const s = targetLen / maxDim;
    realGlb.root.scaling.setAll(s);
    // Align longest axis cleanly so barrel points along +Z in Babylon's left-handed frame
    if (ext.x >= ext.z && ext.x >= ext.y) {
      realGlb.root.rotation.y = isSniper ? Math.PI * 0.5 : -Math.PI * 0.5;
    } else if (isSniper) {
      realGlb.root.rotation.y = Math.PI;
    }

    for (const m of realGlb.meshes) m.computeWorldMatrix(true);
    const b2 = getWeaponBounds();
    const ctr2 = b2.min.add(b2.max).scale(0.5);
    realGlb.root.position.set(-ctr2.x, -ctr2.y - 0.01, -ctr2.z);

    for (const m of realGlb.meshes) m.computeWorldMatrix(true);
    const b3 = getWeaponBounds();
    for (const m of realGlb.meshes) {
      if (skin.id !== "standard_issue" && m.material instanceof PBRMaterial) {
        m.material.albedoColor = Color3.FromHexString(skin.materials.primary.baseColorHex ?? "#ffffff");
      }
    }
    if (isSniper) {
      // The imported rifle has a conventional wrist and a short wooden fore-end.
      const length = b3.max.z - b3.min.z;
      const height = b3.max.y - b3.min.y;
      stockGrips = {
        firing: new Vector3(b3.max.x * 0.46, b3.min.y + height * 0.48, b3.min.z + length * 0.236),
        support: new Vector3(0, b3.min.y + height * 0.53, b3.min.z + length * 0.45),
      };
      socketOptic.position.set(0, Math.max(0.032, b3.max.y), 0.01);
      socketMuzzle.position.set(0, 0.036, Math.max(0.42, b3.max.z - 0.05));
    } else {
      socketOptic.position.set(0, Math.max(0.045, b3.max.y), -0.01);
      socketMuzzle.position.set(0, 0.015, Math.max(0.11, b3.max.z - 0.01));
    }
  } else {
    const built = buildProceduralGun({
      scene,
      root,
      boltNode,
      magNode,
      idSuffix,
      weaponId: blueprint.id,
      category: cat,
      mats: { primary: matPrimary, secondary: matSecondary, accent: matAccent, dark: matDark },
      extendedMag: attachments.mag === "mag_extended_quick",
      hasOptic: Boolean(attachments.optic),
    });
    meshes.push(...built.meshes);
    socketOptic.position.set(0, built.railTop, 0.0);
    socketMuzzle.position.set(0, 0, built.muzzleZ);
    socketUnderbarrel.position.set(0, built.underbarrelY, built.underbarrelZ);
    socketMag.position.copyFrom(built.magSocket);
    boltNode.position.copyFrom(built.boltPos);
    proceduralGrips = {
      firing: built.firingGrip.clone(),
      support: built.supportGrip.clone(),
      eject: built.ejectPos.clone(),
    };
  }

  const addAttBox = (
    name: string,
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    mat: PBRMaterial | StandardMaterial,
    parentNode: TransformNode,
    rotX = 0
  ) => {
    const m = MeshBuilder.CreateBox(`${name}_${idSuffix}`, { width: w, height: h, depth: d }, scene);
    m.parent = parentNode;
    m.position.set(x, y, z);
    m.rotation.x = rotX;
    m.material = mat;
    m.isPickable = false;
    meshes.push(m);
  };

  const addOpticHousing = (name: string, height: number, innerRadius: number, profile: [number, number][]) => {
    const rear = profile[0][1];
    const front = profile[profile.length - 1][1];
    const shape = [
      new Vector3(innerRadius, rear, 0),
      ...profile.map(([outerRadius, z]) => new Vector3(outerRadius, z, 0)),
      new Vector3(innerRadius, front, 0),
      new Vector3(innerRadius, rear, 0),
    ];
    const housing = MeshBuilder.CreateLathe(`${name}_${idSuffix}`, {
      shape, tessellation: 24, sideOrientation: Mesh.DOUBLESIDE,
    }, scene);
    housing.parent = socketOptic;
    housing.rotation.x = Math.PI * 0.5;
    housing.position.y = height;
    housing.material = matPrimary;
    housing.isPickable = false;
    meshes.push(housing);
  };

  // Keep the optical bore open. First-person reticles are drawn in the HUD.
  let adsHeightOffset = 0.064;
  if (attachments.optic === "optic_red_dot") {
    const centerHeight = 0.026;
    addAttBox("rd_mount", 0.036, 0.012, 0.062, 0, 0.006, 0, matSecondary, socketOptic);
    addAttBox("rd_wall_l", 0.006, 0.034, 0.05, -0.018, 0.026, 0, matPrimary, socketOptic);
    addAttBox("rd_wall_r", 0.006, 0.034, 0.05, 0.018, 0.026, 0, matPrimary, socketOptic);
    addAttBox("rd_roof", 0.042, 0.006, 0.05, 0, 0.044, 0, matPrimary, socketOptic);
    if (!firstPerson) {
      addAttBox("rd_glass", 0.03, 0.028, 0.003, 0, centerHeight, 0.01, glassMat, socketOptic);
      dotMat = new StandardMaterial(`rd_dot_${idSuffix}`, scene);
      dotMat.emissiveColor = Color3.FromHexString("#ff2e4c");
      dotMat.disableLighting = true;
      const dot = MeshBuilder.CreateSphere(`rd_lens_${idSuffix}`, { diameter: 0.005 }, scene);
      dot.parent = socketOptic;
      dot.position.set(0, centerHeight, 0.008);
      dot.material = dotMat;
      dot.isPickable = false;
      meshes.push(dot);
    }
    adsHeightOffset = socketOptic.position.y + centerHeight;
  } else if (attachments.optic === "optic_2x_acog") {
    const centerHeight = 0.028;
    addAttBox("acog_mount", 0.032, 0.014, 0.075, 0, 0.007, 0, matSecondary, socketOptic);
    addOpticHousing("acog", centerHeight, 0.016, [[0.021, -0.0625], [0.021, 0.0625]]);
    adsHeightOffset = socketOptic.position.y + centerHeight;
  } else if (attachments.optic === "optic_6x_sniper") {
    const centerHeight = 0.022;
    for (const rz of [-0.04, 0.04]) {
      addAttBox(`s6x_base_${rz}`, 0.02, 0.012, 0.014, 0, 0.006, rz, matSecondary, socketOptic);
      const ring = MeshBuilder.CreateTorus(
        `s6x_ring_${rz}_${idSuffix}`,
        { diameter: 0.036, thickness: 0.007, tessellation: 16 },
        scene
      );
      ring.parent = socketOptic;
      ring.rotation.x = Math.PI * 0.5;
      ring.position.set(0, centerHeight, rz);
      ring.material = matSecondary;
      ring.isPickable = false;
      meshes.push(ring);
    }
    addOpticHousing("s6x_housing", centerHeight, 0.012, [
      [0.02, -0.12], [0.02, -0.08], [0.016, -0.06],
      [0.016, 0.055], [0.022, 0.09], [0.022, 0.14],
    ]);
    if (!firstPerson) {
      for (const z of [-0.118, 0.138]) {
        const lens = MeshBuilder.CreateCylinder(`s6x_lens_${z}_${idSuffix}`, {
          diameter: 0.024, height: 0.002, tessellation: 24,
        }, scene);
        lens.parent = socketOptic;
        lens.rotation.x = Math.PI * 0.5;
        lens.position.set(0, centerHeight, z);
        lens.material = glassMat;
        lens.isPickable = false;
        meshes.push(lens);
      }
    }
    adsHeightOffset = socketOptic.position.y + centerHeight;
  }

  const ejectNode = new TransformNode(`eject_${idSuffix}`, scene);
  ejectNode.parent = root;
  if (proceduralGrips) ejectNode.position.copyFrom(proceduralGrips.eject);
  else ejectNode.position.set(0.038, 0.018, 0.04);

  const muzzleTipNode = new TransformNode(`muzzle_tip_${idSuffix}`, scene);
  muzzleTipNode.parent = socketMuzzle;

  if (attachments.muzzle === "muzzle_suppressor") {
    const supp = MeshBuilder.CreateCylinder(
      `supp_${idSuffix}`,
      { diameter: 0.04, height: 0.17, tessellation: 14 },
      scene
    );
    supp.parent = socketMuzzle;
    supp.rotation.x = Math.PI * 0.5;
    supp.position.set(0, 0, 0.08);
    supp.material = matAccent;
    meshes.push(supp);
    muzzleTipNode.position.set(0, 0, 0.17);
  } else if (attachments.muzzle === "muzzle_compensator") {
    addAttBox("comp_body", 0.032, 0.03, 0.064, 0, 0, 0.032, matSecondary, socketMuzzle);
    muzzleTipNode.position.set(0, 0, 0.066);
  } else {
    muzzleTipNode.position.set(0, 0, 0.04);
  }

  if (attachments.underbarrel === "grip_vertical") {
    const vg = MeshBuilder.CreateCylinder(
      `vg_${idSuffix}`,
      { diameter: 0.028, height: 0.095, tessellation: 12 },
      scene
    );
    vg.parent = socketUnderbarrel;
    vg.position.set(0, -0.048, 0);
    vg.material = matAccent;
    meshes.push(vg);
  } else if (attachments.underbarrel === "grip_angled") {
    addAttBox("ag", 0.03, 0.034, 0.11, 0, -0.02, 0.01, matAccent, socketUnderbarrel, -0.35);
  }

  return {
    root,
    muzzleNode: muzzleTipNode,
    ejectNode,
    boltNode,
    magNode,
    firingGrip: stockGrips?.firing ?? proceduralGrips?.firing ?? new Vector3(0, -0.077, -bodyLen * 0.29),
    boltRestZ: boltNode.position.z,
    supportGrip: stockGrips?.support ?? (proceduralGrips
      ? new Vector3(
          proceduralGrips.support.x,
          attachments.underbarrel === "grip_vertical"
            ? socketUnderbarrel.position.y - 0.05
            : attachments.underbarrel === "grip_angled"
              ? socketUnderbarrel.position.y - 0.02
              : proceduralGrips.support.y,
          attachments.underbarrel ? socketUnderbarrel.position.z : proceduralGrips.support.z
        )
      : isPistol
      ? new Vector3(-0.021, -0.09, -0.045)
      : new Vector3(-0.022, attachments.underbarrel === "grip_vertical" ? -0.084 : -0.042, bodyLen * 0.5 + 0.11)),
    adsAlignOffset: new Vector3(0, -adsHeightOffset, 0.30),
    dispose: () => {
      realGlb?.dispose();
      for (const m of meshes) m.dispose();
      matPrimary.dispose();
      matSecondary.dispose();
      matAccent.dispose();
      matDark.dispose();
      glassMat.dispose();
      dotMat?.dispose();
      root.dispose();
    },
  };
}
