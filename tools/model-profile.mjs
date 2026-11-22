// Prints a side profile of a weapon .glb so grip, optic and muzzle positions can be read off.
//
//   node tools/model-profile.mjs <model.glb>
//
// Assumes the model is already oriented (barrel along +Z, up +Y). It prints, for 20 slices from the
// stock (0.00) to the muzzle (1.00), the lowest and highest point as a fraction of the model's height.
// The "centre top" column is the highest point along the gun's centre line only (within 1.2 cm of the
// middle), which is where an optic actually sits; side decorations can make the plain maximum misleading.
// Those are the numbers that go into a skin's `model` block in SkinRegistry.ts.
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";

const doc = await new NodeIO().registerExtensions(ALL_EXTENSIONS).read(process.argv[2]);
const pts = [];
for (const node of doc.getRoot().listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  const m = node.getWorldMatrix();
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute("POSITION");
    const v = [0, 0, 0];
    for (let i = 0; i < pos.getCount(); i++) {
      pos.getElement(i, v);
      pts.push([
        m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
        m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
        m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
      ]);
    }
  }
}
const lo = [0, 1, 2].map((a) => Math.min(...pts.map((p) => p[a])));
const hi = [0, 1, 2].map((a) => Math.max(...pts.map((p) => p[a])));
const size = hi.map((h, a) => h - lo[a]);
console.log("size x/y/z:", size.map((n) => n.toFixed(3)).join(" / "), "  (z should be the longest)");
const N = 20;
const midX = (lo[0] + hi[0]) / 2;
const bins = Array.from({ length: N }, () => ({ lo: Infinity, hi: -Infinity, x0: Infinity, x1: -Infinity, ctr: -Infinity }));
for (const [x, y, z] of pts) {
  const b = bins[Math.min(N - 1, Math.floor(((z - lo[2]) / size[2]) * N))];
  b.lo = Math.min(b.lo, y); b.hi = Math.max(b.hi, y); b.x0 = Math.min(b.x0, x); b.x1 = Math.max(b.x1, x);
  if (Math.abs(x - midX) < 0.012) b.ctr = Math.max(b.ctr, y);
}
console.log("z    | y low..high (fraction of height) | centre top | x width (fraction of length)");
bins.forEach((b, i) => console.log(
  ((i + 0.5) / N).toFixed(2), "|", ((b.lo - lo[1]) / size[1]).toFixed(2), "..", ((b.hi - lo[1]) / size[1]).toFixed(2),
  "|", Number.isFinite(b.ctr) ? ((b.ctr - lo[1]) / size[1]).toFixed(2) : " -- ", "|", ((b.x1 - b.x0) / size[2]).toFixed(3)));
