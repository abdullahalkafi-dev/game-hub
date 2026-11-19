import {
  LAUNCH_GREEN_ZONE_MAX,
  LAUNCH_GREEN_ZONE_MIN,
  LIVERY_REGISTRY,
  RACE_MODE_CONFIGS,
  TRACK_LIST,
  TRACK_REGISTRY,
  VEHICLE_REGISTRY,
  sampleTrackFrames,
  type RaceEventMessage,
  type RacePodiumEntry,
  type RaceRoomStateBroadcast,
  type TrackId,
  type TransmissionMode,
} from "@game/shared";
import type { RaceHudSnapshot, RaceStandingRow } from "../games/racer/RacerScene.js";
import { RACE_PAD, RACE_TOUCH_CONTROLS, type RaceTouchControl } from "../games/racer/RaceControls.js";
import { saveGuestProfile, type GuestProfile } from "../state/UserProfileStore.js";

export type { RaceHudSnapshot };

export interface RaceHudCallbacks {
  onResumeDriving: () => void;
  onOpenMenu: () => void;
  onStartRace: () => void;
  onRestartPractice: () => void;
  onTouchControl: (control: RaceTouchControl, active: boolean) => void;
  onSwitchTrack: (trackId: TrackId) => void;
  onVoteTrack: (trackId: TrackId) => void;
  onRematchNow: () => void;
  onTransmissionChanged: (mode: TransmissionMode) => void;
  onOpenSettings: () => void;
  onLeaveRoom: () => void;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function ordinalSuffix(rank: number): string {
  const mod100 = rank % 100;
  if (mod100 >= 11 && mod100 <= 13) return "th";
  switch (rank % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

function formatRaceTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "--:--.--";
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  const hundredths = Math.floor((ms % 1000) / 10);
  return `${mins < 10 ? "0" : ""}${mins}:${secs < 10 ? "0" : ""}${secs}.${hundredths < 10 ? "0" : ""}${hundredths}`;
}

function formatSplitDelta(deltaMs: number | null | undefined): string {
  if (deltaMs === null || deltaMs === undefined || !Number.isFinite(deltaMs)) return "";
  const sign = deltaMs <= 0 ? "-" : "+";
  return `${sign}${(Math.abs(deltaMs) / 1000).toFixed(2)}s`;
}

function formatGear(gear: number): string {
  if (gear < 0) return "R";
  if (gear === 0) return "N";
  return String(Math.min(6, Math.max(1, Math.round(gear))));
}

interface MinimapTrackCache {
  trackId: TrackId;
  points: { mx: number; my: number; isTunnel: boolean }[];
  startA: { mx: number; my: number };
  startB: { mx: number; my: number };
  minX: number;
  minZ: number;
  scale: number;
  offsetX: number;
  offsetY: number;
}

const TACH_RADIUS = 74;
const TACH_CX = 93;
const TACH_CY = 93;
const TACH_START_DEG = 150;
const TACH_SWEEP_DEG = 240;
const TACH_ARC_LENGTH = (2 * Math.PI * TACH_RADIUS * TACH_SWEEP_DEG) / 360;

function polarToCartesian(cx: number, cy: number, radius: number, angleDeg: number): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  return {
    x: cx + radius * Math.cos(rad),
    y: cy + radius * Math.sin(rad),
  };
}

function describeArc(cx: number, cy: number, radius: number, startDeg: number, endDeg: number): string {
  const start = polarToCartesian(cx, cy, radius, startDeg);
  const end = polarToCartesian(cx, cy, radius, endDeg);
  const largeArc = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${radius} ${radius} 0 ${largeArc} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

function buildTachometerTicksSvg(): string {
  const parts: string[] = [];
  for (let i = 0; i <= 9; i++) {
    const frac = i / 9;
    const deg = TACH_START_DEG + frac * TACH_SWEEP_DEG;
    const pOuter = polarToCartesian(TACH_CX, TACH_CY, TACH_RADIUS + 4, deg);
    const pInner = polarToCartesian(TACH_CX, TACH_CY, TACH_RADIUS - 6, deg);
    const pText = polarToCartesian(TACH_CX, TACH_CY, TACH_RADIUS - 16, deg);
    const isRed = i >= 8;
    parts.push(
      `<line x1="${pInner.x.toFixed(1)}" y1="${pInner.y.toFixed(1)}" x2="${pOuter.x.toFixed(1)}" y2="${pOuter.y.toFixed(1)}" stroke="${isRed ? "#ef4444" : "rgba(226,232,240,0.45)"}" stroke-width="${isRed ? 2.4 : 1.6}" stroke-linecap="round" />`
    );
    parts.push(
      `<text x="${pText.x.toFixed(1)}" y="${(pText.y + 3.5).toFixed(1)}" text-anchor="middle" fill="${isRed ? "#f87171" : "rgba(148,163,184,0.85)"}" font-size="9" font-family="var(--font-mono)" font-weight="800">${i}</text>`
    );
  }
  return parts.join("");
}

export class RaceHud {
  private readonly root: HTMLDivElement;
  private minimapCtx: CanvasRenderingContext2D | null = null;
  private minimapCache: MinimapTrackCache | null = null;
  private room: RaceRoomStateBroadcast | null = null;
  private localPlayerId = "";
  private paused = false;
  private standingsVisible = false;
  private lastMinimapDraw = 0;
  private lastStandingsDraw = 0;
  private lastCountdownKey = -99;
  private goHideTimeout: ReturnType<typeof setTimeout> | null = null;
  private launchHideTimeout: ReturnType<typeof setTimeout> | null = null;
  private splitHideTimeout: ReturnType<typeof setTimeout> | null = null;
  private driftHoldUntil = 0;
  private lastHeldDriftScore = 0;
  private lastHeldDriftMult = 1;
  private lastSnap: RaceHudSnapshot | null = null;
  private podiumRenderedKey = "";
  private maxObservedDriftCombo = 0;

  // Cached DOM refs for 60Hz zero-allocation updates
  private elSpeed!: HTMLElement;
  private elGear!: HTMLElement;
  private elTransTag!: HTMLElement;
  private elTachCard!: HTMLElement;
  private elTachArc!: SVGPathElement;
  private elNitroFill!: HTMLElement;
  private elNitroPct!: HTMLElement;
  private elSlipstream!: HTMLElement;
  private elLaunchWrap!: HTMLElement;
  private elLaunchNeedle!: HTMLElement;
  private elLaunchStatus!: HTMLElement;
  private elDriftBanner!: HTMLElement;
  private elDriftMult!: HTMLElement;
  private elDriftPoints!: HTMLElement;
  private elDriftTotal!: HTMLElement;
  private elWrongWay!: HTMLElement;
  private elPosNum!: HTMLElement;
  private elPosOrd!: HTMLElement;
  private elPosTotal!: HTMLElement;
  private elLapVal!: HTMLElement;
  private elLapTimer!: HTMLElement;
  private elBestLap!: HTMLElement;
  private elSplitDelta!: HTMLElement;
  private elTelemetry!: HTMLElement;
  private elControlsStrip!: HTMLElement;

  constructor(
    parent: HTMLElement,
    private readonly profile: GuestProfile,
    private readonly callbacks: RaceHudCallbacks
  ) {
    this.root = document.createElement("div");
    this.root.className = "race-hud-root hidden";

    const fullArcPath = describeArc(TACH_CX, TACH_CY, TACH_RADIUS, TACH_START_DEG, TACH_START_DEG + TACH_SWEEP_DEG);
    const redlineStartDeg = TACH_START_DEG + TACH_SWEEP_DEG * 0.82;
    const redlineArcPath = describeArc(TACH_CX, TACH_CY, TACH_RADIUS, redlineStartDeg, TACH_START_DEG + TACH_SWEEP_DEG);
    const launchMinPct = Math.round(LAUNCH_GREEN_ZONE_MIN * 100);
    const launchWidthPct = Math.round((LAUNCH_GREEN_ZONE_MAX - LAUNCH_GREEN_ZONE_MIN) * 100);

    this.root.innerHTML = `
      <!-- TOP-LEFT: Room Bar + Live Track Spline Minimap -->
      <div class="race-room-bar interactive">
        <span style="font-weight:900;color:#fb7185;font-family:var(--font-mono);" id="race-hud-room-code">GRID ----</span>
        <span id="race-hud-track-label" style="color:var(--text-muted);max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">Tokyo Midnight</span>
        <button type="button" class="btn btn-secondary" id="race-hud-open-menu" style="padding:3px 7px;font-size:10px;">[M] Menu</button>
        <button type="button" class="btn btn-secondary" id="race-hud-copy-invite" style="padding:3px 7px;font-size:10px;">Invite</button>
        <button type="button" class="btn btn-amber hidden" id="race-hud-host-start" style="padding:3px 8px;font-size:10px;">Start Race</button>
      </div>

      <div class="race-minimap-wrap">
        <canvas class="race-minimap-canvas" id="race-minimap-canvas" width="164" height="164"></canvas>
        <div class="race-minimap-footer">
          <span id="race-minimap-track-short">TOKYO MIDNIGHT</span>
          <span style="color:#22d3ee;">● YOU</span>
        </div>
      </div>

      <!-- TOP-CENTER: Position, Lap, Live Timer & Split Delta -->
      <div class="race-top-telemetry">
        <div class="race-pos-block">
          <span class="race-pos-num pos-1" id="race-hud-pos">1</span>
          <span class="race-pos-ord" id="race-hud-pos-ord">st</span>
          <span class="race-pos-total" id="race-hud-pos-total">/ 8</span>
        </div>
        <div class="race-lap-block">
          <div class="race-lap-label">Lap</div>
          <div class="race-lap-val" id="race-hud-lap">1 / 2</div>
        </div>
        <div class="race-time-block">
          <div class="race-lap-timer" id="race-hud-lap-timer">00:00.00</div>
          <div class="race-best-row">
            <span id="race-hud-best-lap">BEST --:--.--</span>
            <span class="race-split-delta hidden" id="race-hud-split-delta"></span>
          </div>
        </div>
      </div>

      <!-- TOP-RIGHT: FPS, Ping, Camera Mode -->
      <div class="race-telemetry-topright">
        <div class="race-cam-pill" id="race-hud-telemetry">60 FPS · 0ms · [C] DYNAMIC CHASE</div>
      </div>

      <div class="race-grid-status hidden" id="race-hud-grid-status" role="status"></div>
      <div class="race-clock-status hidden" id="race-hud-clock-status"></div>
      <div class="race-touch-control-deck hidden" id="race-touch-controls">
        ${RACE_TOUCH_CONTROLS.map(({ id, label, display }) =>
          `<button type="button" data-race-touch="${id}" aria-label="${label}">${display}</button>`).join("")}
      </div>

      <!-- CONNECTION STATUS -->
      <div class="connection-banner interactive hidden" id="race-hud-connection" role="status">
        <span id="race-hud-connection-text"></span>
        <button type="button" class="btn btn-secondary" id="race-hud-disconnect-leave">Return to Garage</button>
      </div>

      <!-- CENTER ANIMATED ALERTS: 3-2-1-GO!, Perfect Launch, Wrong Way -->
      <div class="race-center-stage-alerts">
        <div class="race-countdown-banner hidden" id="race-hud-countdown">
          <div class="race-start-lights">
            <span class="race-light-bulb" id="race-light-1"></span>
            <span class="race-light-bulb" id="race-light-2"></span>
            <span class="race-light-bulb" id="race-light-3"></span>
          </div>
          <div class="race-countdown-text" id="race-hud-countdown-text">3</div>
        </div>
        <div class="race-launch-banner hidden" id="race-hud-launch-banner">⚡ PERFECT LAUNCH! TURBO BOOST</div>
        <div class="race-wrongway-banner hidden" id="race-hud-wrongway">⚠ WRONG WAY — PRESS [R] TO RESET</div>
      </div>

      <!-- CENTER-RIGHT: Dynamic Drift Combo Banner -->
      <div class="race-drift-banner hidden" id="race-hud-drift">
        <div class="race-drift-combo-line">
          <span class="race-drift-tag">DRIFT</span>
          <span class="race-drift-mult" id="race-hud-drift-mult">x1</span>
        </div>
        <div class="race-drift-points" id="race-hud-drift-points">+0</div>
        <div class="race-drift-total" id="race-hud-drift-total">TOTAL 0</div>
      </div>

      <!-- BOTTOM-LEFT: Compact Controls Strip -->
      <div class="race-controls-strip" id="race-hud-controls">
        <strong>WASD</strong> Drive · <strong>SPACE</strong> Drift · <strong>SHIFT</strong> Nitro · <strong>C</strong> Cam · <strong>B</strong> Rear · <strong>R</strong> Reset · <strong>TAB</strong> Grid · <strong>M</strong> Menu
      </div>

      <!-- BOTTOM-RIGHT: Slipstream Pill, Launch Zone, SVG Circular Tachometer & Nitro Bar -->
      <div class="race-cluster">
        <div class="race-slipstream-pill hidden" id="race-hud-slipstream">
          ≫ SLIPSTREAM DRAFTING (+10%)
        </div>

        <div class="race-launch-zone-wrap hidden" id="race-launch-zone-wrap">
          <div class="race-launch-zone-header">
            <span>LAUNCH RPM</span>
            <span id="race-launch-zone-status">HOLD GREEN ZONE!</span>
          </div>
          <div class="race-launch-bar">
            <div class="race-launch-sweetspot" style="left:${launchMinPct}%;width:${launchWidthPct}%;"></div>
            <div class="race-launch-needle" id="race-launch-needle" style="left:15%;"></div>
          </div>
        </div>

        <div class="race-tach-card" id="race-tach-card">
          <div class="race-tach-svg-wrap">
            <svg class="race-tach-svg" viewBox="0 0 186 158" aria-hidden="true">
              <defs>
                <linearGradient id="raceTachGrad" x1="0%" y1="100%" x2="100%" y2="0%">
                  <stop offset="0%" stop-color="#38bdf8" />
                  <stop offset="65%" stop-color="#f59e0b" />
                  <stop offset="100%" stop-color="#ef4444" />
                </linearGradient>
              </defs>
              <path d="${fullArcPath}" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="11" stroke-linecap="round" />
              <path d="${redlineArcPath}" fill="none" stroke="rgba(239,68,68,0.38)" stroke-width="11" stroke-linecap="round" />
              <path
                id="race-tach-arc"
                d="${fullArcPath}"
                fill="none"
                stroke="url(#raceTachGrad)"
                stroke-width="11"
                stroke-linecap="round"
                stroke-dasharray="${TACH_ARC_LENGTH.toFixed(2)}"
                stroke-dashoffset="${TACH_ARC_LENGTH.toFixed(2)}"
              />
              ${buildTachometerTicksSvg()}
            </svg>
            <div class="race-tach-center">
              <div class="race-gear-row">
                <span class="race-gear-badge" id="race-hud-gear">1</span>
                <span class="race-trans-tag" id="race-hud-trans">AUTO</span>
              </div>
              <div class="race-speed-val" id="race-hud-speed">0</div>
              <div class="race-speed-unit">KM/H</div>
            </div>
          </div>

          <div class="race-nitro-wrap">
            <div class="race-nitro-header">
              <span>NITRO [SHIFT]</span>
              <span id="race-hud-nitro-pct">100%</span>
            </div>
            <div class="race-nitro-track">
              <div class="race-nitro-fill" id="race-hud-nitro-fill" style="width:100%;"></div>
            </div>
          </div>
        </div>
      </div>

      <!-- HOLD-TAB LIVE STANDINGS OVERLAY -->
      <div class="race-standings-overlay hidden" id="race-hud-standings"></div>

      <!-- [M] RACE PAUSE MENU -->
      <div class="pause-overlay interactive hidden" id="race-hud-pause" role="dialog" aria-label="Race menu" aria-modal="true" tabindex="-1">
        <div class="modal-card" style="max-width:480px;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <div>
              <div style="font-size:18px;font-weight:900;">RACE CONTROL MENU</div>
              <div style="font-size:12px;color:var(--text-muted);" id="race-pause-info">Grid ----</div>
            </div>
            <span style="font-size:11px;color:var(--accent-green);font-weight:800;" id="race-pause-host-tag"></span>
          </div>

          <div id="race-pause-players" class="pause-player-list"></div>

          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;border-radius:8px;background:rgba(255,255,255,0.04);border:1px solid var(--border-subtle);">
            <span style="font-size:12px;font-weight:700;">Transmission</span>
            <div class="chip-row">
              <button type="button" class="chip race-chip" data-pause-trans="AUTO">AUTO</button>
              <button type="button" class="chip race-chip" data-pause-trans="MANUAL">MANUAL (Q/E)</button>
            </div>
          </div>

          <div id="race-pause-host-controls" class="hidden" style="display:flex;flex-direction:column;gap:8px;padding-top:8px;border-top:1px solid var(--border-subtle);">
            <button type="button" class="btn btn-amber" id="race-pause-start">Start Race Countdown</button>
            <div class="code-row">
              <select id="race-pause-track-select" class="text-input" aria-label="Switch circuit" style="text-transform:none;">
                ${TRACK_LIST.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join("")}
              </select>
              <button type="button" class="btn btn-secondary" id="race-pause-apply-track">Switch Track</button>
            </div>
            <div id="race-pause-track-status" role="status" class="map-change-status"></div>
          </div>

          <button type="button" class="btn btn-secondary hidden" id="race-pause-restart-practice">Restart Time Trial</button>

          <details class="match-controls">
            <summary>Driving Controls</summary>
            <p>WASD / Arrows steer &amp; throttle · Space handbrake drift · Shift nitrous boost</p>
            <p>C cycle camera · B rear view · Q/E manual shift · R instant track reset · Tab standings · M menu</p>
            <p>Controller · Left stick steer · ${RACE_PAD.throttle.label} gas · ${RACE_PAD.brake.label} brake · ${RACE_PAD.drift.label} or ${RACE_PAD.driftButton.label} drift · ${RACE_PAD.nitro.label} nitro</p>
            <p>${RACE_PAD.shiftDown.label} / ${RACE_PAD.shiftUp.label} gears · ${RACE_PAD.camera.label} camera · ${RACE_PAD.rearLeft.label} / ${RACE_PAD.rearRight.label} rear view · ${RACE_PAD.reset.label} reset · ${RACE_PAD.standings.label} standings · ${RACE_PAD.menu.label} menu</p>
          </details>

          <div class="match-menu-actions">
            <button type="button" class="btn btn-race-primary" id="race-pause-resume" style="flex:1;">Resume Race</button>
            <button type="button" class="btn btn-secondary" id="race-pause-settings">Settings</button>
            <button type="button" class="btn btn-danger" id="race-pause-leave">Leave Grid</button>
          </div>
        </div>
      </div>

      <!-- POST-RACE 3D PODIUM OVERLAY -->
      <div class="race-podium-overlay interactive hidden" id="race-hud-podium"></div>
    `;

    parent.appendChild(this.root);

    const minimapCanvas = this.root.querySelector<HTMLCanvasElement>("#race-minimap-canvas");
    this.minimapCtx = minimapCanvas?.getContext("2d") ?? null;

    this.elSpeed = this.root.querySelector("#race-hud-speed")!;
    this.elGear = this.root.querySelector("#race-hud-gear")!;
    this.elTransTag = this.root.querySelector("#race-hud-trans")!;
    this.elTachCard = this.root.querySelector("#race-tach-card")!;
    this.elTachArc = this.root.querySelector("#race-tach-arc")!;
    this.elNitroFill = this.root.querySelector("#race-hud-nitro-fill")!;
    this.elNitroPct = this.root.querySelector("#race-hud-nitro-pct")!;
    this.elSlipstream = this.root.querySelector("#race-hud-slipstream")!;
    this.elLaunchWrap = this.root.querySelector("#race-launch-zone-wrap")!;
    this.elLaunchNeedle = this.root.querySelector("#race-launch-needle")!;
    this.elLaunchStatus = this.root.querySelector("#race-launch-zone-status")!;
    this.elDriftBanner = this.root.querySelector("#race-hud-drift")!;
    this.elDriftMult = this.root.querySelector("#race-hud-drift-mult")!;
    this.elDriftPoints = this.root.querySelector("#race-hud-drift-points")!;
    this.elDriftTotal = this.root.querySelector("#race-hud-drift-total")!;
    this.elWrongWay = this.root.querySelector("#race-hud-wrongway")!;
    this.elPosNum = this.root.querySelector("#race-hud-pos")!;
    this.elPosOrd = this.root.querySelector("#race-hud-pos-ord")!;
    this.elPosTotal = this.root.querySelector("#race-hud-pos-total")!;
    this.elLapVal = this.root.querySelector("#race-hud-lap")!;
    this.elLapTimer = this.root.querySelector("#race-hud-lap-timer")!;
    this.elBestLap = this.root.querySelector("#race-hud-best-lap")!;
    this.elSplitDelta = this.root.querySelector("#race-hud-split-delta")!;
    this.elTelemetry = this.root.querySelector("#race-hud-telemetry")!;
    this.elControlsStrip = this.root.querySelector("#race-hud-controls")!;

    this.bindEvents();
  }

  private bindEvents(): void {
    this.root.querySelector<HTMLElement>("#race-hud-pause")?.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.callbacks.onResumeDriving();
      }
    });

    this.root.querySelector("#race-hud-disconnect-leave")?.addEventListener("click", () => {
      this.callbacks.onLeaveRoom();
    });

    this.root.querySelector("#race-hud-open-menu")?.addEventListener("click", () => {
      this.callbacks.onOpenMenu();
    });

    this.root.querySelector("#race-hud-host-start")?.addEventListener("click", () => {
      this.callbacks.onStartRace();
    });

    this.root.querySelector("#race-hud-copy-invite")?.addEventListener("click", async () => {
      if (!this.room) return;
      const url = `${window.location.origin}/?race=${this.room.code}`;
      try {
        await navigator.clipboard.writeText(url);
        const btn = this.root.querySelector("#race-hud-copy-invite");
        if (btn) {
          btn.textContent = "Copied!";
          setTimeout(() => {
            btn.textContent = "Invite";
          }, 1800);
        }
      } catch {
        window.prompt("Copy race invite link:", url);
      }
    });

    this.root.querySelector("#race-pause-resume")?.addEventListener("click", () => {
      this.callbacks.onResumeDriving();
    });

    this.root.querySelector("#race-pause-restart-practice")?.addEventListener("click", () => {
      this.callbacks.onRestartPractice();
    });

    for (const button of this.root.querySelectorAll<HTMLButtonElement>("[data-race-touch]")) {
      const control = button.dataset.raceTouch as RaceTouchControl;
      let pointerId: number | null = null;
      button.addEventListener("pointerdown", (event) => {
        if (pointerId !== null) return;
        event.preventDefault();
        pointerId = event.pointerId;
        button.setPointerCapture(pointerId);
        button.classList.add("pressed");
        this.callbacks.onTouchControl(control, true);
      });
      const release = (event: PointerEvent) => {
        if (event.pointerId !== pointerId) return;
        pointerId = null;
        button.classList.remove("pressed");
        this.callbacks.onTouchControl(control, false);
      };
      button.addEventListener("pointerup", release);
      button.addEventListener("pointercancel", release);
      button.addEventListener("lostpointercapture", release);
    }

    this.root.querySelector("#race-pause-start")?.addEventListener("click", () => {
      this.callbacks.onStartRace();
      this.callbacks.onResumeDriving();
    });

    this.root.querySelector("#race-pause-apply-track")?.addEventListener("click", () => {
      const sel = this.root.querySelector<HTMLSelectElement>("#race-pause-track-select");
      if (sel?.value && sel.value !== this.room?.trackId) {
        const trackId = sel.value as TrackId;
        const status = this.root.querySelector("#race-pause-track-status");
        if (status) status.textContent = `Switching circuit to ${TRACK_REGISTRY[trackId]?.name ?? trackId}…`;
        this.callbacks.onSwitchTrack(trackId);
      }
    });

    this.root.querySelector("#race-pause-settings")?.addEventListener("click", () => {
      this.callbacks.onOpenSettings();
    });

    this.root.querySelector("#race-pause-leave")?.addEventListener("click", () => {
      this.callbacks.onLeaveRoom();
    });

    this.root.querySelectorAll<HTMLElement>("[data-pause-trans]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.dataset.pauseTrans as TransmissionMode;
        this.profile.racing.transmission = mode;
        saveGuestProfile(this.profile);
        this.callbacks.onTransmissionChanged(mode);
        this.refreshPauseTransButtons();
      });
    });
  }

  private refreshPauseTransButtons(): void {
    const mode = this.profile.racing.transmission;
    this.root.querySelectorAll<HTMLElement>("[data-pause-trans]").forEach((btn) => {
      btn.classList.toggle("selected", btn.dataset.pauseTrans === mode);
    });
  }

  show(localPlayerId: string, room: RaceRoomStateBroadcast): void {
    this.localPlayerId = localPlayerId;
    this.maxObservedDriftCombo = 0;
    this.podiumRenderedKey = "";
    this.root.classList.remove("hidden");
    this.updateRoom(room);
  }

  hide(): void {
    this.root.classList.add("hidden");
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    const menu = this.root.querySelector<HTMLElement>("#race-hud-pause");
    menu?.classList.toggle("hidden", !paused);
    if (paused) {
      menu?.focus({ preventScroll: true });
      if (this.room) this.refreshPausePanel(this.room);
    }
    this.refreshTouchControls();
  }

  private refreshTouchControls(): void {
    const hide = this.paused || !this.room || this.room.phase === "PODIUM" ||
      this.room.players.some((p) => p.id === this.localPlayerId && p.finished);
    this.root.querySelector("#race-touch-controls")?.classList.toggle("hidden", hide);
  }

  setConnectionStatus(text: string): void {
    this.root.querySelector("#race-hud-connection")?.classList.toggle("hidden", !text);
    const el = this.root.querySelector("#race-hud-connection-text");
    if (el) el.textContent = text;
  }

  setStandingsVisible(visible: boolean): void {
    if (this.standingsVisible === visible) return;
    this.standingsVisible = visible;
    const el = this.root.querySelector("#race-hud-standings");
    if (!el) return;
    if (visible && this.room) {
      this.renderStandingsOverlay(this.room);
      el.classList.remove("hidden");
    } else {
      el.classList.add("hidden");
    }
  }

  showPerfectLaunch(): void {
    const el = this.root.querySelector("#race-hud-launch-banner");
    if (!el) return;
    el.classList.remove("hidden");
    if (this.launchHideTimeout) clearTimeout(this.launchHideTimeout);
    this.launchHideTimeout = setTimeout(() => {
      el.classList.add("hidden");
    }, 2000);
  }

  showSplitDelta(deltaMs: number | null): void {
    if (deltaMs === null || !Number.isFinite(deltaMs)) return;
    this.elSplitDelta.textContent = formatSplitDelta(deltaMs);
    this.elSplitDelta.className = `race-split-delta ${deltaMs <= 0 ? "faster" : "slower"}`;
    this.elSplitDelta.classList.remove("hidden");
    if (this.splitHideTimeout) clearTimeout(this.splitHideTimeout);
    this.splitHideTimeout = setTimeout(() => {
      this.elSplitDelta.classList.add("hidden");
    }, 5000);
  }

  handleRaceEvent(event: RaceEventMessage): void {
    if (event.event === "PERFECT_LAUNCH" && event.playerId === this.localPlayerId) {
      this.showPerfectLaunch();
    } else if (event.event === "LAP_COMPLETE" && event.playerId === this.localPlayerId) {
      this.showSplitDelta(event.splitDeltaMs);
    } else if (event.event === "REMATCH_STARTED") {
      this.maxObservedDriftCombo = 0;
      this.podiumRenderedKey = "";
      this.root.querySelector("#race-hud-podium")?.classList.add("hidden");
      this.elSplitDelta.classList.add("hidden");
    } else if (event.event === "PODIUM_READY" && this.room) {
      this.renderPodiumOverlay(this.room, event.podium);
    }
  }

  updateRoom(room: RaceRoomStateBroadcast): void {
    const prevTrack = this.room?.trackId;
    if (this.room?.gridRevision !== room.gridRevision) this.maxObservedDriftCombo = 0;
    this.room = room;
    const track = TRACK_REGISTRY[room.trackId];
    const trackName = track?.name ?? room.trackId;
    const modeShort = RACE_MODE_CONFIGS[room.mode]?.shortLabel ?? room.mode;

    if (prevTrack !== room.trackId) {
      this.minimapCache = null;
      const trackSel = this.root.querySelector<HTMLSelectElement>("#race-pause-track-select");
      if (trackSel) trackSel.value = room.trackId;
      const status = this.root.querySelector("#race-pause-track-status");
      if (status && prevTrack) status.textContent = `Now racing on ${trackName}`;
    }

    const codeEl = this.root.querySelector("#race-hud-room-code");
    if (codeEl) codeEl.textContent = room.mode === "TIME_TRIAL" ? "SOLO" : `GRID ${room.code}`;
    this.root.querySelector("#race-hud-copy-invite")?.classList.toggle("hidden", room.mode === "TIME_TRIAL");
    const trackEl = this.root.querySelector("#race-hud-track-label");
    if (trackEl) trackEl.textContent = `${trackName} (${modeShort})`;
    const miniShort = this.root.querySelector("#race-minimap-track-short");
    if (miniShort) miniShort.textContent = trackName.toUpperCase().slice(0, 18);

    const local = room.players.find((p) => p.id === this.localPlayerId);
    this.root.querySelector(".race-pos-block")?.classList.toggle("hidden", room.mode === "TIME_TRIAL");
    const startBtn = this.root.querySelector("#race-hud-host-start");
    if (startBtn) {
      startBtn.classList.toggle("hidden", !(local?.isHost && room.phase === "LOBBY" && !room.waitingForReady));
    }

    const gridStatus = this.root.querySelector("#race-hud-grid-status");
    const drivers = room.players.filter((p) => !p.isBot);
    const ready = drivers.filter((p) => p.ready && p.connected).length;
    const waitingText = room.phase === "LOBBY"
      ? room.readyWaitExpired
        ? "Grid readiness timed out. The host can start again."
        : room.waitingForReady
          ? `Waiting for drivers · ${ready}/${drivers.length} ready`
          : "Grid open ? Waiting for the host"
      : "";
    if (gridStatus && gridStatus.textContent !== waitingText) gridStatus.textContent = waitingText;
    gridStatus?.classList.toggle("hidden", !waitingText);

    this.refreshTouchControls();
    if (room.phase === "PODIUM") {
      this.renderPodiumOverlay(room, room.podium);
    } else {
      this.podiumRenderedKey = "";
      this.root.querySelector("#race-hud-podium")?.classList.add("hidden");
    }

    if (this.standingsVisible) {
      this.renderStandingsOverlay(room);
    }
    if (this.paused) {
      this.refreshPausePanel(room);
    }
  }

  private refreshPausePanel(room: RaceRoomStateBroadcast): void {
    const local = room.players.find((p) => p.id === this.localPlayerId);
    const infoEl = this.root.querySelector("#race-pause-info");
    if (infoEl) {
      const trackName = TRACK_REGISTRY[room.trackId]?.name ?? room.trackId;
      infoEl.textContent = `Code: ${room.code} • ${room.isPublic ? "Public" : "Private"} • ${RACE_MODE_CONFIGS[room.mode]?.label ?? room.mode} • ${trackName}`;
    }
    const hostTag = this.root.querySelector("#race-pause-host-tag");
    if (hostTag) hostTag.textContent = local?.isHost ? "YOU ARE HOST" : "";

    const listEl = this.root.querySelector("#race-pause-players");
    if (listEl) {
      const sorted = [...room.players].sort((a, b) => a.position - b.position);
      listEl.innerHTML = sorted
        .map((p) => {
          const carName = VEHICLE_REGISTRY[p.setup.vehicleId]?.name ?? p.setup.vehicleId;
          const livColor = LIVERY_REGISTRY[p.setup.liveryId]?.bodyHex ?? "#38bdf8";
          const status = p.isBot ? "" : !p.connected ? " · Reconnecting" : room.phase === "LOBBY"
            ? p.ready ? " · Ready" : " · Loading"
            : "";
          return `
            <div style="display:flex;justify-content:space-between;align-items:center;background:${p.id === this.localPlayerId ? "rgba(56,189,248,0.14)" : "rgba(255,255,255,0.04)"};padding:6px 10px;border-radius:6px;font-size:12px;">
              <span>
                <strong style="font-family:var(--font-mono);color:#fb7185;">P${p.position}</strong>
                <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${livColor};margin:0 5px;"></span>
                ${escapeHtml(p.callsign)} ${p.isHost ? "👑" : ""} ${p.isBot ? "<span style='color:#94a3b8;font-size:10px;'>[AI]</span>" : ""}
              </span>
              <span style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);">${escapeHtml(carName)}${status}</span>
            </div>
          `;
        })
        .join("");
    }

    const hostCtrl = this.root.querySelector("#race-pause-host-controls");
    if (hostCtrl) hostCtrl.classList.toggle("hidden", !local?.isHost || room.phase !== "LOBBY");
    this.root.querySelector("#race-pause-start")?.classList.toggle("hidden", room.phase !== "LOBBY" || room.waitingForReady);
    this.root.querySelector("#race-pause-restart-practice")?.classList.toggle("hidden", !local?.isHost || !room.canRestartPractice);
    this.refreshPauseTransButtons();
  }

  private renderStandingsOverlay(room: RaceRoomStateBroadcast): void {
    const el = this.root.querySelector("#race-hud-standings");
    if (!el) return;
    const trackName = TRACK_REGISTRY[room.trackId]?.name ?? room.trackId;
    const modeLabel = RACE_MODE_CONFIGS[room.mode]?.label ?? room.mode;
    const liveRows: RaceStandingRow[] =
      this.lastSnap && this.lastSnap.standings.length > 0
        ? this.lastSnap.standings
        : [...room.players]
            .sort((a, b) => a.position - b.position)
            .map((p) => ({
              playerId: p.id,
              callsign: p.callsign,
              isPlayer: p.id === this.localPlayerId,
              isBot: p.isBot,
              position: p.position,
              vehicleId: p.setup.vehicleId,
              liveryHex: LIVERY_REGISTRY[p.setup.liveryId]?.bodyHex ?? "#38bdf8",
              lap: p.lap,
              bestLapMs: p.bestLapMs,
              totalDriftScore: p.totalDriftScore,
              finished: p.finished,
              finishTimeMs: p.finishTimeMs,
              pingMs: p.pingMs,
            }));

    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div>
          <div style="font-size:16px;font-weight:900;">${escapeHtml(trackName)} // ${escapeHtml(modeLabel)}</div>
          <div style="font-size:11px;color:var(--text-muted);">Grid ${escapeHtml(room.code)} • ${room.totalLaps} Laps • ${room.phase}</div>
        </div>
        <div style="font-family:var(--font-mono);font-size:12px;color:#fb7185;font-weight:800;">
          ${liveRows.length} RACERS
        </div>
      </div>

      <table class="race-standings-table">
        <thead>
          <tr>
            <th>Pos</th>
            <th>Driver</th>
            <th>Vehicle</th>
            <th>Lap</th>
            <th>Best Lap</th>
            <th>Drift</th>
            <th style="text-align:right;">Status</th>
          </tr>
        </thead>
        <tbody>
          ${liveRows
            .map((p) => {
              const isSelf = p.isPlayer || p.playerId === this.localPlayerId;
              const carName = VEHICLE_REGISTRY[p.vehicleId as keyof typeof VEHICLE_REGISTRY]?.name ?? p.vehicleId;
              const bodyHex = p.liveryHex || "#38bdf8";
              return `
                <tr class="${isSelf ? "race-standings-row-self" : ""}">
                  <td style="font-family:var(--font-mono);font-weight:900;color:${p.position === 1 ? "#facc15" : p.position === 2 ? "#e2e8f0" : p.position === 3 ? "#fb923c" : "#94a3b8"};">
                    ${p.position}${ordinalSuffix(p.position)}
                  </td>
                  <td style="font-weight:800;">
                    <span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${bodyHex};margin-right:6px;border:1px solid rgba(255,255,255,0.4);"></span>
                    ${escapeHtml(p.callsign)}
                    ${isSelf ? "<span style='color:#22d3ee;font-size:10px;margin-left:4px;'>(YOU)</span>" : ""}
                    ${p.isBot ? "<span style='color:#94a3b8;font-size:10px;margin-left:4px;'>[AI]</span>" : ""}
                  </td>
                  <td style="color:var(--text-muted);">${escapeHtml(carName)}</td>
                  <td style="font-family:var(--font-mono);">${Math.min(p.lap, room.totalLaps)}/${room.totalLaps}</td>
                  <td style="font-family:var(--font-mono);color:#86efac;">${formatRaceTime(p.bestLapMs)}</td>
                  <td style="font-family:var(--font-mono);color:#fdba74;">${p.totalDriftScore.toLocaleString()}</td>
                  <td style="text-align:right;font-family:var(--font-mono);color:${p.finished ? "#4ade80" : "#cbd5e1"};">
                    ${p.finished ? formatRaceTime(p.finishTimeMs) : "RACING"}
                  </td>
                </tr>
              `;
            })
            .join("")}
        </tbody>
      </table>
    `;
  }

  private renderPodiumOverlay(room: RaceRoomStateBroadcast, entries: RacePodiumEntry[]): void {
    const el = this.root.querySelector<HTMLElement>("#race-hud-podium");
    if (!el) return;
    const list = entries.length > 0 ? entries : room.podium;
    const votesSig = room.trackVoteOptions.map((id) => `${id}:${room.trackVotes[id] ?? 0}`).join(",");
    const localIsHost = room.players.some((p) => p.id === this.localPlayerId && p.isHost);
    const nextRace = room.podiumAutoRematchSec > 0 ? `Next grid in ${room.podiumAutoRematchSec}s` : "Preparing next grid";
    const key = `${room.gridRevision}|${room.trackId}|${list.length}|${votesSig}|${localIsHost}`;
    if (key === this.podiumRenderedKey && !el.classList.contains("hidden")) {
      const timer = el.querySelector("#race-podium-rematch-timer");
      if (timer && timer.textContent !== nextRace) timer.textContent = nextRace;
      return;
    }
    this.podiumRenderedKey = key;

    const top3 = list.slice(0, 3);
    const localEntry = list.find((e) => e.playerId === this.localPlayerId);
    const trackName = TRACK_REGISTRY[room.trackId]?.name ?? room.trackId;
    const isDriftMode = room.mode === "DRIFT_ATTACK";
    const isTimeTrial = room.mode === "TIME_TRIAL";

    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div>
          <div style="font-size:11px;font-weight:900;letter-spacing:1.6px;color:#fb7185;">${isTimeTrial ? "TIME TRIAL RESULT" : "RACE RESULTS"}</div>
          <div style="font-size:22px;font-weight:900;">${escapeHtml(trackName)} — ${escapeHtml(RACE_MODE_CONFIGS[room.mode]?.label ?? room.mode)}</div>
        </div>
        <div id="race-podium-rematch-timer" style="font-family:var(--font-mono);font-size:12px;color:var(--accent-amber);font-weight:800;">${nextRace}</div>
      </div>

      <div class="race-podium-top3">
        ${top3
          .map((p) => {
            const medal = p.dnf ? "DNF" : isTimeTrial ? "COMPLETED" : p.rank === 1 ? "🥇 1ST PLACE" : p.rank === 2 ? "🥈 2ND PLACE" : "🥉 3RD PLACE";
            const carName = VEHICLE_REGISTRY[p.vehicleId]?.name ?? p.vehicleId;
            const bodyHex = LIVERY_REGISTRY[p.liveryId as keyof typeof LIVERY_REGISTRY]?.bodyHex ?? "#38bdf8";
            const gapLabel =
              p.rank === 1
                ? formatRaceTime(p.finishTimeMs)
                : p.dnf
                  ? "DNF"
                  : p.gapToWinnerMs !== null
                    ? `+${(p.gapToWinnerMs / 1000).toFixed(2)}s`
                    : formatRaceTime(p.finishTimeMs);
            return `
              <div class="race-podium-card rank-${p.rank}">
                <div style="font-size:11px;font-weight:900;letter-spacing:1px;color:${p.rank === 1 ? "#facc15" : p.rank === 2 ? "#e2e8f0" : "#fb923c"};">${medal}</div>
                <div style="font-size:16px;font-weight:900;display:flex;align-items:center;gap:6px;">
                  <span style="width:10px;height:10px;border-radius:50%;background:${bodyHex};display:inline-block;"></span>
                  ${escapeHtml(p.callsign)}
                  ${p.playerId === this.localPlayerId ? "<span style='font-size:10px;color:#22d3ee;'>YOU</span>" : ""}
                </div>
                <div style="font-size:11px;color:var(--text-muted);">${escapeHtml(carName)}</div>
                <div style="display:flex;justify-content:space-between;margin-top:6px;font-family:var(--font-mono);font-size:11.5px;">
                  <span style="color:#fff;font-weight:800;">${isDriftMode ? `${p.totalDriftScore.toLocaleString()} PTS` : gapLabel}</span>
                  <span style="color:#86efac;">BEST ${formatRaceTime(p.bestLapMs)}</span>
                </div>
              </div>
            `;
          })
          .join("")}
      </div>

      ${
        localEntry
          ? `<div class="race-podium-summary">
              ${isTimeTrial ? "" : `<span><strong>Your finish</strong> ${localEntry.dnf ? "DNF" : `${localEntry.rank}${ordinalSuffix(localEntry.rank)} / ${list.length}`}</span>`}
              <span><strong>Best Lap:</strong> <span style="font-family:var(--font-mono);color:#86efac;">${formatRaceTime(localEntry.bestLapMs)}</span></span>
              <span><strong>Total Drift:</strong> <span style="font-family:var(--font-mono);color:#fdba74;">${localEntry.totalDriftScore.toLocaleString()}</span></span>
              <span><strong>Max Combo:</strong> <span style="font-family:var(--font-mono);color:#fb7185;">+${this.maxObservedDriftCombo.toLocaleString()}</span></span>
            </div>`
          : ""
      }

      <div class="race-podium-actions">
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
          <span style="font-size:11px;font-weight:800;color:var(--text-muted);letter-spacing:1px;">VOTE NEXT TRACK:</span>
          ${room.trackVoteOptions
            .map((tId) => {
              const name = TRACK_REGISTRY[tId]?.name ?? tId;
              const votes = room.trackVotes[tId] ?? 0;
              return `<button type="button" class="btn btn-secondary" data-race-vote-track="${tId}" style="padding:7px 11px;font-size:11px;">${escapeHtml(name)} (${votes})</button>`;
            })
            .join("")}
        </div>
        <div style="display:flex;gap:8px;">
          ${localIsHost ? '<button type="button" class="btn btn-race-primary" id="race-podium-rematch">Start Next Grid</button>' : ""}
          <button type="button" class="btn btn-danger" id="race-podium-leave">Garage</button>
        </div>
      </div>
    `;

    el.classList.remove("hidden");

    el.querySelectorAll<HTMLElement>("[data-race-vote-track]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const trackId = btn.dataset.raceVoteTrack as TrackId;
        this.callbacks.onVoteTrack(trackId);
      });
    });

    el.querySelector("#race-podium-rematch")?.addEventListener("click", () => {
      this.callbacks.onRematchNow();
    });

    el.querySelector("#race-podium-leave")?.addEventListener("click", () => {
      this.callbacks.onLeaveRoom();
    });
  }

  private ensureMinimapCache(trackId: TrackId): MinimapTrackCache {
    if (this.minimapCache && this.minimapCache.trackId === trackId) {
      return this.minimapCache;
    }
    const frames = sampleTrackFrames(trackId, 160);
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const f of frames) {
      if (f.position.x < minX) minX = f.position.x;
      if (f.position.x > maxX) maxX = f.position.x;
      if (f.position.z < minZ) minZ = f.position.z;
      if (f.position.z > maxZ) maxZ = f.position.z;
    }
    const pad = 16;
    const size = 164;
    const spanX = Math.max(1, maxX - minX);
    const spanZ = Math.max(1, maxZ - minZ);
    const scale = (size - pad * 2) / Math.max(spanX, spanZ);
    const drawnW = spanX * scale;
    const drawnH = spanZ * scale;
    const offsetX = (size - drawnW) * 0.5;
    const offsetY = (size - drawnH) * 0.5;

    const toCanvas = (x: number, z: number) => ({
      mx: offsetX + (x - minX) * scale,
      my: size - (offsetY + (z - minZ) * scale),
    });

    const points = frames.map((f) => ({
      ...toCanvas(f.position.x, f.position.z),
      isTunnel: f.isTunnel,
    }));

    const f0 = frames[0];
    const halfW = Math.max(10, f0.roadWidth * 0.75);
    const startA = toCanvas(f0.position.x - f0.right.x * halfW, f0.position.z - f0.right.z * halfW);
    const startB = toCanvas(f0.position.x + f0.right.x * halfW, f0.position.z + f0.right.z * halfW);

    this.minimapCache = {
      trackId,
      points,
      startA,
      startB,
      minX,
      minZ,
      scale,
      offsetX,
      offsetY,
    };
    return this.minimapCache;
  }

  private renderMinimap(snap: RaceHudSnapshot): void {
    const ctx = this.minimapCtx;
    const room = this.room;
    if (!ctx || !room) return;

    const cache = this.ensureMinimapCache(room.trackId);
    const size = 164;

    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = "rgba(6, 10, 18, 0.94)";
    ctx.fillRect(0, 0, size, size);

    // Subtle radar grid
    ctx.strokeStyle = "rgba(148, 163, 184, 0.08)";
    ctx.lineWidth = 1;
    for (let g = 32; g < size; g += 32) {
      ctx.beginPath();
      ctx.moveTo(g, 0);
      ctx.lineTo(g, size);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, g);
      ctx.lineTo(size, g);
      ctx.stroke();
    }

    // Full closed circuit outline
    const pts = cache.points;
    if (pts.length > 2) {
      ctx.lineJoin = "round";
      ctx.lineCap = "round";

      // Road outer border
      ctx.beginPath();
      ctx.moveTo(pts[0].mx, pts[0].my);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].mx, pts[i].my);
      ctx.closePath();
      ctx.strokeStyle = "rgba(148, 163, 184, 0.35)";
      ctx.lineWidth = 8;
      ctx.stroke();

      // Road inner ribbon
      ctx.strokeStyle = "rgba(226, 232, 240, 0.82)";
      ctx.lineWidth = 3.2;
      ctx.stroke();

      // Highlight tunnel stretches in subtle neon cyan
      ctx.beginPath();
      let drawingTunnel = false;
      for (let i = 0; i < pts.length; i++) {
        if (pts[i].isTunnel) {
          if (!drawingTunnel) {
            ctx.moveTo(pts[i].mx, pts[i].my);
            drawingTunnel = true;
          } else {
            ctx.lineTo(pts[i].mx, pts[i].my);
          }
        } else {
          drawingTunnel = false;
        }
      }
      ctx.strokeStyle = "rgba(34, 211, 238, 0.72)";
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    // Start / Finish line bar
    ctx.beginPath();
    ctx.moveTo(cache.startA.mx, cache.startA.my);
    ctx.lineTo(cache.startB.mx, cache.startB.my);
    ctx.strokeStyle = "#f43f5e";
    ctx.lineWidth = 3.2;
    ctx.stroke();

    const toCanvas = (x: number, z: number) => ({
      mx: cache.offsetX + (x - cache.minX) * cache.scale,
      my: size - (cache.offsetY + (z - cache.minZ) * cache.scale),
    });

    // Rival car dots
    for (const car of snap.minimapCars) {
      if (car.isPlayer || car.id === this.localPlayerId) continue;
      const { mx, my } = toCanvas(car.x, car.z);
      ctx.fillStyle = car.position === 1 ? "#facc15" : car.colorHex || "#fb7185";
      ctx.beginPath();
      ctx.arc(mx, my, 3.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#090d16";
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    // Local player glowing cyan directional chevron
    const selfPt = toCanvas(snap.playerPos.x, snap.playerPos.z);
    ctx.save();
    ctx.translate(selfPt.mx, selfPt.my);
    // Babylon yaw=0 faces +Z (up on minimap because Y is inverted from Z), +yaw turns right (clockwise)
    ctx.rotate(snap.playerYaw);

    ctx.fillStyle = "rgba(34, 211, 238, 0.28)";
    ctx.beginPath();
    ctx.arc(0, 0, 8, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#22d3ee";
    ctx.beginPath();
    ctx.moveTo(0, -6.5);
    ctx.lineTo(5, 5);
    ctx.lineTo(0, 2.2);
    ctx.lineTo(-5, 5);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  private updateCountdownBanner(snap: RaceHudSnapshot): void {
    const state = snap.countdownState;
    const banner = this.root.querySelector("#race-hud-countdown");
    const textEl = this.root.querySelector("#race-hud-countdown-text");
    const l1 = this.root.querySelector("#race-light-1");
    const l2 = this.root.querySelector("#race-light-2");
    const l3 = this.root.querySelector("#race-light-3");
    if (!banner || !textEl) return;

    const isCountdownTick = state === 3 || state === 2 || state === 1;
    const isGo = state === 0;

    // Green launch zone bar during 3-2-1 countdown
    this.elLaunchWrap.classList.toggle("hidden", !isCountdownTick);
    if (isCountdownTick) {
      const pct = Math.max(0, Math.min(100, snap.rpmNorm * 100));
      this.elLaunchNeedle.style.left = `${pct.toFixed(1)}%`;
      this.elLaunchStatus.textContent = snap.inLaunchGreenZone ? "PERFECT ZONE ✓" : "HOLD GREEN ZONE!";
      this.elLaunchStatus.style.color = snap.inLaunchGreenZone ? "#4ade80" : "#fde047";
    }

    if (state === this.lastCountdownKey) return;
    this.lastCountdownKey = state;

    if (this.goHideTimeout) {
      clearTimeout(this.goHideTimeout);
      this.goHideTimeout = null;
    }

    const resetLights = () => {
      l1?.classList.remove("lit-red", "lit-amber", "lit-green");
      l2?.classList.remove("lit-red", "lit-amber", "lit-green");
      l3?.classList.remove("lit-red", "lit-amber", "lit-green");
    };

    if (isCountdownTick) {
      resetLights();
      if (state === 3) {
        l1?.classList.add("lit-red");
      } else if (state === 2) {
        l1?.classList.add("lit-red");
        l2?.classList.add("lit-amber");
      } else {
        l1?.classList.add("lit-red");
        l2?.classList.add("lit-amber");
        l3?.classList.add("lit-amber");
      }
      textEl.textContent = String(state);
      textEl.classList.remove("is-go");
      banner.classList.remove("hidden");
    } else if (isGo) {
      resetLights();
      l1?.classList.add("lit-green");
      l2?.classList.add("lit-green");
      l3?.classList.add("lit-green");
      textEl.textContent = "GO!";
      textEl.classList.add("is-go");
      banner.classList.remove("hidden");
      this.goHideTimeout = setTimeout(() => {
        banner.classList.add("hidden");
      }, 1150);
    } else {
      banner.classList.add("hidden");
    }
  }

  updateLiveHud(snap: RaceHudSnapshot): void {
    this.lastSnap = snap;
    const now = performance.now();

    // 1. Speedometer + Gear + SVG Tachometer Arc
    const speedInt = Math.max(0, Math.round(snap.speedKmh));
    this.elSpeed.textContent = String(speedInt);
    this.elGear.textContent = formatGear(snap.gear);
    this.elTransTag.textContent = snap.transmission === "MANUAL" ? "MAN" : "AUTO";

    const clampedRpmNorm = Math.max(0, Math.min(1, snap.rpmNorm));
    const dashOffset = TACH_ARC_LENGTH * (1 - clampedRpmNorm);
    this.elTachArc.style.strokeDashoffset = dashOffset.toFixed(1);
    this.elTachCard.classList.toggle("redline", clampedRpmNorm >= 0.86);

    // 2. Nitrous Boost Bar & Slipstream Pill
    const nitroClamped = Math.max(0, Math.min(100, snap.nitroPct));
    this.elNitroFill.style.width = `${nitroClamped.toFixed(1)}%`;
    this.elNitroFill.classList.toggle("boosting", Boolean(snap.nitroActive));
    this.elNitroPct.textContent = `${Math.round(nitroClamped)}%`;
    this.elSlipstream.classList.toggle("hidden", !snap.slipstreamActive);

    // 3. Countdown & Green Launch Zone + Launch Boost + Wrong Way
    this.updateCountdownBanner(snap);
    if (snap.perfectLaunchActive) {
      const launchEl = this.root.querySelector("#race-hud-launch-banner");
      if (launchEl?.classList.contains("hidden")) {
        this.showPerfectLaunch();
      }
    }
    this.elWrongWay.classList.toggle("hidden", !snap.wrongWay);

    // 4. Center-Right Dynamic Drift Combo Banner
    if (snap.drifting || snap.driftScore > 0) {
      const roundedScore = Math.round(snap.driftScore);
      if (roundedScore > this.maxObservedDriftCombo) {
        this.maxObservedDriftCombo = roundedScore;
      }
      this.lastHeldDriftScore = roundedScore;
      this.lastHeldDriftMult = Math.max(1, Math.round(snap.driftMultiplier));
      this.driftHoldUntil = now + 1350;
      this.elDriftBanner.classList.remove("hidden");
      this.elDriftMult.textContent = `x${this.lastHeldDriftMult}`;
      this.elDriftPoints.textContent = `+${this.lastHeldDriftScore.toLocaleString()}`;
      this.elDriftTotal.textContent = `TOTAL ${(snap.totalDriftScore ?? 0).toLocaleString()}`;
    } else if (now > this.driftHoldUntil) {
      this.elDriftBanner.classList.add("hidden");
    }

    // 5. Top-Center Position, Lap, Live Timer & Best Lap
    const pos = Math.max(1, snap.position);
    this.elPosNum.textContent = String(pos);
    this.elPosNum.className = `race-pos-num ${pos <= 3 ? `pos-${pos}` : ""}`;
    this.elPosOrd.textContent = ordinalSuffix(pos);
    this.elPosTotal.textContent = `/ ${Math.max(1, snap.totalRacers)}`;

    const displayLap = Math.min(Math.max(1, snap.lap), Math.max(1, snap.totalLaps));
    this.elLapVal.textContent = `${displayLap} / ${Math.max(1, snap.totalLaps)}`;
    this.elLapTimer.textContent = formatRaceTime(snap.lapTimeMs);
    this.elBestLap.textContent = `BEST ${formatRaceTime(snap.bestLapMs)}`;
    if (snap.splitDeltaMs !== null && Number.isFinite(snap.splitDeltaMs) && this.elSplitDelta.classList.contains("hidden")) {
      this.showSplitDelta(snap.splitDeltaMs);
    }

    // 6. Top-Right Telemetry & Controls Strip (Manual shift hint)
    const pingText = snap.pingMs !== null ? `${Math.round(snap.pingMs)}ms` : "—";
    this.elTelemetry.textContent = `${Math.round(snap.fps)} FPS · ${pingText} · [C] ${snap.cameraModeLabel}`;
    const expectedControls =
      snap.transmission === "MANUAL"
        ? "<strong>WASD</strong> Drive · <strong>Q/E</strong> Shift · <strong>SPACE</strong> Drift · <strong>SHIFT</strong> Nitro · <strong>C</strong> Cam · <strong>R</strong> Reset · <strong>TAB</strong> Grid · <strong>M</strong> Menu"
        : "<strong>WASD</strong> Drive · <strong>SPACE</strong> Drift · <strong>SHIFT</strong> Nitro · <strong>C</strong> Cam · <strong>B</strong> Rear · <strong>R</strong> Reset · <strong>TAB</strong> Grid · <strong>M</strong> Menu";
    if (this.elControlsStrip.innerHTML !== expectedControls) {
      this.elControlsStrip.innerHTML = expectedControls;
    }

    this.root.classList.toggle("manual-transmission", snap.transmission === "MANUAL");
    const clock = this.root.querySelector("#race-hud-clock-status");
    const ghostLabel = this.room?.mode === "TIME_TRIAL" ? (snap.timeTrialGhostMs
      ? `PB ghost ${formatRaceTime(snap.timeTrialGhostMs)}`
      : "Finish a lap to set your ghost") : "";
    const remaining = this.room?.raceRemainingSec;
    const showDeadline = snap.phase === "RACING" && remaining !== undefined &&
      (this.room?.mode === "DRIFT_ATTACK" || remaining <= 60);
    const clockLabel = [ghostLabel, showDeadline ? `${formatRaceTime(remaining * 1000)} remaining` : ""]
      .filter(Boolean).join(" · ");
    if (clock && clock.textContent !== clockLabel) clock.textContent = clockLabel;
    clock?.classList.toggle("hidden", !clockLabel);

    // 7. Throttled Live Track Spline Minimap (~22Hz)
    if (now - this.lastMinimapDraw >= 45) {
      this.lastMinimapDraw = now;
      this.renderMinimap(snap);
    }

    // 8. Refresh Tab Standings if held open (~5Hz)
    if (this.standingsVisible && this.room && now - this.lastStandingsDraw >= 200) {
      this.lastStandingsDraw = now;
      this.renderStandingsOverlay(this.room);
    }

    // 9. Show Podium if snapshot reports finished with podium entries
    if (snap.finished && snap.podiumEntries.length > 0 && this.room) {
      this.renderPodiumOverlay(this.room, snap.podiumEntries);
    }
  }

  getLastSnapshot(): RaceHudSnapshot | null {
    return this.lastSnap;
  }

  dispose(): void {
    if (this.goHideTimeout) clearTimeout(this.goHideTimeout);
    if (this.launchHideTimeout) clearTimeout(this.launchHideTimeout);
    if (this.splitHideTimeout) clearTimeout(this.splitHideTimeout);
    this.root.remove();
  }
}
