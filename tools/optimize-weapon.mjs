// Shrinks an imported weapon model so it is cheap to download and draw in a match.
//
//   node tools/optimize-weapon.mjs <in.glb> <out.glb> [--tris 20000] [--tex 1024] [--quality 88]
//
// What it does: merges duplicate vertices and data, simplifies the mesh to roughly --tris triangles,
// downsizes textures to at most --tex pixels and re-encodes them as WebP, quantizes vertex data, and
// strips anything unused. It deliberately avoids meshopt/Draco compression, so the game needs no
// extra decoder download.
import fs from "node:fs";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, prune, quantize, simplify, textureCompress, weld } from "@gltf-transform/functions";
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
