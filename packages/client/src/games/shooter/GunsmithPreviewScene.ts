import {
  ArcRotateCamera,
  Color3,
  Color4,
  DefaultRenderingPipeline,
  DirectionalLight,
  HemisphericLight,
  ImageProcessingConfiguration,
  MeshBuilder,
  PBRMaterial,
  PointLight,
  Scene,
  Vector3,
} from "@babylonjs/core";
import type { PlayerWeaponConfig } from "@game/shared";
import type { EngineApp } from "../../core/EngineApp.js";
import { ModelAssetCache } from "./ModelAssetCache.js";
import { PbrTextureGenerator } from "./PbrTextureGenerator.js";
import { assembleWeaponMesh, type AssembledWeapon } from "./WeaponAssembler.js";

/**
 * Interactive 3D Gunsmith Showcase Stage:
 * - Loads real `/assets/env/studio.env` HDR reflections & Poly Haven PBR models
 * - Supports click-drag orbit & scroll-wheel zoom around the customized weapon
 */
export class GunsmithPreviewScene {
  public readonly scene: Scene;
  private readonly camera: ArcRotateCamera;
  private readonly texGen: PbrTextureGenerator;
  private readonly modelCache: ModelAssetCache;
  private currentConfig: PlayerWeaponConfig;
  private weapon: AssembledWeapon | null = null;
  private rafId = 0;
  private active = false;
  private autoRotate = true;

  constructor(private readonly app: EngineApp, initialConfig: PlayerWeaponConfig) {
    this.currentConfig = initialConfig;
    this.scene = new Scene(app.engine);
    this.scene.clearColor = new Color4(0.035, 0.05, 0.09, 1);

    this.texGen = new PbrTextureGenerator(this.scene);
    this.scene.environmentTexture = this.texGen.createEnvironmentCubeTexture("GUNSMITH");
    this.scene.environmentIntensity = 0.72;

    this.modelCache = new ModelAssetCache(this.scene);

    this.camera = new ArcRotateCamera(
      "gunsmith_cam",
      -Math.PI * 0.36,
      Math.PI * 0.42,
      1.55,
      new Vector3(0, -0.03, 0.07),
      this.scene
    );
    this.camera.minZ = 0.03;
    this.camera.lowerRadiusLimit = 0.8;
    this.camera.upperRadiusLimit = 2.6;
    this.scene.activeCamera = this.camera;

    const pipeline = new DefaultRenderingPipeline("gs_pipe", true, this.scene, [this.camera]);
    pipeline.fxaaEnabled = true;
    pipeline.bloomEnabled = true;
    pipeline.bloomThreshold = 0.92;
    pipeline.bloomWeight = 0.14;
    pipeline.imageProcessingEnabled = true;
    pipeline.imageProcessing.toneMappingEnabled = true;
    pipeline.imageProcessing.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    pipeline.imageProcessing.exposure = 1.02;
    pipeline.imageProcessing.contrast = 1.18;

    const hemi = new HemisphericLight("gs_hemi", new Vector3(0, 1, 0), this.scene);
    hemi.intensity = 0.55;
    hemi.diffuse = Color3.FromHexString("#e2e8f0");
    hemi.groundColor = Color3.FromHexString("#1e293b");

    const key = new DirectionalLight("gs_key", new Vector3(0.4, -0.5, -0.75), this.scene);
    key.intensity = 1.15;
    key.diffuse = Color3.FromHexString("#fff7ed");

    const frontFill = new PointLight("gs_front_fill", new Vector3(-0.9, 0.45, 0.9), this.scene);
    frontFill.diffuse = Color3.FromHexString("#e2e8f0");
    frontFill.intensity = 0.85;

    const rim = new PointLight("gs_rim", new Vector3(1.1, 0.6, -0.9), this.scene);
    rim.diffuse = Color3.FromHexString("#38bdf8");
    rim.intensity = 1.25;

    const pedestal = MeshBuilder.CreateCylinder(
      "gs_pedestal",
      { diameter: 1.05, height: 0.04, tessellation: 36 },
      this.scene
    );
    pedestal.position.set(0, -0.22, 0.05);
    const pMat = new PBRMaterial("gs_ped_mat", this.scene);
    this.texGen.applyRealPbrToMaterial(pMat, "metal_plate_02", 2, 2, "#1e293b");
    pedestal.material = pMat;

    this.setWeaponConfig(initialConfig);

    void this.modelCache.preloadAll(["sniper", "pistol"]).then(() => {
      if (this.active) {
        this.setWeaponConfig(this.currentConfig);
      }
    });
  }

  setWeaponConfig(config: PlayerWeaponConfig): void {
    this.currentConfig = config;
    this.weapon?.dispose();
    this.weapon = assembleWeaponMesh(this.scene, config, "gs", this.modelCache, this.texGen);
    this.weapon.root.scaling.setAll(1.3);
    this.weapon.root.position.set(0, 0.02, -0.04);
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.app.setScene(this.scene);
    this.camera.attachControl(this.app.canvas, true);

    let lastTime = performance.now();
    const loop = (now: number) => {
      if (!this.active) return;
      this.rafId = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - lastTime) / 1000);
      lastTime = now;
      if (this.weapon && this.autoRotate) {
        this.weapon.root.rotation.y += dt * 0.42;
      }
      this.scene.render();
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    this.active = false;
    this.camera.detachControl();
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  dispose(): void {
    this.stop();
    this.weapon?.dispose();
    this.modelCache.dispose();
    this.texGen.dispose();
    this.scene.dispose();
  }
}
