// Shrinks an imported weapon model so it is cheap to download and draw in a match.
//
//   node tools/optimize-weapon.mjs <in.glb> <out.glb> [--tris 20000] [--tex 1024] [--quality 88] [--orient NAME]
//
// --orient rotates the model so the barrel points along +Z and up is +Y, which is what the game expects.
// Run tools/model-profile.mjs on the input first: its "size x/y/z" line shows which axis is the barrel.
//   yup-xfwd / yup-negxfwd   already Y-up, barrel along +X / -X (common for Sketchfab downloads)
//   zup-xfwd / zup-yfwd      Z-up exports, barrel along X / Y
// If the muzzle ends up at the stock end, switch between the two variants of the same pair.
//
// What it does: merges duplicate vertices and data, simplifies the mesh to roughly --tris triangles,
// downsizes textures to at most --tex pixels and re-encodes them as WebP, quantizes vertex data, and
// strips anything unused. It deliberately avoids meshopt/Draco compression, so the game needs no
// extra decoder download.
import fs from "node:fs";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, flatten, prune, quantize, simplify, textureCompress, transformMesh, weld } from "@gltf-transform/functions";
import { MeshoptSimplifier } from "meshoptimizer";
import sharp from "sharp";

const [input, output, ...flags] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: node tools/optimize-weapon.mjs <in.glb> <out.glb> [--tris N] [--tex PX] [--quality Q]");
  process.exit(1);
}
const flag = (name, fallback) => {
  const i = flags.indexOf("--" + name);
  return i >= 0 ? Number(flags[i + 1]) : fallback;
};
const targetTris = flag("tris", 20000);
const texSize = flag("tex", 1024);
const quality = flag("quality", 88);
const orientName = flags.includes("--orient") ? flags[flags.indexOf("--orient") + 1] : null;

// Column-major 4x4 matrices. Each is a pure rotation (determinant +1), so triangle winding is preserved.
const ORIENTATIONS = {
  // new x = -old z, new y = old y, new z = old x
  "yup-xfwd": [0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 0, 1],
  // new x = old z, new y = old y, new z = -old x
  "yup-negxfwd": [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1],
  // new x = old y, new y = old z, new z = old x
  "zup-xfwd": [0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1],
  // new x = old x, new y = old z, new z = -old y
  "zup-yfwd": [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1],
};
const mul = (a, b) => {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
};

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
const before = triangleCount(doc);
const ratio = Math.min(1, targetTris / before);

if (orientName) {
  const matrix = ORIENTATIONS[orientName];
  if (!matrix) throw new Error("Unknown --orient " + orientName + ". Options: " + Object.keys(ORIENTATIONS).join(", "));
  // Bake every node transform into its mesh, then rotate the vertices themselves.
  await doc.transform(flatten());
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    transformMesh(mesh, mul(matrix, node.getWorldMatrix()));
    node.setTranslation([0, 0, 0]).setRotation([0, 0, 0, 1]).setScale([1, 1, 1]);
  }
}

await doc.transform(
  weld(),
  simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.01, lockBorder: false }),
  dedup(),
  prune(),
  textureCompress({ encoder: sharp, targetFormat: "webp", resize: [texSize, texSize], quality }),
  quantize(),
);
await io.write(output, doc);

console.log(
  `${input}: ${before} -> ${triangleCount(doc)} triangles, ` +
  `${(fs.statSync(input).size / 1048576).toFixed(1)} MB -> ${(fs.statSync(output).size / 1048576).toFixed(2)} MB`,
);
