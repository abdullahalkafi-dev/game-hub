// Generates short game sound effects with the ElevenLabs sound-generation API.
//
//   ELEVENLABS_API_KEY=... node tools/generate-sfx.mjs <jobs.json> <outDir> [--max-seconds 20]
//
// The key is read from the environment only and is never written anywhere. Every request has an explicit
// duration, so the cost is predictable (about 20 credits per second), and the script refuses to exceed
// --max-seconds in total. Existing outputs are skipped, so re-running does not spend credits twice.
//
// jobs.json: [ { "out": "gun-ar-1.mp3", "seconds": 1.0, "prompt": "..." } ]
import fs from "node:fs";
import path from "node:path";

const [jobsPath, outDirArg, ...flags] = process.argv.slice(2);
const key = process.env.ELEVENLABS_API_KEY;
if (!jobsPath || !outDirArg || !key) {
  console.error("usage: ELEVENLABS_API_KEY=... node tools/generate-sfx.mjs <jobs.json> <outDir> [--max-seconds N]");
  process.exit(1);
}
const maxIdx = flags.indexOf("--max-seconds");
const maxSeconds = maxIdx >= 0 ? Number(flags[maxIdx + 1]) : 20;
const jobs = JSON.parse(fs.readFileSync(jobsPath, "utf8"));
const outDir = path.resolve(outDirArg);
fs.mkdirSync(outDir, { recursive: true });

const pending = jobs.filter((job) => !fs.existsSync(path.join(outDir, job.out)));
const total = pending.reduce((sum, job) => sum + job.seconds, 0);
console.log(`${pending.length} to generate, ${total.toFixed(1)}s of audio (~${Math.round(total * 20)} credits)`);
if (total > maxSeconds) {
  console.error(`Refusing: ${total.toFixed(1)}s exceeds --max-seconds ${maxSeconds}`);
  process.exit(1);
}

for (const job of pending) {
  const response = await fetch("https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128", {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      text: job.prompt,
      duration_seconds: Math.min(22, Math.max(0.5, job.seconds)),
      prompt_influence: job.influence ?? 0.5,
    }),
  });
  if (!response.ok) {
    console.error(`FAILED ${job.out}: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
    process.exit(1);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(path.join(outDir, job.out), bytes);
  console.log(`ok ${job.out} (${bytes.length} bytes)`);
}
