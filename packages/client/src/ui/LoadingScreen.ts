import { MAP_REGISTRY } from "@game/shared";
import type { LoadStage } from "../core/AssetManager.js";

export class LoadingScreen {
  private readonly root: HTMLDivElement;

  constructor(parent: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "loading-overlay interactive hidden";
    parent.appendChild(this.root);
  }

  show(mapId: string, roomCode: string): void {
    const map = MAP_REGISTRY[mapId] ?? MAP_REGISTRY.cargo_docks;
    this.root.innerHTML = `
      <div class="loading-box">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div>
            <div style="font-size:11px;color:var(--accent-cyan);font-weight:800;letter-spacing:1.5px;">DEPLOYING TO ARENA // ROOM ${roomCode}</div>
            <div style="font-size:24px;font-weight:900;margin-top:2px;">${map.name}</div>
          </div>
          <div id="load-pct" style="font-family:var(--font-mono);font-size:24px;font-weight:900;color:var(--accent-cyan);">10%</div>
        </div>
        <div style="font-size:13px;color:var(--text-muted);">${map.subtitle}</div>
        <div class="progress-track"><div class="progress-bar" id="load-bar" style="width:10%;"></div></div>
        <div id="load-detail" style="font-size:12px;color:#e2e8f0;font-family:var(--font-mono);">Initializing asset pipeline...</div>
        <div class="stage-list">
          <div class="stage-pill active" id="st-cache">1. Arena assets</div>
          <div class="stage-pill" id="st-pools">2. Rapier & Pools</div>
          <div class="stage-pill" id="st-shaders">3. GPU Shader Warm-Up</div>
        </div>
      </div>
    `;
    this.root.classList.remove("hidden");
  }

  update(stage: LoadStage, pct: number, detail: string): void {
    const bar = this.root.querySelector("#load-bar") as HTMLElement | null;
    const pctEl = this.root.querySelector("#load-pct") as HTMLElement | null;
    const detEl = this.root.querySelector("#load-detail") as HTMLElement | null;
    if (bar) bar.style.width = `${pct}%`;
    if (pctEl) pctEl.textContent = `${pct}%`;
    if (detEl) detEl.textContent = detail;

    const c = this.root.querySelector("#st-cache");
    const p = this.root.querySelector("#st-pools");
    const s = this.root.querySelector("#st-shaders");

    if (stage === "CACHE") {
      c?.classList.add("active");
    } else if (stage === "POOLS") {
      c?.classList.remove("active");
      c?.classList.add("done");
      p?.classList.add("active");
    } else if (stage === "SHADERS") {
      c?.classList.add("done");
      p?.classList.remove("active");
      p?.classList.add("done");
      s?.classList.add("active");
    } else if (stage === "READY") {
      c?.classList.add("done");
      p?.classList.add("done");
      s?.classList.remove("active");
      s?.classList.add("done");
    }
  }

  hide(): void {
    this.root.classList.add("hidden");
  }

  dispose(): void {
    this.root.remove();
  }
}
