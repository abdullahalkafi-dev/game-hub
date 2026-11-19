import { initRapier } from "@game/shared";

export type LoadStage = "CACHE" | "POOLS" | "SHADERS" | "READY";

interface AssetManifest {
  env: string[];
  textures: Record<string, Record<string, string>>;
  models: Record<string, { main?: string; dir?: string; file?: string }>;
}

interface GltfDependencies {
  buffers?: { uri?: string }[];
  images?: { uri?: string }[];
}

/** Warms the browser's HTTP cache with the same URLs used by Babylon's loaders. */
export class AssetManager {
  private readonly progressListeners = new Set<(pct: number) => void>();
  private preload: Promise<boolean> | null = null;
  private progress = 0;

  async preloadArena(onProgress?: (pct: number) => void): Promise<boolean> {
    if (onProgress) {
      this.progressListeners.add(onProgress);
      onProgress(this.progress);
    }
    this.preload ??= this.fetchArenaAssets();
    try {
      return await this.preload;
    } finally {
      if (onProgress) this.progressListeners.delete(onProgress);
    }
  }

  private async fetchArenaAssets(): Promise<boolean> {
    try {
      const response = await this.fetchAsset("/assets/asset-manifest.json");
      const manifest = (await response.json()) as AssetManifest;
      const models = Object.values(manifest.models).map((model) => model.main ?? `${model.dir}${model.file}`);
      const paths = new Set([
        ...manifest.env.filter((path) => path !== "env/studio.env"),
        ...Object.values(manifest.textures).flatMap((texture) => Object.values(texture)),
        ...models,
      ]);
      const jobs = [...paths];
      let completed = 0;
      let failed = false;
      const workers = Array.from({ length: 5 }, async () => {
        for (let path = jobs.shift(); path !== undefined; path = jobs.shift()) {
          try {
            const url = `/assets/${path}`;
            const asset = await this.fetchAsset(url);
            if (path.endsWith(".gltf")) {
              const gltf = (await asset.json()) as GltfDependencies;
              const base = new URL(url, location.origin);
              const dependencies = [...(gltf.buffers ?? []), ...(gltf.images ?? [])];
              for (const { uri } of dependencies) {
                if (!uri || uri.startsWith("data:")) continue;
                const dependency = new URL(uri, base);
                const relativePath = dependency.pathname.slice("/assets/".length);
                if (dependency.origin !== location.origin || !dependency.pathname.startsWith("/assets/") || paths.has(relativePath)) continue;
                paths.add(relativePath);
                jobs.push(relativePath);
              }
            } else {
              await asset.arrayBuffer();
            }
          } catch {
            failed = true;
          }
          completed++;
          this.progress = Math.min(99, Math.max(this.progress, Math.round(completed * 100 / paths.size)));
          for (const listener of this.progressListeners) listener(this.progress);
        }
      });
      await Promise.all(workers);
      if (failed) return false;
      this.progress = 100;
      for (const listener of this.progressListeners) listener(100);
      return true;
    } catch {
      return false;
    }
  }

  private async fetchAsset(url: string): Promise<Response> {
    const response = await fetch(url, { cache: "force-cache", signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`Asset request failed (${response.status}).`);
    return response;
  }

  async prepareMatchStage1And2(onStage: (stage: LoadStage, pct: number, detail: string) => void): Promise<void> {
    const physics = initRapier();
    const preloaded = await this.preloadArena((pct) => {
      onStage("CACHE", 10 + Math.round(pct * 0.48), `Preloading arena models and textures · ${pct}%`);
    });
    onStage("POOLS", 65, preloaded ? "Initializing movement and collision…" : "Loading remaining assets on demand…");
    await physics;
  }
}
