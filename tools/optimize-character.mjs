// Shrinks a rigged character so it is cheap to download and to animate for every player in a match.
//
//   node tools/optimize-character.mjs <in.glb> <out.glb> [--tris 20000] [--tex 512] [--quality 85]
//
// Character exports from game engines carry hundreds of bones (fingers, face, cloth, FX sockets) and
// 200k triangles. The game only needs a body skeleton, so this:
//   1. drops meshes that are invisible at play distance (teeth, eyelashes, eyes, tear lines, eyebrows)
//   2. keeps ~24 body bones; every vertex weight on a removed bone moves to the nearest kept ancestor
//   3. removes the animation tracks of removed bones
//   4. merges duplicate data, simplifies the meshes, shrinks textures to WebP
// It deliberately skips quantize(): quantizing skinned meshes shifts them off their skeleton.
import fs from "node:fs";
import { Accessor, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, prune, simplify, textureCompress, weld } from "@gltf-transform/functions";
import { MeshoptSimplifier } from "meshoptimizer";
import sharp from "sharp";

const [input, output, ...flags] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: node tools/optimize-character.mjs <in.glb> <out.glb> [--tris N] [--tex PX] [--quality Q]");
  process.exit(1);
}
const flag = (name, fallback) => {
  const i = flags.indexOf("--" + name);
  return i >= 0 ? Number(flags[i + 1]) : fallback;
};
const targetTris = flag("tris", 20000);
const texSize = flag("tex", 512);
const quality = flag("quality", 85);

/** Materials whose meshes are not worth drawing for a player seen from a few metres away. */
const DROP_MATERIAL = /teeth|eyelash|tearline|eyebrow|iris|sclera/i;
/** Joint names (without the trailing _NNN export suffix) that are kept. */
const BODY_JOINT = /^Bip001(_Pelvis|_Spine\d?|_Neck|_Head|_[LR]_(Clavicle|UpperArm|Forearm|Hand|Thigh|Calf|Foot|Toe0))?$/;
/** Set KEEP_ALL_BONES=1 to keep the whole skeleton (bigger, but weights stay untouched). */
const KEEP_JOINT = process.env.KEEP_ALL_BONES ? /./ : BODY_JOINT;
const baseName = (node) => node.getName().replace(/_\d+$/, "");

const triangleCount = (doc) => {
  let tris = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const indices = prim.getIndices();
      tris += (indices ? indices.getCount() : prim.getAttribute("POSITION").getCount()) / 3;
    }
  }
  return Math.round(tris);
};

await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(input);
const root = doc.getRoot();
const trisBefore = triangleCount(doc);

// 1. Drop tiny detail meshes.
for (const node of root.listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  const material = mesh.listPrimitives()[0]?.getMaterial()?.getName() ?? "";
  if (DROP_MATERIAL.test(material)) {
    node.setMesh(null).setSkin(null);
    mesh.dispose();
  }
}

// 2. Collapse the skeleton onto the kept body bones.
const skin = root.listSkins()[0];
const oldJoints = skin.listJoints();
const oldIbm = skin.getInverseBindMatrices().getArray();
const keptSet = new Set(oldJoints.filter((j) => KEEP_JOINT.test(baseName(j))));
const kept = oldJoints.filter((j) => keptSet.has(j));
// Bones above the body skeleton (armature / dummy roots) carry the model's scale and axis conversion, so they stay in the skin.
const needed = new Set(kept);
for (const j of kept) for (let p = j.getParentNode(); p; p = p.getParentNode()) needed.add(p);
const skinJoints = process.env.NOREMOVE ? oldJoints : oldJoints.filter((j) => needed.has(j));
const newIndex = new Map(skinJoints.map((j, i) => [j, i]));
const pelvis = kept.find((j) => baseName(j) === "Bip001_Pelvis") ?? kept[0];
const owner = (joint) => {
  for (let n = joint; n; n = n.getParentNode()) if (keptSet.has(n)) return n;
  return pelvis;
};
const remap = oldJoints.map((j) => newIndex.get(owner(j)));

const ibm = new Float32Array(skinJoints.length * 16);
skinJoints.forEach((j, i) => ibm.set(oldIbm.subarray(oldJoints.indexOf(j) * 16, oldJoints.indexOf(j) * 16 + 16), i * 16));
for (const j of oldJoints) skin.removeJoint(j);
for (const j of skinJoints) skin.addJoint(j);
skin.setInverseBindMatrices(doc.createAccessor("ibm").setType(Accessor.Type.MAT4).setArray(ibm).setBuffer(root.listBuffers()[0]));

const jv = [0, 0, 0, 0];
const wv = [0, 0, 0, 0];
for (const mesh of root.listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    const joints = prim.getAttribute("JOINTS_0");
    const weights = prim.getAttribute("WEIGHTS_0");
    if (!joints || !weights) continue;
    if (prim.getAttribute("JOINTS_1")) throw new Error("More than 4 bone influences per vertex is not supported");
    for (let i = 0; i < joints.getCount(); i++) {
      joints.getElement(i, jv);
      weights.getElement(i, wv);
      const merged = new Map();
      for (let k = 0; k < 4; k++) {
        if (wv[k] <= 0) continue;
        const to = remap[jv[k]];
        merged.set(to, (merged.get(to) ?? 0) + wv[k]);
      }
      const top = [...merged.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
      const sum = top.reduce((s, [, w]) => s + w, 0) || 1;
      for (let k = 0; k < 4; k++) {
        jv[k] = top[k]?.[0] ?? 0;
        wv[k] = top[k] ? top[k][1] / sum : 0;
      }
      joints.setElement(i, jv);
      weights.setElement(i, wv);
    }
  }
}

// 3. Remove animation tracks of removed bones.
// Only the body bones keep animation tracks; the rest sit at their rest pose, which keeps the file small.
const animated = new Set();
for (const j of oldJoints) if (BODY_JOINT.test(baseName(j))) for (let n = j; n; n = n.getParentNode()) animated.add(n);
for (const anim of root.listAnimations()) {
  for (const channel of anim.listChannels()) {
    if (!animated.has(channel.getTargetNode())) channel.dispose();
  }
  const used = new Set(anim.listChannels().map((c) => c.getSampler()));
  for (const sampler of anim.listSamplers()) if (!used.has(sampler)) sampler.dispose();
}

// 4. Drop removed bones that nothing needs any more, shrink geometry and textures.
for (const joint of oldJoints) {
  if (!keptSet.has(joint) && joint.listChildren().every((c) => !keptSet.has(c))) {
    // Leaf bones disappear; prune() below removes whatever becomes empty after this.
  }
}
if (process.env.STAGE === "remap") { await io.write(output, doc); process.exit(0); }
await doc.transform(
  prune(),
  weld(),
  simplify({ simplifier: MeshoptSimplifier, ratio: Math.min(1, targetTris / triangleCount(doc)), error: 0.02, lockBorder: false }),
  dedup(),
  prune(),
  textureCompress({ encoder: sharp, targetFormat: "webp", resize: [texSize, texSize], quality }),
);
await io.write(output, doc);

// Report the bind-pose size so the game can scale the character to the right height.
let min = [Infinity, Infinity, Infinity];
let max = [-Infinity, -Infinity, -Infinity];
for (const mesh of doc.getRoot().listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute("POSITION");
    const v = [0, 0, 0];
    for (let i = 0; i < pos.getCount(); i++) {
      pos.getElement(i, v);
      for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], v[a]); max[a] = Math.max(max[a], v[a]); }
    }
  }
}
const size = max.map((m, a) => (m - min[a]).toFixed(3));
console.log(
  `${input}: ${trisBefore} -> ${triangleCount(doc)} triangles, ${oldJoints.length} -> ${skinJoints.length} bones, ` +
  `${(fs.statSync(input).size / 1048576).toFixed(1)} MB -> ${(fs.statSync(output).size / 1048576).toFixed(2)} MB`,
);
console.log(`bind-pose size x/y/z: ${size.join(" / ")}, min y ${min[1].toFixed(3)}`);
