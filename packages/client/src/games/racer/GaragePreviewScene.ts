import {
  ArcRotateCamera,
  Color3,
  Color4,
  DefaultRenderingPipeline,
  DirectionalLight,
  DynamicTexture,
  HemisphericLight,
  ImageProcessingConfiguration,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  PointLight,
  Scene,
  ShadowGenerator,
  StandardMaterial,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import {
  defaultCarSetup,
  getLiveryDefinition,
  getUnderglowDefinition,
  getVehicleDefinition,
  sanitizeCarSetup,
  type CarSetupConfig,
} from "@game/shared";
import type { EngineApp } from "../../core/EngineApp.js";
import type { EngineAudioSynth } from "./EngineAudioSynth.js";
import { RaceAssetCache, type CarVisualRig } from "./RaceAssetCache.js";

interface ShowroomRevFlame {
  pivot: TransformNode;
  outer: Mesh;
  inner: Mesh;
}

export type GarageCarSetupInput = Partial<{
  vehicleId: string;
  liveryId: string;
  tuneId: string;
  spoilerId: string;
  rimId: string;
  underglowId: string;
  transmission: string;
}>;

/**
 * Interactive 3D Automotive Showroom for ApexDrive Street Racer:
 * - Drag-to-orbit & scroll-zoom ArcRotateCamera with gentle turntable auto-orbit that pauses on drag
 * - Glossy reflective showroom floor, beveled turntable platform, overhead LED softbox strips & studio HDR IBL
 * - Real-time car archetype, clearcoat livery, rim, spoiler & underglow preview
 * - Interactive `triggerRevPreview()` firing animated exhaust flames, chassis torque kick & Web Audio rev burst
 */
export class GaragePreviewScene {
  public readonly scene: Scene;
  public readonly camera: ArcRotateCamera;
  public readonly assets: RaceAssetCache;

  private readonly shadowGen: ShadowGenerator;
  private readonly pipeline: DefaultRenderingPipeline;
  private readonly turntableRoot: TransformNode;
  private readonly ringAccentMat: StandardMaterial;
  private readonly revFlames: ShowroomRevFlame[] = [];
  private readonly revFlameOuterMat: StandardMaterial;
  private readonly revFlameInnerMat: StandardMaterial;
  private readonly revLight: PointLight;

  private currentSetup: CarSetupConfig;
  private carRig: CarVisualRig | null = null;
  private active = false;
  private rafId = 0;

  private isDragging = false;
  private idleSinceDragSec = 99;
  private autoOrbitEnabled = true;

  private revTimer = 0;
  private revDuration = 0.85;
  private revClock = 0;

  private onPointerDownBound: (() => void) | null = null;
  private onPointerUpBound: (() => void) | null = null;
  private onWheelBound: (() => void) | null = null;

  constructor(
    private readonly app: EngineApp,
    initialSetup?: GarageCarSetupInput,
    private readonly audio?: EngineAudioSynth
  ) {
    this.currentSetup = sanitizeCarSetup((initialSetup ?? defaultCarSetup()) as Partial<CarSetupConfig>);
    this.scene = new Scene(app.engine);
    this.scene.clearColor = new Color4(0.028, 0.04, 0.072, 1);
    this.scene.fogMode = Scene.FOGMODE_EXP2;
    this.scene.fogDensity = 0.016;
    this.scene.fogColor = Color3.FromHexString("#070b14");

    this.assets = new RaceAssetCache(this.scene);
    this.scene.environmentTexture = this.assets.getEnvironmentTexture("GARAGE");
    this.scene.environmentIntensity = 1.05;

    // Front-3/4 hero framing (car nose faces +Z, right is +X -> alpha ~0.27*PI shows nose & side!)
    this.camera = new ArcRotateCamera(
      "garage_showroom_cam",
      Math.PI * 0.27,
      Math.PI * 0.415,
      7.6,
      new Vector3(0, 0.56, 0.12),
      this.scene
    );
    this.camera.minZ = 0.08;
    this.camera.maxZ = 140;
    this.camera.lowerRadiusLimit = 3.6;
    this.camera.upperRadiusLimit = 10.8;
    this.camera.lowerBetaLimit = 0.26;
    this.camera.upperBetaLimit = Math.PI * 0.482;
    this.camera.wheelPrecision = 26;
    this.camera.pinchPrecision = 40;
    this.camera.inertia = 0.82;
    this.camera.panningSensibility = 0; // Keep car centered on turntable
    this.scene.activeCamera = this.camera;

    // Post-processing: ACES tone mapping + FXAA + balanced studio bloom
    this.pipeline = new DefaultRenderingPipeline("garage_pipe", true, this.scene, [this.camera]);
    this.pipeline.fxaaEnabled = true;
    this.pipeline.imageProcessingEnabled = true;
    this.pipeline.imageProcessing.toneMappingEnabled = true;
    this.pipeline.imageProcessing.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    this.pipeline.imageProcessing.exposure = 1.06;
    this.pipeline.imageProcessing.contrast = 1.18;
    this.pipeline.bloomEnabled = true;
    this.pipeline.bloomThreshold = 0.88;
    this.pipeline.bloomWeight = 0.24;
    this.pipeline.bloomKernel = 48;

    // Automotive Studio 4-Point Lighting Rig
    const hemi = new HemisphericLight("garage_hemi", new Vector3(0, 1, 0), this.scene);
    hemi.intensity = 0.48;
    hemi.diffuse = Color3.FromHexString("#dbeafe");
    hemi.groundColor = Color3.FromHexString("#111827");

    const keyLight = new DirectionalLight("garage_key", new Vector3(-0.35, -0.82, -0.45).normalize(), this.scene);
    keyLight.position = new Vector3(6, 12, 7);
    keyLight.intensity = 1.85;
    keyLight.diffuse = Color3.FromHexString("#fff8ee");
    keyLight.specular = Color3.FromHexString("#ffffff");

    this.shadowGen = new ShadowGenerator(1024, keyLight);
    this.shadowGen.usePercentageCloserFiltering = true;
    this.shadowGen.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
    this.shadowGen.bias = 0.0005;

    const rimCyan = new PointLight("garage_rim_cyan", new Vector3(-5.8, 3.2, -4.8), this.scene);
    rimCyan.diffuse = Color3.FromHexString("#38bdf8");
    rimCyan.intensity = 16;
    rimCyan.range = 24;

    const fillWarm = new PointLight("garage_fill_warm", new Vector3(5.6, 2.6, 4.6), this.scene);
    fillWarm.diffuse = Color3.FromHexString("#ffe4c4");
    fillWarm.intensity = 11;
    fillWarm.range = 22;

    // Showroom Architecture: Glossy floor, turntable deck, cyclorama wall & overhead LED softboxes
    this.turntableRoot = new TransformNode("garage_turntable_root", this.scene);
    this.ringAccentMat = this.buildShowroomEnvironment();

    // Exhaust Rev Flame Cones + Tail Glow Light
    this.revFlameOuterMat = new StandardMaterial("garage_rev_outer_mat", this.scene);
    this.revFlameOuterMat.emissiveColor = Color3.FromHexString("#ff7a18");
    this.revFlameOuterMat.disableLighting = true;
    this.revFlameOuterMat.alpha = 0.9;
    this.revFlameOuterMat.alphaMode = 1;
    this.revFlameOuterMat.backFaceCulling = false;

    this.revFlameInnerMat = new StandardMaterial("garage_rev_inner_mat", this.scene);
    this.revFlameInnerMat.emissiveColor = Color3.FromHexString("#8be9ff");
    this.revFlameInnerMat.disableLighting = true;
    this.revFlameInnerMat.alpha = 0.95;
    this.revFlameInnerMat.alphaMode = 1;
    this.revFlameInnerMat.backFaceCulling = false;

    for (let i = 0; i < 4; i++) {
      const pivot = new TransformNode(`garage_rev_pivot_${i}`, this.scene);
      const outer = MeshBuilder.CreateCylinder(
        `garage_rev_outer_${i}`,
        { diameterTop: 0.01, diameterBottom: 0.24, height: 0.85, tessellation: 12 },
        this.scene
      );
      outer.parent = pivot;
      outer.rotation.x = Math.PI / 2;
      outer.position.z = 0.425;
      outer.material = this.revFlameOuterMat;
      outer.isPickable = false;
      outer.setEnabled(false);

      const inner = MeshBuilder.CreateCylinder(
        `garage_rev_inner_${i}`,
        { diameterTop: 0.008, diameterBottom: 0.12, height: 0.52, tessellation: 10 },
        this.scene
      );
      inner.parent = pivot;
      inner.rotation.x = Math.PI / 2;
      inner.position.z = 0.26;
      inner.material = this.revFlameInnerMat;
      inner.isPickable = false;
      inner.setEnabled(false);

      this.revFlames.push({ pivot, outer, inner });
    }

    this.revLight = new PointLight("garage_rev_light", new Vector3(0, 0.4, -2.5), this.scene);
    this.revLight.diffuse = Color3.FromHexString("#ff8c24");
    this.revLight.intensity = 0;
    this.revLight.range = 8;

    // Build initial car immediately (sculpted fallback first, then auto-upgrades once ferrari.glb finishes preloading!)
    this.rebuildCarRig();
    this.syncTurntableAccent();

  }

  private buildShowroomEnvironment(): StandardMaterial {
    // 1. Glossy dark reflective showroom floor with subtle geometric radial grid
    const floorTex = new DynamicTexture("garage_floor_tex", { width: 1024, height: 1024 }, this.scene, true);
    const g = floorTex.getContext();
    g.fillStyle = "#0b0f18";
    g.fillRect(0, 0, 1024, 1024);

    // Subtle showroom architectural seam grid
    g.strokeStyle = "rgba(148,163,184,0.08)";
    g.lineWidth = 2;
    for (let x = 0; x <= 1024; x += 64) {
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, 1024);
      g.stroke();
      g.beginPath();
      g.moveTo(0, x);
      g.lineTo(1024, x);
      g.stroke();
    }
    // Subtle dark radial vignette center
    const rad = g.createRadialGradient(512, 512, 80, 512, 512, 500);
    rad.addColorStop(0, "rgba(30,45,75,0.22)");
    rad.addColorStop(1, "rgba(4,6,12,0.55)");
    g.fillStyle = rad;
    g.fillRect(0, 0, 1024, 1024);
    floorTex.update(true);
    floorTex.anisotropicFilteringLevel = 8;

    const floorMat = new PBRMaterial("garage_floor_mat", this.scene);
    floorMat.albedoTexture = floorTex;
    floorMat.roughness = 0.14;
    floorMat.metallic = 0.42;
    floorMat.environmentIntensity = 1.2;
    floorMat.clearCoat.isEnabled = true;
    floorMat.clearCoat.intensity = 0.72;
    floorMat.clearCoat.roughness = 0.08;

    const floor = MeshBuilder.CreateDisc("garage_floor", { radius: 34, tessellation: 48 }, this.scene);
    floor.rotation.x = Math.PI / 2;
    floor.position.y = -0.095;
    floor.material = floorMat;
    floor.receiveShadows = true;
    floor.isPickable = false;

    // 2. Elevated Circular Brushed-Carbon Turntable Pedestal (flush with car tires at y = 0!)
    const deckMat = new PBRMaterial("garage_deck_mat", this.scene);
    deckMat.albedoColor = Color3.FromHexString("#141923");
    deckMat.roughness = 0.2;
    deckMat.metallic = 0.58;
    deckMat.clearCoat.isEnabled = true;
    deckMat.clearCoat.intensity = 0.55;
    deckMat.clearCoat.roughness = 0.12;

    const deck = MeshBuilder.CreateCylinder(
      "garage_turntable_deck",
      { diameterTop: 6.9, diameterBottom: 7.3, height: 0.09, tessellation: 64 },
      this.scene
    );
    deck.position.y = -0.045;
    deck.material = deckMat;
    deck.receiveShadows = true;
    deck.isPickable = false;

    // Glowing perimeter LED ring around the turntable platform
    const ringMat = new StandardMaterial("garage_turntable_ring_mat", this.scene);
    ringMat.emissiveColor = Color3.FromHexString("#00f0ff").scale(1.4);
    ringMat.disableLighting = true;

    const ring = MeshBuilder.CreateTorus(
      "garage_turntable_ring",
      { diameter: 7.12, thickness: 0.055, tessellation: 64 },
      this.scene
    );
    ring.position.y = -0.02;
    ring.material = ringMat;
    ring.isPickable = false;

    // 3. Curved Studio Cyclorama Wall around the showroom perimeter
    const wallMat = new PBRMaterial("garage_wall_mat", this.scene);
    wallMat.albedoColor = Color3.FromHexString("#0a101d");
    wallMat.roughness = 0.85;
    wallMat.metallic = 0.12;
    wallMat.backFaceCulling = false;

    const wall = MeshBuilder.CreateCylinder(
      "garage_cyclorama",
      { diameter: 42, height: 14, tessellation: 48, sideOrientation: Mesh.BACKSIDE },
      this.scene
    );
    wall.position.y = 6.8;
    wall.material = wallMat;
    wall.isPickable = false;

    // 4. Overhead Studio LED Softbox Light Strips (creates authentic automotive paint specular highlights!)
    const softboxMat = new StandardMaterial("garage_softbox_mat", this.scene);
    softboxMat.emissiveColor = new Color3(1.55, 1.62, 1.78);
    softboxMat.disableLighting = true;
    softboxMat.backFaceCulling = false;

    const housingMat = new PBRMaterial("garage_softbox_housing", this.scene);
    housingMat.albedoColor = Color3.FromHexString("#111622");
    housingMat.roughness = 0.5;
    housingMat.metallic = 0.7;

    const stripConfigs = [
      { x: 0, y: 4.9, z: 0, w: 1.15, d: 6.2, rz: 0 },
      { x: -2.4, y: 4.55, z: 0, w: 0.65, d: 5.6, rz: -0.22 },
      { x: 2.4, y: 4.55, z: 0, w: 0.65, d: 5.6, rz: 0.22 },
    ];
    for (let i = 0; i < stripConfigs.length; i++) {
      const sc = stripConfigs[i];
      const box = MeshBuilder.CreateBox(
        `garage_softbox_frame_${i}`,
        { width: sc.w + 0.16, height: 0.14, depth: sc.d + 0.16 },
        this.scene
      );
      box.position.set(sc.x, sc.y + 0.08, sc.z);
      box.rotation.z = sc.rz;
      box.material = housingMat;
      box.isPickable = false;

      const emitter = MeshBuilder.CreatePlane(
        `garage_softbox_emit_${i}`,
        { width: sc.w, height: sc.d },
        this.scene
      );
      emitter.rotation.x = -Math.PI / 2;
      emitter.rotation.z = sc.rz;
      emitter.position.set(sc.x, sc.y, sc.z);
      emitter.material = softboxMat;
      emitter.isPickable = false;
    }

    // Subtle vertical studio light columns along the back cyclorama
    const accentColMat = new StandardMaterial("garage_accent_col_mat", this.scene);
    accentColMat.emissiveColor = Color3.FromHexString("#38bdf8").scale(0.85);
    accentColMat.disableLighting = true;

    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * Math.PI * 2 + 0.2;
      const col = MeshBuilder.CreateBox(`garage_bg_pillar_${i}`, { width: 0.16, height: 7.5, depth: 0.16 }, this.scene);
      col.position.set(Math.cos(ang) * 18.5, 3.7, Math.sin(ang) * 18.5);
      col.material = accentColMat;
      col.isPickable = false;
    }

    return ringMat;
  }

  private rebuildCarRig(): void {
    this.carRig?.dispose();
    const livery = getLiveryDefinition(this.currentSetup.liveryId);
    const underglow = getUnderglowDefinition(this.currentSetup.underglowId);

    this.carRig = this.assets.buildCarRig({
      vehicleId: this.currentSetup.vehicleId,
      livery,
      spoilerId: this.currentSetup.spoilerId,
      rimId: this.currentSetup.rimId,
      underglowHex: underglow.hex,
      isNight: true, // Showroom highlights crisp headlights & subtle tail LEDs!
      shadowGen: this.shadowGen,
      idSuffix: "garage",
    });
    this.carRig.root.parent = this.turntableRoot;
    this.carRig.setHeadlights(true);
    this.carRig.setBrakeLight(0.18);
    this.carRig.setUnderglow(underglow.hex);
  }

  private syncTurntableAccent(): void {
    const underglow = getUnderglowDefinition(this.currentSetup.underglowId);
    const hex = underglow.hex ?? "#38bdf8";
    this.ringAccentMat.emissiveColor = Color3.FromHexString(hex).scale(1.35);
  }

  /**
   * Live-updates the displayed 3D car setup.
   * Swaps paint/rim/underglow instantaneously in-place; rebuilds geometry cleanly when archetype or spoiler changes.
   */
  setCarSetup(setup: GarageCarSetupInput): void {
    const next = sanitizeCarSetup({ ...this.currentSetup, ...(setup as Partial<CarSetupConfig>) });
    const needsRebuild =
      !this.carRig ||
      next.vehicleId !== this.currentSetup.vehicleId ||
      next.spoilerId !== this.currentSetup.spoilerId;

    this.currentSetup = next;

    if (needsRebuild) {
      this.rebuildCarRig();
    } else if (this.carRig) {
      const livery = getLiveryDefinition(next.liveryId);
      const underglow = getUnderglowDefinition(next.underglowId);
      this.carRig.applyLivery(livery, next.rimId);
      this.carRig.setUnderglow(underglow.hex);
    }

    this.syncTurntableAccent();
  }

  getCarSetup(): CarSetupConfig {
    return { ...this.currentSetup };
  }

  /**
   * Blips dramatic exhaust backfire flames on the 3D showroom car, shakes chassis torque,
   * and triggers `EngineAudioSynth.playRevBurst(...)` for the currently selected car!
   */
  triggerRevPreview(): void {
    this.revTimer = this.revDuration;
    const vehicle = getVehicleDefinition(this.currentSetup.vehicleId);
    if (this.audio) {
      this.audio.unlock();
      this.audio.playRevBurst(vehicle.engineAudioProfile);
    }
  }

  setAutoOrbit(enabled: boolean): void {
    this.autoOrbitEnabled = enabled;
  }

  async preloadAssets(onProgress?: (pct: number, detail: string) => void): Promise<void> {
    onProgress?.(15, "Loading the 3D showroom");
    await this.assets.preload("GARAGE");
    if (!this.scene.isDisposed && this.currentSetup.vehicleId === "apex_gt" && this.assets.hasFerrariModel()) {
      this.rebuildCarRig();
    }
    onProgress?.(100, "Showroom ready");
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.app.setScene(this.scene);
    this.camera.attachControl(this.app.canvas, true);

    this.onPointerDownBound = () => {
      this.isDragging = true;
      this.idleSinceDragSec = 0;
    };
    this.onPointerUpBound = () => {
      this.isDragging = false;
      this.idleSinceDragSec = 0;
    };
    this.onWheelBound = () => {
      this.idleSinceDragSec = 0;
    };

    this.app.canvas.addEventListener("pointerdown", this.onPointerDownBound);
    window.addEventListener("pointerup", this.onPointerUpBound);
    window.addEventListener("pointercancel", this.onPointerUpBound);
    this.app.canvas.addEventListener("wheel", this.onWheelBound, { passive: true });

    let lastTime = performance.now();
    const loop = (now: number) => {
      if (!this.active) return;
      this.rafId = requestAnimationFrame(loop);
      const dt = Math.min(0.05, Math.max(0.001, (now - lastTime) / 1000));
      lastTime = now;

      this.updateFrame(dt);
      this.scene.render();
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private updateFrame(dt: number): void {
    if (!this.isDragging) {
      this.idleSinceDragSec += dt;
      if (this.autoOrbitEnabled && this.idleSinceDragSec > 1.8) {
        this.camera.alpha += dt * 0.22;
      }
    }

    // Rev preview exhaust flame & engine torque animation
    if (this.revTimer > 0 && this.carRig) {
      this.revTimer = Math.max(0, this.revTimer - dt);
      this.revClock += dt;
      const progress = 1 - this.revTimer / this.revDuration;

      // Engine torque kick during initial rev surge + crisp backfire flash on decel lift (~0.45..0.82)
      const torqueEnv = Math.sin(Math.min(1, progress * 1.4) * Math.PI);
      const vibe = Math.sin(this.revClock * 92) * 0.009 * torqueEnv;
      this.carRig.chassisNode.rotation.z = torqueEnv * 0.022 + vibe;
      this.carRig.chassisNode.rotation.x = -torqueEnv * 0.012;
      this.carRig.setBrakeLight(progress > 0.5 ? 0.85 : 0.25);

      // Flame flashes during peak blip & overrun pop
      const flashA = progress > 0.18 && progress < 0.36 ? Math.sin(((progress - 0.18) / 0.18) * Math.PI) : 0;
      const flashB = progress > 0.52 && progress < 0.82 ? Math.sin(((progress - 0.52) / 0.3) * Math.PI) : 0;
      const flameStrength = Math.max(flashA * 0.85, flashB);

      const tips = this.carRig.exhaustTips;
      const flicker = 0.8 + Math.sin(this.revClock * 110) * 0.2;
      for (let i = 0; i < this.revFlames.length; i++) {
        const rf = this.revFlames[i];
        if (i < tips.length && flameStrength > 0.08) {
          const tipPos = tips[i].getAbsolutePosition();
          rf.pivot.position.copyFrom(tipPos);
          rf.pivot.lookAt(new Vector3(tipPos.x, tipPos.y, tipPos.z - 4));
          rf.outer.setEnabled(true);
          rf.inner.setEnabled(true);
          const s = (0.55 + flameStrength * 0.95) * flicker;
          rf.outer.scaling.set(s, s, 0.7 + flameStrength * 1.25);
          rf.inner.scaling.set(s * 0.85, s * 0.85, 0.65 + flameStrength * 1.05);
        } else {
          rf.outer.setEnabled(false);
          rf.inner.setEnabled(false);
        }
      }

      if (flameStrength > 0.08 && tips.length > 0) {
        const p = tips[0].getAbsolutePosition();
        this.revLight.position.set(p.x, p.y + 0.15, p.z - 0.6);
        this.revLight.intensity = 10 * flameStrength * flicker;
      } else {
        this.revLight.intensity = 0;
      }
    } else if (this.carRig) {
      this.carRig.chassisNode.rotation.z *= 0.85;
      this.carRig.chassisNode.rotation.x *= 0.85;
      this.carRig.setBrakeLight(0.18);
      this.revLight.intensity = 0;
      for (const rf of this.revFlames) {
        rf.outer.setEnabled(false);
        rf.inner.setEnabled(false);
      }
    }
  }

  stop(): void {
    this.active = false;
    this.isDragging = false;
    this.camera.detachControl();
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    if (this.onPointerDownBound) {
      this.app.canvas.removeEventListener("pointerdown", this.onPointerDownBound);
      this.onPointerDownBound = null;
    }
    if (this.onPointerUpBound) {
      window.removeEventListener("pointerup", this.onPointerUpBound);
      window.removeEventListener("pointercancel", this.onPointerUpBound);
      this.onPointerUpBound = null;
    }
    if (this.onWheelBound) {
      this.app.canvas.removeEventListener("wheel", this.onWheelBound);
      this.onWheelBound = null;
    }
  }

  dispose(): void {
    this.stop();
    this.carRig?.dispose();
    this.carRig = null;
    for (const rf of this.revFlames) {
      rf.outer.dispose();
      rf.inner.dispose();
      rf.pivot.dispose();
    }
    this.revFlames.length = 0;
    this.revFlameOuterMat.dispose();
    this.revFlameInnerMat.dispose();
    this.revLight.dispose();
    this.pipeline.dispose();
    this.shadowGen.dispose();
    this.assets.dispose();
    this.scene.dispose();
  }
}
