import {
  ATTACHMENT_LIST,
  MAP_LIST,
  MODE_CONFIGS,
  careerLevel,
  SKIN_LIST,
  THROWABLE_LIST,
  WEAPON_LIST,
  WEAPON_REGISTRY,
  computeEffectiveWeaponStats,
  getAttachmentsForWeaponSlot,
  type AttachmentSlot,
  type BotDifficulty,
  type GameMode,
  type MatchRules,
  type PlayerWeaponConfig,
  type ThrowableType,
} from "@game/shared";
import type { PublicRoomSummary } from "../core/NetClient.js";
import { saveGuestProfile, type GuestProfile } from "../state/UserProfileStore.js";
import { bindTdmThrowables, renderTdmThrowables } from "./TdmLoadout.js";

export interface LobbyActionCallbacks {
  onQuickPlay: (opts: { mode: GameMode; mapId: string; botFill: boolean; botDifficulty: BotDifficulty; matchRules?: Partial<MatchRules> }) => void;
  onCreateRoom: (opts: {
    mode: GameMode;
    mapId: string;
    isPublic: boolean;
    botFill: boolean;
    botDifficulty: BotDifficulty;
    matchRules?: Partial<MatchRules>;
  }) => void;
  onJoinCode: (code: string) => void;
  onRefreshPublicRooms: () => Promise<PublicRoomSummary[]>;
  onWeaponPreviewChanged: (cfg: PlayerWeaponConfig) => void;
  onOpenSettings: () => void;
  onSwitchToRacer?: () => void;
}

export class LobbyScreen {
  private readonly root: HTMLDivElement;
  private selectedMode: GameMode = "2v2";
  private selectedMapId = "cargo_docks";
  private createPublic = true;
  private botFill = true;
  private friendlyFire = false;
  private customTime = "";
  private activeTab: "PLAY" | "GUNSMITH" | "SERVERS" = "PLAY";
  private editingSlot: "primary" | "secondary" = "primary";
  private preloadStatusText = "Preloading map assets...";
  private publicRooms: PublicRoomSummary[] = [];
  private statusBanner = "";

  constructor(
    parent: HTMLElement,
    private readonly profile: GuestProfile,
    private readonly callbacks: LobbyActionCallbacks
  ) {
    this.root = document.createElement("div");
    this.root.className = "lobby-shell";
    parent.appendChild(this.root);
    this.render();
  }

  show(): void {
    this.root.classList.remove("hidden");
    this.render();
  }

  hide(): void {
    this.root.classList.add("hidden");
  }

  setPreloadStatus(text: string): void {
    this.preloadStatusText = text;
    const el = this.root.querySelector("#preload-status");
    if (el) el.textContent = text;
  }

  setErrorBanner(msg: string): void {
    this.statusBanner = msg;
    const el = this.root.querySelector("#lobby-error");
    if (el) {
      el.textContent = msg;
      el.classList.toggle("hidden", !msg);
    }
  }

  private getEditingWeaponConfig(): PlayerWeaponConfig {
    return this.editingSlot === "primary" ? this.profile.loadout.primary : this.profile.loadout.secondary;
  }

  private render(): void {
    const modes: GameMode[] = ["1v1", "2v2", "4v4", "TDM", "WARMUP"];
    const editCfg = this.getEditingWeaponConfig();
    const baseWeapon = WEAPON_REGISTRY[editCfg.weaponId] ?? WEAPON_REGISTRY.m416;
    const effStats = computeEffectiveWeaponStats(editCfg.weaponId, editCfg.attachments);
    const availableWeapons = WEAPON_LIST.filter((w) =>
      this.editingSlot === "primary" ? w.category !== "PISTOL" : w.category === "PISTOL"
    );

    const kd =
      this.profile.stats.deaths > 0
        ? (this.profile.stats.kills / this.profile.stats.deaths).toFixed(2)
        : String(this.profile.stats.kills);

    this.root.innerHTML = `
      <div class="topbar">
        <div class="brand-lockup">
          <div class="brand-badge">SC</div>
          <div>
            <div class="brand-title">STRIKECORE // ARENA</div>
            <div class="brand-sub">WebGL2 / WebGPU • Rapier3D WASM • HRTF Audio</div>
          </div>
        </div>

        <div class="game-hub-switcher" role="navigation" aria-label="Game Hub Switcher">
          <button type="button" class="hub-pill active" data-switch-game="shooter" aria-current="page">
            <span class="hub-dot hub-dot-shooter"></span>StrikeCore FPS
          </button>
          <button type="button" class="hub-pill" data-switch-game="racer" id="btn-switch-to-racer">
            <span class="hub-dot hub-dot-racer"></span>ApexDrive Racer
          </button>
        </div>

        <div class="nav-tabs">
          <button class="tab-btn ${this.activeTab === "PLAY" ? "active" : ""}" data-tab="PLAY">Play Arena</button>
          <button class="tab-btn ${this.activeTab === "GUNSMITH" ? "active" : ""}" data-tab="GUNSMITH">3D Gunsmith</button>
          <button class="tab-btn ${this.activeTab === "SERVERS" ? "active" : ""}" data-tab="SERVERS">Public Rooms</button>
          <button class="tab-btn" id="btn-open-settings">Settings</button>
        </div>

        <div class="profile-pill">
            <div style="font-size:11px;color:var(--accent-cyan);font-weight:800;">LEVEL ${careerLevel(this.profile.stats.xp)} · ${this.profile.stats.xp} XP</div>
          <input id="callsign-input" class="callsign-input" maxlength="16" title="Edit Callsign" />
          <div style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono);">
            K/D ${kd} • W ${this.profile.stats.wins}
          </div>
        </div>
      </div>

      <div id="lobby-error" role="alert" class="hidden" style="margin-top:10px;background:rgba(239,68,68,0.18);border:1px solid #ef4444;color:#fecaca;padding:8px 14px;border-radius:8px;font-size:13px;"></div>

      ${this.activeTab === "SERVERS" ? this.renderServersTab() : this.renderMainOrGunsmithGrid(modes, editCfg, baseWeapon.id, effStats, availableWeapons)}
    `;

    const callsign = this.root.querySelector<HTMLInputElement>("#callsign-input");
    if (callsign) callsign.value = this.profile.callsign;
    this.setErrorBanner(this.statusBanner);
    this.bindEvents();
  }

  private renderServersTab(): string {
    return `
      <div class="panel" style="margin-top:18px;flex:1;">
        <div class="panel-title">
          <span>Live Public Rooms</span>
          <button class="btn btn-secondary" id="btn-refresh-rooms" style="padding:6px 12px;font-size:11px;">Refresh List</button>
        </div>
        ${
          this.publicRooms.length === 0
            ? `<div style="padding:36px;text-align:center;color:var(--text-muted);">No public rooms currently open. Click <strong>Quick Play</strong> or <strong>Create Room</strong> to host one instantly!</div>`
            : `<div style="display:grid;gap:10px;">
                ${this.publicRooms
                  .map(
                    (r) => `
                  <div class="select-card" style="display:flex;justify-content:space-between;align-items:center;cursor:default;">
                    <div>
                      <div class="select-card-title" style="gap:10px;">
                        <span style="font-family:var(--font-mono);color:var(--accent-cyan);">[${r.code}]</span>
                        <span>${r.mapName}</span>
                        <span style="font-size:11px;color:var(--accent-amber);">${r.ranked ? "Ranked TDM" : r.mode} • ${r.phase}</span>
                      </div>
                      <div class="select-card-desc">Players: ${r.playerCount} / ${r.maxPlayers} (${r.humanCount} human)</div>
                    </div>
                    <button class="btn btn-primary" data-join-public="${r.code}">Join Room</button>
                  </div>
                `
                  )
                  .join("")}
              </div>`
        }
      </div>
    `;
  }

  private renderMainOrGunsmithGrid(
    modes: GameMode[],
    editCfg: PlayerWeaponConfig,
    _baseWeaponId: string,
    effStats: ReturnType<typeof computeEffectiveWeaponStats>,
    availableWeapons: typeof WEAPON_LIST
  ): string {
    const slots: { slot: AttachmentSlot; label: string }[] = [
      { slot: "optic", label: "Optic Rail" },
      { slot: "muzzle", label: "Muzzle" },
      { slot: "underbarrel", label: "Underbarrel" },
      { slot: "mag", label: "Magazine" },
    ];

    const dmgPct = Math.min(100, Math.round((effStats.damageHead / 200) * 100));
    const rpmPct = Math.min(100, Math.round((effStats.rpm / 1100) * 100));
    const recoilCtrlPct = Math.max(10, Math.min(100, Math.round(100 - effStats.recoilVertical * 14)));
    const adsSpeedPct = Math.max(15, Math.min(100, Math.round(100 - effStats.adsTimeSec * 210)));
    const mobPct = Math.min(100, Math.round(effStats.moveSpeedMultiplier * 92));
    const magPct = Math.min(100, Math.round((effStats.magSize / 42) * 100));

    return `
      <div class="lobby-grid">
        <!-- LEFT PANEL: Mode + Map OR Gunsmith Weapons -->
        <div class="panel">
          ${
            this.activeTab === "PLAY"
              ? `
            <div class="panel-title"><span>1. Select Tactical Mode</span></div>
            <div class="mode-grid">
              ${modes
                .map((m) => {
                  const cfg = MODE_CONFIGS[m];
                  return `
                    <button class="select-card ${this.selectedMode === m ? "selected" : ""}" data-mode="${m}">
                      <div class="select-card-title">
                        <span>${cfg.label}</span>
                        <span style="font-size:11px;color:var(--accent-cyan);">${cfg.maxPlayers}P</span>
                      </div>
                      <div class="select-card-desc">${cfg.description}</div>
                    </button>
                  `;
                })
                .join("")}
            </div>

            <div class="panel-title" style="margin-top:4px;">
              <span>2. Select Arena</span>
              <span id="preload-status" style="font-size:10px;color:var(--accent-green);text-transform:none;">${this.preloadStatusText}</span>
            </div>
            <div class="map-grid">
              ${MAP_LIST.map(
                (map) => `
                <button class="select-card ${this.selectedMapId === map.id ? "selected" : ""}" data-map="${map.id}">
                  <div class="select-card-title">
                    <span>${map.name}</span>
                    <span class="swatch-dot" style="background:${map.previewAccentHex};"></span>
                  </div>
                  <div class="select-card-desc">${map.subtitle}</div>
                </button>
              `
              ).join("")}
            </div>
          `
              : `
            <div class="panel-title">
              <span>Weapon Slot</span>
              <div class="chip-row">
                <button class="chip ${this.editingSlot === "primary" ? "selected" : ""}" data-edit-slot="primary">Primary</button>
                <button class="chip ${this.editingSlot === "secondary" ? "selected" : ""}" data-edit-slot="secondary">Sidearm</button>
              </div>
            </div>
            <div class="mode-grid">
              ${availableWeapons
                .map(
                  (w) => `
                <button class="select-card ${editCfg.weaponId === w.id ? "selected" : ""}" data-weapon="${w.id}">
                  <div class="select-card-title">
                    <span>${w.name}</span>
                    <span style="font-size:10px;color:var(--accent-amber);">${w.category}</span>
                  </div>
                  <div class="select-card-desc">${w.description}</div>
                </button>
              `
                )
                .join("")}
            </div>
            <div class="panel-title" style="margin-top:6px;">Preferred throwable</div>
            <div class="chip-row">
              ${THROWABLE_LIST.map(
                (t) => `<button class="chip ${this.profile.loadout.throwable === t.id ? "selected" : ""}" data-throwable="${t.id}">${t.name}</button>`
              ).join("")}
            </div>
            ${renderTdmThrowables(this.profile.loadout)}
          `
          }
        </div>

        <!-- CENTER STAGE: Transparent 3D Weapon Showcase + Live Stats -->
        <div class="gunsmith-stage">
          <div class="gunsmith-banner">
            <div>
              <div style="font-size:11px;color:var(--accent-cyan);font-weight:800;letter-spacing:1.5px;">ACTIVE WEAPON BLUEPRINT</div>
              <div style="font-size:24px;font-weight:900;">${effStats.name}</div>
              <div style="font-size:12px;color:var(--text-muted);">
                ${effStats.blueprint.stats.fireModes.join(" / ")} • ${effStats.magSize} Rd Mag • ${effStats.useSuppressedAudio ? "Suppressed" : "Standard"}
              </div>
            </div>
            <button class="btn btn-secondary" id="btn-quick-customize" style="padding:8px 14px;font-size:11px;">
              ${this.activeTab === "PLAY" ? "Customize Attachments & Skins →" : "← Back to Match Setup"}
            </button>
          </div>
          <div style="text-align:center;font-size:11px;color:rgba(148,163,184,0.65);letter-spacing:1px;">
            DRAG TO ORBIT WEAPON • SCROLL TO ZOOM
          </div>

          <div class="stat-bars">
            <div class="stat-row">
              <div class="stat-row-label"><span>Head / Chest DMG</span><span>${effStats.damageHead} / ${effStats.damageChest}</span></div>
              <div class="stat-track"><div class="stat-fill" style="width:${dmgPct}%;"></div></div>
            </div>
            <div class="stat-row">
              <div class="stat-row-label"><span>Fire Rate</span><span>${effStats.rpm} RPM</span></div>
              <div class="stat-track"><div class="stat-fill" style="width:${rpmPct}%;"></div></div>
            </div>
            <div class="stat-row">
              <div class="stat-row-label"><span>Recoil Control</span><span>${recoilCtrlPct}%</span></div>
              <div class="stat-track"><div class="stat-fill" style="width:${recoilCtrlPct}%;"></div></div>
            </div>
            <div class="stat-row">
              <div class="stat-row-label"><span>ADS Speed</span><span>${Math.round(effStats.adsTimeSec * 1000)} ms</span></div>
              <div class="stat-track"><div class="stat-fill" style="width:${adsSpeedPct}%;"></div></div>
            </div>
            <div class="stat-row">
              <div class="stat-row-label"><span>Mobility</span><span>${Math.round(effStats.moveSpeedMultiplier * 100)}%</span></div>
              <div class="stat-track"><div class="stat-fill" style="width:${mobPct}%;"></div></div>
            </div>
            <div class="stat-row">
              <div class="stat-row-label"><span>Mag / Reload</span><span>${effStats.magSize} (${effStats.reloadTacticalSec}s)</span></div>
              <div class="stat-track"><div class="stat-fill" style="width:${magPct}%;"></div></div>
            </div>
          </div>
        </div>

        <!-- RIGHT PANEL: Deploy Actions OR Attachments & Skins -->
        <div class="panel">
          ${
            this.activeTab === "PLAY"
              ? `
            <div class="panel-title"><span>Zero-Login Deployment</span></div>
            <button class="btn btn-primary" id="btn-quick-play" style="padding:16px;font-size:15px;">
              ⚡ Quick Play (${this.selectedMode})
            </button>
            ${this.selectedMode === "TDM" ? `<button class="btn btn-secondary" id="btn-ranked">Ranked TDM · Rating ${this.profile.stats.rating}</button>` : ""}

            <div class="select-card" style="cursor:default;">
              <div class="panel-title" style="margin-bottom:8px;">Host Custom Room</div>
              <label style="display:flex;align-items:center;gap:8px;font-size:12px;margin-bottom:6px;cursor:pointer;">
                <input id="chk-public" type="checkbox" ${this.createPublic ? "checked" : ""}> Public Room (Listed & Matchmade)
              </label>
              <label style="display:flex;align-items:center;gap:8px;font-size:12px;margin-bottom:10px;cursor:pointer;">
                <input id="chk-bots" type="checkbox" ${this.botFill ? "checked" : ""}> Auto-Fill Empty Slots with Tactical AI Bots
              </label>
              ${this.selectedMode !== "WARMUP" ? `<label class="code-row" style="margin-bottom:8px;font-size:12px;">
                <span>${this.selectedMode === "TDM" ? "Match" : "Round"} time (seconds)</span>
                <input class="text-input" id="custom-time" type="number" min="30" max="900" step="1" value="${this.customTime}" placeholder="${MODE_CONFIGS[this.selectedMode].roundTimeSec}" aria-label="Time limit in seconds" style="width:95px;">
              </label>` : ""}
              <label class="code-row" style="margin-bottom:8px;font-size:12px;">
                <input type="checkbox" id="custom-friendly-fire" ${this.friendlyFire ? "checked" : ""}> Friendly fire
              </label>
              <button class="btn btn-amber" id="btn-create-room" style="width:100%;">
                Create ${this.createPublic ? "Public" : "Private"} Room & Get Code
              </button>
            </div>

            <div class="select-card" style="cursor:default;">
              <div class="panel-title" style="margin-bottom:8px;">Join Friend by 4-Letter Code</div>
              <div class="code-row">
                <input id="join-code-input" class="text-input" maxlength="6" placeholder="K9X4" />
                <button class="btn btn-secondary" id="btn-join-code">Join</button>
              </div>
            </div>

            <div class="select-card" style="cursor:default;font-size:11px;color:var(--text-muted);line-height:1.5;">
              <strong style="color:#fff;">Tactical Controls:</strong><br/>
              • <strong>WASD</strong> Move • <strong>Shift</strong> Sprint • <strong>Shift+C</strong> Slide<br/>
              • <strong>Q / E</strong> Lean Peek • <strong>Space</strong> Jump / Auto-Vault<br/>
              • <strong>LMB</strong> Shoot • <strong>RMB</strong> ADS • <strong>Shift (ADS)</strong> Hold Breath<br/>
              • <strong>Hold G</strong> Cook Frag/Smoke/Flash • <strong>Z</strong> 3D Ping<br/>
              • <strong>V</strong> Quick-swap optic (iron / red dot / 2x / 6x) • <strong>B</strong> Fire mode
            </div>
          `
              : `
            <div class="panel-title"><span>Socket Attachments</span></div>
            ${slots
              .filter((s) => effStats.blueprint.allowedSlots.includes(s.slot))
              .map((s) => {
                const choices = getAttachmentsForWeaponSlot(effStats.blueprint.category, s.slot);
                const currentId = editCfg.attachments[s.slot] ?? "";
                return `
                  <div style="margin-bottom:6px;">
                    <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;font-weight:700;">${s.label}</div>
                    <div class="chip-row">
                      <button class="chip ${!currentId ? "selected" : ""}" data-att-slot="${s.slot}" data-att-id="">None</button>
                      ${choices
                        .map(
                          (att) =>
                            `<button class="chip ${currentId === att.id ? "selected" : ""}" data-att-slot="${s.slot}" data-att-id="${att.id}" title="${att.description}">${att.shortName}</button>`
                        )
                        .join("")}
                    </div>
                  </div>
                `;
              })
              .join("")}

            <div class="panel-title" style="margin-top:8px;"><span>Universal Skins (PBR)</span></div>
            <div class="chip-row">
              ${SKIN_LIST.map(
                (sk) => `
                <button class="skin-swatch ${editCfg.skinId === sk.id ? "selected" : ""}" data-skin="${sk.id}" ${careerLevel(this.profile.stats.xp) < (sk.unlockLevel ?? 1) ? "disabled" : ""}>
                  <span class="swatch-dot" style="background:${sk.previewGradient};"></span>
                  <span>${sk.name}${careerLevel(this.profile.stats.xp) < (sk.unlockLevel ?? 1) ? ` · Lv. ${sk.unlockLevel}` : ""}</span>
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

  private bindEvents(): void {
    this.root.querySelectorAll<HTMLElement>("[data-tab]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        this.activeTab = btn.dataset.tab as "PLAY" | "GUNSMITH" | "SERVERS";
        if (this.activeTab === "SERVERS") {
          this.publicRooms = await this.callbacks.onRefreshPublicRooms();
        }
        this.render();
      });
    });

    this.root.querySelector("#btn-open-settings")?.addEventListener("click", () => {
      this.callbacks.onOpenSettings();
    });

    this.root.querySelector("#btn-switch-to-racer")?.addEventListener("click", () => {
      this.callbacks.onSwitchToRacer?.();
    });

    this.root.querySelector("#btn-quick-customize")?.addEventListener("click", () => {
      this.activeTab = this.activeTab === "PLAY" ? "GUNSMITH" : "PLAY";
      this.render();
    });

    this.root.querySelector("#callsign-input")?.addEventListener("input", (e) => {
      this.profile.callsign = (e.target as HTMLInputElement).value.trim() || "Operator";
      saveGuestProfile(this.profile);
    });

    this.root.querySelectorAll<HTMLElement>("[data-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.selectedMode = btn.dataset.mode as GameMode;
        this.render();
      });
    });

    this.root.querySelectorAll<HTMLElement>("[data-map]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.selectedMapId = btn.dataset.map!;
        this.render();
      });
    });

    this.root.querySelector("#chk-public")?.addEventListener("change", (e) => {
      this.createPublic = (e.target as HTMLInputElement).checked;
      this.render();
    });
    this.root.querySelector("#chk-bots")?.addEventListener("change", (e) => {
      this.botFill = (e.target as HTMLInputElement).checked;
    });

    this.root.querySelector("#btn-quick-play")?.addEventListener("click", () => {
      this.callbacks.onQuickPlay({
        mode: this.selectedMode,
        mapId: this.selectedMapId,
        botFill: this.botFill,
        botDifficulty: this.profile.settings.botDifficulty,
      });
    });

    this.root.querySelector("#btn-ranked")?.addEventListener("click", () => {
      this.callbacks.onQuickPlay({ mode: "TDM", mapId: this.selectedMapId, botFill: false,
        botDifficulty: this.profile.settings.botDifficulty, matchRules: { ranked: true } });
    });
    this.root.querySelector<HTMLInputElement>("#custom-time")?.addEventListener("input", (event) => {
      this.customTime = (event.currentTarget as HTMLInputElement).value;
    });
    this.root.querySelector<HTMLInputElement>("#custom-friendly-fire")?.addEventListener("change", (event) => {
      this.friendlyFire = (event.currentTarget as HTMLInputElement).checked;
    });

    this.root.querySelector("#btn-create-room")?.addEventListener("click", () => {
      const timeLimit = this.root.querySelector<HTMLInputElement>("#custom-time")?.valueAsNumber;
      const friendlyFire = this.root.querySelector<HTMLInputElement>("#custom-friendly-fire")?.checked === true;
      this.callbacks.onCreateRoom({
        mode: this.selectedMode,
        mapId: this.selectedMapId,
        isPublic: this.createPublic,
        matchRules: { friendlyFire, timeLimitSeconds: Number.isFinite(timeLimit) ? timeLimit : undefined },
        botFill: this.botFill,
        botDifficulty: this.profile.settings.botDifficulty,
      });
    });

    this.root.querySelector("#btn-join-code")?.addEventListener("click", () => {
      const val = (this.root.querySelector("#join-code-input") as HTMLInputElement)?.value.trim().toUpperCase();
      if (val) this.callbacks.onJoinCode(val);
    });

    this.root.querySelector("#btn-refresh-rooms")?.addEventListener("click", async () => {
      this.publicRooms = await this.callbacks.onRefreshPublicRooms();
      this.render();
    });

    this.root.querySelectorAll<HTMLElement>("[data-join-public]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.callbacks.onJoinCode(btn.dataset.joinPublic!);
      });
    });

    // Gunsmith controls
    this.root.querySelectorAll<HTMLElement>("[data-edit-slot]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.editingSlot = btn.dataset.editSlot as "primary" | "secondary";
        this.callbacks.onWeaponPreviewChanged(this.getEditingWeaponConfig());
        this.render();
      });
    });

    this.root.querySelectorAll<HTMLElement>("[data-weapon]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const wId = btn.dataset.weapon!;
        const bp = WEAPON_REGISTRY[wId];
        const target = this.getEditingWeaponConfig();
        target.weaponId = wId;
        target.attachments = { ...(bp?.defaultAttachments ?? {}) };
        saveGuestProfile(this.profile);
        this.callbacks.onWeaponPreviewChanged(target);
        this.render();
      });
    });

    this.root.querySelectorAll<HTMLElement>("[data-att-slot]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const slot = btn.dataset.attSlot as AttachmentSlot;
        const attId = btn.dataset.attId || "";
        const target = this.getEditingWeaponConfig();
        if (!attId) delete target.attachments[slot];
        else target.attachments[slot] = attId;
        saveGuestProfile(this.profile);
        this.callbacks.onWeaponPreviewChanged(target);
        this.render();
      });
    });

    this.root.querySelectorAll<HTMLElement>("[data-skin]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = this.getEditingWeaponConfig();
        target.skinId = btn.dataset.skin!;
        saveGuestProfile(this.profile);
        this.callbacks.onWeaponPreviewChanged(target);
        this.render();
      });
    });

    this.root.querySelectorAll<HTMLElement>("[data-throwable]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.profile.loadout.throwable = btn.dataset.throwable as ThrowableType;
        saveGuestProfile(this.profile);
        this.render();
      });
    });
    bindTdmThrowables(this.root, this.profile.loadout, () => saveGuestProfile(this.profile));

    void ATTACHMENT_LIST;
  }

  dispose(): void {
    this.root.remove();
  }
}
