import {
  COMBAT_CONTROLS,
  canBindCombatKey,
  combatKey,
  combatKeyLabel,
  convertSensitivityFromGame,
  saveGuestProfile,
  type CrosshairStyle,
  type CombatAction,
  type GraphicsQuality,
  type HitMarkerStyle,
  type GuestProfile,
  type SensitivitySourceGame,
} from "../state/UserProfileStore.js";
import type { BotDifficulty } from "@game/shared";

export class SettingsModal {
  private readonly backdrop: HTMLDivElement;
  private opener: HTMLElement | null = null;
  private roomBots: { difficulty: BotDifficulty; canChange: boolean } | undefined;

  constructor(
    parent: HTMLElement,
    private readonly profile: GuestProfile,
    private readonly onChanged: () => void,
    private readonly onRoomDifficultyChanged: (difficulty: BotDifficulty) => void
  ) {
    this.backdrop = document.createElement("div");
    this.backdrop.className = "modal-backdrop interactive hidden";
    this.backdrop.setAttribute("role", "dialog");
    this.backdrop.setAttribute("aria-label", "Settings");
    this.backdrop.setAttribute("aria-modal", "true");
    this.backdrop.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      this.close();
    });
    parent.appendChild(this.backdrop);
  }

  open(roomBots?: { difficulty: BotDifficulty; canChange: boolean }): void {
    if (!this.backdrop.classList.contains("hidden")) return;
    this.roomBots = roomBots;
    this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.render();
    this.backdrop.classList.remove("hidden");
    this.backdrop.querySelector<HTMLElement>("#set-close")?.focus({ preventScroll: true });
  }

  close(): void {
    this.backdrop.classList.add("hidden");
    if (this.opener?.isConnected) this.opener.focus({ preventScroll: true });
    this.opener = null;
  }

  private renderCrosshairPreviewSvg(): string {
    const s = this.profile.settings;
    const c = s.crosshairColor;
    const sz = s.crosshairSize;
    const gap = s.crosshairGap;
    const cx = 36;
    const cy = 36;
    if (s.crosshairStyle === "STATIC_DOT") {
      return `<svg width="72" height="72"><circle cx="${cx}" cy="${cy}" r="${Math.max(2, sz * 0.35)}" fill="${c}"/></svg>`;
    }
    if (s.crosshairStyle === "CIRCLE_CROSS") {
      return `<svg width="72" height="72">
        <circle cx="${cx}" cy="${cy}" r="${gap + sz * 0.7}" fill="none" stroke="${c}" stroke-width="1.5"/>
        <circle cx="${cx}" cy="${cy}" r="1.8" fill="${c}"/>
        <line x1="${cx - gap - sz}" y1="${cy}" x2="${cx - gap}" y2="${cy}" stroke="${c}" stroke-width="2"/>
        <line x1="${cx + gap}" y1="${cy}" x2="${cx + gap + sz}" y2="${cy}" stroke="${c}" stroke-width="2"/>
      </svg>`;
    }
    const topLine =
      s.crosshairStyle === "CLASSIC_T"
        ? ""
        : `<line x1="${cx}" y1="${cy - gap - sz}" x2="${cx}" y2="${cy - gap}" stroke="${c}" stroke-width="2"/>`;
    return `<svg width="72" height="72">
      ${topLine}
      <line x1="${cx}" y1="${cy + gap}" x2="${cx}" y2="${cy + gap + sz}" stroke="${c}" stroke-width="2"/>
      <line x1="${cx - gap - sz}" y1="${cy}" x2="${cx - gap}" y2="${cy}" stroke="${c}" stroke-width="2"/>
      <line x1="${cx + gap}" y1="${cy}" x2="${cx + gap + sz}" y2="${cy}" stroke="${c}" stroke-width="2"/>
    </svg>`;
  }

  private render(): void {
    const s = this.profile.settings;
    const styles: { id: CrosshairStyle; label: string }[] = [
      { id: "DYNAMIC_CROSS", label: "Dynamic Cross" },
      { id: "STATIC_DOT", label: "Static Dot" },
      { id: "CIRCLE_CROSS", label: "Circle Cross" },
      { id: "CLASSIC_T", label: "Classic T" },
    ];
    const colors = ["#22d3ee", "#4ade80", "#ef4444", "#facc15", "#ffffff"];
    const qualities: GraphicsQuality[] = ["LOW", "MEDIUM", "HIGH", "ULTRA"];
    const diffs: BotDifficulty[] = ["EASY", "NORMAL", "PRO"];
    const actions = Object.keys(COMBAT_CONTROLS) as CombatAction[];

    this.backdrop.innerHTML = `
      <div class="modal-card">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div>
            <div style="font-size:18px;font-weight:900;">PRO COMPETITIVE SETTINGS</div>
            <div style="font-size:12px;color:var(--text-muted);">Saved automatically to Guest Profile</div>
          </div>
          <button class="btn btn-secondary" id="set-close">Close</button>
        </div>

        <div class="settings-grid">
          <div class="select-card" style="cursor:default;">
            <div class="select-card-title"><span>Field of View (FOV)</span><span id="fov-val">${s.fov}°</span></div>
            <input id="set-fov" type="range" min="80" max="110" step="1" value="${s.fov}" style="width:100%;margin-top:8px;">
          </div>

          <div class="select-card" style="cursor:default;">
            <div class="select-card-title"><span>Master Audio + HRTF 3D</span><span id="vol-val">${Math.round(s.masterVolume * 100)}%</span></div>
            <input id="set-vol" type="range" min="0" max="100" step="5" value="${Math.round(s.masterVolume * 100)}" style="width:100%;margin-top:8px;">
            <label style="display:flex;align-items:center;gap:6px;font-size:11px;margin-top:6px;color:var(--text-muted);">
              <input id="set-hrtf" type="checkbox" ${s.hrtfEnabled ? "checked" : ""}> Enable HRTF Binaural 3D Audio
            </label>
          </div>

          <div class="select-card" style="cursor:default;">
            <label class="select-card-title" for="set-gunfire">Gunfire <span id="gunfire-val">${Math.round(s.gunfireVolume * 100)}%</span></label>
            <input id="set-gunfire" type="range" min="0" max="100" step="5" value="${Math.round(s.gunfireVolume * 100)}" style="width:100%;margin-top:8px;">
            <div class="select-card-desc">Controls shots without turning down footsteps.</div>
          </div>

          <div class="select-card" style="cursor:default;">
            <label class="select-card-title" for="set-hit-feedback">Hit feedback <span id="hit-feedback-val">${Math.round(s.hitFeedbackVolume * 100)}%</span></label>
            <input id="set-hit-feedback" type="range" min="0" max="100" step="5" value="${Math.round(s.hitFeedbackVolume * 100)}" style="width:100%;margin-top:8px;">
            <label><input id="set-headshot-announcer" type="checkbox" ${s.headshotAnnouncer ? "checked" : ""}> Spoken headshot callout</label>
          </div>

          <div class="select-card" style="cursor:default;">
            <div class="select-card-title"><span>Hip-Fire Sensitivity</span><span id="hip-val">${s.hipSens.toFixed(2)}</span></div>
            <input id="set-hip" type="range" min="0.1" max="4.0" step="0.05" value="${s.hipSens}" style="width:100%;margin-top:8px;">
            <label style="display:flex;align-items:center;gap:6px;font-size:11px;margin-top:6px;color:var(--text-muted);">
              <input id="set-raw" type="checkbox" ${s.rawMouseInput ? "checked" : ""}> Raw Mouse Input (Bypass OS Accel)
            </label>
          </div>

          <div class="select-card" style="cursor:default;">
            <div class="select-card-title"><span>ADS Sensitivity Multiplier</span><span id="ads-val">${s.adsSensMult.toFixed(2)}x</span></div>
            <input id="set-ads" type="range" min="0.25" max="1.5" step="0.05" value="${s.adsSensMult}" style="width:100%;margin-top:8px;">
          </div>

          <div class="select-card" style="cursor:default;">
            <div class="panel-title" style="margin-bottom:6px;">Graphics Quality Preset</div>
            <div class="chip-row">
              ${qualities.map((q) => `<button class="chip ${s.graphicsQuality === q ? "selected" : ""}" data-gfx="${q}">${q}</button>`).join("")}
            </div>
          </div>

          <div class="select-card" style="cursor:default;">
            <div class="panel-title" style="margin-bottom:6px;">Movement</div>
            <label>
              <input id="set-toggle-crouch" type="checkbox" ${s.toggleCrouch ? "checked" : ""}> Toggle crouch
            </label>
            <div class="select-card-desc">Tap your crouch key to crouch and stand. Leave off to hold the key.</div>
          </div>

          <div class="select-card" style="cursor:default;">
            <div class="panel-title" style="margin-bottom:6px;">AI Bot Difficulty</div>
            <div class="chip-row">
              ${diffs.map((d) => `<button class="chip ${(this.roomBots?.difficulty ?? s.botDifficulty) === d ? "selected" : ""}" data-bot-diff="${d}" ${this.roomBots?.canChange === false ? "disabled" : ""}>${d}</button>`).join("")}
            </div>
            <div class="select-card-desc">${this.roomBots ? this.roomBots.canChange ? "Applies to bots in this room." : "The room host sets bot difficulty." : "Applies when finding or creating a room."}</div>
          </div>
        </div>

        <div class="select-card" style="cursor:default;">
          <div class="panel-title">Hit-marker style</div>
          <div class="chip-row" style="margin-top:8px;">
            ${(["CROSS", "DOT", "MINIMAL"] as const).map((style) => `<button class="chip ${s.hitMarkerStyle === style ? "selected" : ""}" data-hit-style="${style}">${style}</button>`).join("")}
          </div>
        </div>
        <div class="select-card" style="cursor:default;">
          <div class="panel-title">Combat keys</div>
          <div class="chip-row" style="margin-top:8px;gap:6px;">
            ${actions.map((action) => `<button type="button" class="chip" data-combat-key="${action}"></button>`).join("")}
          </div>
          <div class="code-row" style="margin-top:8px;">
            <button type="button" class="btn btn-secondary" id="set-reset-keys">Reset keys</button>
            <span class="select-card-desc" id="set-key-status" role="status"></span>
          </div>
        </div>

        <div class="select-card" style="cursor:default;">
          <div class="panel-title">1-Click Sensitivity Converter</div>
          <div class="code-row" style="margin-top:8px;">
            <select id="conv-game" class="text-input" style="max-width:150px;text-transform:none;">
              <option value="VALORANT">Valorant</option>
              <option value="CS2">CS2 / CS:GO</option>
              <option value="COD">Call of Duty</option>
            </select>
            <input id="conv-val" class="text-input" type="number" step="0.05" value="0.35" style="max-width:120px;">
            <button class="btn btn-primary" id="conv-apply">Convert & Apply</button>
          </div>
        </div>

        <div class="select-card" style="cursor:default;">
          <div class="panel-title" style="margin-bottom:8px;">Custom Crosshair Builder</div>
          <div style="display:flex;gap:16px;align-items:center;">
            <div id="crosshair-preview" style="background:#090d16;border:1px solid var(--border-subtle);border-radius:10px;padding:6px;">
              ${this.renderCrosshairPreviewSvg()}
            </div>
            <div style="flex:1;display:flex;flex-direction:column;gap:8px;">
              <div class="chip-row">
                ${styles.map((st) => `<button class="chip ${s.crosshairStyle === st.id ? "selected" : ""}" data-ch-style="${st.id}">${st.label}</button>`).join("")}
              </div>
              <div class="chip-row">
                ${colors.map((col) => `<button class="skin-swatch ${s.crosshairColor === col ? "selected" : ""}" data-ch-color="${col}"><span class="swatch-dot" style="background:${col};"></span></button>`).join("")}
              </div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:11px;color:var(--text-muted);">
                <label><span id="ch-size-val">Size (${s.crosshairSize}px)</span> <input id="ch-size" type="range" min="3" max="16" value="${s.crosshairSize}" style="width:100%;"></label>
                <label><span id="ch-gap-val">Gap (${s.crosshairGap}px)</span> <input id="ch-gap" type="range" min="1" max="12" value="${s.crosshairGap}" style="width:100%;"></label>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    this.backdrop.querySelector("#set-close")?.addEventListener("click", () => this.close());
    this.backdrop.querySelector("#set-fov")?.addEventListener("input", (e) => {
      s.fov = Number((e.target as HTMLInputElement).value);
      const lbl = this.backdrop.querySelector("#fov-val");
      if (lbl) lbl.textContent = `${s.fov}°`;
      this.commit();
    });
    for (const [id, key] of [["gunfire", "gunfireVolume"], ["hit-feedback", "hitFeedbackVolume"]] as const) {
      this.backdrop.querySelector<HTMLInputElement>(`#set-${id}`)?.addEventListener("input", (event) => {
        const value = Number((event.currentTarget as HTMLInputElement).value);
        s[key] = value / 100;
        const label = this.backdrop.querySelector(`#${id}-val`);
        if (label) label.textContent = `${value}%`;
        this.commit();
      });
    }
    this.backdrop.querySelector<HTMLInputElement>("#set-headshot-announcer")?.addEventListener("change", (event) => {
      s.headshotAnnouncer = (event.currentTarget as HTMLInputElement).checked;
      this.commit();
    });
    this.backdrop.querySelector("#set-vol")?.addEventListener("input", (e) => {
      s.masterVolume = Number((e.target as HTMLInputElement).value) / 100;
      const lbl = this.backdrop.querySelector("#vol-val");
      if (lbl) lbl.textContent = `${Math.round(s.masterVolume * 100)}%`;
      this.commit();
    });
    this.backdrop.querySelector("#set-hrtf")?.addEventListener("change", (e) => {
      s.hrtfEnabled = (e.target as HTMLInputElement).checked;
      this.commit();
    });
    this.backdrop.querySelector("#set-hip")?.addEventListener("input", (e) => {
      s.hipSens = Number((e.target as HTMLInputElement).value);
      const lbl = this.backdrop.querySelector("#hip-val");
      if (lbl) lbl.textContent = s.hipSens.toFixed(2);
      this.commit();
    });
    this.backdrop.querySelector("#set-raw")?.addEventListener("change", (e) => {
      s.rawMouseInput = (e.target as HTMLInputElement).checked;
      this.commit();
    });
    this.backdrop.querySelector("#set-ads")?.addEventListener("input", (e) => {
      s.adsSensMult = Number((e.target as HTMLInputElement).value);
      const lbl = this.backdrop.querySelector("#ads-val");
      if (lbl) lbl.textContent = `${s.adsSensMult.toFixed(2)}x`;
      this.commit();
    });

    this.backdrop.querySelector("#conv-apply")?.addEventListener("click", () => {
      const game = (this.backdrop.querySelector("#conv-game") as HTMLSelectElement).value as SensitivitySourceGame;
      const input = this.backdrop.querySelector<HTMLInputElement>("#conv-val");
      const val = input?.valueAsNumber ?? NaN;
      if (!Number.isFinite(val) || val <= 0) {
        input?.setCustomValidity("Enter a positive sensitivity.");
        input?.reportValidity();
        return;
      }
      s.hipSens = Math.max(0.1, Math.min(4, convertSensitivityFromGame(game, val)));
      const range = this.backdrop.querySelector<HTMLInputElement>("#set-hip");
      if (range) range.value = String(s.hipSens);
      const label = this.backdrop.querySelector("#hip-val");
      if (label) label.textContent = s.hipSens.toFixed(2);
      this.commit();
    });
    this.backdrop.querySelector<HTMLInputElement>("#conv-val")?.addEventListener("input", (event) => {
      (event.currentTarget as HTMLInputElement).setCustomValidity("");
    });

    this.backdrop.querySelectorAll<HTMLElement>("[data-ch-style]").forEach((btn) => {
      btn.addEventListener("click", () => {
        s.crosshairStyle = btn.dataset.chStyle as CrosshairStyle;
        this.commit();
        this.markSelected("[data-ch-style]", btn);
        this.updateCrosshairPreview();
      });
    });
    this.backdrop.querySelectorAll<HTMLElement>("[data-ch-color]").forEach((btn) => {
      btn.addEventListener("click", () => {
        s.crosshairColor = btn.dataset.chColor!;
        this.commit();
        this.markSelected("[data-ch-color]", btn);
        this.updateCrosshairPreview();
      });
    });
    this.backdrop.querySelector("#ch-size")?.addEventListener("input", (e) => {
      s.crosshairSize = Number((e.target as HTMLInputElement).value);
      this.commit();
      this.updateCrosshairPreview();
    });
    this.backdrop.querySelector("#ch-gap")?.addEventListener("input", (e) => {
      s.crosshairGap = Number((e.target as HTMLInputElement).value);
      this.commit();
      this.updateCrosshairPreview();
    });
    this.backdrop.querySelectorAll<HTMLElement>("[data-gfx]").forEach((btn) => {
      btn.addEventListener("click", () => {
        s.graphicsQuality = btn.dataset.gfx as GraphicsQuality;
        this.commit();
        this.markSelected("[data-gfx]", btn);
      });
    });
    this.backdrop.querySelector<HTMLInputElement>("#set-toggle-crouch")?.addEventListener("change", (event) => {
      s.toggleCrouch = (event.currentTarget as HTMLInputElement).checked;
      this.commit();
    });
    this.backdrop.querySelectorAll<HTMLButtonElement>("[data-bot-diff]").forEach((btn) => {
      btn.addEventListener("click", () => {
        s.botDifficulty = btn.dataset.botDiff as BotDifficulty;
        if (this.roomBots?.canChange) this.onRoomDifficultyChanged(s.botDifficulty);
        this.commit();
        this.markSelected("[data-bot-diff]", btn);
      });
    });
    this.bindCombatKeys(actions);
    this.backdrop.querySelectorAll<HTMLButtonElement>("[data-hit-style]").forEach((button) => {
      button.addEventListener("click", () => {
        s.hitMarkerStyle = button.dataset.hitStyle as HitMarkerStyle;
        this.commit();
        this.markSelected("[data-hit-style]", button);
      });
    });
  }

  private bindCombatKeys(actions: CombatAction[]): void {
    const settings = this.profile.settings;
    const buttons = this.backdrop.querySelectorAll<HTMLButtonElement>("[data-combat-key]");
    const status = this.backdrop.querySelector("#set-key-status");
    let editing: CombatAction | null = null;
    const refresh = () => {
      for (const button of buttons) {
        const action = button.dataset.combatKey as CombatAction;
        const label = COMBAT_CONTROLS[action].label;
        button.textContent = label + (editing === action ? " · Press a key" : " · " + combatKeyLabel(combatKey(settings.combatBindings, action)));
        button.setAttribute("aria-pressed", String(editing === action));
      }
    };
    for (const button of buttons) {
      const action = button.dataset.combatKey as CombatAction;
      button.addEventListener("click", () => {
        editing = action;
        if (status) status.textContent = "Escape cancels.";
        refresh();
      });
      button.addEventListener("blur", () => {
        if (editing !== action) return;
        editing = null;
        if (status) status.textContent = "";
        refresh();
      });
      button.addEventListener("keydown", (event) => {
        if (editing !== action || event.code === "Tab") return;
        event.preventDefault();
        event.stopPropagation();
        if (event.code === "Escape") {
          editing = null;
          if (status) status.textContent = "";
        } else if (!canBindCombatKey(event.code) || event.ctrlKey || event.altKey || event.metaKey) {
          if (status) status.textContent = "Choose an available letter, number, or punctuation key.";
        } else {
          const conflict = actions.find((other) => other !== action && combatKey(settings.combatBindings, other) === event.code);
          if (conflict) {
            if (status) status.textContent = `That key is assigned to ${COMBAT_CONTROLS[conflict].label.toLowerCase()}.`;
          } else {
            settings.combatBindings = { ...settings.combatBindings, [action]: event.code };
            editing = null;
            this.commit();
            if (status) status.textContent = "Binding saved.";
          }
        }
        refresh();
      });
    }
    this.backdrop.querySelector("#set-reset-keys")?.addEventListener("click", () => {
      editing = null;
      settings.combatBindings = {};
      this.commit();
      if (status) status.textContent = "Default controls restored.";
      refresh();
    });
    refresh();
  }

  private markSelected(selector: string, selected: HTMLElement): void {
    for (const button of this.backdrop.querySelectorAll(selector)) {
      button.classList.toggle("selected", button === selected);
    }
  }

  private updateCrosshairPreview(): void {
    const preview = this.backdrop.querySelector("#crosshair-preview");
    if (preview) preview.innerHTML = this.renderCrosshairPreviewSvg();
    const size = this.backdrop.querySelector("#ch-size-val");
    if (size) size.textContent = `Size (${this.profile.settings.crosshairSize}px)`;
    const gap = this.backdrop.querySelector("#ch-gap-val");
    if (gap) gap.textContent = `Gap (${this.profile.settings.crosshairGap}px)`;
  }

  private commit(): void {
    saveGuestProfile(this.profile);
    this.onChanged();
  }

  dispose(): void {
    this.backdrop.remove();
  }
}
