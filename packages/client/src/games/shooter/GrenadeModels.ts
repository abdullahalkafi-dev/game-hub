import { Color3, Mesh, MeshBuilder, PBRMaterial, Scene, Vector3 } from "@babylonjs/core";
import type { ThrowableType } from "@game/shared";

export interface GrenadeModel {
  /** Body mesh (pivot at the centre of mass); all details are children of it. */
  root: Mesh;
  lever: Mesh;
  ring: Mesh;
  pin: Mesh;
}

const materialCache = new WeakMap<Scene, Map<string, PBRMaterial>>();

function mat(scene: Scene, key: string, hex: string, metallic: number, roughness: number, emissiveHex?: string): PBRMaterial {
  let cache = materialCache.get(scene);
  if (!cache) {
    cache = new Map();
    materialCache.set(scene, cache);
  }
  const existing = cache.get(key);
  if (existing) return existing;
  const m = new PBRMaterial(`gren_mat_${key}`, scene);
  m.albedoColor = Color3.FromHexString(hex);
  m.metallic = metallic;
  m.roughness = roughness;
  m.environmentIntensity = 0.6;
  if (emissiveHex) m.emissiveColor = Color3.FromHexString(emissiveHex);
  cache.set(key, m);
  return m;
}

/**
 * Builds a recognisable hand-grenade silhouette:
 * - Frag: ribbed olive pineapple body, fuse neck, spoon lever, safety pin + pull ring
 * - Flashbang: steel perforated cylinder with a yellow band
 * - Smoke: grey canister with a coloured top cap
 * Materials are shared per scene, so dispose with `mesh.dispose(false, false)`.
 */
export function createGrenadeModel(scene: Scene, type: ThrowableType, name: string): GrenadeModel {
  const steel = mat(scene, "steel", "#8b9096", 0.9, 0.34);
  const darkSteel = mat(scene, "dark_steel", "#3b4046", 0.85, 0.42);

  let root: Mesh;
  let neckY: number;

  if (type === "frag") {
    const body = mat(scene, "frag_body", "#46592f", 0.15, 0.58);
    root = MeshBuilder.CreateSphere(`${name}_body`, { diameterX: 0.064, diameterY: 0.078, diameterZ: 0.064, segments: 12 }, scene);
    root.material = body;
    // Segmented ribs give the classic pineapple look.
    for (let i = 0; i < 4; i++) {
      const rib = MeshBuilder.CreateTorus(`${name}_rib_${i}`, { diameter: 0.063 - Math.abs(i - 1.5) * 0.006, thickness: 0.004, tessellation: 18 }, scene);
      rib.parent = root;
      rib.position.y = -0.024 + i * 0.016;
      rib.material = darkSteel;
      rib.isPickable = false;
    }
    neckY = 0.043;
  } else {
    const isFlash = type === "flashbang";
    root = MeshBuilder.CreateCylinder(`${name}_body`, { diameter: 0.054, height: 0.118, tessellation: 20 }, scene);
    root.material = isFlash ? mat(scene, "flash_body", "#6c7178", 0.8, 0.4) : mat(scene, "smoke_body", "#52606d", 0.35, 0.5);
    const band = MeshBuilder.CreateCylinder(`${name}_band`, { diameter: 0.0565, height: 0.022, tessellation: 20 }, scene);
    band.parent = root;
    band.position.y = 0.03;
    band.material = isFlash ? mat(scene, "flash_band", "#e9c46a", 0.2, 0.5) : mat(scene, "smoke_band", "#d1d5db", 0.2, 0.5);
    band.isPickable = false;
    const base = MeshBuilder.CreateCylinder(`${name}_base`, { diameter: 0.0565, height: 0.008, tessellation: 20 }, scene);
    base.parent = root;
    base.position.y = -0.056;
    base.material = darkSteel;
    base.isPickable = false;
    neckY = 0.062;
  }
  root.isPickable = false;

  const neck = MeshBuilder.CreateCylinder(`${name}_neck`, { diameter: 0.026, height: 0.026, tessellation: 12 }, scene);
  neck.parent = root;
  neck.position.y = neckY;
  neck.material = darkSteel;
  neck.isPickable = false;

  const head = MeshBuilder.CreateBox(`${name}_fuse`, { width: 0.032, height: 0.014, depth: 0.02 }, scene);
  head.parent = root;
  head.position.y = neckY + 0.018;
  head.material = steel;
  head.isPickable = false;

  // Safety lever (spoon) wrapping down the side of the body.
  const lever = MeshBuilder.CreateBox(`${name}_lever`, { width: 0.004, height: neckY + 0.012 + 0.045, depth: 0.02 }, scene);
  lever.parent = root;
  lever.position.set(0.0285, neckY * 0.5 - 0.012, 0);
  lever.rotation.z = type === "frag" ? -0.08 : 0;
  lever.material = steel;
  lever.isPickable = false;

  // Safety pin and pull ring (pulled off when cooking starts).
  const pin = MeshBuilder.CreateCylinder(`${name}_pin`, { diameter: 0.0028, height: 0.03, tessellation: 6 }, scene);
  pin.parent = root;
  pin.position.set(0.0, neckY + 0.018, 0.0);
  pin.rotation.z = Math.PI / 2;
  pin.material = steel;
  pin.isPickable = false;

  const ring = MeshBuilder.CreateTorus(`${name}_ring`, { diameter: 0.034, thickness: 0.003, tessellation: 16 }, scene);
  ring.parent = root;
  ring.position.set(-0.026, neckY + 0.018, 0);
  ring.rotation.x = Math.PI / 2;
  ring.material = steel;
  ring.isPickable = false;

  return { root, lever, ring, pin };
}

export function grenadeTrailColor(type: ThrowableType): { c1: [number, number, number]; c2: [number, number, number] } {
  if (type === "smoke") return { c1: [0.8, 0.84, 0.9], c2: [0.55, 0.6, 0.66] };
  if (type === "flashbang") return { c1: [1, 0.95, 0.7], c2: [1, 0.85, 0.4] };
  return { c1: [0.75, 0.75, 0.72], c2: [0.45, 0.45, 0.42] };
}

export const GRENADE_SPIN_AXIS = new Vector3(1, 0.4, 0.7).normalize();
