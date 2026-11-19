import fs from "node:fs";
import path from "node:path";

const RACING_ROOT = path.resolve("packages/client/public/assets/racing");
const HEADERS = { "User-Agent": "ApexDriveAssetPipeline/1.0" };

const MODEL_DOWNLOADS = [
  {
    key: "ferrari",
    url: "https://raw.githubusercontent.com/mrdoob/three.js/master/examples/models/gltf/ferrari.glb",
    dest: path.join(RACING_ROOT, "ferrari.glb"),
    verifyGlb: true,
  },
];

const DRACO_DOWNLOADS = [
  {
    key: "wasmUrl",
    url: "https://cdn.babylonjs.com/draco_wasm_wrapper_gltf.js",
    dest: path.join(RACING_ROOT, "draco", "draco_wasm_wrapper_gltf.js"),
  },
  {
    key: "wasmBinaryUrl",
    url: "https://cdn.babylonjs.com/draco_decoder_gltf.wasm",
    dest: path.join(RACING_ROOT, "draco", "draco_decoder_gltf.wasm"),
  },
  {
    key: "fallbackUrl",
    url: "https://cdn.babylonjs.com/draco_decoder_gltf.js",
    dest: path.join(RACING_ROOT, "draco", "draco_decoder_gltf.js"),
  },
];

const ENV_DOWNLOADS = [
  {
    key: "night",
    url: "https://playground.babylonjs.com/textures/night.env",
    dest: path.join(RACING_ROOT, "env", "night.env"),
  },
  {
    key: "sunset",
    url: "https://playground.babylonjs.com/textures/country.env",
    dest: path.join(RACING_ROOT, "env", "sunset.env"),
  },
  {
    key: "daylight",
    url: "https://assets.babylonjs.com/environments/environmentSpecular.env",
    dest: path.join(RACING_ROOT, "env", "daylight.env"),
  },
  {
    key: "studio",
    url: "https://assets.babylonjs.com/environments/studio.env",
    dest: path.join(RACING_ROOT, "env", "studio.env"),
  },
];

const TEXTURE_SPECS = [
  { key: "asphalt", candidates: ["asphalt_04", "asphalt_01", "asphalt_02"] },
  { key: "cliff_rock", candidates: ["rock_wall_02", "aerial_rocks_02", "cliff_side"] },
  { key: "gravel", candidates: ["gravel_road", "gravel_embedded_concrete"] },
  { key: "barrier_steel", candidates: ["metal_plate_02", "corrugated_iron_02"] },
];

function verifyGlbBuffer(buf, label) {
  if (buf.length < 20) {
    throw new Error(`Invalid GLB (${label}): too small (${buf.length} bytes)`);
  }
  const magic = buf.subarray(0, 4).toString("ascii");
  if (magic !== "glTF") {
    throw new Error(`Invalid GLB header for ${label}: expected "glTF", got ${JSON.stringify(magic)}`);
  }
  const version = buf.readUInt32LE(4);
  const declaredLen = buf.readUInt32LE(8);
  if (version !== 2 || declaredLen > buf.length) {
    throw new Error(`Invalid GLB v2 metadata for ${label}: version=${version}, declared=${declaredLen}, actual=${buf.length}`);
  }
}

function verifyNotHtml(buf, label) {
  const head = buf.subarray(0, 32).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<!doctype") || head.startsWith("<html")) {
    throw new Error(`Unexpected HTML response instead of binary asset for ${label}`);
  }
}

async function downloadFile(url, destPath, { verifyGlb = false, minBytes = 256 } = {}) {
  if (fs.existsSync(destPath)) {
    const existing = fs.readFileSync(destPath);
    if (existing.length >= minBytes) {
      if (verifyGlb) verifyGlbBuffer(existing, path.basename(destPath));
      verifyNotHtml(existing, path.basename(destPath));
      return { bytes: existing.length, cached: true };
    }
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const resp = await fetch(url, { headers: HEADERS, redirect: "follow" });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} downloading ${url}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length < minBytes) {
    throw new Error(`Unexpected tiny file (${buf.length} bytes) from ${url}`);
  }
  verifyNotHtml(buf, url);
  if (verifyGlb) {
    verifyGlbBuffer(buf, url);
  }
  fs.writeFileSync(destPath, buf);
  return { bytes: buf.length, cached: false };
}

async function fetchJson(url) {
  const resp = await fetch(url, { headers: HEADERS });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} fetching ${url}`);
  }
  return resp.json();
}

function pickFormatEntry(mapObj) {
  if (!mapObj) return null;
  const preferred = mapObj["2k"] || mapObj["1k"];
  if (!preferred) return null;
  return preferred.jpg || preferred.png || null;
}

async function fetchPolyHavenTexture(spec) {
  let lastErr = null;
  for (const slug of spec.candidates) {
    try {
      const files = await fetchJson(`https://api.polyhaven.com/files/${slug}`);
      const diffInfo = pickFormatEntry(files.Diffuse || files.col || files.albedo);
      const norInfo = pickFormatEntry(files.nor_gl || files.Normal);
      const armInfo = pickFormatEntry(files.arm || files.Rough);

      if (!diffInfo?.url || !norInfo?.url || !armInfo?.url) {
        throw new Error(`Incomplete PBR maps for ${slug}`);
      }

      const dir = path.join(RACING_ROOT, "textures", spec.key);
      const maps = [
        ["diff", diffInfo.url, path.join(dir, "diff.jpg")],
        ["nor_gl", norInfo.url, path.join(dir, "nor_gl.jpg")],
        ["arm", armInfo.url, path.join(dir, "arm.jpg")],
      ];

      const record = { slug, files: {}, bytes: 0 };
      for (const [mapName, url, dest] of maps) {
        const { bytes, cached } = await downloadFile(url, dest, { minBytes: 4096 });
        const rel = path.relative(RACING_ROOT, dest).replace(/\\/g, "/");
        record.files[mapName] = { path: rel, bytes };
        record.bytes += bytes;
        console.log(`[TEX ${cached ? "CACHE" : "DL"}] ${spec.key}/${mapName} (${slug}, ${Math.round(bytes / 1024)} KB)`);
      }
      return record;
    } catch (err) {
      lastErr = err;
      console.warn(`[WARN] Poly Haven candidate ${slug} failed: ${err.message}`);
    }
  }
  throw lastErr ?? new Error(`All texture candidates failed for ${spec.key}`);
}

async function main() {
  fs.mkdirSync(RACING_ROOT, { recursive: true });

  const manifest = {
    generatedAt: new Date().toISOString(),
    baseUrl: "/assets/racing/",
    models: {},
    draco: {},
    env: {},
    textures: {},
    totalBytes: 0,
  };

  // 1. Real 3D car GLB
  for (const item of MODEL_DOWNLOADS) {
    const { bytes, cached } = await downloadFile(item.url, item.dest, {
      verifyGlb: item.verifyGlb,
      minBytes: 10000,
    });
    const rel = path.relative(RACING_ROOT, item.dest).replace(/\\/g, "/");
    manifest.models[item.key] = { path: rel, bytes };
    manifest.totalBytes += bytes;
    console.log(`[GLB ${cached ? "CACHE" : "DL"}] ${rel} (${Math.round(bytes / 1024)} KB)`);
  }

  // 2. Local Babylon Draco decoder bundle (ensures offline/zero-CDN GLB decoding)
  for (const item of DRACO_DOWNLOADS) {
    const { bytes, cached } = await downloadFile(item.url, item.dest, { minBytes: 1024 });
    const rel = path.relative(RACING_ROOT, item.dest).replace(/\\/g, "/");
    manifest.draco[item.key] = { path: rel, bytes };
    manifest.totalBytes += bytes;
    console.log(`[DRACO ${cached ? "CACHE" : "DL"}] ${rel} (${Math.round(bytes / 1024)} KB)`);
  }

  // 3. Prefiltered HDR .env IBL environments
  for (const item of ENV_DOWNLOADS) {
    const { bytes, cached } = await downloadFile(item.url, item.dest, { minBytes: 10000 });
    const rel = path.relative(RACING_ROOT, item.dest).replace(/\\/g, "/");
    manifest.env[item.key] = { path: rel, bytes };
    manifest.totalBytes += bytes;
    console.log(`[ENV ${cached ? "CACHE" : "DL"}] ${rel} (${Math.round(bytes / 1024)} KB)`);
  }

  // 4. 2K Poly Haven CC0 PBR texture sets (Diffuse, Normal GL, ARM)
  for (const spec of TEXTURE_SPECS) {
    const record = await fetchPolyHavenTexture(spec);
    manifest.textures[spec.key] = record;
    manifest.totalBytes += record.bytes;
  }

  const manifestPath = path.join(RACING_ROOT, "race-asset-manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(
    `\nDONE! Verified all ApexDrive racing assets (${(manifest.totalBytes / (1024 * 1024)).toFixed(2)} MB total) -> ${path.relative(process.cwd(), manifestPath)}`
  );
}

main().catch((err) => {
  console.error("Racing asset fetch failed:", err);
  process.exit(1);
});
