import {
  Color3, DynamicTexture, Matrix, MeshBuilder, PBRMaterial, Quaternion, SceneLoader, TransformNode, Vector3, VertexBuffer,
  type AbstractMesh, type Scene,
} from "@babylonjs/core";

interface Limb {
  shoulder: TransformNode;
  upper: TransformNode;
  lower: TransformNode;
  wrist: TransformNode;
  socket: TransformNode;
  rest: Quaternion[];
  fingers: { joint: TransformNode; rest: Quaternion; curl: number }[];
  lastGrip: number;
}

export class FirstPersonArms {
  private root: TransformNode | null = null;
  private right: Limb | null = null;
  private left: Limb | null = null;
  private disposed = false;
  private clothTexture: DynamicTexture | null = null;
  private readonly inverse = Matrix.Identity();
  private readonly turn = Quaternion.Identity();
  private readonly scratch = new Vector3();
  private readonly aimFrom = new Vector3();
  private readonly aimTo = new Vector3();
  private readonly fore = new Vector3();
  private readonly shoulder = new Vector3();
  private readonly elbowBias = new Vector3();
  private readonly reach = new Vector3();
  private readonly reachDirection = new Vector3();
  private readonly originalUpper = new Vector3();
  private readonly target = new Vector3();
  private readonly palmAxis = new Vector3();
  private readonly palmNormal = new Vector3();
  private readonly rollCross = new Vector3();

  constructor(scene: Scene, parent: TransformNode) {
    void SceneLoader.ImportMeshAsync(null, "/assets/models/view-arms/", "arms.glb", scene).then((model) => {
      const root = model.meshes[0];
      if (!root || this.disposed || scene.isDisposed) {
        root?.dispose(false, true);
        return;
      }
      const joints = new Map(model.transformNodes.map((joint) => [joint.name, joint]));
      for (const skeleton of model.skeletons) {
        for (const bone of skeleton.bones) {
          const linked = bone.getTransformNode();
          if (linked) joints.set(bone.name, linked);
        }
      }
      this.left = this.getLimb(joints, "l");
      this.right = this.getLimb(joints, "r");
      if (!this.left || !this.right) {
        root.dispose(false, true);
        return;
      }
      root.parent = parent;
      root.scaling.scaleInPlace(0.109);
      let clothed = false;
      for (const mesh of model.meshes) {
        mesh.isPickable = false;
        mesh.alwaysSelectAsActiveMesh = true;
        if (mesh.skeleton) {
          if (!this.applyClothing(mesh)) {
            root.dispose(false, true);
            return;
          }
          clothed = true;
        }
      }
      if (!clothed) {
        root.dispose(false, true);
        return;
      }
      const cuffMaterial = new PBRMaterial("vm_wrist_cuff", scene);
      cuffMaterial.albedoColor = Color3.FromHexString("#3c4733").toLinearSpace();
      cuffMaterial.emissiveColor.set(0.010, 0.012, 0.010);
      cuffMaterial.metallic = 0;
      cuffMaterial.roughness = 0.92;
      for (const limb of [this.left, this.right]) {
        const path = [-0.33, -0.25, -0.13, -0.03].map((offset) => new Vector3(0, limb.wrist.position.y + offset, 0));
        const radii = [0.28, 0.32, 0.30, 0.27];
        const cuff = MeshBuilder.CreateTube(`cuff_${limb.wrist.name}`, {
          path, radiusFunction: (index) => radii[index], tessellation: 12,
        }, scene);
        cuff.parent = limb.lower;
        cuff.scaling.z = 0.88;
        cuff.material = cuffMaterial;
        cuff.isPickable = false;
      }
      root.setEnabled(false);
      this.root = root;
    }).catch(() => { /* The procedural arms are available while loading and if the model is unavailable. */ });
  }

  private weave(scene: Scene): DynamicTexture {
    if (this.clothTexture) return this.clothTexture;
    const texture = new DynamicTexture("vm_cloth_weave", 64, scene, true);
    const ctx = texture.getContext();
    const pixels = new ImageData(64, 64);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const offset = (y * 64 + x) * 4;
        const thread = (x % 4 < 2) === (y % 4 < 2) ? 15 : 0;
        const grain = ((x * 41) ^ (y * 29) ^ (x * y)) & 15;
        pixels.data[offset] = pixels.data[offset + 1] = pixels.data[offset + 2] = 222 + thread + grain;
        pixels.data[offset + 3] = 255;
      }
    }
    ctx.putImageData(pixels, 0, 0);
    texture.uScale = 5;
    texture.vScale = 5;
    texture.update();
    this.clothTexture = texture;
    return texture;
  }

  private applyClothing(mesh: AbstractMesh): boolean {
    if (!(mesh.material instanceof PBRMaterial) || !mesh.skeleton) return false;
    const joints = mesh.getVerticesData(VertexBuffer.MatricesIndicesKind);
    const weights = mesh.getVerticesData(VertexBuffer.MatricesWeightsKind);
    if (!joints || !weights) return false;
    const fabric = Color3.FromHexString("#46543b").toLinearSpace();
    const glove = Color3.FromHexString("#272c2d").toLinearSpace();
    const pad = Color3.FromHexString("#404442").toLinearSpace();
    const palette = new Map(mesh.skeleton.bones.map((bone) => [
      bone.getIndex(),
      bone.name.startsWith("finger_") ? (bone.name.includes("1.") ? pad : glove)
        : bone.name.startsWith("wrist.") ? glove : fabric,
    ]));
    const colors = new Float32Array(weights.length);
    for (let i = 0; i < weights.length; i += 4) {
      for (let j = i; j < i + 4; j++) {
        const shade = palette.get(joints[j]) ?? fabric;
        colors[i] += shade.r * weights[j];
        colors[i + 1] += shade.g * weights[j];
        colors[i + 2] += shade.b * weights[j];
      }
      colors[i + 3] = 1;
    }
    mesh.setVerticesData(VertexBuffer.ColorKind, colors);
    mesh.useVertexColors = true;
    const skinTexture = mesh.material.albedoTexture;
    const cloth = this.weave(mesh.getScene());
    mesh.material.albedoTexture = cloth;
    if (skinTexture !== cloth) skinTexture?.dispose();
    mesh.material.albedoColor.set(1, 1, 1);
    mesh.material.emissiveColor.set(0.010, 0.012, 0.010);
    mesh.material.metallic = 0;
    mesh.material.roughness = 0.92;
    return true;
  }

  private getLimb(joints: Map<string, TransformNode>, side: "l" | "r"): Limb | null {
    const shoulder = joints.get(`shoulder.${side}`);
    const upper = joints.get(`bicep.${side}`);
    const lower = joints.get(`forearm.${side}`);
    const wrist = joints.get(`wrist.${side}`);
    const socket = joints.get(`socket.${side}`);
    if (!shoulder || !upper?.rotationQuaternion || !lower?.rotationQuaternion || !wrist?.rotationQuaternion || !socket) return null;
    const fingers: Limb["fingers"] = [];
    for (const [name, joint] of joints) {
      if (!name.startsWith("finger_") || !name.endsWith("." + side) || !joint.rotationQuaternion) continue;
      const curl = name.includes("thumb") ? 0.24 : name.includes("index") && side === "r" ? 0.30
        : name.includes("2.") ? 0.90 : 0.64;
      fingers.push({ joint, rest: joint.rotationQuaternion.clone(), curl });
    }
    return { shoulder, upper, lower, wrist, socket,
      rest: [upper.rotationQuaternion.clone(), lower.rotationQuaternion.clone(), wrist.rotationQuaternion.clone()],
      fingers, lastGrip: -1 };
  }

  private rollPalm(wrist: TransformNode, basis: Matrix, towardGrip: Vector3, side: number): void {
    if (!(wrist.parent instanceof TransformNode)) return;
    wrist.parent.computeWorldMatrix(true).invertToRef(this.inverse);
    Vector3.TransformNormalToRef(towardGrip, this.inverse, this.palmAxis);
    this.palmAxis.normalize();
    this.scratch.set(-side, 0, 0);
    Vector3.TransformNormalToRef(this.scratch, wrist.getWorldMatrix(), this.palmNormal);
    Vector3.TransformNormalToRef(this.palmNormal, this.inverse, this.aimFrom);
    this.scratch.set(side > 0 ? -1 : 0.18, side > 0 ? 0.20 : 1, 0);
    Vector3.TransformNormalToRef(this.scratch, basis, this.palmNormal);
    Vector3.TransformNormalToRef(this.palmNormal, this.inverse, this.aimTo);
    this.palmAxis.scaleToRef(Vector3.Dot(this.aimFrom, this.palmAxis), this.scratch);
    this.aimFrom.subtractInPlace(this.scratch).normalize();
    this.palmAxis.scaleToRef(Vector3.Dot(this.aimTo, this.palmAxis), this.scratch);
    this.aimTo.subtractInPlace(this.scratch).normalize();
    if (this.aimFrom.lengthSquared() < 0.5 || this.aimTo.lengthSquared() < 0.5) return;
    Vector3.CrossToRef(this.aimFrom, this.aimTo, this.rollCross);
    const roll = Math.atan2(Vector3.Dot(this.palmAxis, this.rollCross), Vector3.Dot(this.aimFrom, this.aimTo));
    Quaternion.RotationAxisToRef(this.palmAxis, roll, this.turn);
    this.turn.multiplyToRef(wrist.rotationQuaternion!, wrist.rotationQuaternion!);
  }

  private aimJoint(joint: TransformNode, from: Vector3, to: Vector3): void {
    if (!(joint.parent instanceof TransformNode) || !joint.rotationQuaternion) return;
    joint.parent.computeWorldMatrix(true).invertToRef(this.inverse);
    Vector3.TransformNormalToRef(from, this.inverse, this.aimFrom);
    Vector3.TransformNormalToRef(to, this.inverse, this.aimTo);
    const current = this.aimFrom.normalize();
    const desired = this.aimTo.normalize();
    if (desired.lengthSquared() < 0.5 || current.lengthSquared() < 0.5) return;
    Quaternion.FromUnitVectorsToRef(current, desired, this.turn);
    this.turn.multiplyToRef(joint.rotationQuaternion, joint.rotationQuaternion);
    joint.computeWorldMatrix(true);
  }

  private poseArm(limb: Limb, basis: Matrix, side: number, hand: Vector3, grip: number): void {
    const { upper, lower, wrist, socket, rest } = limb;
    upper.rotationQuaternion!.copyFrom(rest[0]);
    lower.rotationQuaternion!.copyFrom(rest[1]);
    wrist.rotationQuaternion!.copyFrom(rest[2]);
    this.scratch.set(side * 0.21, -0.29, side > 0 ? -0.40 : -0.21);
    const shoulder = this.shoulder;
    Vector3.TransformCoordinatesToRef(this.scratch, basis, shoulder);
    this.scratch.set(side * 0.036, -0.018, -0.072);
    Vector3.TransformNormalToRef(this.scratch, basis, this.target);
    this.target.addInPlace(hand);
    upper.computeWorldMatrix(true);
    shoulder.subtractToRef(upper.getAbsolutePosition(), this.scratch);
    this.scratch.addInPlace(limb.shoulder.getAbsolutePosition());
    limb.shoulder.setAbsolutePosition(this.scratch);
    upper.computeWorldMatrix(true);
    lower.computeWorldMatrix(true);
    wrist.computeWorldMatrix(true);
    const upperVec = lower.getAbsolutePosition().subtractToRef(shoulder, this.originalUpper);
    const upperLength = upperVec.length();
    const lowerLength = Vector3.Distance(lower.getAbsolutePosition(), wrist.getAbsolutePosition());
    const reach = this.target.subtractToRef(shoulder, this.reach);
    const direction = reach.normalizeToRef(this.reachDirection);
    const length = Math.max(Math.abs(upperLength - lowerLength) + 0.01, Math.min(reach.length(), upperLength + lowerLength - 0.01));
    const along = (upperLength ** 2 + length ** 2 - lowerLength ** 2) / (2 * length);
    this.scratch.set(side * 0.36, -1, 0);
    Vector3.TransformNormalToRef(this.scratch, basis, this.elbowBias);
    direction.scaleToRef(Vector3.Dot(this.elbowBias, direction), this.scratch);
    const bend = this.elbowBias.subtractInPlace(this.scratch).normalize();
    direction.scaleToRef(along, this.scratch);
    this.aimJoint(upper, upperVec, this.scratch.addInPlace(bend.scaleInPlace(Math.sqrt(Math.max(0, upperLength ** 2 - along ** 2)))));
    lower.computeWorldMatrix(true);
    wrist.computeWorldMatrix(true);
    const elbow = lower.getAbsolutePosition();
    const currentLower = wrist.getAbsolutePosition().subtractToRef(elbow, this.originalUpper);
    direction.scaleToRef(length, this.scratch);
    this.aimJoint(lower, currentLower, this.scratch.addInPlace(shoulder).subtractInPlace(elbow));
    wrist.computeWorldMatrix(true);
    socket.computeWorldMatrix(true);
    const palm = socket.getAbsolutePosition().subtractToRef(wrist.getAbsolutePosition(), this.originalUpper);
    const towardGrip = hand.subtractToRef(wrist.getAbsolutePosition(), this.fore);
    this.aimJoint(wrist, palm, towardGrip);
    this.rollPalm(wrist, basis, towardGrip, side);
    if (limb.lastGrip === grip) return;
    limb.lastGrip = grip;
    for (const finger of limb.fingers) {
      Quaternion.RotationAxisToRef(Vector3.LeftHandedForwardReadOnly, side * finger.curl * grip, this.turn);
      finger.rest.multiplyToRef(this.turn, finger.joint.rotationQuaternion!);
    }
  }

  update(basis: Matrix, right: Vector3, left: Vector3, leftGrip: number, visible: boolean): boolean {
    if (!this.root || !this.left || !this.right) return false;
    this.root.setEnabled(visible);
    if (!visible) return false;
    this.root.computeWorldMatrix(true);
    this.poseArm(this.right, basis, 1, right, 1);
    this.poseArm(this.left, basis, -1, left, leftGrip);
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.root?.dispose(false, true);
    this.clothTexture?.dispose();
  }
}
