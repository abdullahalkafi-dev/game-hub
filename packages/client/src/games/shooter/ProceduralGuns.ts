import { Mesh, MeshBuilder, PBRMaterial, Scene, TransformNode, Vector3 } from "@babylonjs/core";

/**
 * Detailed procedural firearm builders.
 *
 * Coordinate frame: +Z is the muzzle direction, +Y is up, the bore axis sits at y = 0 and the receiver is
 * centred on z = 0. Real-world proportions are used (a rifle is ~0.9 m long, receiver ~0.1 m tall) so the
 * silhouette reads as a solid weapon instead of a thin stick. All static parts parented to `root` are merged
 * per material into a handful of meshes to keep draw calls low (first-person + every remote soldier).
 */

export interface GunMaterials {
  primary: PBRMaterial;
  secondary: PBRMaterial;
  accent: PBRMaterial;
  dark: PBRMaterial;
}

export interface BuiltGun {
  /** y of the top surface of the optic rail */
  railTop: number;
  /** z of the end of the barrel / handguard (muzzle device attaches here) */
  muzzleZ: number;
  underbarrelY: number;
  underbarrelZ: number;
  magSocket: Vector3;
  ejectPos: Vector3;
  boltPos: Vector3;
  firingGrip: Vector3;
  supportGrip: Vector3;
  /** every mesh created (already merged); caller disposes them */
  meshes: Mesh[];
}

interface BuildParams {
  scene: Scene;
  root: TransformNode;
  boltNode: TransformNode;
  magNode: TransformNode;
  idSuffix: string;
  weaponId: string;
  category: "AR" | "SMG" | "SNIPER" | "SHOTGUN" | "PISTOL" | string;
  mats: GunMaterials;
  extendedMag: boolean;
  hasOptic: boolean;
}

type Mat = PBRMaterial;

class Kit {
  readonly statics = new Map<Mat, Mesh[]>();
  readonly loose: Mesh[] = [];
  private n = 0;

  constructor(
    private readonly scene: Scene,
    private readonly root: TransformNode,
    private readonly suffix: string
  ) {}

  private reg(mesh: Mesh, mat: Mat, parent: TransformNode | null): Mesh {
    mesh.material = mat;
    mesh.isPickable = false;
    if (parent && parent !== this.root) {
      mesh.parent = parent;
      this.loose.push(mesh);
    } else {
      mesh.parent = this.root;
      const list = this.statics.get(mat) ?? [];
      list.push(mesh);
      this.statics.set(mat, list);
    }
    return mesh;
  }

  box(
    w: number, h: number, d: number,
    x: number, y: number, z: number,
    mat: Mat,
    rotX = 0, rotY = 0, rotZ = 0,
    parent: TransformNode | null = null
  ): Mesh {
    const m = MeshBuilder.CreateBox(`gb_${this.suffix}_${this.n++}`, { width: w, height: h, depth: d }, this.scene);
    m.position.set(x, y, z);
    m.rotation.set(rotX, rotY, rotZ);
    return this.reg(m, mat, parent);
  }

  /** cylinder along Z */
  cyl(
    diameter: number, length: number,
    x: number, y: number, z: number,
    mat: Mat,
    tess = 16,
    parent: TransformNode | null = null,
    diameterTop = diameter
  ): Mesh {
    const m = MeshBuilder.CreateCylinder(
      `gc_${this.suffix}_${this.n++}`,
      { diameterTop, diameterBottom: diameter, height: length, tessellation: tess },
      this.scene
    );
    m.rotation.x = Math.PI / 2;
    m.position.set(x, y, z);
    return this.reg(m, mat, parent);
  }

  /** cylinder along Y (vertical) */
  vcyl(diameter: number, height: number, x: number, y: number, z: number, mat: Mat, tess = 12, parent: TransformNode | null = null): Mesh {
    const m = MeshBuilder.CreateCylinder(`gv_${this.suffix}_${this.n++}`, { diameter, height, tessellation: tess }, this.scene);
    m.position.set(x, y, z);
    return this.reg(m, mat, parent);
  }

  merge(): Mesh[] {
    const out: Mesh[] = [];
    for (const [mat, list] of this.statics) {
      if (list.length === 1) {
        out.push(list[0]);
        continue;
      }
      for (const m of list) m.computeWorldMatrix(true);
      const merged = Mesh.MergeMeshes(list, true, true, undefined, false, false);
      if (merged) {
        merged.name = `gun_${this.suffix}_${mat.name}`;
        merged.material = mat;
        merged.parent = this.root;
        merged.isPickable = false;
        out.push(merged);
      }
    }
    return [...out, ...this.loose];
  }
}

function magazine(kit: Kit, magNode: TransformNode, mats: GunMaterials, opts: {
  w: number; d: number; h: number; curve: number; mat: Mat; plate: Mat;
}): void {
  const { w, d, h, curve, mat, plate } = opts;
  // Two stacked segments with a small forward kink give the classic banana-ish curve.
  kit.box(w, h * 0.55, d, 0, -h * 0.27, 0, mat, -curve * 0.4, 0, 0, magNode);
  kit.box(w, h * 0.5, d * 0.98, 0, -h * 0.74, d * 0.12 + curve * 0.04, mat, -curve, 0, 0, magNode);
  kit.box(w * 1.1, 0.012, d * 1.08, 0, -h * 0.99, d * 0.17 + curve * 0.06, plate, -curve, 0, 0, magNode);
  // feed lips visible at the top
  kit.box(w * 0.82, 0.01, d * 0.9, 0, 0.004, 0, mats.dark, 0, 0, 0, magNode);
  void mats;
}

function railTeeth(kit: Kit, mats: GunMaterials, y: number, z0: number, z1: number, width: number): void {
  const count = Math.max(2, Math.round((z1 - z0) / 0.026));
  for (let i = 0; i < count; i++) {
    const z = z0 + (i + 0.5) * ((z1 - z0) / count);
    kit.box(width, 0.004, 0.011, 0, y, z, mats.secondary);
  }
}

function mlokSlots(kit: Kit, mats: GunMaterials, zMid: number, length: number, halfW: number, halfH: number): void {
  const n = Math.max(2, Math.floor(length / 0.055));
  for (let i = 0; i < n; i++) {
    const z = zMid - length * 0.42 + (i * length * 0.84) / (n - 1);
    kit.box(0.003, 0.012, 0.034, halfW, 0.002, z, mats.dark);
    kit.box(0.003, 0.012, 0.034, -halfW, 0.002, z, mats.dark);
    kit.box(0.02, 0.003, 0.034, 0, -halfH, z, mats.dark);
  }
}

function trigger(kit: Kit, mats: GunMaterials, z: number, y: number): void {
  kit.box(0.007, 0.004, 0.07, 0, y - 0.028, z + 0.01, mats.secondary); // guard bottom
  kit.box(0.007, 0.03, 0.005, 0, y - 0.013, z + 0.046, mats.secondary); // guard front
  kit.box(0.006, 0.026, 0.008, 0, y - 0.004, z + 0.012, mats.dark, -0.35); // trigger
}

function ironSights(kit: Kit, mats: GunMaterials, frontZ: number, rearZ: number, baseY: number): void {
  // sight line at y = 0.064
  kit.box(0.016, 0.022, 0.022, 0, baseY + 0.011, frontZ, mats.secondary);
  kit.box(0.004, 0.02, 0.006, 0, 0.054, frontZ, mats.dark);
  kit.box(0.007, 0.028, 0.012, 0.012, baseY + 0.014, rearZ, mats.secondary);
  kit.box(0.007, 0.028, 0.012, -0.012, baseY + 0.014, rearZ, mats.secondary);
}

function buildAR(kit: Kit, p: BuildParams, built: BuiltGun): void {
  const { mats, boltNode, magNode } = p;
  const isAk = p.weaponId === "akm";

  if (!isAk) {
    // --- M4/HK-style carbine ---
    kit.box(0.052, 0.064, 0.30, 0, 0.004, 0.0, mats.primary); // upper
    kit.box(0.0535, 0.008, 0.06, 0, 0.024, -0.06, mats.primary); // ejection port bulge
    kit.box(0.004, 0.022, 0.07, 0.027, 0.014, -0.02, mats.dark); // ejection port
    kit.box(0.048, 0.052, 0.21, 0, -0.046, -0.03, mats.primary); // lower
    kit.box(0.044, 0.04, 0.08, 0, -0.082, 0.035, mats.primary); // magwell flare
    kit.box(0.008, 0.016, 0.014, 0.027, -0.034, -0.04, mats.dark); // selector
    kit.box(0.006, 0.02, 0.024, 0.027, -0.058, -0.012, mats.secondary); // mag release
    // forward assist & dust-cover hint
    kit.box(0.012, 0.014, 0.02, 0.029, 0.008, -0.1, mats.secondary);

    // free-float quad-rail handguard
    const hgLen = 0.31;
    const hgZ = 0.15 + hgLen / 2;
    kit.box(0.062, 0.058, hgLen, 0, -0.006, hgZ, mats.primary);
    kit.box(0.066, 0.01, 0.025, 0, 0.0, 0.15 + 0.012, mats.secondary); // delta ring
    mlokSlots(kit, mats, hgZ, hgLen, 0.0315, 0.034);
    kit.box(0.056, 0.012, hgLen * 0.96, 0, -0.041, hgZ, mats.secondary); // bottom rail

    // continuous top rail
    kit.box(0.027, 0.008, 0.60, 0, 0.0405, 0.16, mats.secondary);
    railTeeth(kit, mats, 0.0455, -0.13, 0.46, 0.029);

    // barrel + gas block + flash hider
    kit.cyl(0.022, 0.12, 0, 0.0, 0.15 + hgLen + 0.05, mats.secondary, 16);
    kit.cyl(0.03, 0.055, 0, 0.0, 0.15 + hgLen + 0.1, mats.dark, 14);
    built.muzzleZ = 0.15 + hgLen + 0.125;

    // pistol grip + guard
    kit.box(0.036, 0.11, 0.046, 0, -0.118, -0.118, mats.accent, 0.38);
    kit.box(0.04, 0.02, 0.05, 0, -0.07, -0.098, mats.accent);
    trigger(kit, mats, -0.07, -0.07);

    // adjustable stock
    kit.cyl(0.036, 0.19, 0, 0.0, -0.235, mats.secondary, 16);
    kit.box(0.044, 0.085, 0.14, 0, -0.016, -0.30, mats.primary, 0.05);
    kit.box(0.04, 0.02, 0.1, 0, 0.034, -0.295, mats.primary); // cheek riser
    kit.box(0.048, 0.118, 0.022, 0, -0.026, -0.385, mats.accent, 0.1);

    built.magSocket.set(0, -0.098, 0.035);
    built.ejectPos.set(0.032, 0.014, -0.02);
    built.boltPos.set(0.0, 0.043, -0.12);
    built.firingGrip.set(0, -0.118, -0.118);
    built.railTop = 0.0495;
    built.underbarrelY = -0.043;
    built.underbarrelZ = 0.15 + hgLen - 0.06;
    built.supportGrip.set(-0.004, -0.058, hgZ);

    magazine(kit, magNode, mats, { w: 0.03, d: 0.052, h: p.extendedMag ? 0.215 : 0.15, curve: 0.12, mat: mats.dark, plate: mats.secondary });
    kit.box(0.034, 0.012, 0.05, 0, 0.0, 0, mats.dark, 0, 0, 0, boltNode);
    kit.box(0.026, 0.01, 0.02, 0.0, 0.003, 0.0, mats.secondary, 0, 0, 0, boltNode); // charging handle
  } else {
    // --- AK-style rifle ---
    kit.box(0.05, 0.05, 0.36, 0, -0.002, 0.0, mats.secondary); // stamped receiver
    kit.cyl(0.054, 0.30, 0, 0.012, 0.0, mats.secondary, 18); // rounded dust cover
    kit.box(0.052, 0.034, 0.24, 0, -0.04, -0.03, mats.secondary); // trigger group
    kit.box(0.052, 0.04, 0.08, 0, -0.07, 0.04, mats.secondary); // mag well
    kit.box(0.004, 0.02, 0.07, 0.026, 0.0, -0.02, mats.dark); // ejection port
    kit.box(0.008, 0.012, 0.012, 0.028, 0.018, -0.08, mats.dark); // charging handle slot

    // gas tube + wood furniture
    kit.cyl(0.02, 0.30, 0, 0.034, 0.32, mats.secondary, 12);
    kit.box(0.054, 0.052, 0.19, 0, -0.012, 0.275, mats.accent); // lower handguard
    kit.box(0.052, 0.024, 0.15, 0, 0.034, 0.255, mats.accent); // upper heat shield
    kit.box(0.05, 0.02, 0.012, 0, -0.004, 0.185, mats.secondary); // handguard cap
    kit.cyl(0.02, 0.26, 0, 0.0, 0.46, mats.secondary, 14); // barrel
    kit.cyl(0.028, 0.03, 0, 0.0, 0.2, mats.dark, 10); // gas block
    kit.box(0.014, 0.05, 0.02, 0, 0.032, 0.5, mats.secondary); // front sight tower
    kit.box(0.004, 0.022, 0.006, 0, 0.056, 0.5, mats.dark);
    kit.cyl(0.03, 0.065, 0, 0.0, 0.605, mats.dark, 12); // muzzle brake
    built.muzzleZ = 0.64;

    // top cover rail adapter (so optics still mount)
    kit.box(0.026, 0.008, 0.22, 0, 0.044, -0.01, mats.secondary);
    railTeeth(kit, mats, 0.0485, -0.1, 0.09, 0.028);
    kit.box(0.014, 0.024, 0.016, 0, 0.036, -0.14, mats.secondary); // rear sight block
    kit.box(0.04, 0.018, 0.04, 0, 0.046, -0.14, mats.secondary);

    // pistol grip + guard
    kit.box(0.036, 0.11, 0.05, 0, -0.118, -0.126, mats.accent, 0.4);
    trigger(kit, mats, -0.07, -0.06);

    // fixed wooden stock
    kit.box(0.04, 0.056, 0.2, 0, -0.01, -0.28, mats.accent, 0.1);
    kit.box(0.044, 0.1, 0.1, 0, -0.04, -0.40, mats.accent, 0.12);
    kit.box(0.048, 0.116, 0.014, 0, -0.04, -0.455, mats.dark, 0.12);

    built.magSocket.set(0, -0.092, 0.03);
    built.ejectPos.set(0.032, 0.006, -0.02);
    built.boltPos.set(0.0, 0.0, 0.0);
    built.firingGrip.set(0, -0.118, -0.126);
    built.railTop = 0.0525;
    built.underbarrelY = -0.04;
    built.underbarrelZ = 0.3;
    built.supportGrip.set(-0.004, -0.045, 0.275);

    magazine(kit, magNode, mats, { w: 0.036, d: 0.07, h: p.extendedMag ? 0.24 : 0.17, curve: 0.3, mat: mats.dark, plate: mats.secondary });
    kit.box(0.02, 0.014, 0.034, 0.03, 0.005, 0.0, mats.secondary, 0, 0, 0, boltNode); // charging lug
  }
}

function buildSMG(kit: Kit, p: BuildParams, built: BuiltGun): void {
  const { mats, boltNode, magNode } = p;
  const isVector = p.weaponId === "vector";

  if (isVector) {
    kit.box(0.056, 0.098, 0.30, 0, -0.01, 0.0, mats.primary); // angular body
    kit.box(0.06, 0.046, 0.22, 0, -0.012, 0.22, mats.primary); // forward shroud (lower)
    kit.box(0.044, 0.036, 0.16, 0, 0.02, 0.2, mats.secondary);
    mlokSlots(kit, mats, 0.22, 0.2, 0.0305, 0.023);
    kit.box(0.027, 0.008, 0.46, 0, 0.0445, 0.04, mats.secondary);
    railTeeth(kit, mats, 0.049, -0.1, 0.26, 0.029);
    kit.cyl(0.022, 0.1, 0, 0.0, 0.36, mats.secondary, 14);
    built.muzzleZ = 0.4;
    kit.cyl(0.03, 0.04, 0, 0.0, 0.385, mats.dark, 12);

    // forward angled grip + big magwell hump under the grip
    kit.box(0.038, 0.1, 0.05, 0, -0.1, -0.075, mats.accent, 0.5);
    kit.box(0.044, 0.06, 0.08, 0, -0.075, 0.03, mats.primary);
    trigger(kit, mats, -0.04, -0.05);
    // short folded stock stub
    kit.box(0.044, 0.08, 0.1, 0, -0.01, -0.2, mats.secondary);
    kit.box(0.048, 0.1, 0.016, 0, -0.01, -0.26, mats.accent);

    built.magSocket.set(0, -0.105, 0.03);
    built.ejectPos.set(0.032, 0.02, -0.02);
    built.boltPos.set(0.0, 0.046, -0.1);
    built.firingGrip.set(0, -0.112, -0.075);
    built.railTop = 0.0505;
    built.underbarrelY = -0.036;
    built.underbarrelZ = 0.3;
    built.supportGrip.set(-0.004, -0.04, 0.23);
    magazine(kit, magNode, mats, { w: 0.03, d: 0.05, h: p.extendedMag ? 0.2 : 0.14, curve: 0.04, mat: mats.dark, plate: mats.secondary });
  } else {
    // UMP-style boxy polymer SMG
    kit.box(0.058, 0.078, 0.36, 0, 0.002, 0.0, mats.primary);
    kit.box(0.0595, 0.012, 0.3, 0, 0.034, 0.0, mats.secondary);
    kit.box(0.004, 0.02, 0.07, 0.03, 0.01, -0.01, mats.dark);
    kit.box(0.052, 0.05, 0.1, 0, -0.058, 0.0, mats.primary); // lower
    kit.box(0.05, 0.05, 0.12, 0, -0.005, 0.24, mats.primary); // shroud
    kit.cyl(0.024, 0.1, 0, 0.0, 0.34, mats.secondary, 14);
    kit.cyl(0.032, 0.05, 0, 0.0, 0.385, mats.dark, 12);
    built.muzzleZ = 0.41;
    kit.box(0.027, 0.008, 0.4, 0, 0.0445, 0.04, mats.secondary);
    railTeeth(kit, mats, 0.049, -0.12, 0.24, 0.029);

    kit.box(0.036, 0.11, 0.05, 0, -0.118, -0.1, mats.accent, 0.3);
    trigger(kit, mats, -0.06, -0.06);

    // wire stock with butt plate
    kit.box(0.008, 0.008, 0.2, 0.02, 0.0, -0.26, mats.secondary);
    kit.box(0.008, 0.008, 0.2, -0.02, 0.0, -0.26, mats.secondary);
    kit.box(0.008, 0.07, 0.008, 0.02, -0.03, -0.355, mats.secondary);
    kit.box(0.008, 0.07, 0.008, -0.02, -0.03, -0.355, mats.secondary);
    kit.box(0.048, 0.09, 0.02, 0, -0.03, -0.365, mats.accent);

    built.magSocket.set(0, -0.083, 0.02);
    built.ejectPos.set(0.032, 0.016, -0.02);
    built.boltPos.set(0.0, 0.04, -0.14);
    built.firingGrip.set(0, -0.118, -0.1);
    built.railTop = 0.0505;
    built.underbarrelY = -0.032;
    built.underbarrelZ = 0.28;
    built.supportGrip.set(-0.004, -0.032, 0.25);
    magazine(kit, magNode, mats, { w: 0.03, d: 0.058, h: p.extendedMag ? 0.22 : 0.16, curve: 0.02, mat: mats.dark, plate: mats.secondary });
  }
  kit.box(0.022, 0.01, 0.024, 0.0, 0.0, 0.0, mats.secondary, 0, 0, 0, boltNode);
}

function buildShotgun(kit: Kit, p: BuildParams, built: BuiltGun): void {
  const { mats, boltNode, magNode } = p;
  kit.box(0.052, 0.074, 0.24, 0, 0.0, 0.0, mats.secondary); // receiver
  kit.box(0.004, 0.02, 0.09, 0.027, 0.01, 0.0, mats.dark); // ejection port
  kit.cyl(0.03, 0.5, 0, 0.012, 0.37, mats.secondary, 16); // barrel
  kit.cyl(0.027, 0.42, 0, -0.03, 0.33, mats.secondary, 14); // magazine tube
  kit.cyl(0.036, 0.02, 0, -0.03, 0.55, mats.dark, 14); // tube cap
  kit.box(0.02, 0.012, 0.5, 0, 0.032, 0.34, mats.secondary); // vent rib
  kit.box(0.008, 0.02, 0.01, 0, 0.044, 0.58, mats.dark); // bead sight
  built.muzzleZ = 0.62;
  kit.cyl(0.034, 0.03, 0, 0.012, 0.6, mats.dark, 14);

  kit.box(0.058, 0.052, 0.2, 0, -0.03, 0.34, mats.accent); // pump forend
  for (let i = 0; i < 5; i++) kit.box(0.06, 0.006, 0.01, 0, -0.03, 0.27 + i * 0.03, mats.dark);

  kit.box(0.04, 0.082, 0.14, 0, -0.016, -0.18, mats.accent, 0.1); // stock wrist
  kit.box(0.044, 0.1, 0.2, 0, -0.04, -0.33, mats.accent, 0.13);
  kit.box(0.048, 0.12, 0.02, 0, -0.05, -0.445, mats.dark, 0.13);
  kit.box(0.036, 0.09, 0.044, 0, -0.098, -0.07, mats.accent, 0.25);
  trigger(kit, mats, -0.04, -0.04);
  kit.box(0.026, 0.008, 0.22, 0, 0.041, 0.0, mats.secondary);
  railTeeth(kit, mats, 0.0455, -0.09, 0.09, 0.027);

  built.magSocket.set(0, -0.04, 0.03);
  built.ejectPos.set(0.032, 0.01, 0.0);
  built.boltPos.set(0.0, 0.0, 0.0);
  built.firingGrip.set(0, -0.1, -0.07);
  built.railTop = 0.0455;
  built.underbarrelY = -0.06;
  built.underbarrelZ = 0.4;
  built.supportGrip.set(-0.004, -0.062, 0.34);
  kit.box(0.02, 0.012, 0.04, 0, 0.0, 0.0, mats.dark, 0, 0, 0, magNode); // single shell stub (no mag animation needed)
  kit.box(0.02, 0.012, 0.02, 0.028, 0.0, 0.0, mats.secondary, 0, 0, 0, boltNode);
}

function buildPistol(kit: Kit, p: BuildParams, built: BuiltGun): void {
  const { mats, boltNode, magNode } = p;
  kit.box(0.034, 0.045, 0.21, 0, 0.022, 0.0, mats.secondary); // slide
  for (let i = 0; i < 6; i++) kit.box(0.036, 0.034, 0.005, 0, 0.024, -0.075 + i * 0.01, mats.dark); // serrations
  kit.box(0.004, 0.02, 0.05, 0.018, 0.026, 0.02, mats.dark); // ejection port
  kit.box(0.032, 0.034, 0.17, 0, -0.016, -0.01, mats.primary); // frame
  kit.box(0.027, 0.024, 0.08, 0, -0.012, 0.13, mats.primary); // dust cover rail
  kit.cyl(0.02, 0.03, 0, 0.022, 0.11, mats.dark, 12);
  built.muzzleZ = 0.118;
  kit.box(0.036, 0.1, 0.05, 0, -0.07, -0.062, mats.accent, 0.2); // grip
  kit.box(0.007, 0.004, 0.06, 0, -0.04, 0.03, mats.secondary);
  kit.box(0.007, 0.024, 0.005, 0, -0.03, 0.057, mats.secondary);
  kit.box(0.006, 0.02, 0.008, 0, -0.026, 0.012, mats.dark, -0.3);
  kit.box(0.008, 0.012, 0.01, 0, 0.048, 0.1, mats.dark); // front sight
  kit.box(0.014, 0.012, 0.01, 0, 0.048, -0.095, mats.dark); // rear sight
  built.railTop = 0.046;
  built.magSocket.set(0, -0.06, -0.05);
  built.ejectPos.set(0.02, 0.026, 0.02);
  built.boltPos.set(0.0, 0.0, 0.0);
  built.firingGrip.set(0, -0.075, -0.06);
  built.supportGrip.set(-0.021, -0.09, -0.045);
  built.underbarrelY = -0.03;
  built.underbarrelZ = 0.09;
  kit.box(0.028, 0.03, 0.045, 0, -0.02, 0, mats.dark, 0, 0, 0, magNode);
  kit.box(0.02, 0.01, 0.02, 0, 0.0, 0.0, mats.secondary, 0, 0, 0, boltNode);
}

function buildBoltRifle(kit: Kit, p: BuildParams, built: BuiltGun): void {
  const { mats, boltNode, magNode } = p;
  kit.box(0.05, 0.07, 0.26, 0, 0.002, 0.0, mats.secondary); // receiver
  kit.cyl(0.03, 0.62, 0, 0.012, 0.45, mats.secondary, 18); // heavy barrel
  kit.cyl(0.038, 0.05, 0, 0.012, 0.76, mats.dark, 14); // muzzle brake
  built.muzzleZ = 0.785;
  kit.box(0.06, 0.06, 0.44, 0, -0.012, 0.3, mats.accent); // forend
  kit.box(0.05, 0.1, 0.34, 0, -0.03, -0.28, mats.accent, 0.1); // stock
  kit.box(0.05, 0.13, 0.02, 0, -0.05, -0.455, mats.dark, 0.1);
  kit.box(0.036, 0.1, 0.05, 0, -0.1, -0.1, mats.accent, 0.3);
  trigger(kit, mats, -0.06, -0.05);
  kit.box(0.026, 0.008, 0.3, 0, 0.0455, 0.02, mats.secondary);
  railTeeth(kit, mats, 0.05, -0.12, 0.16, 0.028);
  built.railTop = 0.0535;
  built.magSocket.set(0, -0.06, 0.02);
  built.ejectPos.set(0.032, 0.01, 0.02);
  built.boltPos.set(0.0, 0.0, 0.0);
  built.firingGrip.set(0, -0.112, -0.1);
  built.underbarrelY = -0.045;
  built.underbarrelZ = 0.45;
  built.supportGrip.set(-0.004, -0.045, 0.34);
  kit.box(0.036, 0.1, 0.056, 0, -0.05, 0, mats.dark, 0, 0, 0, magNode);
  kit.box(0.012, 0.012, 0.05, 0.03, 0.008, 0, mats.secondary, 0, 0, 0, boltNode); // bolt handle shank
  const knob = MeshBuilder.CreateSphere(`bolt_knob_${p.idSuffix}`, { diameter: 0.026, segments: 8 }, p.scene);
  knob.parent = boltNode;
  knob.position.set(0.05, 0.0, 0.0);
  knob.material = mats.accent;
  knob.isPickable = false;
  kit.loose.push(knob);
}

export function buildProceduralGun(p: BuildParams): BuiltGun {
  const kit = new Kit(p.scene, p.root, p.idSuffix);
  const built: BuiltGun = {
    railTop: 0.05,
    muzzleZ: 0.5,
    underbarrelY: -0.04,
    underbarrelZ: 0.3,
    magSocket: new Vector3(0, -0.09, 0.03),
    ejectPos: new Vector3(0.032, 0.014, -0.02),
    boltPos: new Vector3(0, 0.04, -0.1),
    firingGrip: new Vector3(0, -0.118, -0.118),
    supportGrip: new Vector3(-0.004, -0.058, 0.3),
    meshes: [],
  };

  switch (p.category) {
    case "PISTOL":
      buildPistol(kit, p, built);
      break;
    case "SHOTGUN":
      buildShotgun(kit, p, built);
      break;
    case "SNIPER":
      buildBoltRifle(kit, p, built);
      break;
    case "SMG":
      buildSMG(kit, p, built);
      break;
    default:
      buildAR(kit, p, built);
  }

  // Iron sights only when no optic occupies the rail.
  if (!p.hasOptic && p.category !== "PISTOL" && p.weaponId !== "akm") {
    const base = built.railTop;
    ironSights(kit, p.mats, Math.max(0.2, built.muzzleZ - 0.14), -0.12, base);
  }

  built.meshes = kit.merge();
  return built;
}
