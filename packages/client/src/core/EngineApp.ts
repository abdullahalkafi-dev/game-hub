import { Engine, Scene, WebGPUEngine } from "@babylonjs/core";

export class EngineApp {
  public readonly canvas: HTMLCanvasElement;
  public engine!: Engine;
  public activeScene: Scene | null = null;
  public rendererBackend: "WebGPU" | "WebGL2" = "WebGL2";
  private resizeHandler: (() => void) | null = null;
  private stableSamples = 0;
  private slowSamples = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  async init(preferWebGpu = false): Promise<void> {
    if (preferWebGpu && typeof navigator !== "undefined" && "gpu" in navigator) {
      try {
        const supported = await WebGPUEngine.IsSupportedAsync;
        if (supported) {
          const webgpu = new WebGPUEngine(this.canvas, {
            antialias: true,
            powerPreference: "high-performance",
          });
          await webgpu.initAsync();
          this.engine = webgpu as unknown as Engine;
          this.rendererBackend = "WebGPU";
        }
      } catch {
        // Fall back to WebGL2 cleanly
      }
    }

    if (!this.engine) {
      this.engine = new Engine(this.canvas, true, {
        preserveDrawingBuffer: false,
        stencil: true,
        powerPreference: "high-performance",
        antialias: true,
      });
      this.rendererBackend = this.engine.webGLVersion >= 2 ? "WebGL2" : "WebGL2";
    }

    this.engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio || 1, 1.5));

    this.resizeHandler = () => {
      this.engine.resize();
    };
    window.addEventListener("resize", this.resizeHandler);
  }

  setScene(scene: Scene): void {
    this.activeScene = scene;
  }

  resetResolution(scale: number): void {
    this.stableSamples = this.slowSamples = 0;
    this.engine.setHardwareScalingLevel(scale);
  }

  adaptResolution(fps: number, presetScale: number): void {
    this.slowSamples = fps < 48 ? this.slowSamples + 1 : 0;
    this.stableSamples = fps >= 59 ? this.stableSamples + 1 : 0;
    const scale = this.engine.getHardwareScalingLevel();
    if (this.slowSamples >= 3 && scale < 2) {
      this.resetResolution(Math.min(2, scale + 0.15));
    } else if (this.stableSamples >= 10 && scale > presetScale) {
      this.resetResolution(Math.max(presetScale, scale - 0.10));
    }
  }

  dispose(): void {
    if (this.resizeHandler) {
      window.removeEventListener("resize", this.resizeHandler);
      this.resizeHandler = null;
    }
    this.activeScene?.dispose();
    this.engine?.dispose();
  }
}
