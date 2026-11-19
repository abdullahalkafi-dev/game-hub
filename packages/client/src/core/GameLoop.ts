import { FIXED_DT, MAX_ACCUMULATOR_SEC } from "@game/shared";

export interface LoopCallbacks {
  onFixedStep: (dt: number) => void;
  onRenderFrame: (alpha: number, rawDt: number) => void;
  onFpsSample?: (fps: number) => void;
}

/**
 * Fixed 60Hz Physics Accumulator decoupled from monitor refresh rate (60Hz-240Hz).
 * Supplies interpolation alpha [0..1] to smoothly render transforms at native display Hz.
 */
export class GameLoop {
  private running = false;
  private rafId = 0;
  private lastTimeMs = 0;
  private accumulator = 0;
  private fpsFrames = 0;
  private fpsTimerMs = 0;
  private _currentFps = 60;

  constructor(private readonly callbacks: LoopCallbacks) {}

  get currentFps(): number {
    return this._currentFps;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTimeMs = performance.now();
    this.accumulator = 0;
    this.fpsFrames = 0;
    this.fpsTimerMs = 0;
    const frame = (nowMs: number) => {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(frame);

      const rawDt = Math.max(0, (nowMs - this.lastTimeMs) / 1000);
      this.lastTimeMs = nowMs;

      this.fpsFrames++;
      this.fpsTimerMs += rawDt * 1000;
      if (this.fpsTimerMs >= 500) {
        this._currentFps = Math.round((this.fpsFrames * 1000) / this.fpsTimerMs);
        this.callbacks.onFpsSample?.(this._currentFps);
        this.fpsFrames = 0;
        this.fpsTimerMs = 0;
      }

      this.accumulator = Math.min(this.accumulator + rawDt, MAX_ACCUMULATOR_SEC);

      let steps = 0;
      while (this.accumulator >= FIXED_DT && steps < 6) {
        this.callbacks.onFixedStep(FIXED_DT);
        this.accumulator -= FIXED_DT;
        steps++;
      }

      const alpha = Math.min(1, this.accumulator / FIXED_DT);
      this.callbacks.onRenderFrame(alpha, Math.min(rawDt, MAX_ACCUMULATOR_SEC));
    };
    this.rafId = requestAnimationFrame(frame);
  }

  stop(): void {
    this.running = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }
}
