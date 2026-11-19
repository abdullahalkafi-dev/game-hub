import { chromium } from "playwright-core";
import path from "node:path";
import fs from "node:fs";

const OUT_DIR =
  "C:\\Users\\kafik\\.gemini\\antigravity\\brain\\500e4c22-3c61-473f-9101-ef12774e417e\\scratch";
fs.mkdirSync(OUT_DIR, { recursive: true });

const EDGE_PATH = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const BASE_URL = "http://localhost:5173";

async function run() {
  const browser = await chromium.launch({
    executablePath: EDGE_PATH,
    headless: true,
    args: [
      "--headless=new",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "--no-sandbox",
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
    consoleErrors.push(err.message);
  });
  page.on("response", (res) => {
    if (res.status() >= 400) {
      failedRequests.push(`${res.status()} ${res.url()}`);
    }
  });

  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.waitForSelector(".lobby-shell");
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT_DIR, "01-lobby-play.png") });

  // 2. Test 3D Gunsmith tab + real photogrammetry Kar98k glTF + drag orbit
  await page.click('[data-tab="GUNSMITH"]');
  await page.waitForTimeout(350);
  await page.click('[data-weapon="kar98k"]');
  await page.waitForTimeout(250);
  await page.click('[data-att-slot="muzzle"][data-att-id="muzzle_suppressor"]');
  await page.click('[data-skin="carbon_gold"]');
  await page.mouse.move(640, 340);
  await page.mouse.down({ button: "left" });
  await page.mouse.move(675, 334, { steps: 6 });
  await page.mouse.up({ button: "left" });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT_DIR, "02-gunsmith-customizer.png") });

  // Equip full-auto AKM for arena burst verification
  await page.click('[data-weapon="akm"]');
  await page.waitForTimeout(150);
  await page.click('[data-att-slot="optic"][data-att-id="optic_red_dot"]');
  await page.click('[data-att-slot="muzzle"][data-att-id="muzzle_suppressor"]');
  await page.click('[data-att-slot="underbarrel"][data-att-id="grip_vertical"]');
  await page.click('[data-att-slot="mag"][data-att-id="mag_extended_quick"]');

  // 3. Deploy into Cargo Docks 1v1 match
  await page.click('[data-tab="PLAY"]');
  await page.waitForTimeout(200);
  await page.click('[data-mode="1v1"]');
  await page.click('[data-map="cargo_docks"]');
  await page.click("#btn-create-room");

  await page.waitForSelector(".hud-root:not(.hidden)", { timeout: 20000 });
  await page.locator("#hud-lock-mouse").click();
  await page.waitForFunction(() => document.pointerLockElement === document.getElementById("render-canvas"));
  await page.keyboard.press("Escape");
  await page.locator("#hud-lock-mouse").waitFor();
  await page.keyboard.press("F2");
  await page.waitForFunction(() => document.pointerLockElement === document.getElementById("render-canvas"));
  await page.waitForTimeout(1600);
  await page.screenshot({ path: path.join(OUT_DIR, "03-arena-cargo-docks.png") });

  const roomCode = await page.textContent("#hud-room-code");
  const ammoBeforeStr = await page.textContent("#hud-ammo-mag");
  const ammoBefore = Number(ammoBeforeStr?.trim() || "0");

  // 4. Test movement, Q/E lean, firing burst (strict mouse aim: no accidental spin)
  await page.keyboard.down("KeyW");
  await page.keyboard.down("KeyE");
  await page.waitForTimeout(280);
  await page.keyboard.up("KeyW");

  await page.mouse.move(640, 360);
  await page.mouse.down({ button: "left" });
  await page.waitForTimeout(420);
  await page.screenshot({ path: path.join(OUT_DIR, "04-arena-shooting-action.png") });
  await page.mouse.up({ button: "left" });
  await page.keyboard.up("KeyE");

  const ammoAfterStr = await page.textContent("#hud-ammo-mag");
  const ammoAfter = Number(ammoAfterStr?.trim() || "0");
  const telemetry = await page.textContent("#hud-telemetry");

  // 5. Switch to Neon Rooftop
  await page.keyboard.press("KeyM");
  await page.waitForSelector("#hud-pause:not(.hidden)", { timeout: 3000 });
  await page.selectOption("#pause-map-select", "neon_rooftop");
  await page.click("#pause-apply-map");
  await page.click("#pause-resume");
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT_DIR, "05-arena-neon-rooftop.png") });

  // 6. Switch to Desert Outpost
  await page.keyboard.press("KeyM");
  await page.waitForSelector("#hud-pause:not(.hidden)", { timeout: 3000 });
  await page.selectOption("#pause-map-select", "desert_outpost");
  await page.click("#pause-apply-map");
  await page.click("#pause-resume");
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT_DIR, "06-arena-desert-outpost.png") });

  // 7. Capture Hold-Tab Scoreboard overlay over live arena
  await page.keyboard.down("Tab");
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(OUT_DIR, "07-scoreboard-and-soldier.png") });
  await page.keyboard.up("Tab");

  console.log(
    JSON.stringify(
      {
        roomCode,
        ammoBefore,
        ammoAfter,
        shotFiredSuccessfully: ammoAfter < ammoBefore,
        telemetry,
        consoleErrorCount: consoleErrors.length,
        consoleErrors,
        failedRequests,
      },
      null,
      2
    )
  );

  await browser.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
