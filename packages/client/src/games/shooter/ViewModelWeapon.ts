import {
  Camera,
  Color3,
  DynamicTexture,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  PointLight,
  Quaternion,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import { damp, type EffectiveWeaponStats, type PlayerWeaponConfig, type ThrowableType } from "@game/shared";
import { createGrenadeModel, type GrenadeModel } from "./GrenadeModels.js";
import { FirstPersonArms } from "./FirstPersonArms.js";
import type { ModelAssetCache } from "./ModelAssetCache.js";
import type { PbrTextureGenerator } from "./PbrTextureGenerator.js";
import { assembleWeaponMesh, type AssembledWeapon } from "./WeaponAssembler.js";

function buildLimbSegment(
  scene: Scene,
  name: string,
  from: Vector3,
  to: Vector3,
  dStart: number,
  dEnd: number,
  mat: PBRMaterial,
  parent: TransformNode
): Mesh {
  const diff = to.subtract(from);
  const len = Math.max(0.05, diff.length());
  // Slightly bulged forearm profile: muscle belly near the elbow tapering to the wrist.
  const cyl = MeshBuilder.CreateLathe(
    name,
    { shape: [
      new Vector3(0, -0.5, 0), new Vector3(dEnd * 0.47, -0.5, 0),
      new Vector3(dEnd * 0.5, -0.38, 0), new Vector3(dEnd * 0.5, -0.2, 0),
      new Vector3(dStart * 0.5, 0.2, 0), new Vector3(dStart * 0.52, 0.36, 0),
      new Vector3(dStart * 0.46, 0.5, 0), new Vector3(0, 0.5, 0),
    ], tessellation: 20, sideOrientation: Mesh.DOUBLESIDE },
    scene
  );
  cyl.parent = parent;
  cyl.position.copyFrom(from.add(to).scale(0.5));
  cyl.scaling.y = len;

  const up = Vector3.Up();
  const dir = diff.normalize();
  const dot = Math.max(-1, Math.min(1, Vector3.Dot(up, dir)));
  const axis = Vector3.Cross(up, dir);
  cyl.rotationQuaternion = Quaternion.Identity();
  if (axis.lengthSquared() > 1e-6) {
    axis.normalize();
    cyl.rotationQuaternion = Quaternion.RotationAxis(axis, Math.acos(dot));
  }
  cyl.isPickable = false;
  cyl.material = mat;
  return cyl;
}

type GrenadeState = "none" | "cook" | "throw" | "cancel";

/**
 * First-Person Tactical Rig:
 * - Slim gloved forearms with fully wrapped, finger-by-finger hands anchored to the weapon's real grip points
 * - Tactical Sprint diagonal pose, ADS optic alignment, and Reload drop/slap sequence
 * - Held grenade rig: weapon lowers, safety pin is pulled, hand trembles while cooking, then a wind-up/throw
 * - Soft radial additive Muzzle Flash star sprite + dynamic point light
 */
export class ViewModelWeapon {
  private readonly holder: TransformNode;
  private readonly armsRoot: TransformNode;
  private readonly riggedArms: FirstPersonArms;
  private readonly knife: TransformNode;
  private shown = true;
  private inspectTimer = 0;
  private meleeTimer = 0;
  private breathClock = 0;
  private assembled: AssembledWeapon | null = null;
  private readonly flashPlanes: Mesh[] = [];
  private readonly muzzleFlashMat: StandardMaterial;
  private readonly flashTex: DynamicTexture;
  private readonly muzzleFlashLight: PointLight;
  private readonly sleeveMat: PBRMaterial;
  private readonly gloveMat: PBRMaterial;
  private readonly gloveArmorMat: PBRMaterial;
  private readonly watchMat: StandardMaterial;
  private readonly armMeshes: Mesh[] = [];
  private readonly firingHand: TransformNode;
  private readonly supportHand: TransformNode;
  private readonly magazineGrip = new Vector3();
  private readonly firingForearm: Mesh;
  private readonly supportForearm: Mesh;
  private readonly firingElbow = new Vector3(0.2, -0.36, -0.4);
  private readonly supportElbow = new Vector3(-0.2, -0.3, -0.02);
  private readonly firingWristOffset = new Vector3(0.036, -0.004, -0.068);
  private readonly supportWristOffset = new Vector3(-0.034, -0.024, -0.062);
  private readonly tmpWrist = new Vector3();
  private readonly limbAxis = new Vector3();
  private readonly up = Vector3.Up();
  private equipDip = 0;

  // grenade rig
  private readonly grenadeRig: TransformNode;
  private readonly grenadeRigMeshes: Mesh[] = [];
  private grenadeModel: GrenadeModel | null = null;
  private grenadeModelType: ThrowableType | null = null;
  private grenadeState: GrenadeState = "none";
  private grenadeT = 0;
  private grenadeLower = 0;
  private wasCooking = false;
  private throwQueued = false;
  private pinFlyT = -1;
  private pinReleased = false;
  private cookFraction = 0;

  private flashTimer = 0;
  private boltKick = 0;

  private hipPos = new Vector3(0.2, -0.19, 0.5);
  private currentPos = new Vector3(0.2, -0.19, 0.5);
  private swayX = 0;
  private swayY = 0;
  private kickZ = 0;
  private kickPitch = 0;
  private sprintAlpha = 0;
  private reloadDip = 0;

  constructor(
    private readonly scene: Scene,
    private readonly camera: Camera,
    private readonly modelCache?: ModelAssetCache,
    private readonly texGen?: PbrTextureGenerator
  ) {
    this.holder = new TransformNode("vm_holder", scene);
    this.holder.parent = camera;
    this.holder.position.copyFrom(this.hipPos);

    this.armsRoot = new TransformNode("vm_arms", scene);
    this.armsRoot.parent = this.holder;
    this.firingHand = new TransformNode("vm_firing_hand", scene);
    this.firingHand.parent = this.armsRoot;
    this.supportHand = new TransformNode("vm_support_hand", scene);
    this.supportHand.parent = this.armsRoot;

    this.sleeveMat = new PBRMaterial("vm_sleeve_mat", scene);
    this.sleeveMat.albedoColor = Color3.FromHexString("#343b2d");
    this.sleeveMat.roughness = 0.92;
    this.sleeveMat.metallic = 0.0;
    this.sleeveMat.environmentIntensity = 0.3;
    if (this.texGen) {
      const clothSet = this.texGen.getPbrTextureSet("concrete_wall_005", 8, 8);
      this.sleeveMat.bumpTexture = clothSet.bump;
      this.sleeveMat.bumpTexture.level = 0.3;
    }

    this.gloveMat = new PBRMaterial("vm_glove_mat", scene);
    this.gloveMat.albedoColor = Color3.FromHexString("#1a1e24");
    this.gloveMat.roughness = 0.7;
    this.gloveMat.metallic = 0.05;
    this.gloveMat.environmentIntensity = 0.35;
    this.gloveArmorMat = new PBRMaterial("vm_glove_armor", scene);
    this.gloveArmorMat.albedoColor = Color3.FromHexString("#4a545c");
    this.gloveArmorMat.roughness = 0.5;
    this.gloveArmorMat.metallic = 0.18;

    this.watchMat = new StandardMaterial("vm_watch_mat", scene);
    this.watchMat.diffuseColor = Color3.FromHexString("#0f172a");
    this.watchMat.emissiveColor = Color3.FromHexString("#0b2a3a");

    // Right arm: slim sleeve down to the wrist cuff.
    this.firingForearm = buildLimbSegment(scene, "vm_r_arm", this.firingElbow, new Vector3(0, -0.07, -0.09), 0.088, 0.062, this.sleeveMat, this.armsRoot);
    this.armMeshes.push(this.firingForearm);
    this.buildFiringHand();

    // Left arm: upper arm + forearm, elbow cap.
    this.supportForearm = buildLimbSegment(scene, "vm_l_fore", this.supportElbow, new Vector3(-0.02, -0.05, 0.2), 0.088, 0.062, this.sleeveMat, this.armsRoot);
    this.armMeshes.push(this.supportForearm);
    const elbowCap = MeshBuilder.CreateSphere("vm_l_elbow_cap", { diameter: 0.1, segments: 10 }, scene);
    elbowCap.parent = this.armsRoot;
    elbowCap.position.copyFrom(this.supportElbow);
    elbowCap.material = this.gloveArmorMat;
    elbowCap.isPickable = false;
    this.armMeshes.push(elbowCap);
    this.buildSupportHand();
    this.riggedArms = new FirstPersonArms(scene, this.holder);
    this.knife = new TransformNode("vm_knife", scene);
    this.knife.parent = camera;
    const handle = MeshBuilder.CreateCapsule("vm_knife_handle", { radius: 0.022, height: 0.13, tessellation: 8, subdivisions: 2 }, scene);
    handle.material = this.gloveMat;
    handle.parent = this.knife;
    const guard = MeshBuilder.CreateBox("vm_knife_guard", { width: 0.09, height: 0.012, depth: 0.045 }, scene);
    guard.material = this.gloveArmorMat;
    guard.parent = this.knife;
    guard.position.y = 0.066;
    const blade = MeshBuilder.CreateCylinder("vm_knife_blade", { height: 0.18, diameterTop: 0, diameterBottom: 0.083, tessellation: 4 }, scene);
    blade.material = this.gloveArmorMat;
    blade.scaling.z = 0.20;
    blade.position.set(0.011, 0.155, 0);
    blade.parent = this.knife;
    this.knife.setEnabled(false);

    // Soft Radial Muzzle Flash Sprite Texture (no blocky boxes)
    this.flashTex = new DynamicTexture("vm_flash_tex", 128, scene, false);
    const fctx = this.flashTex.getContext();
    const fg = fctx.createRadialGradient(64, 64, 4, 64, 64, 60);
    fg.addColorStop(0, "rgba(255,255,240,1)");
    fg.addColorStop(0.3, "rgba(255,195,70,0.85)");
    fg.addColorStop(0.7, "rgba(255,110,20,0.3)");
    fg.addColorStop(1, "rgba(255,80,0,0)");
    fctx.fillStyle = fg;
    fctx.fillRect(0, 0, 128, 128);
    this.flashTex.update();
    this.flashTex.hasAlpha = true;

    this.muzzleFlashMat = new StandardMaterial("vm_flash_mat", scene);
    this.muzzleFlashMat.diffuseTexture = this.flashTex;
    this.muzzleFlashMat.emissiveTexture = this.flashTex;
    this.muzzleFlashMat.useAlphaFromDiffuseTexture = true;
    this.muzzleFlashMat.disableLighting = true;

    for (let i = 0; i < 2; i++) {
      const plane = MeshBuilder.CreatePlane(`vm_flash_pl_${i}`, { width: 0.34, height: 0.34 }, scene);
      plane.rotation.z = (i * Math.PI) / 4;
      plane.material = this.muzzleFlashMat;
      plane.isPickable = false;
      plane.setEnabled(false);
      this.flashPlanes.push(plane);
    }

    this.muzzleFlashLight = new PointLight("vm_flash_light", new Vector3(0, 0, 0.8), scene);
    this.muzzleFlashLight.parent = camera;
    this.muzzleFlashLight.diffuse = new Color3(1.0, 0.78, 0.38);
    this.muzzleFlashLight.range = 12;
    this.muzzleFlashLight.intensity = 0;

    this.grenadeRig = new TransformNode("vm_grenade_rig", scene);
    this.grenadeRig.parent = camera;
    this.grenadeRig.setEnabled(false);
    this.buildGrenadeHand();
  }

  // ---------------------------------------------------------------- hand construction helpers

  private finger(
    parent: TransformNode,
    name: string,
    radius: number,
    length: number,
    pos: [number, number, number],
    rot: [number, number, number],
    mat: PBRMaterial,
    bucket: Mesh[]
  ): Mesh {
    const f = MeshBuilder.CreateCapsule(name, { radius, height: length, tessellation: 10, subdivisions: 2 }, this.scene);
    f.parent = parent;
    f.position.set(...pos);
    f.rotation.set(...rot);
    f.material = mat;
    f.isPickable = false;
    bucket.push(f);
    return f;
  }

  private blob(
    parent: TransformNode,
    name: string,
    size: [number, number, number],
    pos: [number, number, number],
    rot: [number, number, number],
    mat: PBRMaterial,
    bucket: Mesh[]
  ): Mesh {
    const s = MeshBuilder.CreateSphere(name, { diameterX: size[0], diameterY: size[1], diameterZ: size[2], segments: 12 }, this.scene);
    s.parent = parent;
    s.position.set(...pos);
    s.rotation.set(...rot);
    s.material = mat;
    s.isPickable = false;
    bucket.push(s);
    return s;
  }

  private cuff(parent: TransformNode, name: string, pos: [number, number, number], rot: [number, number, number], bucket: Mesh[]): void {
    const c = MeshBuilder.CreateCylinder(name, { diameter: 0.074, height: 0.048, tessellation: 20 }, this.scene);
    c.parent = parent;
    c.position.set(...pos);
    c.rotation.set(...rot);
    c.material = this.gloveArmorMat;
    c.isPickable = false;
    bucket.push(c);
    const strap = MeshBuilder.CreateBox(`${name}_strap`, { width: 0.076, height: 0.012, depth: 0.052 }, this.scene);
    strap.parent = c;
    strap.position.y = 0.0;
    strap.material = this.gloveMat;
    strap.isPickable = false;
    bucket.push(strap);
  }

  /** Right (firing) hand: palm behind the grip, three fingers wrapped round the front, index on the guard, thumb along the left side. */
  private buildFiringHand(): void {
    const h = this.firingHand;
    const b = this.armMeshes;
    this.blob(h, "vm_r_palm", [0.05, 0.1, 0.07], [0.022, 0.004, -0.024], [0.38, 0, 0], this.gloveMat, b);
    this.blob(h, "vm_r_heel", [0.046, 0.05, 0.056], [0.03, -0.044, -0.034], [0.38, 0, 0], this.gloveMat, b);
    this.blob(h, "vm_r_knuckles", [0.056, 0.026, 0.04], [0.018, 0.047, 0.0], [0.38, 0, 0.05], this.gloveArmorMat, b);
    // middle / ring / pinky wrap round the front of the grip (capsules lying along X).
    for (let i = 0; i < 3; i++) {
      const y = 0.012 - i * 0.021;
      this.finger(h, `vm_r_f${i + 1}`, 0.0105 - i * 0.0009, 0.075, [0.0, y, 0.034 - i * 0.004], [0, 0, Math.PI / 2], this.gloveMat, b);
      this.blob(h, `vm_r_tip${i + 1}`, [0.022, 0.02, 0.022], [-0.026, y, 0.026 - i * 0.004], [0, 0, 0], this.gloveMat, b);
    }
    // index finger rests alongside the trigger guard.
    this.finger(h, "vm_r_index", 0.0105, 0.085, [0.01, 0.034, 0.05], [Math.PI / 2 - 0.1, 0, 0], this.gloveMat, b);
    // thumb folded along the left of the grip.
    this.finger(h, "vm_r_thumb", 0.0125, 0.075, [-0.026, 0.03, 0.0], [Math.PI / 2 - 0.35, 0.12, 0], this.gloveMat, b);
    this.cuff(h, "vm_r_cuff", [0.036, -0.0, -0.064], [Math.PI / 2 - 0.2, 0.3, 0], b);
  }

  /** Left (support) hand: cradles the handguard from below, fingers curl up the right side, thumb pinned on the left. */
  private buildSupportHand(): void {
    const h = this.supportHand;
    const b = this.armMeshes;
    this.blob(h, "vm_l_palm", [0.07, 0.04, 0.09], [-0.004, -0.014, -0.012], [0, 0, 0], this.gloveMat, b);
    this.blob(h, "vm_l_back", [0.052, 0.03, 0.08], [-0.03, -0.018, -0.016], [0, 0, 0.18], this.gloveArmorMat, b);
    for (let i = 0; i < 4; i++) {
      const z = 0.034 - i * 0.0215;
      const r = 0.0098 - i * 0.0006;
      // proximal phalanx under the handguard, middle phalanx curling up the right side.
      this.finger(h, `vm_l_f${i}_a`, r, 0.07, [0.016, 0.004, z], [0, 0, Math.PI / 2], this.gloveMat, b);
      this.finger(h, `vm_l_f${i}_b`, r * 0.95, 0.04, [0.049, 0.022, z], [0, 0, 0.1], this.gloveMat, b);
    }
    this.finger(h, "vm_l_thumb", 0.012, 0.07, [-0.04, 0.012, 0.03], [Math.PI / 2 - 0.2, 0, -0.45], this.gloveMat, b);
    this.cuff(h, "vm_l_cuff", [-0.032, -0.024, -0.066], [Math.PI / 2 - 0.1, -0.2, 0], b);
    const watch = MeshBuilder.CreateBox("vm_watch", { width: 0.03, height: 0.012, depth: 0.026 }, this.scene);
    watch.parent = this.supportHand;
    watch.position.set(-0.04, -0.012, -0.084);
    watch.rotation.z = -0.35;
    watch.material = this.watchMat;
    watch.isPickable = false;
    this.armMeshes.push(watch);
  }

  /** The hand + forearm that holds a grenade while it is being cooked / thrown (rig origin = grenade centre). */
  private buildGrenadeHand(): void {
    const rig = this.grenadeRig;
    const b = this.grenadeRigMeshes;
    this.blob(rig, "vm_g_palm", [0.05, 0.09, 0.07], [0.052, -0.004, 0.0], [0, 0, 0.12], this.gloveMat, b);
    this.blob(rig, "vm_g_knuckles", [0.03, 0.034, 0.062], [0.06, 0.034, 0.0], [0, 0, 0.12], this.gloveArmorMat, b);
    for (let i = 0; i < 4; i++) {
      this.finger(rig, `vm_g_f${i}`, 0.0098, 0.07, [-0.004, 0.026 - i * 0.02, 0.03 - i * 0.002], [0, 0, Math.PI / 2], this.gloveMat, b);
    }
    this.finger(rig, "vm_g_thumb", 0.012, 0.07, [0.026, 0.044, 0.016], [Math.PI / 2 - 0.5, 0.0, 0.5], this.gloveMat, b);
    const fore = buildLimbSegment(this.scene, "vm_g_fore", new Vector3(0.15, -0.3, -0.3), new Vector3(0.082, -0.03, -0.072), 0.088, 0.062, this.sleeveMat, rig);
    b.push(fore);
    this.cuff(rig, "vm_g_cuff", [0.074, -0.026, -0.066], [Math.PI / 2 - 0.6, -0.3, 0], b);
  }

  // ---------------------------------------------------------------- equip / fire

  equip(config: PlayerWeaponConfig): void {
    for (const plane of this.flashPlanes) plane.parent = this.holder;
    if (this.assembled) {
      this.assembled.dispose();
      this.assembled = null;
    }
    this.assembled = assembleWeaponMesh(this.scene, config, "fp", this.modelCache, this.texGen);
    this.assembled.root.parent = this.holder;
    this.equipDip = 1;
    for (const p of this.flashPlanes) {
      p.parent = this.assembled.muzzleNode;
      p.position.set(0, 0, 0.05);
    }
  }

  private placeForearm(arm: Mesh, elbow: Vector3, wrist: Vector3): void {
    wrist.subtractToRef(elbow, this.limbAxis);
    arm.scaling.y = Math.max(0.05, this.limbAxis.length());
    arm.position.copyFrom(elbow).addInPlace(wrist).scaleInPlace(0.5);
    Quaternion.FromUnitVectorsToRef(this.up, this.limbAxis.normalize(), arm.rotationQuaternion!);
  }

  addMouseSway(dx: number, dy: number): void {
    this.swayX = Math.max(-0.04, Math.min(0.04, this.swayX - dx * 0.00016));
    this.swayY = Math.max(-0.04, Math.min(0.04, this.swayY + dy * 0.00016));
  }

  triggerFire(stats: EffectiveWeaponStats): void {
    this.kickZ = Math.min(0.11, this.kickZ + 0.052);
    this.kickPitch = Math.min(0.18, this.kickPitch + stats.recoilVertical * 0.015);
    this.boltKick = 0.058;

    if (!stats.hideMuzzleFlash) {
      this.flashTimer = 0.055;
      const s = 0.85 + Math.random() * 0.45;
      for (const p of this.flashPlanes) {
        p.setEnabled(true);
        p.scaling.set(s, s, 1);
        p.rotation.z += 0.4;
      }
      this.muzzleFlashLight.intensity = 4.2;
    }
  }

  /** Call the moment a grenade is actually thrown (as opposed to the cook being cancelled). */
  notifyThrow(): void {
    this.throwQueued = true;
  }

  getMuzzleWorldPosition(): Vector3 {
    if (this.assembled) {
      return this.assembled.muzzleNode.getAbsolutePosition().clone();
    }
    return this.holder.getAbsolutePosition().clone();
  }

  getEjectWorldPosition(): Vector3 {
    if (this.assembled) {
      return this.assembled.ejectNode.getAbsolutePosition().clone();
    }
    return this.holder.getAbsolutePosition().clone();
  }

  setVisible(visible: boolean): void {
    this.shown = visible;
    this.holder.setEnabled(visible);
    this.knife.setEnabled(visible && this.meleeTimer > 0);
    if (!visible) this.grenadeRig.setEnabled(false);
    else this.grenadeRig.setEnabled(this.grenadeState !== "none");
  }

  inspect(): void { this.inspectTimer = this.inspectTimer > 0 ? 0 : 1.45; }

  cancelInspect(): void { this.inspectTimer = 0; }

  swingKnife(): void {
    this.cancelInspect();
    this.meleeTimer = 0.38;
  }

  // ---------------------------------------------------------------- grenade rig

  private ensureGrenadeModel(type: ThrowableType): void {
    if (this.grenadeModel && this.grenadeModelType === type) return;
    if (this.grenadeModel) this.grenadeModel.root.dispose(false, false);
    const model = createGrenadeModel(this.scene, type, "vm_gren");
    model.root.parent = this.grenadeRig;
    model.root.scaling.setAll(1.15);
    model.root.rotation.set(0, 0, 0);
    this.grenadeModel = model;
    this.grenadeModelType = type;
  }

  private updateGrenade(dt: number, cooking: boolean, type: ThrowableType, cookFraction: number): void {
    this.cookFraction = cookFraction;
    if (cooking && !this.wasCooking) {
      this.ensureGrenadeModel(type);
      this.grenadeState = "cook";
      this.grenadeT = 0;
      this.pinFlyT = -1;
      this.pinReleased = false;
      this.throwQueued = false;
      const g = this.grenadeModel!;
      g.root.setEnabled(true);
      g.lever.setEnabled(true);
      g.pin.setEnabled(true);
      g.ring.setEnabled(true);
      g.pin.position.set(0, g.pin.position.y, 0);
      g.ring.position.x = -0.026;
      g.ring.scaling.setAll(1);
      g.pin.scaling.setAll(1);
    } else if (!cooking && this.wasCooking) {
      this.grenadeState = this.throwQueued ? "throw" : "cancel";
      this.grenadeT = 0;
    }
    this.wasCooking = cooking;

    const g = this.grenadeModel;
    if (this.grenadeState === "none" || !g) {
      this.grenadeLower = damp(this.grenadeLower, 0, 14, dt);
      this.grenadeRig.setEnabled(false);
      return;
    }

    this.grenadeT += dt;
    this.grenadeRig.setEnabled(this.holder.isEnabled());
    const t = this.grenadeT;
    const rest = { x: 0.2, y: -0.16, z: 0.46 };
    const hidden = { x: 0.12, y: -0.4, z: 0.2 };
    let x = rest.x, y = rest.y, z = rest.z;
    let rotX = 0.15, rotZ = 0;
    let lowerTarget = 1;
    const ease = (v: number) => {
      const c = Math.max(0, Math.min(1, v));
      return c * c * (3 - 2 * c);
    };

    if (this.grenadeState === "cook") {
      const a = ease(t / 0.28);
      x = hidden.x + (rest.x - hidden.x) * a;
      y = hidden.y + (rest.y - hidden.y) * a;
      z = hidden.z + (rest.z - hidden.z) * a;
      // Pin is pulled by the other hand shortly after the grenade appears.
      if (!this.pinReleased && t > 0.32) {
        this.pinReleased = true;
        this.pinFlyT = 0;
      }
      // Tremble grows as the fuse burns down.
      const shake = this.cookFraction * this.cookFraction * 0.006;
      x += Math.sin(t * 61) * shake;
      y += Math.cos(t * 47) * shake;
    } else if (this.grenadeState === "throw") {
      const wind = ease(t / 0.12);
      const fling = ease((t - 0.12) / 0.15);
      const retract = ease((t - 0.3) / 0.25);
      x = rest.x + 0.04 * wind - 0.08 * fling + (hidden.x - rest.x + 0.04) * retract;
      y = rest.y + 0.05 * wind - 0.06 * fling + (hidden.y - rest.y + 0.01) * retract;
      z = rest.z - 0.12 * wind + 0.5 * fling + (hidden.z - rest.z - 0.38) * retract;
      rotX = 0.15 - 0.5 * wind + 1.0 * fling;
      rotZ = 0.3 * wind - 0.4 * fling;
      lowerTarget = t < 0.42 ? 1 : 0;
      g.lever.setEnabled(t < 0.12);
      g.root.setEnabled(t < 0.26);
      if (t >= 0.55) {
        this.grenadeState = "none";
        g.root.setEnabled(false);
      }
    } else {
      const retract = ease(t / 0.22);
      x = rest.x + (hidden.x - rest.x) * retract;
      y = rest.y + (hidden.y - rest.y) * retract;
      z = rest.z + (hidden.z - rest.z) * retract;
      lowerTarget = t < 0.12 ? 1 : 0;
      if (t >= 0.24) this.grenadeState = "none";
    }

    this.grenadeLower = damp(this.grenadeLower, lowerTarget, 12, dt);
    this.grenadeRig.position.set(x, y, z);
    this.grenadeRig.rotation.set(rotX, 0, rotZ);

    // Pin + ring spring free and vanish.
    if (this.pinFlyT >= 0) {
      this.pinFlyT += dt;
      const k = Math.min(1, this.pinFlyT / 0.22);
      g.pin.position.x = -0.12 * k;
      g.ring.position.x = -0.026 - 0.12 * k;
      g.ring.position.y = g.pin.position.y - 0.06 * k * k;
      g.pin.position.y = g.pin.position.y;
      const s = Math.max(0.001, 1 - k);
      g.pin.scaling.setAll(s);
      g.ring.scaling.setAll(s);
      if (k >= 1) {
        g.pin.setEnabled(false);
        g.ring.setEnabled(false);
        this.pinFlyT = -1;
      }
    }
    // Spoon lever: stays clamped while cooking.
    g.root.rotation.y = Math.sin(t * 3) * 0.05;
  }

  update(params: {
    dt: number;
    ads: boolean;
    adsAlpha: number;
    speedXZ: number;
    strideAngle: number;
    sprinting: boolean;
    grounded: boolean;
    sliding: boolean;
    reloading: boolean;
    reloadProgress: number;
    cookingGrenade: boolean;
    grenadeType?: ThrowableType;
    cookFraction?: number;
  }): void {
    const { dt, ads, adsAlpha, speedXZ, strideAngle, sprinting, grounded, sliding, reloading, reloadProgress, cookingGrenade } = params;

    this.updateGrenade(dt, cookingGrenade, params.grenadeType ?? "frag", params.cookFraction ?? 0);
    const grenadeBusy = this.grenadeLower > 0.02;
    if (ads || reloading || sprinting || grenadeBusy) this.cancelInspect();
    this.inspectTimer = Math.max(0, this.inspectTimer - dt);
    this.meleeTimer = Math.max(0, this.meleeTimer - dt);
    this.breathClock = (this.breathClock + dt * 1.35) % (Math.PI * 2);
    const inspectPose = this.inspectTimer > 0 ? Math.sin(this.inspectTimer / 1.45 * Math.PI) : 0;
    const slash = this.meleeTimer > 0 ? Math.sin((1 - this.meleeTimer / 0.38) * Math.PI) : 0;

    const sprintTarget = sprinting && !ads && !reloading && !grenadeBusy ? 1 : 0;
    this.sprintAlpha = damp(this.sprintAlpha, sprintTarget, 10, dt);

    const reloadTarget = reloading ? 1 : 0;
    this.reloadDip = damp(this.reloadDip, reloadTarget, 12, dt);

    // Magazine drop-out & insert animation during reload
    if (this.assembled) {
      const magDrop = Math.sin(reloadProgress * Math.PI) * 0.19;
      this.assembled.magNode.position.y = -magDrop;
      this.assembled.boltNode.position.z = this.assembled.boltRestZ - this.boltKick;
      this.firingHand.position.copyFrom(this.assembled.firingGrip);
      this.supportHand.position.copyFrom(this.assembled.supportGrip);
      const socket = this.assembled.magNode.parent;
      const reach = Math.min(1, reloadProgress / 0.18, (1 - reloadProgress) / 0.22);
      if (socket instanceof TransformNode && reach > 0) {
        this.magazineGrip.copyFrom(socket.position).addInPlaceFromFloats(-0.03, -0.1 - magDrop, 0.0);
        Vector3.LerpToRef(this.assembled.supportGrip, this.magazineGrip, reach, this.supportHand.position);
      }
      this.supportHand.rotation.x = reach * -0.65;
      this.firingHand.rotation.x = 0;
      this.firingHand.position.addToRef(this.firingWristOffset, this.tmpWrist);
      this.placeForearm(this.firingForearm, this.firingElbow, this.tmpWrist);
      this.supportHand.position.addToRef(this.supportWristOffset, this.tmpWrist);
      this.placeForearm(this.supportForearm, this.supportElbow, this.tmpWrist);
    }
    this.equipDip = damp(this.equipDip, 0, 13, dt);

    this.swayX = damp(this.swayX, 0, 10, dt);
    this.swayY = damp(this.swayY, 0, 10, dt);
    this.kickZ = damp(this.kickZ, 0, 18, dt);
    this.kickPitch = damp(this.kickPitch, 0, 15, dt);
    this.boltKick = damp(this.boltKick, 0, 28, dt);

    const hipMotion = 1 - adsAlpha;
    const bobAmp = grounded && !sliding ? Math.min(1, speedXZ / 6.0) * hipMotion * 0.011 : 0;
    const bobX = Math.cos(strideAngle) * bobAmp;
    const bobY = Math.abs(Math.sin(strideAngle)) * bobAmp;

    const adsOffset = this.assembled?.adsAlignOffset ?? new Vector3(0, -0.065, 0.3);
    const targetX = this.hipPos.x * hipMotion + adsOffset.x * adsAlpha - this.sprintAlpha * 0.09;
    const targetY = this.hipPos.y * hipMotion + adsOffset.y * adsAlpha - this.sprintAlpha * 0.03;
    const targetZ = this.hipPos.z * hipMotion + adsOffset.z * adsAlpha - this.sprintAlpha * 0.04;

    this.currentPos.set(
      targetX + this.swayX * hipMotion + bobX,
      targetY + this.swayY * hipMotion - bobY - this.reloadDip * 0.14 - this.equipDip * 0.15 - this.grenadeLower * 0.3 -
        slash * 0.42 + hipMotion * Math.sin(this.breathClock) * 0.0028 + inspectPose * 0.065,
      targetZ - this.kickZ
    );

    this.holder.position.copyFrom(this.currentPos);
    const slideTilt = sliding ? -0.35 : 0;
    this.holder.rotation.set(
      -this.kickPitch * hipMotion + this.reloadDip * 0.42 + this.sprintAlpha * 0.24 + this.equipDip * 0.28 + this.grenadeLower * 0.5,
      this.swayX * hipMotion * 1.4 - this.sprintAlpha * 0.55 - inspectPose * 0.63,
      slideTilt * hipMotion + this.reloadDip * 0.38 + this.sprintAlpha * 0.22 + inspectPose * 0.68
    );
    this.knife.setEnabled(this.shown && this.meleeTimer > 0);
    if (this.meleeTimer > 0) {
      this.knife.position.set(0.26 - slash * 0.29, -0.33 + slash * 0.15, 0.46 + slash * 0.28);
      this.knife.rotation.set(1.15 - slash * 0.5, -0.15, -0.88 + slash * 2.3);
    }
    if (this.shown) {
      const grenade = grenadeBusy && this.grenadeState !== "none";
      const right = grenade ? Vector3.TransformCoordinates(new Vector3(0.056, -0.025, -0.065), this.grenadeRig.computeWorldMatrix(true))
        : this.meleeTimer > 0 ? this.knife.getAbsolutePosition() : this.firingHand.computeWorldMatrix(true).getTranslation();
      const left = grenade ? Vector3.TransformCoordinates(new Vector3(-0.10, this.pinReleased ? -0.24 : 0.07, -0.055), this.grenadeRig.getWorldMatrix())
        : this.supportHand.computeWorldMatrix(true).getTranslation();
      const renderedRig = this.riggedArms.update(this.holder.computeWorldMatrix(true), right, left, reloading ? 0.6 : 1, true);
      this.armsRoot.setEnabled(!renderedRig);
      for (const mesh of this.grenadeRigMeshes) mesh.setEnabled(!renderedRig);
    }

    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) {
        for (const p of this.flashPlanes) p.setEnabled(false);
        this.muzzleFlashLight.intensity = 0;
      }
    }
  }

  dispose(): void {
    this.riggedArms.dispose();
    this.knife.dispose();
    this.assembled?.dispose();
    for (const m of this.armMeshes) m.dispose();
    for (const m of this.grenadeRigMeshes) m.dispose();
    this.grenadeModel?.root.dispose(false, false);
    this.grenadeRig.dispose();
    for (const p of this.flashPlanes) p.dispose();
    this.flashTex.dispose();
    this.sleeveMat.dispose();
    this.gloveMat.dispose();
    this.gloveArmorMat.dispose();
    this.watchMat.dispose();
    this.muzzleFlashMat.dispose();
    this.muzzleFlashLight.dispose();
    this.holder.dispose();
    void this.camera;
  }
}
