import {
  MAP_LIST,
  MAP_REGISTRY,
  careerLevel,
  skinsForWeapon,
  ATTACHMENT_REGISTRY,
  SKIN_REGISTRY,
  MODE_CONFIGS,
  THROWABLE_ORDER,
  THROWABLE_REGISTRY,
  WEAPON_LIST,
  WEAPON_REGISTRY,
  getAttachmentsForWeaponSlot,
  type AttachmentSlot,
  type DamageBreakdownPayload,
  type HitMarkerTier,
  type PlayerLoadoutPayload,
  type RoomStateBroadcast,
  type ServerToClientMessage,
} from "@game/shared";
import type { ArenaHudEvent, HudLiveSnapshot } from "../games/shooter/ShooterScene.js";
import { combatKey, combatKeyLabel, saveGuestProfile, type CombatAction, type GuestProfile } from "../state/UserProfileStore.js";
import { bindTdmThrowables, renderTdmThrowables, THROWABLE_LABELS } from "./TdmLoadout.js";

export interface ShooterHudCallbacks {
  onResumeCombat: () => void;
  onOpenMenu: () => void;
  onLoadoutChanged: (open: boolean) => void;
  onStartMatch: () => void;
  onSwitchMap: (mapId: string) => void;
  onVoteMap: (mapId: string) => void;
  onRematchNow: () => void;
  onOpenSettings: () => void;
  onUpdateLoadout: (loadout: PlayerLoadoutPayload) => void;
  onLeaveRoom: () => void;
  onMasterVolumeChange: (volume: number) => void;
}

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function percentage(numerator = 0, denominator = 0): number {
  return denominator > 0 ? Math.round(100 * numerator / denominator) : 0;
}

const KILLFEED_LIFETIME_MS = 6000;

export class ShooterHud {
  private readonly root: HTMLDivElement;
  private minimapCtx: CanvasRenderingContext2D | null = null;
  private room: RoomStateBroadcast | null = null;
  private localPlayerId = "";
  private hitmarkerTimeout: ReturnType<typeof setTimeout> | null = null;
  private bannerTimeout: ReturnType<typeof setTimeout> | null = null;
  private pingNoticeTimeout: ReturnType<typeof setTimeout> | null = null;
  private damageCardTimeout: ReturnType<typeof setTimeout> | null = null;
  private damageArcTimeout: ReturnType<typeof setTimeout> | null = null;
  private arenaNoticeTimeout: ReturnType<typeof setTimeout> | null = null;
  private paused = false;
  private connectionInterrupted = false;
  private loadoutModalOpen = false;
  private loadoutOpener: HTMLElement | null = null;
  private scoreboardOpen = false;
  private pendingMap: string | null = null;
  private lastMinimapUpdate = 0;
  private lastMarkersUpdate = 0;
  private lastMarkerHtml = "";
  private crosshairKey = "";

  private readonly killfeedItems: { id: number; html: string; mine: boolean; expiresAt: number }[] = [];
  private killfeedTimer: ReturnType<typeof setInterval> | null = null;
  private killBannerTimeout: ReturnType<typeof setTimeout> | null = null;
  private volumeToastTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(
    parent: HTMLElement,
    private readonly profile: GuestProfile,
    private readonly callbacks: ShooterHudCallbacks
  ) {
    this.root = document.createElement("div");
    this.root.className = "hud-root hidden";
    this.root.innerHTML = `
      <div class="flash-overlay" id="hud-flash"></div>
      <div class="suppression-vignette" id="hud-vignette"></div>
      <div class="world-markers-layer" id="hud-world-markers"></div>
      <div class="mouse-capture interactive hidden" id="hud-mouse-capture">
        <button type="button" class="btn btn-primary" id="hud-lock-mouse" aria-keyshortcuts="F2">Lock mouse <kbd>F2</kbd></button>
        <div id="hud-mouse-capture-status" role="status"></div>
      </div>

      <div class="room-badge-top interactive" style="gap:6px;padding:5px 10px;font-size:11px;">
        <span style="font-weight:900;color:var(--accent-cyan);font-family:var(--font-mono);" id="hud-room-code">ROOM ----</span>
        <span id="hud-map-label" style="color:var(--text-muted);max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">Cargo Docks</span>
        <button class="btn btn-secondary" id="hud-open-menu" style="padding:3px 7px;font-size:10px;">[M] Menu</button>
        <button class="btn btn-secondary" id="hud-open-loadout" style="padding:3px 7px;font-size:10px;">[L] Loadout</button>
        <button class="btn btn-secondary" id="hud-copy-invite" style="padding:3px 7px;font-size:10px;">Invite</button>
        <button class="btn btn-amber hidden" id="hud-host-start" style="padding:3px 8px;font-size:10px;">Start</button>
      </div>

      <div class="minimap-wrap">
        <canvas class="minimap-canvas" id="hud-minimap" width="158" height="158"></canvas>
      </div>

      <div class="scoreboard-top">
        <div class="score-team score-a"><span>TEAM A</span><span id="hud-score-a">0</span></div>
        <div class="timer-box">
          <div class="timer-val" id="hud-timer">0:45</div>
          <div class="phase-sub" id="hud-phase">WARMUP</div>
        </div>
        <div class="score-team score-b"><span id="hud-score-b">0</span><span>TEAM B</span></div>
      </div>

      <div class="telemetry-badge" id="hud-telemetry" title="Round-trip time, time since last snapshot, and movement corrections">Connecting…</div>
      <div class="connection-banner interactive hidden" id="hud-connection" role="status">
        <span id="hud-connection-text"></span>
        <button class="btn btn-secondary" id="hud-disconnect-leave">Return to lobby</button>
      </div>
      <div class="killfeed" id="hud-killfeed"></div>

      <div class="killbanner hidden" id="hud-killbanner" aria-live="polite"></div>
      <div class="volume-toast hidden" id="hud-volume-toast" role="status" aria-live="polite">
        <div class="vt-row"><span class="vt-icon" id="hud-volume-icon">🔊</span><span class="vt-label">VOLUME</span><span class="vt-pct" id="hud-volume-pct">75%</span></div>
        <div class="vt-track"><div class="vt-fill" id="hud-volume-fill"></div></div>
        <div class="vt-keys"><kbd>-</kbd> <kbd>=</kbd> volume · <kbd>F8</kbd> mute</div>
      </div>

      <div class="sniper-scope hidden" id="hud-scope">
        <div class="scope-lens" aria-hidden="true">
          <svg class="scope-reticle" viewBox="0 0 400 400">
            <path class="scope-marks" d="M54 200H194 M206 200H346 M200 54V194 M200 206V346 M176 196V204 M224 196V204 M196 176H204 M196 224H204 M152 194V206 M248 194V206 M194 152H206 M194 248H206" />
            <path class="prism-marks" d="M190 200H197 M203 200H210 M200 190V197 M200 203V210" />
            <circle class="scope-center-dot" cx="200" cy="200" r="1.5" />
          </svg>
        </div>
        <div class="scope-breath" id="hud-breath">Hold Shift to steady</div>
      </div>

      <div class="crosshair-center" id="hud-crosshair"></div>
      <div class="hitmarker" id="hud-hitmarker"></div>
      <div id="hud-damage-arc" class="hud-damage-direction hidden">
        <svg width="180" height="180" viewBox="0 0 180 180">
          <path d="M 54 20 Q 90 0 126 20" fill="none" stroke="#ff3737" stroke-width="9" stroke-linecap="round" />
          <path d="M 86 21 L 90 15 L 94 21 Z" fill="#fff0e7" />
        </svg>
      </div>

      <div class="center-banner hidden" id="hud-banner"></div>
      <div id="hud-arena-notice" class="hud-arena-notice hidden" role="status"></div>
      <div id="hud-replay" class="hud-replay hidden"></div>
      <div id="hud-match-results" class="hud-match-results hidden"></div>
      <div class="ping-notice hidden" id="hud-ping-notice" role="status"></div>
      <div class="damage-card hidden" id="hud-damage-card"></div>

      <div class="tab-scoreboard hidden" id="hud-scoreboard-tab"></div>

      <div class="bottom-hud">
        <div class="vitals-card">
          <div style="display:flex;justify-content:space-between;font-size:12px;font-weight:800;">
            <span id="hud-stance">STAND</span>
            <span id="hud-lean" style="color:var(--accent-cyan);"></span>
          </div>
          <div class="bar-row">
            <span style="width:24px;font-size:11px;font-weight:800;color:#4ade80;">HP</span>
            <div class="bar-track"><div class="hp-fill" id="hud-hp-fill" style="width:100%;"></div></div>
            <span id="hud-hp-val" style="width:30px;text-align:right;font-family:var(--font-mono);font-weight:800;">100</span>
          </div>
          <div id="hud-recovery" class="hidden" style="font-size:11px;font-weight:800;color:#86efac;"></div>
          <div class="bar-row">
            <span style="width:24px;font-size:11px;font-weight:800;color:#38bdf8;">AR</span>
            <div class="bar-track"><div class="armor-fill" id="hud-armor-fill" style="width:100%;"></div></div>
            <span id="hud-armor-val" style="width:30px;text-align:right;font-family:var(--font-mono);font-weight:800;">50</span>
          </div>
        </div>

        <div class="controls-hint" id="hud-hint">
          WASD Move · Q/E Lean · L Loadout · M Menu
        </div>

        <div class="weapon-card">
          <div style="font-size:13px;font-weight:900;" id="hud-wep-name">M416 Tactical</div>
          <div style="font-size:11px;color:var(--accent-cyan);" id="hud-wep-meta">[AUTO] • Factory Tactical</div>
          <div style="margin-top:4px;">
            <span class="ammo-big" id="hud-ammo-mag">30</span>
            <span class="ammo-res" id="hud-ammo-res"> / 120</span>
          </div>
          <div style="font-size:11px;color:var(--accent-amber);margin-top:2px;" id="hud-grenade"></div>
          <div id="hud-grenade-stock" class="chip-row hidden" style="margin-top:5px;gap:4px;">
            ${THROWABLE_ORDER.map((kind) => `
              <span class="chip" data-grenade-stock="${kind}" style="font-size:10px;padding:2px 5px;">
                <span aria-hidden="true">${THROWABLE_LABELS[kind].icon}</span>
                <span data-grenade-label></span>
              </span>`).join("")}
          </div>
        </div>
      </div>

      <div class="modal-backdrop interactive hidden" id="hud-loadout-modal" role="dialog" aria-label="Match loadout" aria-modal="true" tabindex="-1">
        <div class="modal-card" id="hud-loadout-content"></div>
      </div>

      <div class="pause-overlay interactive hidden" id="hud-pause" role="dialog" aria-label="Match menu" aria-modal="true" tabindex="-1">
        <div class="modal-card" style="max-width:460px;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <div>
              <div style="font-size:18px;font-weight:900;">Match menu</div>
              <div style="font-size:12px;color:var(--text-muted);" id="pause-room-info">Room ----</div>
            </div>
            <span style="font-size:11px;color:var(--accent-green);" id="pause-host-tag"></span>
          </div>

          <label class="pause-volume" for="pause-volume">
            <span class="pv-head"><span>Master volume <small>(<kbd>-</kbd> / <kbd>=</kbd> in game, <kbd>F8</kbd> mute)</small></span><b id="pause-volume-val">75%</b></span>
            <input id="pause-volume" type="range" min="0" max="100" step="5" value="75">
          </label>

          <div id="pause-players" class="pause-player-list"></div>
          <details class="match-controls"><summary>Controls</summary>
            <p>WASD move · Mouse aim · Left click fire · Right click aim down sights</p>
            <p>Shift sprint · Space jump or vault · Q/E lean · Z or middle click team ping · Tab scoreboard</p>
            <p id="pause-combat-bindings"></p>
            <p id="pause-grenade-bindings"></p>
          </details>

          <div id="pause-host-controls" class="hidden" style="display:flex;flex-direction:column;gap:8px;padding-top:8px;border-top:1px solid var(--border-subtle);">
            <button class="btn btn-amber" id="pause-start-match">Start match</button>
            <div class="code-row">
              <select id="pause-map-select" class="text-input" aria-label="Next map" style="text-transform:none;">
                ${MAP_LIST.map((m) => `<option value="${m.id}">${m.name}</option>`).join("")}
              </select>
              <button class="btn btn-secondary" id="pause-apply-map">Switch Map</button>
            </div>
            <div id="pause-map-status" role="status" class="map-change-status"></div>
          </div>

          <div id="pause-match-end" class="hidden" style="display:flex;flex-direction:column;gap:8px;">
            <div style="font-size:12px;font-weight:800;color:var(--accent-amber);">VOTE NEXT ARENA</div>
            <div id="pause-vote-btns" class="code-row"></div>
            <button class="btn btn-primary" id="pause-rematch-now">Rematch</button>
          </div>

          <div class="match-menu-actions">
            <button class="btn btn-primary" id="pause-resume" style="flex:1;" aria-keyshortcuts="F2">Resume &amp; lock mouse</button>
            <button class="btn btn-secondary" id="pause-loadout">Loadout</button>
            <button class="btn btn-secondary" id="pause-settings">Settings</button>
            <button class="btn btn-danger" id="pause-leave">Leave</button>
          </div>
        </div>
      </div>
    `;
    parent.appendChild(this.root);
    const canvas = this.root.querySelector("#hud-minimap") as HTMLCanvasElement | null;
    this.minimapCtx = canvas?.getContext("2d") ?? null;
    this.bindEvents();
  }

  private bindEvents(): void {
    const bindMenu = (id: string, close: () => void) => {
      this.root.querySelector<HTMLElement>(id)?.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      });
    };
    bindMenu("#hud-loadout-modal", () => this.toggleLoadoutModal(false));
    bindMenu("#hud-pause", () => this.callbacks.onResumeCombat());
    this.root.querySelector("#hud-disconnect-leave")?.addEventListener("click", this.callbacks.onLeaveRoom);
    this.root.querySelector("#hud-lock-mouse")?.addEventListener("click", this.callbacks.onResumeCombat);
    this.root.querySelector("#hud-copy-invite")?.addEventListener("click", async () => {
      if (!this.room) return;
      const url = `${window.location.origin}/?room=${this.room.code}`;
      try {
        await navigator.clipboard.writeText(url);
        const btn = this.root.querySelector("#hud-copy-invite");
        if (btn) {
          btn.textContent = "Copied!";
          setTimeout(() => {
            btn.textContent = "Invite";
          }, 1800);
        }
      } catch {
        window.prompt("Copy room invite link:", url);
      }
    });

    this.root.querySelector("#hud-open-menu")?.addEventListener("click", () => {
      this.callbacks.onOpenMenu();
    });
    this.root.querySelector("#hud-open-loadout")?.addEventListener("click", () => {
      this.toggleLoadoutModal(true);
    });
    this.root.querySelector("#pause-loadout")?.addEventListener("click", () => {
      this.toggleLoadoutModal(true);
    });

    this.root.querySelector("#hud-host-start")?.addEventListener("click", () => {
      this.callbacks.onStartMatch();
    });

    this.root.querySelector<HTMLInputElement>("#pause-volume")?.addEventListener("input", (event) => {
      const value = Number((event.currentTarget as HTMLInputElement).value);
      const label = this.root.querySelector("#pause-volume-val");
      if (label) label.textContent = `${value}%`;
      this.callbacks.onMasterVolumeChange(value / 100);
    });
    this.root.querySelector("#pause-resume")?.addEventListener("click", () => {
      this.callbacks.onResumeCombat();
    });
    this.root.querySelector("#pause-start-match")?.addEventListener("click", () => {
      this.callbacks.onStartMatch();
      this.callbacks.onResumeCombat();
    });
    this.root.querySelector("#pause-apply-map")?.addEventListener("click", () => {
      const sel = this.root.querySelector("#pause-map-select") as HTMLSelectElement;
      if (sel?.value && sel.value !== this.room?.mapId) {
        this.pendingMap = sel.value;
        this.setMapStatus(`Switching to ${MAP_REGISTRY[sel.value]?.name ?? sel.value}…`);
        this.callbacks.onSwitchMap(sel.value);
      }
    });
    this.root.querySelector("#pause-rematch-now")?.addEventListener("click", () => {
      this.callbacks.onRematchNow();
    });
    this.root.querySelector("#pause-settings")?.addEventListener("click", () => {
      this.callbacks.onOpenSettings();
    });
    this.root.querySelector("#pause-leave")?.addEventListener("click", () => {
      this.callbacks.onLeaveRoom();
    });
  }

  toggleLoadoutModal(open?: boolean): boolean {
    const next = open ?? !this.loadoutModalOpen;
    if (next === this.loadoutModalOpen) return next;
    this.loadoutModalOpen = next;
    const modal = this.root.querySelector<HTMLElement>("#hud-loadout-modal");
    if (!modal) return false;
    if (this.loadoutModalOpen) {
      this.loadoutOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      this.renderLoadoutModal();
      modal.classList.remove("hidden");
      if (document.pointerLockElement) document.exitPointerLock();
      modal.focus({ preventScroll: true });
    } else {
      modal.classList.add("hidden");
      if (this.paused && this.loadoutOpener?.isConnected) this.loadoutOpener.focus({ preventScroll: true });
      this.loadoutOpener = null;
    }
    this.callbacks.onLoadoutChanged(this.loadoutModalOpen);
    return this.loadoutModalOpen;
  }

  private renderLoadoutModal(): void {
    const content = this.root.querySelector("#hud-loadout-content");
    if (!content) return;
    const isTdm = this.room !== null && this.room !== undefined && this.room.mode !== "WARMUP";
    const kitSlot = this.profile.tdmKitSlot ?? 0;
    const kits = isTdm ? this.getTdmKits(kitSlot) : undefined;
    const primary = this.profile.loadout.primary;
    const applyAtRespawn = isTdm && (this.room?.phase === "LIVE" || this.room?.phase === "COUNTDOWN");
    const bp = WEAPON_REGISTRY[primary.weaponId] ?? WEAPON_REGISTRY.m416;
    const primaries = WEAPON_LIST.filter((w) => w.category !== "PISTOL");
    const slots: { slot: AttachmentSlot; label: string }[] = [
      { slot: "optic", label: "Optic" },
      { slot: "muzzle", label: "Muzzle" },
      { slot: "underbarrel", label: "Grip" },
      { slot: "mag", label: "Mag" },
    ];

    content.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div>
          <div style="font-size:18px;font-weight:900;">IN-MATCH QUICK LOADOUT</div>
          <div style="font-size:12px;color:var(--text-muted);">${applyAtRespawn ? "Changes apply on your next life." : "Choose your weapon and gear."}</div>
        </div>
        <button class="btn btn-primary" id="inm-lo-apply">Apply & Resume</button>
      </div>

      ${kits ? `
        <div class="panel-title">Saved kits</div>
        <div class="chip-row">
          ${kits.map((kit, index) => `<button type="button" class="chip ${index === kitSlot ? "selected" : ""}" data-tdm-kit="${index}">
            Kit ${index + 1} · ${WEAPON_REGISTRY[kit.primary.weaponId]?.name ?? "Custom"}
          </button>`).join("")}
        </div>` : ""}
      <div class="panel-title">Primary Weapon</div>
      <div class="chip-row">
        ${primaries.map((w) => `<button class="chip ${primary.weaponId === w.id ? "selected" : ""}" data-inm-wep="${w.id}">${w.name}</button>`).join("")}
      </div>
      ${isTdm ? renderTdmThrowables(this.profile.loadout) : ""}

      ${slots
        .filter((s) => bp.allowedSlots.includes(s.slot))
        .map((s) => {
          const choices = getAttachmentsForWeaponSlot(bp.category, s.slot);
          const cur = primary.attachments[s.slot] ?? "";
          return `
            <div style="font-size:11px;color:var(--text-muted);font-weight:700;">${s.label}</div>
            <div class="chip-row">
              <button class="chip ${!cur ? "selected" : ""}" data-inm-slot="${s.slot}" data-inm-att="">None</button>
              ${choices.map((a) => `<button class="chip ${cur === a.id ? "selected" : ""}" data-inm-slot="${s.slot}" data-inm-att="${a.id}">${a.shortName}</button>`).join("")}
            </div>
          `;
        })
        .join("")}

      <div class="panel-title">Universal Skin</div>
      <div class="chip-row">
        ${skinsForWeapon(primary.weaponId).map((sk) => `<button class="skin-swatch ${primary.skinId === sk.id ? "selected" : ""}" data-inm-skin="${sk.id}" ${careerLevel(this.profile.stats.xp) < (sk.unlockLevel ?? 1) ? "disabled" : ""}><span class="swatch-dot" style="background:${sk.previewGradient};"></span>${sk.name}${careerLevel(this.profile.stats.xp) < (sk.unlockLevel ?? 1) ? ` · Lv. ${sk.unlockLevel}` : ""}</button>`).join("")}
      </div>
    `;

    content.querySelectorAll<HTMLElement>("[data-inm-wep]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const wId = btn.dataset.inmWep!;
        primary.weaponId = wId;
        primary.attachments = { ...(WEAPON_REGISTRY[wId]?.defaultAttachments ?? {}) };
        this.saveMatchLoadout();
        this.renderLoadoutModal();
      });
    });

    content.querySelectorAll<HTMLElement>("[data-inm-slot]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const slot = btn.dataset.inmSlot as AttachmentSlot;
        const att = btn.dataset.inmAtt || "";
        if (!att) delete primary.attachments[slot];
        else primary.attachments[slot] = att;
        this.saveMatchLoadout();
        this.renderLoadoutModal();
      });
    });

    content.querySelectorAll<HTMLElement>("[data-inm-skin]").forEach((btn) => {
      btn.addEventListener("click", () => {
        primary.skinId = btn.dataset.inmSkin!;
        this.saveMatchLoadout();
        this.renderLoadoutModal();
      });
    });

    if (isTdm) {
      bindTdmThrowables(content, this.profile.loadout, () => this.saveMatchLoadout());
      content.querySelectorAll<HTMLButtonElement>("[data-tdm-kit]").forEach((button) => {
        button.addEventListener("click", () => {
          const index = button.dataset.tdmKit === "1" ? 1 : 0;
          if (!kits || index === kitSlot) return;
          this.profile.tdmKitSlot = index;
          this.profile.loadout = structuredClone(kits[index]);
          this.saveMatchLoadout();
          this.renderLoadoutModal();
        });
      });
    }
    content.querySelector("#inm-lo-apply")?.addEventListener("click", () => {
      this.toggleLoadoutModal(false);
      this.callbacks.onResumeCombat();
    });
  }

  private getTdmKits(activeSlot: 0 | 1): [PlayerLoadoutPayload, PlayerLoadoutPayload] {
    if (!this.profile.tdmKits) {
      const alternate = structuredClone(this.profile.loadout);
      const weapon = WEAPON_REGISTRY[alternate.primary.weaponId === "m870" ? "m416" : "m870"];
      alternate.primary.weaponId = weapon.id;
      alternate.primary.attachments = { ...weapon.defaultAttachments };
      alternate.tdmThrowables = ["flashbang", "smoke"];
      this.profile.tdmKits = [structuredClone(this.profile.loadout), alternate];
    }
    this.profile.tdmKits[activeSlot] = structuredClone(this.profile.loadout);
    return this.profile.tdmKits;
  }

  private saveMatchLoadout(): void {
    if (this.room && this.room.mode !== "WARMUP") this.getTdmKits(this.profile.tdmKitSlot ?? 0);
    saveGuestProfile(this.profile);
    this.callbacks.onUpdateLoadout(this.profile.loadout);
  }

  setScoreboardVisible(visible: boolean): void {
    if (this.scoreboardOpen === visible) return;
    this.scoreboardOpen = visible;
    const el = this.root.querySelector("#hud-scoreboard-tab");
    if (!el) return;
    if (visible && this.room) {
      this.renderScoreboardOverlay(this.room);
      el.classList.remove("hidden");
    } else {
      el.classList.add("hidden");
    }
  }

  private renderScoreboardOverlay(room: RoomStateBroadcast): void {
    const el = this.root.querySelector("#hud-scoreboard-tab");
    if (!el) return;
    const mapName = MAP_REGISTRY[room.mapId]?.name ?? room.mapId;
    const teamA = room.players.filter((p) => p.team === "A");
    const teamB = room.players.filter((p) => p.team === "B");

    const renderRows = (list: typeof teamA, accent: string) =>
      list
        .map(
          (p) => `
        <div style="display:grid;grid-template-columns:minmax(0,1fr) 40px 40px 50px 60px;align-items:center;padding:7px 10px;border-radius:6px;background:${p.id === this.localPlayerId ? "rgba(56,189,248,0.16)" : "rgba(255,255,255,0.04)"};font-size:12px;">
          <span style="font-weight:700;color:${p.alive ? "#f8fafc" : "#64748b"};">
            <span style="color:${accent};">●</span> ${escapeText(p.callsign)} ${p.isBot ? "<span style='color:#94a3b8;font-size:10px;'>[AI]</span>" : ""}
          </span>
          <span style="text-align:center;font-family:var(--font-mono);">${p.kills}K</span>
          <span style="text-align:center;font-family:var(--font-mono);color:var(--text-muted);">${p.deaths}D</span>
          <span title="Accuracy" style="text-align:center;color:var(--text-muted);">${percentage(p.combatStats?.shotsHit, p.combatStats?.shots)}%</span>
          <span style="text-align:right;font-size:10px;font-weight:800;color:${p.alive ? "#4ade80" : "#f87171"};">${p.alive ? `${Math.ceil(p.hp)} HP` : "DEAD"}</span>
        </div>
      `
        )
        .join("");

    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <div>
          <div style="font-size:16px;font-weight:900;">${mapName} // ${room.mode} (${room.code})</div>
          <div style="font-size:11px;color:var(--text-muted);">${this.describeMatchRules(room)}</div>
        </div>
        <div style="font-family:var(--font-mono);font-size:20px;font-weight:900;">
          <span style="color:#38bdf8;">${room.scoreA}</span> : <span style="color:#f87171;">${room.scoreB}</span>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">
        <div style="display:grid;gap:5px;">
          <div style="font-size:11px;font-weight:900;color:#38bdf8;letter-spacing:1px;">TEAM A</div>
          ${renderRows(teamA, "#38bdf8")}
        </div>
        <div style="display:grid;gap:5px;">
          <div style="font-size:11px;font-weight:900;color:#f87171;letter-spacing:1px;">TEAM B</div>
          ${renderRows(teamB, "#f87171")}
        </div>
      </div>
    `;
  }

  show(localPlayerId: string, room: RoomStateBroadcast): void {
    this.localPlayerId = localPlayerId;
    this.root.classList.remove("hidden");
    this.updateRoom(room);
  }

  hide(): void {
    this.root.classList.add("hidden");
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    const menu = this.root.querySelector<HTMLElement>("#hud-pause");
    menu?.classList.toggle("hidden", !paused);
    if (paused && !this.loadoutModalOpen) menu?.focus({ preventScroll: true });
    if (this.room) this.refreshPausePanel(this.room);
  }

  /** Keeps the pause-menu slider in step with hotkey and settings-modal changes. */
  syncVolumeControls(volume: number): void {
    const pct = Math.round(volume * 100);
    const slider = this.root.querySelector<HTMLInputElement>("#pause-volume");
    if (slider) slider.value = String(pct);
    const label = this.root.querySelector("#pause-volume-val");
    if (label) label.textContent = `${pct}%`;
  }

  showVolumeToast(volume: number, muted: boolean): void {
    const el = this.root.querySelector<HTMLElement>("#hud-volume-toast");
    if (!el) return;
    const pct = muted ? 0 : Math.round(volume * 100);
    const icon = this.root.querySelector("#hud-volume-icon");
    if (icon) icon.textContent = muted || pct === 0 ? "🔇" : pct < 40 ? "🔉" : "🔊";
    const label = this.root.querySelector("#hud-volume-pct");
    if (label) label.textContent = muted ? "MUTED" : `${pct}%`;
    const fill = this.root.querySelector<HTMLElement>("#hud-volume-fill");
    if (fill) fill.style.width = `${pct}%`;
    el.classList.toggle("muted", muted);
    el.classList.remove("hidden");
    if (this.volumeToastTimeout) clearTimeout(this.volumeToastTimeout);
    this.volumeToastTimeout = setTimeout(() => el.classList.add("hidden"), 1400);
  }

  updateRoom(room: RoomStateBroadcast): void {
    const previousMap = this.room?.mapId;
    if (room.phase !== "MATCH_END") this.root.querySelector("#hud-match-results")?.classList.add("hidden");
    this.room = room;
    if (room.mapId !== previousMap) {
      const mapSelect = this.root.querySelector<HTMLSelectElement>("#pause-map-select");
      if (mapSelect) mapSelect.value = room.mapId;
      if (this.pendingMap) this.setMapStatus(`Now playing ${MAP_REGISTRY[room.mapId]?.name ?? room.mapId}`);
      this.pendingMap = null;
    }
    const map = MAP_REGISTRY[room.mapId];

    const setText = (sel: string, txt: string) => {
      const el = this.root.querySelector(sel);
      if (el) el.textContent = txt;
    };

    setText("#hud-room-code", `ROOM ${room.code}`);
    setText("#hud-map-label", `${map?.name ?? room.mapId} (${room.mode})`);
    setText("#hud-score-a", String(room.scoreA));
    setText("#hud-score-b", String(room.scoreB));

    setText("#hud-timer", this.formatClock(room));
    setText("#hud-phase", this.describeMatchRules(room));

    const local = room.players.find((p) => p.id === this.localPlayerId);
    const hostStartBtn = this.root.querySelector("#hud-host-start");
    if (hostStartBtn) {
      hostStartBtn.classList.toggle("hidden", !(local?.isHost && !room.matchRules?.ranked && room.phase === "WARMUP" && room.mode !== "WARMUP"));
    }

    if (this.scoreboardOpen) this.renderScoreboardOverlay(room);

    if (room.phase === "MATCH_END" && !this.paused) {
      this.callbacks.onOpenMenu();
    } else if (this.paused) {
      this.refreshPausePanel(room);
    }
  }

  private setMapStatus(text: string): void {
    const status = this.root.querySelector("#pause-map-status");
    if (status) status.textContent = text;
  }

  setConnectionStatus(text: string): void {
    this.connectionInterrupted = Boolean(text);
    this.root.querySelector("#hud-connection")?.classList.toggle("hidden", !text);
    const status = this.root.querySelector("#hud-connection-text");
    if (status) status.textContent = text;
  }

  private refreshPausePanel(room: RoomStateBroadcast): void {
    const local = room.players.find((p) => p.id === this.localPlayerId);
    const infoEl = this.root.querySelector("#pause-room-info");
    if (infoEl) {
      infoEl.textContent = `Code: ${room.code} • ${room.isPublic ? "Public" : "Private"} • ${room.mode}`;
    }
    const hostTag = this.root.querySelector("#pause-host-tag");
    if (hostTag) {
      hostTag.textContent = local?.isHost ? "YOU ARE HOST" : "";
    }

    const listEl = this.root.querySelector("#pause-players");
    if (listEl) {
      listEl.innerHTML = room.players
        .map(
          (p) => `
        <div style="display:flex;justify-content:space-between;background:rgba(255,255,255,0.04);padding:6px 10px;border-radius:6px;font-size:12px;">
          <span><strong style="color:${p.team === "A" ? "#38bdf8" : "#f87171"}">[${p.team}]</strong> ${escapeText(p.callsign)} ${p.isHost ? "👑" : ""} ${p.isBot ? "(AI)" : ""}</span>
          <span style="font-family:var(--font-mono);color:var(--text-muted);">${p.kills}K / ${p.deaths}D</span>
        </div>
      `
        )
        .join("");
    }

    const hostCtrl = this.root.querySelector("#pause-host-controls");
    if (hostCtrl) {
      hostCtrl.classList.toggle("hidden", !local?.isHost || room.phase === "MATCH_END" ||
        (room.mode !== "WARMUP" && room.phase !== "WARMUP"));
    }
    this.root.querySelector("#pause-start-match")?.classList.toggle("hidden", room.mode === "WARMUP" || room.phase !== "WARMUP");

    const matchEnd = this.root.querySelector("#pause-match-end");
    if (matchEnd) {
      matchEnd.classList.toggle("hidden", room.phase !== "MATCH_END");
      if (room.phase === "MATCH_END" && room.mapVoteOptions) {
        const voteWrap = this.root.querySelector("#pause-vote-btns");
        if (voteWrap) {
          voteWrap.innerHTML = room.mapVoteOptions
            .map((mId) => {
              const mName = MAP_REGISTRY[mId]?.name ?? mId;
              const votes = room.mapVotes?.[mId] ?? 0;
              return `<button class="btn btn-secondary" data-vote-map="${mId}" style="flex:1;">${mName} (${votes})</button>`;
            })
            .join("");
          voteWrap.querySelectorAll<HTMLElement>("[data-vote-map]").forEach((b) => {
            b.addEventListener("click", () => this.callbacks.onVoteMap(b.dataset.voteMap!));
          });
        }
      }
    }
  }

  private renderMinimap(snap: HudLiveSnapshot): void {
    const ctx = this.minimapCtx;
    const room = this.room;
    if (!ctx || !room) return;
    const map = MAP_REGISTRY[room.mapId];
    if (!map) return;

    const w = 158;
    const h = 158;
    const cx = w * 0.5;
    const cy = h * 0.5;
    const scale = 2.6; // pixels per meter

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(8, 12, 20, 0.92)";
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(snap.playerYaw);

    const toMini = (wx: number, wz: number): [number, number] => [
      (wx - snap.playerPos.x) * scale,
      -(wz - snap.playerPos.z) * scale,
    ];

    // Draw map cover blocks
    for (const b of map.blocks) {
      if (b.isPuddle) continue;
      const [bx, by] = toMini(b.position.x, b.position.z);
      const bw = b.size.x * scale;
      const bd = b.size.z * scale;
      ctx.fillStyle = b.material === "EXPLOSIVE_BARREL" ? "#dc2626" : b.material === "GLASS" ? "#38bdf8" : "#334155";
      ctx.fillRect(bx - bw * 0.5, by - bd * 0.5, bw, bd);
    }

    // Teammates & spotted enemy blips
    for (const mate of snap.minimapTeammates) {
      const [mx, my] = toMini(mate.x, mate.z);
      ctx.fillStyle = "#38bdf8";
      ctx.beginPath();
      ctx.arc(mx, my, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const blip of snap.minimapEnemyBlips) {
      const [ex, ey] = toMini(blip.x, blip.z);
      ctx.fillStyle = "#ef4444";
      ctx.beginPath();
      ctx.arc(ex, ey, 4.2, 0, Math.PI * 2);
      ctx.fill();
    }

    // Team pings stay visible on the radar when their beam is outside the camera view.
    ctx.strokeStyle = "#fbbf24";
    ctx.lineWidth = 1.8;
    for (const ping of snap.minimapPings) {
      const [x, y] = toMini(ping.x, ping.z);
      const edgeScale = Math.min(1, (cx - 9) / Math.hypot(x, y));
      ctx.beginPath();
      ctx.arc(x * edgeScale, y * edgeScale, 4.6, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();

    // FOV Cone & Player Center Arrow
    ctx.fillStyle = "rgba(56, 189, 248, 0.14)";
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx - 28, cy - 52);
    ctx.lineTo(cx + 28, cy - 52);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = "#38bdf8";
    ctx.beginPath();
    ctx.moveTo(cx, cy - 6);
    ctx.lineTo(cx + 5, cy + 5);
    ctx.lineTo(cx, cy + 2);
    ctx.lineTo(cx - 5, cy + 5);
    ctx.closePath();
    ctx.fill();
  }

  private renderWorldMarkers(snap: HudLiveSnapshot): void {
    const layer = this.root.querySelector("#hud-world-markers");
    if (!layer) return;

    let html = "";
    for (const m of snap.screenMarkers) {
      if (m.kind === "TEAMMATE") {
        html += `<div class="world-marker-tag" style="left:${m.x}px;top:${m.y}px;">${escapeText(m.label)} • ${Math.round(m.hp)} HP</div>`;
      } else {
        html += `<div class="world-marker-ping" style="left:${m.x}px;top:${m.y}px;">⚑ ${escapeText(m.label)} • ${m.distanceM}m</div>`;
      }
    }
    if (html !== this.lastMarkerHtml) {
      layer.innerHTML = html;
      this.lastMarkerHtml = html;
    }
  }

  updateLiveHud(snap: HudLiveSnapshot): void {
    const replay = this.root.querySelector("#hud-replay");
    if (replay) {
      const label = snap.replayName ? `Killcam · ${snap.replayName} · Space to skip` : "";
      if (replay.textContent !== label) replay.textContent = label;
      replay.classList.toggle("hidden", !label);
    }
    this.root.querySelector("#hud-mouse-capture")?.classList.toggle("hidden",
      snap.pointerLocked || this.paused || this.loadoutModalOpen || this.connectionInterrupted);
    const now = performance.now();
    if (now - this.lastMinimapUpdate >= 100) {
      this.lastMinimapUpdate = now;
      const tel = this.root.querySelector("#hud-telemetry");
      const ping = snap.pingMs === null ? "–" : `${snap.pingMs}ms`;
      const age = snap.snapshotAgeMs === null ? "–" : `${snap.snapshotAgeMs}ms`;
      if (tel) tel.textContent = `${snap.fps} FPS · ${ping} RTT · ${age} snapshot · ${snap.movementCorrections} corrections`;
      this.renderMinimap(snap);
    }
    if (now - this.lastMarkersUpdate >= 1000 / 30) {
      this.lastMarkersUpdate = now;
      this.renderWorldMarkers(snap);
    }

    const flash = this.root.querySelector("#hud-flash") as HTMLElement | null;
    if (flash) flash.style.opacity = String(snap.flashAlpha);

    const vig = this.root.querySelector("#hud-vignette") as HTMLElement | null;
    if (vig) vig.style.opacity = String(snap.damageVignetteAlpha);

    const scopeEl = this.root.querySelector("#hud-scope");
    const chEl = this.root.querySelector("#hud-crosshair") as HTMLElement | null;
    const isScoped6x = snap.ads && snap.adsScopeLevel === "6X";
    const isScoped = snap.ads && (isScoped6x || snap.adsScopeLevel === "2X");

    if (scopeEl) {
      scopeEl.classList.toggle("hidden", !isScoped);
      scopeEl.classList.toggle("scope-2x", isScoped && !isScoped6x);
    }
    const breathEl = this.root.querySelector("#hud-breath");
    if (breathEl) {
      breathEl.classList.toggle("hidden", !isScoped6x);
      const label = snap.holdBreathPct > 0
        ? `Hold Shift to steady · ${snap.holdBreathPct}%`
        : "Release Shift to recover breath";
      if (breathEl.textContent !== label) breathEl.textContent = label;
    }

    const s = this.profile.settings;
    const crosshairKey = [snap.alive, snap.ads, snap.adsScopeLevel, s.crosshairStyle,
      Math.round(s.crosshairGap * snap.spreadBloom), s.crosshairSize, s.crosshairColor].join("|");
    if (chEl && this.crosshairKey !== crosshairKey) {
      this.crosshairKey = crosshairKey;
      if (isScoped || (snap.ads && snap.adsScopeLevel !== "NONE") || !snap.alive) {
        chEl.innerHTML =
          snap.ads && snap.adsScopeLevel === "RED_DOT"
            ? `<div class="optic-red-dot"></div>`
            : "";
      } else {
        const s = this.profile.settings;
        const g = Math.round(s.crosshairGap * snap.spreadBloom);
        const sz = s.crosshairSize;
        const c = s.crosshairColor;
        const total = (g + sz) * 2 + 12;
        const mid = total / 2;
        if (s.crosshairStyle === "STATIC_DOT") {
          chEl.innerHTML = `<svg width="${total}" height="${total}"><circle cx="${mid}" cy="${mid}" r="${Math.max(2, sz * 0.35)}" fill="${c}"/></svg>`;
        } else if (s.crosshairStyle === "CIRCLE_CROSS") {
          chEl.innerHTML = `<svg width="${total}" height="${total}">
            <circle cx="${mid}" cy="${mid}" r="${g + sz * 0.7}" fill="none" stroke="${c}" stroke-width="1.5"/>
            <circle cx="${mid}" cy="${mid}" r="1.8" fill="${c}"/>
            <line x1="${mid - g - sz}" y1="${mid}" x2="${mid - g}" y2="${mid}" stroke="${c}" stroke-width="2"/>
            <line x1="${mid + g}" y1="${mid}" x2="${mid + g + sz}" y2="${mid}" stroke="${c}" stroke-width="2"/>
          </svg>`;
        } else {
          const top =
            s.crosshairStyle === "CLASSIC_T"
              ? ""
              : `<line x1="${mid}" y1="${mid - g - sz}" x2="${mid}" y2="${mid - g}" stroke="${c}" stroke-width="2"/>`;
          chEl.innerHTML = `<svg width="${total}" height="${total}">
            ${top}
            <line x1="${mid}" y1="${mid + g}" x2="${mid}" y2="${mid + g + sz}" stroke="${c}" stroke-width="2"/>
            <line x1="${mid - g - sz}" y1="${mid}" x2="${mid - g}" y2="${mid}" stroke="${c}" stroke-width="2"/>
            <line x1="${mid + g}" y1="${mid}" x2="${mid + g + sz}" y2="${mid}" stroke="${c}" stroke-width="2"/>
          </svg>`;
        }
      }
    }

    const hpFill = this.root.querySelector("#hud-hp-fill") as HTMLElement | null;
    const arFill = this.root.querySelector("#hud-armor-fill") as HTMLElement | null;
    if (hpFill) hpFill.style.width = `${snap.hp}%`;
    if (arFill) arFill.style.width = `${(snap.armor / 50) * 100}%`;

    const setT = (s: string, v: string) => {
      const e = this.root.querySelector(s);
      if (e && e.textContent !== v) e.textContent = v;
    };
    setT("#hud-hp-val", String(snap.hp));
    setT("#hud-armor-val", String(snap.armor));
    const recovery = snap.spawnProtectionSeconds > 0 && snap.alive
      ? `Spawn protected · ${Math.ceil(snap.spawnProtectionSeconds)}s`
      : snap.healingDelaySeconds === null
        ? ""
        : snap.healingDelaySeconds > 0 ? `Recovery in ${Math.ceil(snap.healingDelaySeconds)}s` : "Recovering health";
    setT("#hud-recovery", recovery);
    this.root.querySelector("#hud-recovery")?.classList.toggle("hidden", !recovery);
    setT("#hud-stance", snap.sliding ? "SLIDING" : snap.crouching ? "CROUCH" : "STAND");
    setT(
      "#hud-lean",
      Math.abs(snap.lean) > 0.2 ? (snap.lean < 0 ? "◀ LEAN L" : "LEAN R ▶") : ""
    );

    const skinName = SKIN_REGISTRY[snap.skinName]?.name ?? snap.skinName;
    setT("#hud-wep-name", snap.weaponName);
    const opticName = snap.opticName ? ATTACHMENT_REGISTRY[snap.opticName]?.shortName ?? snap.opticName : "Iron sights";
    setT("#hud-wep-meta", `[${snap.fireMode}] • ${skinName} • ${opticName} [V]`);
    setT("#hud-ammo-mag", snap.reloading ? "RLD" : String(snap.ammoInMag));
    setT("#hud-ammo-res", ` / ${snap.ammoReserve}`);

    const gSpec = THROWABLE_REGISTRY[snap.throwable];
    const key = (action: CombatAction) => combatKeyLabel(combatKey(this.profile.settings.combatBindings, action));
    if (this.paused) {
      setT("#pause-combat-bindings", `${key("crouch")} crouch or sprint-slide · ${key("reload")} reload · ${key("primary")}/${key("secondary")} weapons · Scroll/${key("swapWeapon")} quick swap`);
      setT("#pause-grenade-bindings", `${key("frag")} frag · ${key("flashbang")} flashbang · ${key("smoke")} smoke · Hold ${key("throwGrenade")} to preview · Right-click to cancel`);
    }
    const stock = snap.throwableStock;
    this.root.querySelector("#hud-grenade-stock")?.classList.toggle("hidden", !stock);
    if (stock) {
      for (const kind of THROWABLE_ORDER) {
        const chip = this.root.querySelector<HTMLElement>(`[data-grenade-stock="${kind}"]`);
        chip?.classList.toggle("selected", snap.throwable === kind && stock[kind] > 0);
        if (chip) chip.style.opacity = stock[kind] > 0 ? "1" : "0.45";
        setT(`[data-grenade-stock="${kind}"] [data-grenade-label]`, `[${key(kind)}] ${THROWABLE_LABELS[kind].name} ×${stock[kind]}`);
      }
    }
    setT(
      "#hud-grenade",
      snap.cookingFusePct > 0
        ? `COOKING FUSE: ${snap.cookingFusePct}%`
        : snap.grenadePreviewing
          ? `Release ${key("throwGrenade")} to throw · Right-click cancels`
          : stock ? `Hold ${key("throwGrenade")} to preview`
            : `[${key("throwGrenade")}] ${gSpec.name} ×${snap.throwablesLeft} · ${THROWABLE_ORDER.map(key).join("/")}`
    );

    let hint = `WASD Move · ${key("primary")}/${key("secondary")} Weapons · Scroll/${key("swapWeapon")} Swap · V Optic · ${key("reload")} Reload · ${key("crouch")} Crouch`;
    if (snap.respawnSeconds !== null) {
      hint = `Respawning in ${Math.max(1, Math.ceil(snap.respawnSeconds))}s${this.room && this.room.mode !== "WARMUP" ? " · L Loadout" : ""}`;
    } else if (!snap.alive) {
      hint = snap.spectatingName ? `Spectating ${snap.spectatingName}` : "Respawning…";
    } else if (this.room?.phase === "COUNTDOWN") {
      hint = "Match starting. Movement unlocks when the countdown ends.";
    } else if (!snap.pointerLocked && !this.paused) {
      hint = "F2 locks mouse aim • Escape releases it";
    }
    setT("#hud-hint", hint);
  }

  showPointerCaptureError(message: string): void {
    const status = this.root.querySelector("#hud-mouse-capture-status");
    if (status) status.textContent = message;
  }

  showHitMarker(tier: HitMarkerTier, damage: number, isWallbang: boolean): void {
    const hm = this.root.querySelector("#hud-hitmarker");
    if (!hm) return;
    const color =
      tier === "KILL"
        ? "#ef4444"
        : tier === "HEADSHOT"
          ? "#f87171"
          : tier === "ARMOR_BREAK"
            ? "#38bdf8"
            : "#ffffff";
    const cross = `
      <svg width="28" height="28">
        <line x1="3" y1="3" x2="10" y2="10" stroke="${color}" stroke-width="2.5"/>
        <line x1="25" y1="3" x2="18" y2="10" stroke="${color}" stroke-width="2.5"/>
        <line x1="3" y1="25" x2="10" y2="18" stroke="${color}" stroke-width="2.5"/>
        <line x1="25" y1="25" x2="18" y2="18" stroke="${color}" stroke-width="2.5"/>
      </svg>
    `;
    const style = this.profile.settings.hitMarkerStyle;
    hm.innerHTML = `
      ${style === "CROSS" ? cross : style === "DOT" ? `<i class="hud-hit-dot" style="background:${color}"></i>` : ""}
      <div style="position:absolute;top:-16px;left:22px;font-size:11px;font-weight:900;color:${color};white-space:nowrap;">
        ${Math.round(damage)}${isWallbang ? " WB" : ""}
      </div>
    `;
    hm.classList.add("show");
    if (this.hitmarkerTimeout) clearTimeout(this.hitmarkerTimeout);
    this.hitmarkerTimeout = setTimeout(() => hm.classList.remove("show"), 160);
  }

  pushKillFeed(msg: Extract<ServerToClientMessage, { type: "KILL_FEED" }>): void {
    const wName = msg.weaponId === "knife" ? "Combat Knife" : WEAPON_REGISTRY[msg.weaponId]?.name ?? msg.weaponId;
    const me = this.profile.callsign;
    const localTeam = this.room?.players.find((p) => p.id === this.localPlayerId)?.team;
    const nameColor = (team: string, name: string): string =>
      name === me ? "#fbbf24" : localTeam ? (team === localTeam ? "#38bdf8" : "#f87171") : team === "A" ? "#38bdf8" : "#f87171";
    const tags = [msg.isHeadshot ? "HS" : "", msg.isWallbang ? "WB" : ""].filter(Boolean).join(" ");
    const html = `
      <span class="kf-name" style="color:${nameColor(msg.killerTeam, msg.killerName)}">${escapeText(msg.killerName)}</span>
      <span class="kf-weapon">${escapeText(wName)}${tags ? ` <b class="kf-tag">${tags}</b>` : ""}</span>
      <span class="kf-name" style="color:${nameColor(msg.victimTeam, msg.victimName)}">${escapeText(msg.victimName)}</span>
    `;
    const involvesMe = msg.killerName === me || msg.victimName === me;
    this.killfeedItems.unshift({ id: Date.now() + Math.random(), html, mine: involvesMe, expiresAt: Date.now() + KILLFEED_LIFETIME_MS });
    if (this.killfeedItems.length > 6) this.killfeedItems.pop();
    this.renderKillFeed();
    if (this.killfeedTimer) clearInterval(this.killfeedTimer);
    this.killfeedTimer = setInterval(() => this.renderKillFeed(), 500);

    const selfKill = msg.killerName === msg.victimName;
    const teamKill = msg.killerTeam === msg.victimTeam && !selfKill;
    if (msg.killerName === me && !selfKill) {
      const multiLabel = ["", "", "DOUBLE KILL", "TRIPLE KILL", "QUAD KILL"][msg.multi] ?? (msg.multi > 4 ? `${msg.multi}x MULTI KILL` : "");
      const details = [wName, msg.distanceM > 0 ? `${msg.distanceM} m` : ""].filter(Boolean).join(" · ");
      const chips = [
        msg.isHeadshot ? `<span class="kb-chip kb-hs">HEADSHOT</span>` : "",
        msg.isWallbang ? `<span class="kb-chip kb-wb">WALLBANG</span>` : "",
        msg.distanceM >= 50 ? `<span class="kb-chip kb-lr">LONG RANGE</span>` : "",
        multiLabel ? `<span class="kb-chip kb-multi">${multiLabel}</span>` : "",
        msg.streak >= 3 && msg.streak % 1 === 0 && msg.multi < 2 ? `<span class="kb-chip kb-streak">${msg.streak} KILL STREAK</span>` : "",
      ].join("");
      this.showKillBanner(
        `<div class="kb-tag-line">${teamKill ? "TEAM KILL" : "ELIMINATED"}</div>
         <div class="kb-name">${escapeText(msg.victimName)}</div>
         <div class="kb-chips">${chips}</div>
         <div class="kb-detail">${escapeText(details)}</div>`,
        msg.isHeadshot ? "headshot" : multiLabel ? "multi" : teamKill ? "team" : "kill",
        2200
      );
    } else if (msg.victimName === me && !selfKill) {
      this.showKillBanner(
        `<div class="kb-tag-line">KILLED BY</div>
         <div class="kb-name">${escapeText(msg.killerName)}</div>
         <div class="kb-detail">${escapeText(wName)} · ${msg.distanceM} m · ${Math.max(0, Math.round(msg.killerHpLeft))} HP left${msg.isHeadshot ? " · HEADSHOT" : ""}</div>`,
        "death",
        2800
      );
    }
  }

  private renderKillFeed(): void {
    const now = Date.now();
    for (let i = this.killfeedItems.length - 1; i >= 0; i--) {
      if (this.killfeedItems[i].expiresAt <= now) this.killfeedItems.splice(i, 1);
    }
    const kf = this.root.querySelector("#hud-killfeed");
    if (kf) {
      kf.innerHTML = this.killfeedItems
        .map((it) => `<div class="killfeed-item${it.mine ? " mine" : ""}${it.expiresAt - now < 700 ? " fading" : ""}">${it.html}</div>`)
        .join("");
    }
    if (!this.killfeedItems.length && this.killfeedTimer) {
      clearInterval(this.killfeedTimer);
      this.killfeedTimer = null;
    }
  }

  private showKillBanner(html: string, kind: "kill" | "headshot" | "multi" | "team" | "death", durationMs: number): void {
    const el = this.root.querySelector("#hud-killbanner") as HTMLElement | null;
    if (!el) return;
    el.className = `killbanner kb-${kind}`;
    el.innerHTML = html;
    // Restart the pop-in animation when kills land back to back.
    void el.offsetWidth;
    el.classList.add("kb-show");
    if (this.killBannerTimeout) clearTimeout(this.killBannerTimeout);
    this.killBannerTimeout = setTimeout(() => el.classList.add("hidden"), durationMs);
  }

  showMatchEnded(msg: Extract<ServerToClientMessage, { type: "MATCH_ENDED" }>): void {
    const local = this.room?.players.find((p) => p.id === this.localPlayerId);
    const title =
      msg.winnerTeam === "DRAW"
        ? "DRAW"
        : local
          ? msg.winnerTeam === local.team ? "VICTORY" : "DEFEAT"
          : `TEAM ${msg.winnerTeam} WINS`;
    const color = msg.winnerTeam === "DRAW" ? "#fbbf24" : local && msg.winnerTeam !== local.team ? "#f87171" : "#4ade80";
    this.showBanner(
      `<div style="font-size:26px;font-weight:900;letter-spacing:2px;color:${color}">${title}</div>
       <div style="font-size:13px;color:var(--text-muted);margin-top:4px;">${escapeText(msg.reason)}</div>`,
      3400
    );
  }

  private formatClock(room: RoomStateBroadcast): string {
    const fmt = (total: number) => `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
    if (room.phase === "WARMUP") return "—";
    if (room.phase === "COUNTDOWN") return String(Math.max(1, room.timeRemainingSec));
    if (room.phase === "MATCH_END") return "END";
    if ((room.matchRules?.timeLimitSeconds ?? 0) === 0) return fmt(room.elapsedSec);
    return fmt(room.timeRemainingSec);
  }

  private describeMatchRules(room: RoomStateBroadcast): string {
    if (room.phase === "WARMUP") {
      return room.mode === "WARMUP" ? "WARM-UP" : room.matchRules?.ranked ? `RANKED · ${room.players.length}/${MODE_CONFIGS[room.mode].maxPlayers}` : "WAITING FOR HOST";
    }
    if (room.phase === "COUNTDOWN") return "MATCH STARTING";
    if (room.phase === "MATCH_END") return "MATCH OVER";
    const rules = room.matchRules;
    const parts: string[] = [rules?.ranked ? "RANKED" : room.mode];
    parts.push(rules && rules.scoreLimit > 0 ? `FIRST TO ${rules.scoreLimit}` : "NO KILL LIMIT");
    if (rules && rules.timeLimitSeconds === 0) parts.push("UNLIMITED TIME");
    return parts.join(" · ");
  }

  showDangerPingNotice(callsign: string | null): void {
    const notice = this.root.querySelector("#hud-ping-notice");
    if (!notice) return;
    notice.textContent = callsign === null ? "Location marked for your team" : `${callsign} marked a location`;
    notice.classList.remove("hidden");
    if (this.pingNoticeTimeout) clearTimeout(this.pingNoticeTimeout);
    this.pingNoticeTimeout = setTimeout(() => notice.classList.add("hidden"), 1800);
  }

  showDamageDirection(relAngleRad: number): void {
    const arc = this.root.querySelector("#hud-damage-arc") as HTMLElement | null;
    if (!arc) return;
    const deg = (relAngleRad * 180) / Math.PI;
    arc.style.transform = `rotate(${deg.toFixed(1)}deg)`;
    arc.classList.remove("hidden");
    for (const a of arc.getAnimations()) a.cancel();
    arc.animate([{ opacity: 1 }, { opacity: 0.92, offset: 0.27 }, { opacity: 0 }], { duration: 650 });
    if (this.damageArcTimeout) clearTimeout(this.damageArcTimeout);
    this.damageArcTimeout = setTimeout(() => arc.classList.add("hidden"), 650);
  }

  showArenaEvent(event: ArenaHudEvent): void {
    if (event.type === "MATCH_RESULTS") {
      const panel = this.root.querySelector("#hud-match-results");
      if (!panel) return;
      const local = event.players.find((player) => player.id === this.localPlayerId);
      const mvp = event.players.find((player) => player.id === event.mvpId);
      panel.innerHTML = `
        <strong>${event.winnerTeam === "DRAW" ? "Draw" : `Team ${event.winnerTeam} wins`}</strong>
        ${mvp ? `<div>MVP · ${escapeText(mvp.callsign)}</div>` : ""}
        <table><thead><tr><th>Player</th><th>K / D</th><th>Accuracy</th><th>Headshot kills</th><th>Streak</th></tr></thead>
        <tbody>${event.players.map((player) => `<tr>
          <td>${escapeText(player.callsign)}</td><td>${player.kills} / ${player.deaths}</td>
          <td>${percentage(player.combatStats.shotsHit, player.combatStats.shots)}%</td>
          <td>${percentage(player.combatStats.headshotKills, player.kills)}%</td>
          <td>${player.combatStats.longestStreak}</td>
        </tr>`).join("")}</tbody></table>
        ${local ? `<div>+${local.xpEarned} XP${local.rating !== undefined ? ` · Rating ${local.rating} (${(local.ratingChange ?? 0) >= 0 ? "+" : ""}${local.ratingChange ?? 0})` : ""}</div>` : ""}
      `;
      panel.classList.remove("hidden");
      return;
    }
    const el = this.root.querySelector("#hud-arena-notice");
    if (!el) return;
    if (event.type === "COMBAT_STREAK") {
      const multikill = ["", "", "Double kill", "Triple kill", "Quad kill"][event.multi] ?? `${event.multi}× multikill`;
      el.textContent = event.multi > 1 ? multikill : `${event.run} kill streak`;
    } else {
      el.textContent = event.kind === "armor" ? "Armor replenished" : "Reserve ammo replenished";
    }
    el.classList.remove("hidden");
    if (this.arenaNoticeTimeout) clearTimeout(this.arenaNoticeTimeout);
    this.arenaNoticeTimeout = setTimeout(() => el.classList.add("hidden"), 2200);
  }

  showDamageBreakdown(bd: DamageBreakdownPayload): void {
    const card = this.root.querySelector("#hud-damage-card");
    if (!card) return;
    const wName = bd.killerWeaponId ? WEAPON_REGISTRY[bd.killerWeaponId]?.name ?? bd.killerWeaponId : "Combat";
    card.innerHTML = `
      <div style="font-size:11px;color:#fca5a5;font-weight:800;letter-spacing:1px;">ELIMINATED BY ${escapeText(bd.killerName ?? "ENEMY")} (${escapeText(wName)} • ${bd.distanceM ?? 0}m)</div>
      <div style="display:flex;justify-content:space-around;margin-top:10px;font-family:var(--font-mono);font-size:13px;">
        <div><span style="color:#4ade80;">DEALT:</span> <strong>${bd.dealtTotal} DMG</strong> (${bd.dealtHits} hits, ${bd.dealtHeadshots} HS)</div>
        <div><span style="color:#f87171;">TAKEN:</span> <strong>${bd.takenTotal} DMG</strong> (${bd.takenHits} hits, ${bd.takenHeadshots} HS)</div>
      </div>
    `;
    card.classList.remove("hidden");
    if (this.damageCardTimeout) clearTimeout(this.damageCardTimeout);
    this.damageCardTimeout = setTimeout(() => card.classList.add("hidden"), 5200);
  }

  private showBanner(html: string, durationMs: number): void {
    const el = this.root.querySelector("#hud-banner");
    if (!el) return;
    el.innerHTML = html;
    el.classList.remove("hidden");
    if (this.bannerTimeout) clearTimeout(this.bannerTimeout);
    this.bannerTimeout = setTimeout(() => el.classList.add("hidden"), durationMs);
  }

  dispose(): void {
    for (const timeout of [this.hitmarkerTimeout, this.bannerTimeout, this.pingNoticeTimeout, this.damageCardTimeout, this.damageArcTimeout, this.arenaNoticeTimeout]) {
      if (timeout !== null) clearTimeout(timeout);
    }
    this.root.remove();
  }
}
