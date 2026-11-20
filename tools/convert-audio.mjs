// Converts downloaded source recordings (ogg / flac / mp3 / wav) into the small mono 16-bit WAV
// files the game loads from packages/client/public/assets/audio.
//
// It decodes with the browser's own audio decoder (headless Chrome via playwright-core), so no ffmpeg
// or sox is required. Trimming, fading and normalising happen in the page, then the WAV bytes are
// written back from Node.
//
// Usage:
//   node tools/convert-audio.mjs <jobs.json> [--info]
//
// jobs.json: { "outDir": "...", "jobs": [ { "src": "path", "out": "name.wav", "maxSec": 0.4,
//   "peak": 0.9, "fadeOutSec": 0.06, "startSec": 0, "threshold": 0.04 } ] }
//
// With --info it only prints each source's duration, sample rate and peak.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const [jobsPath, ...flags] = process.argv.slice(2);
if (!jobsPath) {
  console.error("usage: node tools/convert-audio.mjs <jobs.json> [--info]");
  process.exit(1);
}
const infoOnly = flags.includes("--info");
const spec = JSON.parse(fs.readFileSync(jobsPath, "utf8"));
const baseDir = path.dirname(path.resolve(jobsPath));
const outDir = path.resolve(baseDir, spec.outDir ?? ".");
if (!infoOnly) fs.mkdirSync(outDir, { recursive: true });

async function launch() {
  for (const channel of ["chrome", "msedge"]) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {
      // try the next installed browser
    }
  }
  throw new Error("Neither Chrome nor Edge could be launched for audio decoding.");
}

const browser = await launch();
try {
  const page = await browser.newPage();
  await page.goto("about:blank");
  for (const job of spec.jobs) {
    const bytes = fs.readFileSync(path.resolve(baseDir, job.src));
    const result = await page.evaluate(async ({ b64, job, infoOnly }) => {
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const ctx = new AudioContext();
      const decoded = await ctx.decodeAudioData(bin.buffer.slice(0));
      await ctx.close();
      const peakOf = (data) => { let p = 0; for (let i = 0; i < data.length; i++) p = Math.max(p, Math.abs(data[i])); return p; };
      if (infoOnly) {
        return { info: { seconds: decoded.duration, rate: decoded.sampleRate, channels: decoded.numberOfChannels, peak: peakOf(decoded.getChannelData(0)) } };
      }
      const rate = job.sampleRate ?? 44100;
      const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * rate), rate);
      const src = offline.createBufferSource();
      src.buffer = decoded;
      src.connect(offline.destination);
      src.start();
      const data = (await offline.startRendering()).getChannelData(0);

      const startFrom = Math.floor((job.startSec ?? 0) * rate);
      const globalPeak = peakOf(data.subarray(startFrom)) || 1;
      let onset = startFrom;
      const gate = globalPeak * (job.threshold ?? 0.04);
      while (onset < data.length && Math.abs(data[onset]) < gate) onset++;
      onset = Math.max(startFrom, onset - Math.floor(0.004 * rate));
      const maxLen = Math.floor((job.maxSec ?? 0.5) * rate);
      const length = Math.min(maxLen, data.length - onset);
      const out = new Float32Array(length);
      out.set(data.subarray(onset, onset + length));

      const fadeIn = Math.floor(0.002 * rate);
      for (let i = 0; i < fadeIn && i < length; i++) out[i] *= i / fadeIn;
      const fadeOut = Math.min(length, Math.floor((job.fadeOutSec ?? 0.05) * rate));
      for (let i = 0; i < fadeOut; i++) out[length - 1 - i] *= i / fadeOut;

      const peak = peakOf(out) || 1;
      const gain = (job.peak ?? 0.9) / peak;
      const pcm = new Int16Array(length);
      for (let i = 0; i < length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(out[i] * gain * 32767)));

      const header = new ArrayBuffer(44);
      const dv = new DataView(header);
      const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
      writeStr(0, "RIFF"); dv.setUint32(4, 36 + pcm.byteLength, true); writeStr(8, "WAVE"); writeStr(12, "fmt ");
      dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, rate, true);
      dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); writeStr(36, "data");
      dv.setUint32(40, pcm.byteLength, true);
      const wav = new Uint8Array(44 + pcm.byteLength);
      wav.set(new Uint8Array(header), 0);
      wav.set(new Uint8Array(pcm.buffer), 44);
      let s = "";
      for (let i = 0; i < wav.length; i += 0x8000) s += String.fromCharCode(...wav.subarray(i, i + 0x8000));
      return { b64: btoa(s), seconds: length / rate };
    }, { b64: bytes.toString("base64"), job, infoOnly });

    if (infoOnly) {
      const i = result.info;
      console.log(`${job.src}: ${i.seconds.toFixed(2)}s ${i.rate}Hz ch=${i.channels} peak=${i.peak.toFixed(2)}`);
    } else {
      const dest = path.join(outDir, job.out);
      fs.writeFileSync(dest, Buffer.from(result.b64, "base64"));
      console.log(`wrote ${job.out} (${result.seconds.toFixed(2)}s, ${fs.statSync(dest).size} bytes)`);
    }
  }
} finally {
  await browser.close();
}
