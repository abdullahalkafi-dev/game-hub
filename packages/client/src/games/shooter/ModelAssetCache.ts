import "@babylonjs/loaders/glTF";
import {
  AnimationGroup,
  AssetContainer,
  Color3,
  Mesh,
  PBRMaterial,
  Scene,
  SceneLoader,
  ShadowGenerator,
  Skeleton,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import { SKIN_REGISTRY, skinModelKey, type Vec3 } from "@game/shared";

export type ModelAssetKey =
  | "soldier"
  | "valby"
  | "barrel"
  | "barrier"
  | "crate"
  | "hvac"
  | "sniper"
  | "pistol";

const MODEL_PATHS: Record<ModelAssetKey, { rootUrl: string; filename: string }> = {
  soldier: { rootUrl: "/assets/models/soldier/", filename: "Soldier.glb" },
  valby: { rootUrl: "/assets/models/characters/", filename: "valby_nano.glb" },
  barrel: { rootUrl: "/assets/models/Barrel_01/", filename: "Barrel_01.gltf" },
  barrier: { rootUrl: "/assets/models/concrete_road_barrier/", filename: "concrete_road_barrier.gltf" },
  crate: { rootUrl: "/assets/models/old_military_crate/", filename: "old_military_crate.gltf" },
  hvac: { rootUrl: "/assets/models/utility_box_01/", filename: "utility_box_01.gltf" },
  sniper: { rootUrl: "/assets/models/bolt_action_rifle_7_62/", filename: "bolt_action_rifle_7_62.gltf" },
  pistol: { rootUrl: "/assets/models/service_pistol/", filename: "service_pistol.gltf" },
};

export interface InstantiatedSoldier {
  root: TransformNode;
  meshes: Mesh[];
  skeletons: Skeleton[];
  animationGroups: AnimationGroup[];
}

export interface InstantiatedProp {
  root: TransformNode;
  meshes: Mesh[];
  dispose: () => void;
}

/**
 * Scene-scoped cache of preloaded CC0 `.gltf` / `.glb` AssetContainers.
 * Instantiates real 3D props, weapons, and skeletal soldiers at 0ms runtime load cost.
 */
export class ModelAssetCache {
  /** Static props are keyed by ModelAssetKey; imported weapon-skin models by skinModelKey(skinId). */
  private readonly containers = new Map<string, AssetContainer>();
  private readonly pendingLoads = new Map<string, Promise<boolean>>();

  constructor(private readonly scene: Scene) {}

  async preloadAll(keys?: ModelAssetKey[]): Promise<void> {
    const targets = keys ?? (Object.keys(MODEL_PATHS) as ModelAssetKey[]);
    await Promise.all(
      targets.map(async (key) => {
        if (this.containers.has(key)) return;
        const spec = MODEL_PATHS[key];
        try {
          const container = await SceneLoader.LoadAssetContainerAsync(
            spec.rootUrl,
            spec.filename,
            this.scene
          );
          this.containers.set(key, container);
        } catch (err) {
          console.warn(`[ModelAssetCache] Failed to load ${key}:`, err);
        }
      })
    );
  }

  has(key: string): boolean {
    return this.containers.has(key);
  }

  /**
   * Loads the imported models of the given weapon skins (all of them when no ids are given).
   * Resolves with the ids whose model is newly available, so callers can rebuild those weapons.
   * Safe to call repeatedly: each model is downloaded once.
   */
  async preloadSkinModels(skinIds?: Iterable<string>): Promise<string[]> {
    const ids = [...new Set(skinIds ?? Object.keys(SKIN_REGISTRY))].filter((id) => SKIN_REGISTRY[id]?.model);
    const loaded: string[] = [];
    await Promise.all(ids.map(async (id) => {
      const key = skinModelKey(id);
      if (this.containers.has(key)) return;
      const url = SKIN_REGISTRY[id].model!.url;
      let pending = this.pendingLoads.get(key);
      if (!pending) {
        const slash = url.lastIndexOf("/");
        pending = SceneLoader.LoadAssetContainerAsync(url.slice(0, slash + 1), url.slice(slash + 1), this.scene)
          .then((container) => {
            this.containers.set(key, container);
            return true;
          })
          .catch((error: unknown) => {
            console.warn("[ModelAssetCache] Failed to load weapon model " + url, error);
            return false;
          })
          .finally(() => this.pendingLoads.delete(key));
        this.pendingLoads.set(key, pending);
      }
      if (await pending) loaded.push(id);
    }));
    return loaded;
  }

  /**
   * Clones a prop model and auto-scales/centers it to match the exact Rapier collider `targetSize`.
   */
  instantiateBoxAlignedProp(
    key: ModelAssetKey,
    targetSize: Readonly<Vec3>,
    namePrefix: string,
    shadowGen?: ShadowGenerator,
    tintHex?: string
  ): InstantiatedProp | null {
    const container = this.containers.get(key);
    if (!container) return null;

    const entries = container.instantiateModelsToScene(
      (n) => `${namePrefix}_${n}`,
      Boolean(tintHex),
      { doNotInstantiate: true }
    );

    const holder = new TransformNode(`${namePrefix}_holder`, this.scene);
    const modelWrap = new TransformNode(`${namePrefix}_wrap`, this.scene);
    modelWrap.parent = holder;

    for (const rn of entries.rootNodes) {
      rn.parent = modelWrap;
    }

    holder.computeWorldMatrix(true);
    const bounds = modelWrap.getHierarchyBoundingVectors(true);
    const ext = bounds.max.subtract(bounds.min);
    const center = bounds.min.add(bounds.max).scale(0.5);

    const sx = ext.x > 0.001 ? targetSize.x / ext.x : 1;
    const sy = ext.y > 0.001 ? targetSize.y / ext.y : 1;
    const sz = ext.z > 0.001 ? targetSize.z / ext.z : 1;

    modelWrap.scaling.set(sx, sy, sz);
    modelWrap.position.set(-center.x * sx, -center.y * sy, -center.z * sz);

    const meshes: Mesh[] = [];
    for (const m of holder.getChildMeshes()) {
      const mesh = m as Mesh;
      mesh.isPickable = true;
      mesh.receiveShadows = true;
      shadowGen?.addShadowCaster(mesh);
      if (tintHex && mesh.material instanceof PBRMaterial) {
        mesh.material.albedoColor = Color3.FromHexString(tintHex);
      }
      meshes.push(mesh);
    }

    return {
      root: holder,
      meshes,
      dispose: () => {
        for (const m of meshes) m.dispose();
        holder.dispose();
      },
    };
  }

  instantiateRawModel(
    key: string,
    namePrefix: string,
    cloneMaterials = false
  ): { root: TransformNode; meshes: Mesh[]; dispose: () => void } | null {
    const container = this.containers.get(key);
    if (!container) return null;

    const entries = container.instantiateModelsToScene(
      (n) => `${namePrefix}_${n}`,
      cloneMaterials,
      { doNotInstantiate: true }
    );

    const root = new TransformNode(`${namePrefix}_root`, this.scene);
    for (const rn of entries.rootNodes) {
      rn.parent = root;
    }
    const meshes = root.getChildMeshes() as Mesh[];
    for (const m of meshes) m.isPickable = false;
    const clonedMaterials = new Set(cloneMaterials ? meshes.map((m) => m.material).filter(Boolean) : []);

    return {
      root,
      meshes,
      dispose: () => {
        root.dispose();
        for (const material of clonedMaterials) material?.dispose();
      },
    };
  }

  instantiateSoldier(namePrefix: string, key: "soldier" | "valby" = "soldier"): InstantiatedSoldier | null {
    const container = this.containers.get(key);
    if (!container) return null;

    const entries = container.instantiateModelsToScene(
      (n) => `${namePrefix}_${n}`,
      false,
      { doNotInstantiate: true }
    );

    const root = new TransformNode(`${namePrefix}_soldier`, this.scene);
    for (const rn of entries.rootNodes) {
      rn.parent = root;
    }

    const meshes = root.getChildMeshes() as Mesh[];
    for (const m of meshes) {
      m.isPickable = false;
      m.receiveShadows = true;
    }

    return {
      root,
      meshes,
      skeletons: entries.skeletons,
      animationGroups: entries.animationGroups,
    };
  }

  dispose(): void {
    for (const c of this.containers.values()) {
      c.dispose();
    }
    this.containers.clear();
  }
}
