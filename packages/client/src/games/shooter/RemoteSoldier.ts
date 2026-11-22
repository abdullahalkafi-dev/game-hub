import {
  AnimationGroup,
  Color3,
  Matrix,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  Quaternion,
  Scene,
  ShadowGenerator,
  Skeleton,
  StandardMaterial,
  TransformNode,
  Vector3,
  type Observer,
} from "@babylonjs/core";
import { damp, type PlayerLoadoutPayload, type PlayerWeaponConfig, type TeamId } from "@game/shared";
import type { InterpolatedRemoteState } from "../../core/NetClient.js";
import type { ModelAssetCache } from "./ModelAssetCache.js";
import type { PbrTextureGenerator } from "./PbrTextureGenerator.js";
import { assembleWeaponMesh, type AssembledWeapon } from "./WeaponAssembler.js";
import { advanceStepPhase } from "./Locomotion.js";

/**
 * Real Skeletal Animated Tactical Operator:
 * - Instantiates the rigged `Soldier.glb` character with smooth `Idle` / `Walk` / `Run` AnimationGroups
 * - Falls back cleanly to articulated multi-part mesh if Soldier.glb isn't loaded
 * - Team IFF shoulder/helmet strobe + 3rd-person equipped weapon + hit flinch + 1.2s death fall animation
 */
export class RemoteSoldier {
  public readonly root: TransformNode;
  private readonly modelRoot: TransformNode;
  private readonly weaponMount: TransformNode;
  private readonly iffBeacon: Mesh;
  private readonly iffMat: StandardMaterial;
  private readonly animGroups = new Map<string, AnimationGroup>();
  private readonly ownedMeshes: Mesh[] = [];
  private readonly ownedMats: (PBRMaterial | StandardMaterial)[] = [];
  private readonly joints = new Map<string, TransformNode>();
  private readonly skeletons: Skeleton[] = [];
  private readonly baseRotations = new Map<TransformNode, Quaternion>();
  private readonly posedJoints: TransformNode[] = [];
  private readonly poseDelta = Quaternion.Identity();
  private readonly fallbackLegs: Mesh[] = [];
  private rigPoseBefore: Observer<Scene> | null = null;
  private rigPoseAfter: Observer<Scene> | null = null;
  private crouchPose = 0;
  private slidePose = 0;
  private vaultPose = 0;
  private aimPitch = 0;
  private aimPose = 0;
  private stride = 0;
  private gaitForward = 0;
  private gaitSide = 0;
  private airbornePose = 0;
  private readonly ikInverse = Matrix.Identity();
  private rigHipHeight: number | undefined;
  private readonly modelInverse = Matrix.Identity();

  private weaponMesh: AssembledWeapon | null = null;
  private currentWeaponKey = "";
  private activeSlot: 0 | 1 = 0;
  private activeAnimName = "";
  private flinchTimer = 0;
  private wasAlive = false;
  private deathFallTimer = 0;
  private relationOverride: boolean | null = null;

  constructor(
    private readonly scene: Scene,
    public readonly playerId: string,
    public readonly playerIndex: number,
    private team: TeamId,
    private loadout: PlayerLoadoutPayload,
    private shadowGen?: ShadowGenerator,
    private readonly modelCache?: ModelAssetCache,
    private readonly texGen?: PbrTextureGenerator
  ) {
    this.root = new TransformNode(`soldier_${playerId}`, scene);
    this.root.setEnabled(false);
    this.modelRoot = new TransformNode(`soldier_model_${playerId}`, scene);
    this.modelRoot.parent = this.root;

    this.weaponMount = new TransformNode(`soldier_wep_${playerId}`, scene);
    this.weaponMount.parent = this.modelRoot;
    this.weaponMount.position.set(0.18, 1.24, 0.34);

    // Subtle team IFF indicator strobe above shoulder
    this.iffMat = new StandardMaterial(`iff_mat_${playerId}`, scene);
    this.updateIffColor();
    this.iffMat.disableLighting = true;
    this.ownedMats.push(this.iffMat);

    this.iffBeacon = MeshBuilder.CreateBox(
      `iff_${playerId}`,
      { width: 0.08, height: 0.035, depth: 0.08 },
      scene
    );
    this.iffBeacon.parent = this.modelRoot;
    this.iffBeacon.position.set(0, 1.86, 0);
    this.iffBeacon.material = this.iffMat;
    this.iffBeacon.isPickable = false;
    this.ownedMeshes.push(this.iffBeacon);

    const glbSoldier = this.modelCache?.instantiateSoldier(`p_${playerIndex}`);
    if (glbSoldier) {
      this.skeletons.push(...glbSoldier.skeletons);
      glbSoldier.root.parent = this.modelRoot;
      // Three.js Soldier.glb faces -Z natively; rotate 180 deg to face +Z
      glbSoldier.root.rotation.y = Math.PI;
      for (const m of glbSoldier.meshes) {
        this.shadowGen?.addShadowCaster(m);
        this.ownedMeshes.push(m);
      }
      const rigPrefix = `p_${playerIndex}_`;
      for (const ag of glbSoldier.animationGroups) {
        const clip = (ag.name.startsWith(rigPrefix) ? ag.name.slice(rigPrefix.length) : ag.name).toLowerCase();
        this.animGroups.set(clip, ag);
        ag.stop();
      }
      for (const node of glbSoldier.root.getChildTransformNodes(false)) {
        const name = node.name.split("mixamorig:")[1];
        if (name) this.joints.set(name, node);
      }
      this.rigPoseBefore = scene.onBeforeAnimationsObservable.add(() => this.restoreRigPose());
      this.rigPoseAfter = scene.onAfterAnimationsObservable.add(() => this.applyRigPose());
    } else {
      this.buildFallbackArticulatedMesh();
    }

    this.setWeapon(loadout.primary);
  }

  private updateIffColor(): void {
    const isAlly = this.relationOverride ?? (this.team === "A");
    this.iffMat.emissiveColor = Color3.FromHexString(isAlly ? "#38bdf8" : "#f87171");
  }

  setTeam(team: TeamId): void {
    if (this.team === team) return;
    this.team = team;
    this.updateIffColor();
  }

  setRelation(isAlly: boolean): void {
    if (this.relationOverride === isAlly) return;
    this.relationOverride = isAlly;
    this.updateIffColor();
  }

  /** Rebuilds the held weapon, e.g. after an imported skin model has finished downloading. */
  refreshWeaponModel(): void {
    this.currentWeaponKey = "";
    this.setWeapon(this.activeSlot === 0 ? this.loadout.primary : this.loadout.secondary);
  }

  setLoadout(loadout: PlayerLoadoutPayload): void {
    this.loadout = loadout;
    this.setWeapon(this.activeSlot === 0 ? loadout.primary : loadout.secondary);
  }

  setShadowGenerator(generator: ShadowGenerator | null): void {
    if (this.shadowGen === generator) return;
    this.shadowGen = generator ?? undefined;
    for (const mesh of this.ownedMeshes) generator?.addShadowCaster(mesh);
  }

  private buildFallbackArticulatedMesh(): void {
    const isTeamA = this.team === "A";
    const rigMat = new PBRMaterial(`fb_rig_${this.playerId}`, this.scene);
    rigMat.albedoColor = Color3.FromHexString(isTeamA ? "#334155" : "#4b3832");
    rigMat.roughness = 0.78;
    this.ownedMats.push(rigMat);

    const torso = MeshBuilder.CreateBox(`fb_torso_${this.playerId}`, { width: 0.44, height: 0.65, depth: 0.26 }, this.scene);
    torso.parent = this.modelRoot;
    torso.position.set(0, 1.15, 0);
    torso.material = rigMat;
    torso.isPickable = false;
    this.shadowGen?.addShadowCaster(torso);
    this.ownedMeshes.push(torso);

    const head = MeshBuilder.CreateSphere(`fb_head_${this.playerId}`, { diameter: 0.3 }, this.scene);
    head.parent = this.modelRoot;
    head.position.set(0, 1.62, 0);
    head.material = rigMat;
    head.isPickable = false;
    this.shadowGen?.addShadowCaster(head);
    this.ownedMeshes.push(head);

    for (const side of [-1, 1]) {
      const leg = MeshBuilder.CreateCapsule(`fallback_leg_${this.playerId}_${side}`, { height: 0.82, radius: 0.095, tessellation: 8 }, this.scene);
      leg.parent = this.modelRoot;
      leg.position.set(side * 0.12, 0.42, 0);
      leg.material = rigMat;
      leg.isPickable = false;
      this.ownedMeshes.push(leg);
      this.fallbackLegs.push(leg);
      const arm = MeshBuilder.CreateCapsule(`fallback_arm_${this.playerId}_${side}`, { height: 0.50, radius: 0.072, tessellation: 8 }, this.scene);
      arm.parent = this.modelRoot;
      arm.position.set(side * 0.22, 1.19, 0.17);
      arm.rotation.x = 1.1;
      arm.material = rigMat;
      arm.isPickable = false;
      this.ownedMeshes.push(arm);
      this.shadowGen?.addShadowCaster(leg);
      this.shadowGen?.addShadowCaster(arm);
    }
  }

  private playAnim(name: "idle" | "walk" | "run"): void {
    if (this.activeAnimName === name) return;
    const first = !this.activeAnimName;
    this.activeAnimName = name;
    const animation = this.animGroups.get(name);
    if (animation && !animation.isStarted) {
      animation.weight = first ? 1 : 0;
      animation.start(true);
    }
  }

  private blendAnimations(dt: number): void {
    for (const [name, group] of this.animGroups) {
      if (!group.isStarted) continue;
      group.weight = damp(group.weight, name === this.activeAnimName ? 1 : 0, 16, dt);
      if (name !== this.activeAnimName && group.weight < 0.01) group.stop(true);
    }
  }

  private restoreRigPose(): void {
    for (const joint of this.posedJoints) {
      joint.rotationQuaternion?.copyFrom(this.baseRotations.get(joint)!);
    }
    this.posedJoints.length = 0;
    const hips = this.joints.get("Hips");
    if (hips && this.rigHipHeight !== undefined) hips.position.z = this.rigHipHeight;
  }

  private rotateJoint(name: string, pitch: number, roll = 0): void {
    const joint = this.joints.get(name);
    if (!joint?.rotationQuaternion || Math.abs(pitch) + Math.abs(roll) < 0.001) return;
    this.rememberRotation(joint);
    Quaternion.RotationYawPitchRollToRef(0, pitch, roll, this.poseDelta);
    joint.rotationQuaternion.multiplyInPlace(this.poseDelta);
  }

  private rememberRotation(joint: TransformNode): void {
    if (!joint.rotationQuaternion || this.posedJoints.includes(joint)) return;
    const base = this.baseRotations.get(joint) ?? Quaternion.Identity();
    base.copyFrom(joint.rotationQuaternion);
    this.baseRotations.set(joint, base);
    this.posedJoints.push(joint);
  }

  private rotateToward(joint: TransformNode, from: Vector3, to: Vector3): void {
    if (!joint.rotationQuaternion || !(joint.parent instanceof TransformNode)) return;
    joint.parent.computeWorldMatrix(true).invertToRef(this.ikInverse);
    const current = Vector3.TransformNormal(from, this.ikInverse).normalize();
    const desired = Vector3.TransformNormal(to, this.ikInverse).normalize();
    if (current.lengthSquared() < 0.5 || desired.lengthSquared() < 0.5) return;
    this.rememberRotation(joint);
    Quaternion.FromUnitVectorsToRef(current, desired, this.poseDelta);
    this.poseDelta.multiplyToRef(joint.rotationQuaternion, joint.rotationQuaternion);
    joint.computeWorldMatrix(true);
  }

  private getArm(side: "Left" | "Right"): [TransformNode, TransformNode, TransformNode] | undefined {
    const upper = this.joints.get(`${side}Arm`);
    const lower = this.joints.get(`${side}ForeArm`);
    const hand = this.joints.get(`${side}Hand`);
    if (!upper || !lower || !hand) return undefined;
    for (const limb of [upper, lower, hand]) limb.computeWorldMatrix(true);
    return [upper, lower, hand];
  }

  private reachWithArm([upper, lower, hand]: [TransformNode, TransformNode, TransformNode], grip: Vector3): void {
    const shoulder = upper.getAbsolutePosition();
    const upperVector = lower.getAbsolutePosition().subtract(shoulder);
    const lowerLength = Vector3.Distance(lower.getAbsolutePosition(), hand.getAbsolutePosition());
    const upperLength = upperVector.length();
    const reach = grip.subtract(shoulder);
    if (reach.lengthSquared() < 0.003 || upperLength < 0.03 || lowerLength < 0.03) return;
    const distance = Math.max(Math.abs(upperLength - lowerLength) + 0.005, Math.min(reach.length(), upperLength + lowerLength - 0.005));
    const direction = reach.normalize();
    const along = (upperLength * upperLength + distance * distance - lowerLength * lowerLength) / (2 * distance);
    const bend = upperVector.subtract(direction.scale(Vector3.Dot(upperVector, direction)));
    if (bend.lengthSquared() < 0.0001) return;
    const solvedUpper = direction.scale(along).addInPlace(bend.normalize().scale(Math.sqrt(Math.max(0, upperLength * upperLength - along * along))));
    this.rotateToward(upper, upperVector, solvedUpper);
    lower.computeWorldMatrix(true);
    hand.computeWorldMatrix(true);
    const realElbow = lower.getAbsolutePosition();
    this.rotateToward(lower, hand.getAbsolutePosition().subtract(realElbow), shoulder.add(direction.scale(distance)).subtract(realElbow));
  }

  private poseWeaponGrip(): void {
    const weapon = this.weaponMesh;
    if (!weapon || this.activeSlot === 1 || this.vaultPose > 0.7 || this.deathFallTimer > 0) return;
    const supportArm = this.getArm("Left");
    if (!supportArm) return;
    const [shoulder, elbow, hand] = supportArm.map((joint) => joint.getAbsolutePosition());
    this.weaponMount.computeWorldMatrix(true);
    const grip = Vector3.TransformCoordinates(weapon.supportGrip, weapon.root.computeWorldMatrix(true));
    const reach = grip.subtract(shoulder);
    const maxReach = Vector3.Distance(shoulder, elbow) + Vector3.Distance(elbow, hand) - 0.045;
    const pullBack = reach.length() - maxReach;
    if (pullBack > 0 && maxReach > 0) {
      const correction = reach.normalize().scale(-pullBack);
      this.weaponMount.position.addInPlace(Vector3.TransformNormal(correction, this.modelInverse));
      grip.addInPlace(correction);
      const firingArm = this.getArm("Right");
      if (firingArm) {
        this.weaponMount.computeWorldMatrix(true);
        this.reachWithArm(firingArm, this.weaponMount.getAbsolutePosition());
      }
    }
    this.reachWithArm(supportArm, grip);
  }

  private applyRigPose(): void {
    if (!this.root.isEnabled()) return;
    const hips = this.joints.get("Hips");
    if (hips) {
      this.rigHipHeight = hips.position.z;
      hips.position.z -= this.crouchPose * 19 + this.slidePose * 11;
    }
    const phase = this.stride * Math.PI;
    const swing = Math.sin(phase);
    const leftLift = Math.max(0, Math.cos(phase));
    const rightLift = Math.max(0, -Math.cos(phase));
    this.rotateJoint("Spine1", this.crouchPose * 0.20 + this.vaultPose * 0.22 - this.aimPitch * 0.35, -this.gaitSide * 0.13);
    this.rotateJoint("Head", -this.aimPitch * 0.32);
    this.rotateJoint("LeftUpLeg", -this.crouchPose * 0.68 - this.vaultPose * 0.41 + swing * this.gaitForward * 0.51 - this.airbornePose * 0.27,
      swing * this.gaitSide * 0.46);
    this.rotateJoint("RightUpLeg", -this.crouchPose * 0.60 + this.slidePose * 0.38 - this.vaultPose * 0.29 - swing * this.gaitForward * 0.51 - this.airbornePose * 0.18,
      -swing * this.gaitSide * 0.46);
    const strideLift = Math.hypot(this.gaitForward, this.gaitSide) * 0.42;
    this.rotateJoint("LeftLeg", this.crouchPose * 1.14 + this.vaultPose * 0.65 + leftLift * strideLift + this.airbornePose * 0.47);
    this.rotateJoint("RightLeg", this.crouchPose * 1.01 - this.slidePose * 0.62 + this.vaultPose * 0.58 + rightLift * strideLift + this.airbornePose * 0.31);
    this.rotateJoint("RightArm", -this.aimPose * 0.12 - this.vaultPose * 0.20);
    this.rotateJoint("LeftArm", -this.aimPose * 0.18 - this.vaultPose * 0.24);

    this.modelRoot.computeWorldMatrix(true).invertToRef(this.modelInverse);
    this.moveToJoint("RightHand", this.weaponMount);
    this.poseWeaponGrip();
    if (this.moveToJoint("HeadTop_End", this.iffBeacon)) this.iffBeacon.position.y += 0.10;
  }

  private moveToJoint(jointName: string, marker: TransformNode): boolean {
    const joint = this.joints.get(jointName);
    if (!joint) return false;
    joint.computeWorldMatrix(true);
    Vector3.TransformCoordinatesToRef(joint.getAbsolutePosition(), this.modelInverse, marker.position);
    return true;
  }

  private setWeapon(config: PlayerWeaponConfig): void {
    const key = `${config.weaponId}_${config.skinId}_${JSON.stringify(config.attachments)}`;
    if (key === this.currentWeaponKey) return;
    this.currentWeaponKey = key;

    this.weaponMesh?.dispose();
    this.weaponMesh = assembleWeaponMesh(
      this.scene,
      config,
      `tp_${this.playerIndex}`,
      this.modelCache,
      this.texGen
    );
    this.weaponMesh.root.parent = this.weaponMount;
    if (this.joints.has("RightHand")) this.weaponMesh.root.position.copyFrom(this.weaponMesh.firingGrip).scaleInPlace(-1);
  }

  triggerHitFlinch(): void {
    this.flinchTimer = 0.16;
  }

  getMuzzleWorldPos(): Vector3 {
    if (this.weaponMesh) {
      return this.weaponMesh.muzzleNode.getAbsolutePosition().clone();
    }
    return this.modelRoot.getAbsolutePosition().add(new Vector3(0, 1.35, 0));
  }

  getHeadWorldPos(): Vector3 {
    this.iffBeacon.computeWorldMatrix(true);
    return this.iffBeacon.getAbsolutePosition();
  }

  /** Gait of the most recent snapshot, read by the audio code when a footfall lands. */
  lastStepSpeed = 0;
  lastStepCrouching = false;

  applySnapshot(state: InterpolatedRemoteState, dt: number): boolean {
    const wasAlive = this.wasAlive;
    if (this.wasAlive && !state.alive) {
      this.deathFallTimer = 1.25;
      this.playAnim("idle");
    } else if (!this.wasAlive && state.alive) {
      this.deathFallTimer = 0;
      this.modelRoot.rotation.x = 0;
      this.modelRoot.position.y = 0;
      this.stride = 0;
    }
    this.wasAlive = state.alive;

    if (!state.alive) {
      if (this.deathFallTimer > 0) {
        this.deathFallTimer -= dt;
        this.root.setEnabled(true);
        this.modelRoot.rotation.x = damp(this.modelRoot.rotation.x, -Math.PI * 0.48, 9, dt);
        this.modelRoot.position.y = damp(this.modelRoot.position.y, 0.18, 9, dt);
        this.crouchPose = damp(this.crouchPose, 0.45, 8, dt);
        this.blendAnimations(dt);
      } else if (this.root.isEnabled()) {
        this.root.setEnabled(false);
        for (const animation of this.animGroups.values()) animation.stop(true);
        this.activeAnimName = "";
      }
      return false;
    }

    this.root.setEnabled(true);
    const dx = state.x - this.root.position.x;
    const dz = state.z - this.root.position.z;
    const displacement = Math.hypot(dx, dz);
    const distance = wasAlive && displacement < 1.8 ? displacement : 0;
    this.root.position.set(state.x, state.y, state.z);
    this.root.rotation.y = state.yaw;
    if (state.activeSlot !== this.activeSlot) {
      this.activeSlot = state.activeSlot;
      this.setWeapon(this.activeSlot === 0 ? this.loadout.primary : this.loadout.secondary);
    }

    this.crouchPose = damp(this.crouchPose, state.sliding || state.crouching ? 1 : 0, 16, dt);
    this.slidePose = damp(this.slidePose, state.sliding ? 1 : 0, 16, dt);
    this.vaultPose = damp(this.vaultPose, state.vaulting ? 1 : 0, 15, dt);
    this.aimPitch = damp(this.aimPitch, state.pitch, 16, dt);
    this.aimPose = damp(this.aimPose, state.ads ? 1 : 0, 16, dt);
    this.iffBeacon.position.y = 1.86 - this.crouchPose * 0.29 - this.slidePose * 0.12;

    // Q/E Tactical lean + hit flinch
    let flinchTilt = 0;
    if (this.flinchTimer > 0) {
      this.flinchTimer -= dt;
      flinchTilt = -0.22;
    }
    this.modelRoot.rotation.z = damp(this.modelRoot.rotation.z, -state.lean * 0.24, 14, dt);
    this.modelRoot.rotation.x = damp(this.modelRoot.rotation.x, flinchTilt + this.slidePose * 0.22, 18, dt);
    this.modelRoot.position.x = damp(this.modelRoot.position.x, state.lean * 0.30, 14, dt);

    this.weaponMount.rotation.x = -state.pitch * 0.85;

    const speed = Math.min(9, dt > 0 ? distance / dt : 0);
    const onFoot = state.grounded && !state.sliding && !state.vaulting && speed > 0.25;
    const forward = onFoot && distance > 0 ? (dx * Math.sin(state.yaw) + dz * Math.cos(state.yaw)) / distance : 0;
    const side = onFoot && distance > 0 ? (dx * Math.cos(state.yaw) - dz * Math.sin(state.yaw)) / distance : 0;
    const forwardClip = forward > 0.74 && !state.crouching;
    this.gaitForward = damp(this.gaitForward, forwardClip ? 0 : forward * Math.min(1, speed / 2.8), 12, dt);
    this.gaitSide = damp(this.gaitSide, forwardClip ? 0 : side * Math.min(1, speed / 3.1), 12, dt);
    this.airbornePose = damp(this.airbornePose, !state.grounded && !state.vaulting ? 1 : 0, 15, dt);
    const clip = forwardClip ? speed > 5.6 ? "run" : "walk" : "idle";
    this.playAnim(clip);
    const movingClip = this.animGroups.get(clip);
    if (movingClip && clip !== "idle") movingClip.speedRatio = Math.min(1.6, Math.max(0.35, speed / (clip === "run" ? 7 : 4.6)));
    this.blendAnimations(dt);
    const lastStride = this.stride;
    if (onFoot) this.stride = advanceStepPhase(this.stride, distance, speed, state.crouching);
    this.fallbackLegs.forEach((leg, index) => {
      const step = Math.sin(this.stride * Math.PI + index * Math.PI);
      leg.rotation.x = step * (forwardClip ? Math.min(speed * 0.12, 0.7) : this.gaitForward * 0.55);
      leg.rotation.z = step * this.gaitSide * 0.38;
    });
    this.lastStepSpeed = speed;
    this.lastStepCrouching = state.crouching;
    return onFoot && Math.floor(this.stride) !== Math.floor(lastStride);
  }

  dispose(): void {
    if (this.rigPoseBefore) this.scene.onBeforeAnimationsObservable.remove(this.rigPoseBefore);
    if (this.rigPoseAfter) this.scene.onAfterAnimationsObservable.remove(this.rigPoseAfter);
    this.weaponMesh?.dispose();
    for (const ag of this.animGroups.values()) ag.dispose();
    for (const m of this.ownedMeshes) m.dispose();
    for (const skeleton of this.skeletons) skeleton.dispose();
    for (const mat of this.ownedMats) mat.dispose();
    this.root.dispose();
  }
}
