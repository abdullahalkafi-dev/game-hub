import { chromium } from "playwright-core";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const OUT_DIR = process.env.RACER_QA_OUT ?? fs.mkdtempSync(path.join(os.tmpdir(), "apexdrive-qa-"));
fs.mkdirSync(OUT_DIR, { recursive: true });

const WINDOWS_EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const BROWSER = process.env.RACER_QA_BROWSER ?? (fs.existsSync(WINDOWS_EDGE) ? WINDOWS_EDGE : undefined);
const BASE_URL = process.env.RACER_QA_URL ?? "http://localhost:5173";

function parseLapTimerMs(text) {
  const match = /(\d+):(\d+)\.(\d+)/.exec((text || "").trim());
  if (!match) return 0;
  return Number(match[1]) * 60000 + Number(match[2]) * 1000 + Number(match[3]) * 10;
}

async function waitForRaceGo(page) {
  await page.waitForFunction(
    () => document.querySelector("#race-hud-lap-timer")?.textContent?.trim() !== "00:00.00",
    null,
    { timeout: 15000 }
  );
}

async function enterCircuit(page, trackId) {
  await page.locator('[data-race-tab="ARENA"]').click();
  await page.locator('[data-race-mode="GRAND_PRIX"]').click();
  await page.locator(`[data-race-track="${trackId}"]`).click();
  await page.locator("#race-btn-create-room").click();
  await page.locator(".race-hud-root:not(.hidden)").waitFor({ timeout: 40000 });
}

async function returnToGarage(page) {
  await page.keyboard.press("KeyM");
  const menu = page.locator("#race-hud-pause:not(.hidden)");
  await menu.waitFor({ timeout: 5000 });
  if (await menu.locator("#race-pause-track-select").isVisible()) {
    throw new Error("Track selection should be hidden during a running race");
  }
  await page.locator("#race-pause-leave").click();
  await page.locator(".race-garage-shell:not(.hidden)").waitFor({ timeout: 15000 });
}

async function getCanvasSnapshotDataUrl(page, selector) {
  return page.evaluate((sel) => {
    const c = document.querySelector(sel);
    if (!c || !(c instanceof HTMLCanvasElement)) return "";
    try {
      return c.toDataURL("image/png");
    } catch {
      return "";
    }
  }, selector);
}

async function run() {
  const browser = await chromium.launch({
    executablePath: BROWSER,
    headless: true,
    args: [
      "--headless=new",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
    ],
  });

  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();

  const consoleErrors = [];
  const failedRequests = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => {
    consoleErrors.push(`pageerror: ${err.message}`);
  });
  page.on("response", (res) => {
    if (res.status() >= 400) {
      failedRequests.push(`${res.status()} ${res.url()}`);
    }
  });

  // ---------------------------------------------------------------------------
  // 1. 01-racer-garage.png: Open ApexDrive Racer, Car Garage, customize + orbit
  // ---------------------------------------------------------------------------
  await page.goto(`${BASE_URL}/?game=racer`, { waitUntil: "networkidle" });
  await page.waitForSelector(".race-garage-shell:not(.hidden)", { timeout: 15000 });

  await page.waitForFunction(
    () => document.querySelector("#race-preload-status")?.textContent?.includes("ready"),
    null,
    { timeout: 20000 }
  );

  // Switch to Car Garage tab
  await page.click('[data-race-tab="GARAGE"]');
  await page.waitForSelector('[data-vehicle="apex_gt"]', { timeout: 5000 });
  await page.waitForTimeout(300);

  // Customize paint, spoiler, rims, underglow
  await page.click('[data-livery="sunset_orange_metallic"]');
  await page.waitForTimeout(180);
  await page.click('[data-spoiler="spoiler_ducktail"]');
  await page.waitForTimeout(180);
  await page.click('[data-rim="rim_mesh_gold"]');
  await page.waitForTimeout(180);
  await page.click('[data-underglow="underglow_magenta"]');
  await page.waitForTimeout(250);

  // Blip engine rev preview
  await page.click("#race-btn-rev");
  await page.waitForTimeout(250);

  // Test drag-to-orbit on 3D showroom canvas center
  const garageShotBeforeOrbit = await page.screenshot();
  await page.mouse.move(640, 380);
  await page.mouse.down({ button: "left" });
  await page.mouse.move(760, 350, { steps: 10 });
  await page.mouse.up({ button: "left" });
  await page.waitForTimeout(450);

  const garageShotAfterOrbit = await page.screenshot({
    path: path.join(OUT_DIR, "01-racer-garage.png"),
  });
  const garageOrbitVisualChanged = !garageShotBeforeOrbit.equals(garageShotAfterOrbit);

  // ---------------------------------------------------------------------------
  // 2. 02-tokyo-grid-start.png: Create Grand Prix room on tokyo_midnight
  // ---------------------------------------------------------------------------
  await enterCircuit(page, "tokyo_midnight");

  const roomCode = (await page.textContent("#race-hud-room-code"))?.trim() || "";
  const tokyoTrackLabel = (await page.textContent("#race-hud-track-label"))?.trim() || "";
  const gridCountdownText = (await page.textContent("#race-hud-countdown-text"))?.trim() || "";
  const minimapAtStart = await getCanvasSnapshotDataUrl(page, "#race-minimap-canvas");

  await page.screenshot({ path: path.join(OUT_DIR, "02-tokyo-grid-start.png") });

  // ---------------------------------------------------------------------------
  // 3. 03-tokyo-driving-drift-nitro.png: Wait for GO!, drive + drift + nitro
  // ---------------------------------------------------------------------------
  await waitForRaceGo(page);
  await page.waitForTimeout(150);

  // Accelerate smoothly with W and sample speeds & lap timer for anti-snap-back
  const speedSamples = [];
  const timerSamples = [];
  await page.keyboard.down("KeyW");
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(240);
    const sample = await page.evaluate(() => ({
      speed: Number(document.querySelector("#race-hud-speed")?.textContent?.trim() || "0"),
      timer: document.querySelector("#race-hud-lap-timer")?.textContent?.trim() || "00:00.00",
      gear: document.querySelector("#race-hud-gear")?.textContent?.trim() || "1",
      nitro: document.querySelector("#race-hud-nitro-pct")?.textContent?.trim() || "",
    }));
    speedSamples.push(sample.speed);
    timerSamples.push(parseLapTimerMs(sample.timer));
  }

  const maxAccelSpeedKmh = Math.max(...speedSamples, 0);
  // Check no severe snap-back while accelerating (after reaching >= 40 km/h, speed should not drop abruptly to < 5 km/h)
  let snapBackDetected = false;
  let reached40 = false;
  for (let i = 0; i < speedSamples.length; i++) {
    if (speedSamples[i] >= 40) reached40 = true;
    if (reached40 && speedSamples[i] < 5) snapBackDetected = true;
  }
  const timerProgressed =
    timerSamples.length >= 2 && timerSamples[timerSamples.length - 1] > timerSamples[0];

  const nitroBefore = (await page.textContent("#race-hud-nitro-pct"))?.trim() || "";

  // Initiate handbrake drift with steer + Space while holding W
  await page.keyboard.down("KeyD");
  await page.keyboard.down("Space");
  await page.waitForTimeout(750);
  await page.keyboard.up("Space");
  await page.keyboard.up("KeyD");

  // Ignite Nitro boost while counter-steering slightly so skid marks + smoke + drift banner + nitro flames show
  await page.keyboard.down("KeyA");
  await page.keyboard.down("ShiftLeft");
  await page.waitForTimeout(550);

  const actionHud = await page.evaluate(() => ({
    speedKmh: Number(document.querySelector("#race-hud-speed")?.textContent?.trim() || "0"),
    gear: document.querySelector("#race-hud-gear")?.textContent?.trim() || "",
    nitroPct: document.querySelector("#race-hud-nitro-pct")?.textContent?.trim() || "",
    driftVisible: !document.querySelector("#race-hud-drift")?.classList.contains("hidden"),
    driftPoints: document.querySelector("#race-hud-drift-points")?.textContent?.trim() || "",
    driftMult: document.querySelector("#race-hud-drift-mult")?.textContent?.trim() || "",
    lapTimer: document.querySelector("#race-hud-lap-timer")?.textContent?.trim() || "",
    telemetry: document.querySelector("#race-hud-telemetry")?.textContent?.trim() || "",
  }));
  const minimapMidRace = await getCanvasSnapshotDataUrl(page, "#race-minimap-canvas");
  const minimapUpdated =
    minimapAtStart.length > 100 &&
    minimapMidRace.length > 100 &&
    minimapAtStart !== minimapMidRace;

  await page.screenshot({ path: path.join(OUT_DIR, "03-tokyo-driving-drift-nitro.png") });

  await page.keyboard.up("ShiftLeft");
  await page.keyboard.up("KeyA");
  await page.keyboard.up("KeyW");

  const peakSpeedKmh = Math.max(maxAccelSpeedKmh, actionHud.speedKmh);

  // ---------------------------------------------------------------------------
  // 4. 04-coastal-sunset.png: Switch track to coastal_sunset & drive
  // ---------------------------------------------------------------------------
  await returnToGarage(page);
  await enterCircuit(page, "coastal_sunset");
  await waitForRaceGo(page);
  await page.keyboard.down("KeyW");
  await page.waitForTimeout(2200);
  const coastalSpeedKmh = Number(
    (await page.textContent("#race-hud-speed"))?.trim() || "0"
  );
  await page.screenshot({ path: path.join(OUT_DIR, "04-coastal-sunset.png") });
  await page.keyboard.up("KeyW");

  // ---------------------------------------------------------------------------
  // 5. 05-harbor-gp-camera-hood.png & 06-harbor-standings.png
  // ---------------------------------------------------------------------------
  await returnToGarage(page);
  await enterCircuit(page, "harbor_gp");
  await waitForRaceGo(page);
  await page.keyboard.down("KeyW");
  await page.waitForTimeout(1600);

  // Cycle camera via 'C' until HOOD camera mode is active
  const seenCameras = [];
  seenCameras.push((await page.textContent("#race-hud-telemetry"))?.trim() || "");
  let cameraSwitchedToHood = false;
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("KeyC");
    await page.waitForTimeout(260);
    const tel = (await page.textContent("#race-hud-telemetry"))?.trim() || "";
    seenCameras.push(tel);
    if (/hood/i.test(tel)) {
      cameraSwitchedToHood = true;
      break;
    }
  }
  await page.waitForTimeout(350);
  const harborHoodSpeedKmh = Number(
    (await page.textContent("#race-hud-speed"))?.trim() || "0"
  );
  await page.screenshot({ path: path.join(OUT_DIR, "05-harbor-gp-camera-hood.png") });
  await page.keyboard.up("KeyW");

  // Hold Tab for Standings overlay
  await page.keyboard.down("Tab");
  await page.waitForTimeout(350);
  const standingsInfo = await page.evaluate(() => {
    const el = document.querySelector("#race-hud-standings");
    const visible = Boolean(el && !el.classList.contains("hidden"));
    const rows = el ? el.querySelectorAll("tbody tr").length : 0;
    return { visible, rows };
  });
  await page.screenshot({ path: path.join(OUT_DIR, "06-harbor-standings.png") });
  await page.keyboard.up("Tab");

  // ---------------------------------------------------------------------------
  // 6. Leave Grid -> Switch back to Game 1 StrikeCore Shooter Hub
  // ---------------------------------------------------------------------------
  await returnToGarage(page);
  await page.click("#btn-switch-to-shooter");
  await page.waitForSelector(".lobby-shell:not(.hidden)", { timeout: 10000 });
  await page.waitForTimeout(500);
  const switchedBackToShooter = await page.evaluate(() =>
    Boolean(document.querySelector(".lobby-shell:not(.hidden)"))
  );

  const report = {
    screenshotFolder: OUT_DIR,
    roomCode,
    tokyoTrackLabel,
    gridCountdownText,
    garageOrbitVisualChanged,
    speedSamples,
    maxAccelSpeedKmh,
    peakSpeedKmh,
    snapBackDetected,
    timerProgressed,
    nitroBefore,
    actionHud,
    minimapUpdated,
    coastalSpeedKmh,
    seenCameras,
    cameraSwitchedToHood,
    harborHoodSpeedKmh,
    standingsInfo,
    switchedBackToShooter,
    consoleErrorCount: consoleErrors.length,
    consoleErrors,
    failedRequestCount: failedRequests.length,
    failedRequests,
  };

  console.log(JSON.stringify(report, null, 2));

  await browser.close();

  const failures = [];
  if (consoleErrors.length > 0) failures.push(`Console errors: ${consoleErrors.join(" | ")}`);
  if (failedRequests.length > 0) failures.push(`Failed HTTP requests: ${failedRequests.join(" | ")}`);
  if (!garageOrbitVisualChanged) failures.push("Garage 3D orbit drag did not change canvas frame");
  if (peakSpeedKmh <= 80) failures.push(`Peak speed ${peakSpeedKmh} km/h <= 80 km/h`);
  if (snapBackDetected) failures.push("Detected vehicle speed snap-back during acceleration");
  if (!timerProgressed) failures.push("Lap timer did not progress while driving");
  if (!minimapUpdated) failures.push("Minimap canvas did not update during race");
  if (coastalSpeedKmh <= 50) failures.push(`Coastal sunset speed ${coastalSpeedKmh} km/h <= 50 km/h`);
  if (!cameraSwitchedToHood) failures.push("Failed to cycle camera to HOOD mode via C key");
  if (!standingsInfo.visible || standingsInfo.rows < 2) {
    failures.push(`Tab standings overlay failed: ${JSON.stringify(standingsInfo)}`);
  }
  if (!switchedBackToShooter) failures.push("Failed to switch back to StrikeCore Shooter lobby");

  if (failures.length > 0) {
    console.error("QA ASSERTION FAILURES:\n - " + failures.join("\n - "));
    process.exit(1);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
