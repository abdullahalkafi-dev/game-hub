import fs from "node:fs";
import path from "node:path";

const ROOT_ASSETS = path.resolve("packages/client/public/assets");
const HEADERS = { "User-Agent": "StrikeCoreAssetPipeline/1.0" };

const TEXTURE_SLUGS = [
  "asphalt_02",
  "concrete_wall_005",
  "corrugated_iron_02",
  "sandstone_blocks_05",
  "metal_plate_02",
  "rusty_metal_02",
  "brown_planks_04",
  "coast_sand_01",
];

const MODEL_SLUGS = [
  "bolt_action_rifle_7_62",
  "service_pistol",
  "Barrel_01",
  "concrete_road_barrier",
  "old_military_crate",
  "utility_box_01",
];

const EXTRA_DOWNLOADS = [
  {
    url: "https://assets.babylonjs.com/environments/environmentSpecular.env",
    dest: path.join(ROOT_ASSETS, "env", "outdoor.env"),
  },
  {
    url: "https://assets.babylonjs.com/environments/studio.env",
    dest: path.join(ROOT_ASSETS, "env", "studio.env"),
  },
  {
    url: "https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/gltf/Soldier.glb",
    dest: path.join(ROOT_ASSETS, "models", "soldier", "Soldier.glb"),
  },
];

async function downloadFile(url, destPath) {
  if (fs.existsSync(destPath) && fs.statSync(destPath).size > 100) {
    return fs.statSync(destPath).size;
  }
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const resp = await fetch(url, { headers: HEADERS });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} downloading ${url}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length < 100) {
    throw new Error(`Unexpected tiny file (${buf.length} bytes) from ${url}`);
  }
  fs.writeFileSync(destPath, buf);
  return buf.length;
}

async function fetchJson(url) {
  const resp = await fetch(url, { headers: HEADERS });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  return resp.json();
}

function pickFormatEntry(mapObj) {
  if (!mapObj) return null;
  const res1k = mapObj["1k"] || mapObj["2k"];
  if (!res1k) return null;
  return res1k.jpg || res1k.png || null;
}

async function main() {
  const manifest = {
    generatedAt: new Date().toISOString(),
    env: [],
    textures: {},
    models: {},
  };

  let totalBytes = 0;

  // 1. Download HDR .env maps and Soldier.glb
  for (const item of EXTRA_DOWNLOADS) {
    const bytes = await downloadFile(item.url, item.dest);
    totalBytes += bytes;
    const rel = path.relative(ROOT_ASSETS, item.dest).replace(/\\/g, "/");
    console.log(`[OK] ${rel} (${Math.round(bytes / 1024)} KB)`);
    if (rel.startsWith("env/")) manifest.env.push(rel);
    else manifest.models.soldier = { main: rel, bytes };
  }

  // 2. Download 1K Poly Haven CC0 PBR texture sets (Diffuse, Normal GL, ARM)
  for (const slug of TEXTURE_SLUGS) {
    const files = await fetchJson(`https://api.polyhaven.com/files/${slug}`);
    const dir = path.join(ROOT_ASSETS, "textures", slug);
    const diffInfo = pickFormatEntry(files.Diffuse || files.col || files.albedo);
    const norInfo = pickFormatEntry(files.nor_gl || files.Normal);
    const armInfo = pickFormatEntry(files.arm || files.Rough);

    const record = {};
    if (diffInfo?.url) {
      const b = await downloadFile(diffInfo.url, path.join(dir, "diff.jpg"));
      totalBytes += b;
      record.diff = `textures/${slug}/diff.jpg`;
    }
    if (norInfo?.url) {
      const b = await downloadFile(norInfo.url, path.join(dir, "nor_gl.jpg"));
      totalBytes += b;
      record.nor_gl = `textures/${slug}/nor_gl.jpg`;
    }
    if (armInfo?.url) {
      const b = await downloadFile(armInfo.url, path.join(dir, "arm.jpg"));
      totalBytes += b;
      record.arm = `textures/${slug}/arm.jpg`;
    }
    manifest.textures[slug] = record;
    console.log(`[TEX] ${slug}: ${Object.keys(record).join(", ")}`);
  }

  // 3. Download 1K Poly Haven CC0 glTF 3D models (.gltf + .bin + textures/*)
  for (const slug of MODEL_SLUGS) {
    const files = await fetchJson(`https://api.polyhaven.com/files/${slug}`);
    const gltfEntry = files.gltf?.["1k"]?.gltf || files.gltf?.["2k"]?.gltf;
    if (!gltfEntry?.url) {
      throw new Error(`No glTF entry found for ${slug}`);
    }
    const modelDir = path.join(ROOT_ASSETS, "models", slug);
    const gltfFileName = `${slug}.gltf`;
    const mainDest = path.join(modelDir, gltfFileName);
    let modelBytes = await downloadFile(gltfEntry.url, mainDest);

    if (gltfEntry.include) {
      for (const [incRel, incInfo] of Object.entries(gltfEntry.include)) {
        if (!incInfo?.url) continue;
        const incDest = path.join(modelDir, incRel);
        modelBytes += await downloadFile(incInfo.url, incDest);
      }
    }

    totalBytes += modelBytes;
    manifest.models[slug] = {
      dir: `models/${slug}/`,
      file: gltfFileName,
      bytes: modelBytes,
    };
    console.log(`[MODEL] ${slug} (${Math.round(modelBytes / 1024)} KB)`);
  }

  fs.writeFileSync(
    path.join(ROOT_ASSETS, "asset-manifest.json"),
    JSON.stringify(manifest, null, 2)
  );
  console.log(`\nDONE! Downloaded/verified all CC0 assets (${(totalBytes / (1024 * 1024)).toFixed(2)} MB total).`);
}

main().catch((err) => {
  console.error("Asset fetch failed:", err);
  process.exit(1);
});
