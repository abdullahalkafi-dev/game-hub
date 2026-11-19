import {
  LIVERY_LIST,
  LIVERY_REGISTRY,
  RACE_MODE_CONFIGS,
  RACE_MODE_LIST,
  RIM_LIST,
  SPOILER_LIST,
  TRACK_LIST,
  TRACK_REGISTRY,
  TUNE_LIST,
  UNDERGLOW_LIST,
  VEHICLE_LIST,
  computeEffectiveVehicleStats,
  getLiveryDefinition,
  getTrackLength,
  getTuneDefinition,
  getVehicleDefinition,
  sanitizeCarSetup,
  type BotDifficulty,
  type CarSetupConfig,
  type RaceMode,
  type RacePublicRoomSummary,
  type TrackId,
  type TransmissionMode,
} from "@game/shared";
import { saveGuestProfile, type GuestProfile } from "../state/UserProfileStore.js";

export interface RaceGarageCallbacks {
  onQuickRace: (opts: {
    mode: RaceMode;
    trackId: TrackId;
    botFill: boolean;
    botDifficulty: BotDifficulty;
  }) => void;
  onCreateRoom: (opts: {
    mode: RaceMode;
    trackId: TrackId;
    isPublic: boolean;
    botFill: boolean;
    botDifficulty: BotDifficulty;
  }) => void;
  onJoinCode: (code: string) => void;
  onRefreshPublicRooms: () => Promise<RacePublicRoomSummary[]>;
  onCarSetupChanged: (setup: CarSetupConfig) => void;
  onRevEngine: () => void;
  onOpenSettings: () => void;
  onSwitchToShooter: () => void;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function formatBestLap(ms?: number): string {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return "--:--.--";
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  const hundredths = Math.floor((ms % 1000) / 10);
  return `${mins}:${secs < 10 ? "0" : ""}${secs}.${hundredths < 10 ? "0" : ""}${hundredths}`;
}

function formatEngineLabel(profile: string): string {
  switch (profile) {
    case "V10_SUPER":
      return "V10 SUPER";
    case "I6_TURBO":
      return "I6 TURBO";
    case "V8_MUSCLE":
      return "V8 MUSCLE";
    case "BOXER_RALLY":
      return "BOXER AWD";
    default:
      return profile;
  }
}

function trackAccentHex(trackId: TrackId): string {
  switch (trackId) {
    case "tokyo_midnight":
      return "#22d3ee";
    case "coastal_sunset":
      return "#fb923c";
    case "harbor_gp":
      return "#38bdf8";
  }
}

export class RaceGarageScreen {
  private readonly root: HTMLDivElement;
  private activeTab: "ARENA" | "GARAGE" | "ROOMS" = "ARENA";
  private selectedMode: RaceMode = "GRAND_PRIX";
  private selectedTrackId: TrackId = "tokyo_midnight";
  private createPublic = true;
  private botFill = true;
  private botDifficulty: BotDifficulty;
  private preloadStatusText = "Loading 3D showroom & track assets...";
  private publicRooms: RacePublicRoomSummary[] = [];
  private statusBanner = "";
  private revAnimTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(
    parent: HTMLElement,
    private readonly profile: GuestProfile,
    private readonly callbacks: RaceGarageCallbacks
  ) {
    this.botDifficulty = profile.settings.botDifficulty;
    this.root = document.createElement("div");
    this.root.className = "race-garage-shell hidden";
    parent.appendChild(this.root);
    this.render();
  }

  show(): void {
    this.botDifficulty = this.profile.settings.botDifficulty;
    this.root.classList.remove("hidden");
    this.render();
  }

  hide(): void {
    this.root.classList.add("hidden");
  }

  setActiveTab(tab: "ARENA" | "GARAGE" | "ROOMS"): void {
    this.activeTab = tab;
    this.render();
  }

  setPreloadStatus(text: string): void {
    this.preloadStatusText = text;
    const el = this.root.querySelector("#race-preload-status");
    if (el) el.textContent = text;
  }

  setErrorBanner(msg: string): void {
    this.statusBanner = msg;
    const el = this.root.querySelector("#race-garage-error");
    if (el) {
      el.textContent = msg;
      el.classList.toggle("hidden", !msg);
    }
  }

  getCarSetup(): CarSetupConfig {
    return sanitizeCarSetup(this.profile.racing as Partial<CarSetupConfig>);
  }

  private render(): void {
    const setup = this.getCarSetup();
    const vehicle = getVehicleDefinition(setup.vehicleId);
    const livery = getLiveryDefinition(setup.liveryId);
    const tune = getTuneDefinition(setup.tuneId);
    const effStats = computeEffectiveVehicleStats(setup.vehicleId, setup.tuneId);
    const stats = this.profile.racing.stats;

    this.root.innerHTML = `
      <div class="topbar race-garage-topbar">
        <div class="brand-lockup">
          <div class="race-brand-badge">AD</div>
          <div>
            <div class="brand-title">APEXDRIVE // STREET</div>
          </div>
        </div>

        <div class="game-hub-switcher" role="navigation" aria-label="Game Hub Switcher">
          <button type="button" class="hub-pill" data-switch-game="shooter" id="btn-switch-to-shooter">
            <span class="hub-dot hub-dot-shooter"></span>StrikeCore FPS
          </button>
          <button type="button" class="hub-pill active-racer" data-switch-game="racer" aria-current="page">
            <span class="hub-dot hub-dot-racer"></span>ApexDrive Racer
          </button>
        </div>

        <div class="nav-tabs">
          <button type="button" class="tab-btn race-tab-btn ${this.activeTab === "ARENA" ? "active" : ""}" data-race-tab="ARENA">Race Arena</button>
          <button type="button" class="tab-btn race-tab-btn ${this.activeTab === "GARAGE" ? "active" : ""}" data-race-tab="GARAGE">Car Garage</button>
          <button type="button" class="tab-btn race-tab-btn ${this.activeTab === "ROOMS" ? "active" : ""}" data-race-tab="ROOMS">Public Rooms</button>
          <button type="button" class="tab-btn race-tab-btn" id="race-btn-open-settings">Settings</button>
        </div>

        <div class="profile-pill">
          <div style="font-size:11px;color:#fb7185;font-weight:800;white-space:nowrap;">WINS ${stats.wins} · RACES ${stats.races}</div>
          <input id="race-callsign-input" class="callsign-input" maxlength="16" title="Edit Driver Callsign" />
          <div style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono);white-space:nowrap;">
            DRIFT ${stats.bestDriftScore.toLocaleString()}
          </div>
        </div>
      </div>

      <div id="race-garage-error" role="alert" class="hidden" style="pointer-events:auto;margin-top:10px;background:rgba(239,68,68,0.2);border:1px solid #ef4444;color:#fecaca;padding:8px 14px;border-radius:8px;font-size:13px;"></div>

      ${
        this.activeTab === "ROOMS"
          ? this.renderPublicRoomsTab()
          : this.renderMainOrGarageGrid(setup, vehicle, livery, tune, effStats)
      }
    `;

    const callsignInput = this.root.querySelector<HTMLInputElement>("#race-callsign-input");
    if (callsignInput) callsignInput.value = this.profile.callsign;
    this.setErrorBanner(this.statusBanner);
    this.bindEvents();
  }

  private renderPublicRoomsTab(): string {
    return `
      <div class="race-panel" style="margin-top:16px;flex:1;">
        <div class="panel-title">
          <span>Live Public Racing Grids</span>
          <button type="button" class="btn btn-secondary" id="race-btn-refresh-rooms" style="padding:6px 12px;font-size:11px;">Refresh List</button>
        </div>
        ${
          this.publicRooms.length === 0
            ? `<div style="padding:40px;text-align:center;color:var(--text-muted);">No public racing rooms open right now. Launch <strong>Quick Race</strong> or <strong>Create Custom Room</strong> to start a grid instantly!</div>`
            : `<div style="display:grid;gap:10px;">
                ${this.publicRooms
                  .map((r) => {
                    const trackName = TRACK_REGISTRY[r.trackId]?.name ?? r.trackId;
                    const modeLabel = RACE_MODE_CONFIGS[r.mode]?.label ?? r.mode;
                    const canJoin = r.phase === "LOBBY" && r.humanCount < r.maxPlayers;
                    return `
                      <div class="race-select-card" style="display:flex;justify-content:space-between;align-items:center;cursor:default;">
                        <div>
                          <div class="select-card-title" style="gap:10px;">
                            <span style="font-family:var(--font-mono);color:#fb7185;">[${escapeHtml(r.code)}]</span>
                            <span>${escapeHtml(trackName)}</span>
                            <span style="font-size:11px;color:var(--accent-amber);">${escapeHtml(modeLabel)} • ${r.phase}</span>
                          </div>
                          <div class="select-card-desc">
                            Grid: ${r.playerCount} / ${r.maxPlayers} (${r.humanCount} human${r.botFill ? ` · AI ${r.botDifficulty}` : ""})
                          </div>
                        </div>
                        <button type="button" class="btn btn-race-primary" data-race-join-public="${escapeHtml(r.code)}" ${canJoin ? "" : "disabled"}>${canJoin ? "Join Grid" : r.phase !== "LOBBY" ? "In Progress" : "Full"}</button>
                      </div>
                    `;
                  })
                  .join("")}
              </div>`
        }
      </div>
    `;
  }

  private renderMainOrGarageGrid(
    setup: CarSetupConfig,
    vehicle: ReturnType<typeof getVehicleDefinition>,
    livery: ReturnType<typeof getLiveryDefinition>,
    tune: ReturnType<typeof getTuneDefinition>,
    effStats: ReturnType<typeof computeEffectiveVehicleStats>
  ): string {
    const diffs: BotDifficulty[] = ["EASY", "NORMAL", "PRO"];
    const isTimeTrial = this.selectedMode === "TIME_TRIAL";
    const stats = this.profile.racing.stats;
    const personalBests = isTimeTrial ? stats.bestTimeTrialMsByTrack : stats.bestLapMsByTrack;
    const bestTrackMs = personalBests[this.selectedTrackId];

    return `
      <div class="race-garage-grid">
        <!-- LEFT PANEL: Race Modes & Circuits OR Vehicle Roster -->
        <div class="race-panel">
          ${
            this.activeTab === "ARENA"
              ? `
            <div class="panel-title"><span>1. Select Race Mode</span></div>
            <div class="mode-grid">
              ${RACE_MODE_LIST.map(
                (m) => `
                  <button type="button" class="race-select-card ${this.selectedMode === m.id ? "selected" : ""}" data-race-mode="${m.id}">
                    <div class="select-card-title">
                      <span>${escapeHtml(m.label)}</span>
                      <span style="font-size:11px;color:#fb7185;">${m.maxPlayers}P</span>
                    </div>
                    <div class="select-card-desc">${escapeHtml(m.description)}</div>
                  </button>
                `
              ).join("")}
            </div>

            <div class="panel-title" style="margin-top:4px;">
              <span>2. Select Circuit</span>
              <span id="race-preload-status" style="font-size:10px;color:var(--accent-green);text-transform:none;">${escapeHtml(this.preloadStatusText)}</span>
            </div>
            <div class="map-grid">
              ${TRACK_LIST.map((track) => {
                const lenKm = (getTrackLength(track) / 1000).toFixed(2);
                const pb = personalBests[track.id];
                return `
                  <button type="button" class="race-select-card ${this.selectedTrackId === track.id ? "selected" : ""}" data-race-track="${track.id}">
                    <div class="select-card-title">
                      <span>${escapeHtml(track.name)}</span>
                      <span class="swatch-dot" style="background:${trackAccentHex(track.id)};"></span>
                    </div>
                    <div class="select-card-desc">${escapeHtml(track.subtitle)}</div>
                    <div class="race-track-meta">
                      <span>${isTimeTrial ? "1 LAP" : `${track.laps} LAPS`} • ${lenKm} KM • ${track.isNight ? "NIGHT" : "DAY"}</span>
                      <span style="color:${pb ? "#4ade80" : "var(--text-muted)"};">PB ${formatBestLap(pb)}</span>
                    </div>
                  </button>
                `;
              }).join("")}
            </div>
          `
              : `
            <div class="panel-title">
              <span>Select Vehicle Chassis</span>
              <span style="font-size:10px;color:#fb7185;">${VEHICLE_LIST.length} ARCHETYPES</span>
            </div>
            <div class="mode-grid">
              ${VEHICLE_LIST.map(
                (v) => `
                  <button type="button" class="race-select-card ${setup.vehicleId === v.id ? "selected" : ""}" data-vehicle="${v.id}">
                    <div class="select-card-title">
                      <span>${escapeHtml(v.name)}</span>
                      <span style="font-size:10px;color:var(--accent-amber);">${escapeHtml(v.classLabel)} · ${v.drivetrain}</span>
                    </div>
                    <div class="select-card-desc">${escapeHtml(v.tagline)}</div>
                    <div class="race-car-mini-bars">
                      <div class="race-mini-bar-item">
                        <span>SPD ${v.stats.topSpeed}</span>
                        <div class="race-mini-track"><div class="race-mini-fill race-stat-fill-speed" style="width:${v.stats.topSpeed}%;"></div></div>
                      </div>
                      <div class="race-mini-bar-item">
                        <span>ACC ${v.stats.acceleration}</span>
                        <div class="race-mini-track"><div class="race-mini-fill race-stat-fill-accel" style="width:${v.stats.acceleration}%;"></div></div>
                      </div>
                      <div class="race-mini-bar-item">
                        <span>DRF ${v.stats.driftGrip}</span>
                        <div class="race-mini-track"><div class="race-mini-fill race-stat-fill-drift" style="width:${v.stats.driftGrip}%;"></div></div>
                      </div>
                    </div>
                  </button>
                `
              ).join("")}
            </div>

            <div class="panel-title" style="margin-top:4px;"><span>Transmission</span></div>
            <div class="transmission-segmented">
              <button type="button" class="chip race-chip ${setup.transmission === "AUTO" ? "selected" : ""}" data-transmission="AUTO" style="padding:9px;text-align:center;">
                AUTO SHIFT
              </button>
              <button type="button" class="chip race-chip ${setup.transmission === "MANUAL" ? "selected" : ""}" data-transmission="MANUAL" style="padding:9px;text-align:center;">
                MANUAL (Q / E)
              </button>
            </div>
          `
          }
        </div>

        <!-- CENTER STAGE: Transparent 3D Car Showroom (pointer-events: none for drag-orbit & zoom!) -->
        <div class="race-stage-center">
          <div class="race-stage-banner">
            <div class="race-stage-title-card">
              <div style="font-size:10.5px;color:#fb7185;font-weight:900;letter-spacing:1.4px;">
                ${escapeHtml(vehicle.classLabel)} • ${vehicle.drivetrain} • ${formatEngineLabel(effStats.engineAudioProfile)}
              </div>
              <div style="font-size:24px;font-weight:900;line-height:1.15;">${escapeHtml(vehicle.name)}</div>
              <div style="font-size:11.5px;color:var(--text-muted);margin-top:2px;">
                ${escapeHtml(livery.name)} • ${escapeHtml(tune.name)} • ${setup.transmission}
              </div>
            </div>

            <div class="race-stage-actions">
              <button type="button" class="btn-rev" id="race-btn-rev" title="Blip throttle & test exhaust note">
                🔥 REV ENGINE
              </button>
              <button type="button" class="btn btn-secondary" id="race-btn-quick-garage" style="padding:7px 12px;font-size:11px;">
                ${this.activeTab === "ARENA" ? "Customize Car & Paint →" : "← Back to Race Arena"}
              </button>
            </div>
          </div>

          <div class="race-stage-footer">
            <div class="race-orbit-hint">DRAG TO ORBIT 3D SHOWROOM • SCROLL TO ZOOM</div>
            <div class="race-spec-strip">
              <div class="stat-row">
                <div class="stat-row-label">
                  <span>Top Speed</span>
                  <span style="color:#fff;font-family:var(--font-mono);">${Math.round(effStats.topSpeedKmh)} KM/H</span>
                </div>
                <div class="stat-track">
                  <div class="stat-fill race-stat-fill-speed" style="width:${effStats.bars.topSpeed}%;"></div>
                </div>
              </div>
              <div class="stat-row">
                <div class="stat-row-label">
                  <span>Acceleration</span>
                  <span style="color:#fff;font-family:var(--font-mono);">${effStats.bars.acceleration}/100</span>
                </div>
                <div class="stat-track">
                  <div class="stat-fill race-stat-fill-accel" style="width:${effStats.bars.acceleration}%;"></div>
                </div>
              </div>
              <div class="stat-row">
                <div class="stat-row-label">
                  <span>Drift Grip</span>
                  <span style="color:#fff;font-family:var(--font-mono);">${effStats.bars.driftGrip}/100</span>
                </div>
                <div class="stat-track">
                  <div class="stat-fill race-stat-fill-drift" style="width:${effStats.bars.driftGrip}%;"></div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- RIGHT PANEL: Launch Controls OR Paint / Tune / Parts Customizer -->
        <div class="race-panel">
          ${
            this.activeTab === "ARENA"
              ? `
            <div class="panel-title"><span>${isTimeTrial ? "Solo Time Trial" : "Find a Race"}</span></div>
            <button type="button" class="btn btn-race-primary" id="race-btn-quick" style="padding:15px;font-size:15px;">
              ${isTimeTrial ? "Start Time Trial" : `Quick Race (${escapeHtml(RACE_MODE_CONFIGS[this.selectedMode].shortLabel)})`}
            </button>
            ${
              bestTrackMs
                ? `<div style="font-size:11px;font-family:var(--font-mono);color:#86efac;text-align:center;">
                     Personal Best on ${escapeHtml(TRACK_REGISTRY[this.selectedTrackId].name)}: ${formatBestLap(bestTrackMs)}
                   </div>`
                : ""
            }

${isTimeTrial ? "" : `
            <div class="race-select-card" style="cursor:default;">
              <div class="panel-title" style="margin-bottom:8px;">Host Custom Room</div>
              <label style="display:flex;align-items:center;gap:8px;font-size:12px;margin-bottom:6px;cursor:pointer;">
                <input id="race-chk-public" type="checkbox" ${this.createPublic ? "checked" : ""}> Public Room (Listed & Matchmade)
              </label>
              <label style="display:flex;align-items:center;gap:8px;font-size:12px;margin-bottom:8px;cursor:pointer;">
                <input id="race-chk-bots" type="checkbox" ${this.botFill ? "checked" : ""}> Auto-Fill Starting Grid with AI Racers
              </label>
              <div style="font-size:11px;color:var(--text-muted);font-weight:700;margin-bottom:5px;">AI Rival Difficulty</div>
              <div class="chip-row" style="margin-bottom:10px;">
                ${diffs
                  .map(
                    (d) =>
                      `<button type="button" class="chip race-chip ${this.botDifficulty === d ? "selected" : ""}" data-race-bot-diff="${d}">${d}</button>`
                  )
                  .join("")}
              </div>
              <button type="button" class="btn btn-amber" id="race-btn-create-room" style="width:100%;">
                Create ${this.createPublic ? "Public" : "Private"} Grid & Get Code
              </button>
            </div>
            `}

            <div class="race-select-card" style="cursor:default;">
              <div class="panel-title" style="margin-bottom:8px;">Join Friend by 4-Letter Code</div>
              <div class="code-row">
                <input id="race-join-code-input" class="text-input" maxlength="6" placeholder="R8X2" />
                <button type="button" class="btn btn-secondary" id="race-btn-join-code">Join</button>
              </div>
            </div>

            <div class="race-select-card" style="cursor:default;font-size:11px;color:var(--text-muted);line-height:1.52;">
              <strong style="color:#fff;">Driving Controls (Keyboard + Gamepad):</strong><br/>
              • <strong>WASD / Arrows</strong> Throttle, Brake, Steer<br/>
              • <strong>Space</strong> Handbrake Drift (charges Nitro + Combo)<br/>
              • <strong>Shift</strong> Nitrous Boost • <strong>Hold Green RPM</strong> on GO! for Launch<br/>
              • <strong>C</strong> Camera (Chase / Far / Hood / Bumper) • <strong>B</strong> Rear View<br/>
              • <strong>Q / E</strong> Manual Shift • <strong>R</strong> Instant Reset • <strong>Tab</strong> Grid • <strong>M</strong> Menu
            </div>
          `
              : `
            <div class="panel-title"><span>Clearcoat Paint & Livery</span></div>
            <div class="livery-swatch-grid">
              ${LIVERY_LIST.map(
                (liv) => `
                  <button type="button" class="livery-swatch-btn ${setup.liveryId === liv.id ? "selected" : ""}" data-livery="${liv.id}">
                    <span class="livery-disc" style="background:linear-gradient(135deg, ${liv.bodyHex} 58%, ${liv.accentHex} 58%);"></span>
                    <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(liv.name)}</span>
                  </button>
                `
              ).join("")}
            </div>

            <div class="panel-title" style="margin-top:4px;"><span>Performance Tune</span></div>
            <div class="chip-row">
              ${TUNE_LIST.map(
                (t) => `
                  <button type="button" class="chip race-chip ${setup.tuneId === t.id ? "selected" : ""}" data-tune="${t.id}" title="${escapeHtml(t.description)}">
                    ${escapeHtml(t.name)}
                  </button>
                `
              ).join("")}
            </div>
            <div style="font-size:11px;color:var(--text-muted);line-height:1.35;">${escapeHtml(tune.description)}</div>

            <div class="panel-title" style="margin-top:4px;"><span>Rear Aero / Spoiler</span></div>
            <div class="chip-row">
              ${SPOILER_LIST.map(
                (sp) => `
                  <button type="button" class="chip race-chip ${setup.spoilerId === sp.id ? "selected" : ""}" data-spoiler="${sp.id}" title="${escapeHtml(sp.description)}">
                    ${escapeHtml(sp.name)}
                  </button>
                `
              ).join("")}
            </div>

            <div class="panel-title" style="margin-top:4px;"><span>Forged Rims</span></div>
            <div class="chip-row">
              ${RIM_LIST.map(
                (rim) => `
                  <button type="button" class="chip race-chip ${setup.rimId === rim.id ? "selected" : ""}" data-rim="${rim.id}" title="${escapeHtml(rim.description)}">
                    ${escapeHtml(rim.name)}
                  </button>
                `
              ).join("")}
            </div>

            <div class="panel-title" style="margin-top:4px;"><span>Neon Underglow</span></div>
            <div class="chip-row">
              ${UNDERGLOW_LIST.map(
                (ug) => `
                  <button type="button" class="skin-swatch ${setup.underglowId === ug.id ? "selected" : ""}" data-underglow="${ug.id}">
                    <span class="underglow-dot" style="background:${ug.swatchHex};${ug.hex ? `box-shadow:0 0 8px ${ug.hex};` : ""}"></span>
                    <span>${escapeHtml(ug.name)}</span>
                  </button>
                `
              ).join("")}
            </div>
          `
          }
        </div>
      </div>
    `;
  }

  private commitSetup(): void {
    saveGuestProfile(this.profile);
    this.callbacks.onCarSetupChanged(this.getCarSetup());
  }

  private bindEvents(): void {
    this.root.querySelector("#btn-switch-to-shooter")?.addEventListener("click", () => {
      this.callbacks.onSwitchToShooter();
    });

    this.root.querySelectorAll<HTMLElement>("[data-race-tab]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        this.activeTab = btn.dataset.raceTab as "ARENA" | "GARAGE" | "ROOMS";
        if (this.activeTab === "ROOMS") {
          this.publicRooms = await this.callbacks.onRefreshPublicRooms();
        }
        this.render();
      });
    });

    this.root.querySelector("#race-btn-open-settings")?.addEventListener("click", () => {
      this.callbacks.onOpenSettings();
    });

    this.root.querySelector("#race-btn-quick-garage")?.addEventListener("click", () => {
      this.activeTab = this.activeTab === "ARENA" ? "GARAGE" : "ARENA";
      this.render();
    });

    this.root.querySelector("#race-btn-rev")?.addEventListener("click", (ev) => {
      const btn = ev.currentTarget as HTMLElement;
      btn.classList.add("revving");
      if (this.revAnimTimeout) clearTimeout(this.revAnimTimeout);
      this.revAnimTimeout = setTimeout(() => btn.classList.remove("revving"), 240);
      this.callbacks.onRevEngine();
    });

    this.root.querySelector("#race-callsign-input")?.addEventListener("input", (e) => {
      this.profile.callsign = (e.target as HTMLInputElement).value.trim() || "Driver";
      saveGuestProfile(this.profile);
    });

    // Race Arena tab controls
    this.root.querySelectorAll<HTMLElement>("[data-race-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.selectedMode = btn.dataset.raceMode as RaceMode;
        this.render();
      });
    });

    this.root.querySelectorAll<HTMLElement>("[data-race-track]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.selectedTrackId = btn.dataset.raceTrack as TrackId;
        this.render();
      });
    });

    this.root.querySelector("#race-chk-public")?.addEventListener("change", (e) => {
      this.createPublic = (e.target as HTMLInputElement).checked;
      this.render();
    });

    this.root.querySelector("#race-chk-bots")?.addEventListener("change", (e) => {
      this.botFill = (e.target as HTMLInputElement).checked;
    });

    this.root.querySelectorAll<HTMLElement>("[data-race-bot-diff]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.botDifficulty = btn.dataset.raceBotDiff as BotDifficulty;
        this.profile.settings.botDifficulty = this.botDifficulty;
        saveGuestProfile(this.profile);
        this.render();
      });
    });

    this.root.querySelector("#race-btn-quick")?.addEventListener("click", () => {
      this.callbacks.onQuickRace({
        mode: this.selectedMode,
        trackId: this.selectedTrackId,
        botFill: this.selectedMode !== "TIME_TRIAL" && this.botFill,
        botDifficulty: this.botDifficulty,
      });
    });

    this.root.querySelector("#race-btn-create-room")?.addEventListener("click", () => {
      this.callbacks.onCreateRoom({
        mode: this.selectedMode,
        trackId: this.selectedTrackId,
        isPublic: this.createPublic,
        botFill: this.botFill,
        botDifficulty: this.botDifficulty,
      });
    });

    this.root.querySelector("#race-btn-join-code")?.addEventListener("click", () => {
      const val = (this.root.querySelector("#race-join-code-input") as HTMLInputElement | null)?.value
        .trim()
        .toUpperCase();
      if (val) this.callbacks.onJoinCode(val);
    });

    this.root.querySelector("#race-join-code-input")?.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") {
        const val = (e.currentTarget as HTMLInputElement).value.trim().toUpperCase();
        if (val) this.callbacks.onJoinCode(val);
      }
    });

    // Public rooms tab
    this.root.querySelector("#race-btn-refresh-rooms")?.addEventListener("click", async () => {
      this.publicRooms = await this.callbacks.onRefreshPublicRooms();
      this.render();
    });

    this.root.querySelectorAll<HTMLElement>("[data-race-join-public]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const code = btn.dataset.raceJoinPublic;
        if (code) this.callbacks.onJoinCode(code);
      });
    });

    // Car Garage customizer controls
    this.root.querySelectorAll<HTMLElement>("[data-vehicle]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const vehicleId = btn.dataset.vehicle!;
        this.profile.racing.vehicleId = vehicleId;
        this.commitSetup();
        this.render();
      });
    });

    this.root.querySelectorAll<HTMLElement>("[data-livery]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const liveryId = btn.dataset.livery!;
        if (liveryId in LIVERY_REGISTRY) {
          this.profile.racing.liveryId = liveryId;
          this.commitSetup();
          this.render();
        }
      });
    });

    this.root.querySelectorAll<HTMLElement>("[data-tune]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.profile.racing.tuneId = btn.dataset.tune!;
        this.commitSetup();
        this.render();
      });
    });

    this.root.querySelectorAll<HTMLElement>("[data-spoiler]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.profile.racing.spoilerId = btn.dataset.spoiler!;
        this.commitSetup();
        this.render();
      });
    });

    this.root.querySelectorAll<HTMLElement>("[data-rim]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.profile.racing.rimId = btn.dataset.rim!;
        this.commitSetup();
        this.render();
      });
    });

    this.root.querySelectorAll<HTMLElement>("[data-underglow]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.profile.racing.underglowId = btn.dataset.underglow!;
        this.commitSetup();
        this.render();
      });
    });

    this.root.querySelectorAll<HTMLElement>("[data-transmission]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.profile.racing.transmission = btn.dataset.transmission as TransmissionMode;
        this.commitSetup();
        this.render();
      });
    });
  }

  dispose(): void {
    if (this.revAnimTimeout) clearTimeout(this.revAnimTimeout);
    this.root.remove();
  }
}
