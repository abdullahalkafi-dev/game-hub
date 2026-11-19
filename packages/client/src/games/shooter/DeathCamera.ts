import { lerp, yawPitchToDir, type DeathReplayFrame, type ServerToClientMessage } from "@game/shared";
import { Vector3, type UniversalCamera } from "@babylonjs/core";

export class DeathCamera {
  private recording?: Extract<ServerToClientMessage, { type: "DEATH_REPLAY" }>;
  private cursor = 0;
  private elapsedMs = 0;
  readonly victim = new Vector3();
  private readonly target = new Vector3();
  private readonly aim = { x: 0, y: 0, z: 1 };

  get name(): string | null { return this.recording?.killerName ?? null; }
  get reachedElimination(): boolean {
    const last = this.recording?.frames.at(-1);
    return !!last && this.elapsedMs >= last.timeMs;
  }

  start(recording: Extract<ServerToClientMessage, { type: "DEATH_REPLAY" }>): void {
    if (recording.frames.length < 2) return;
    this.recording = recording;
    this.elapsedMs = 0;
    this.cursor = 0;
  }

  stop(): void { this.recording = undefined; }

  tick(dt: number, camera: UniversalCamera): boolean {
    const frames = this.recording?.frames;
    if (!frames) return false;
    this.elapsedMs += dt * 1000;
    const last = frames.length - 1;
    if (this.elapsedMs > frames[last].timeMs + 200) {
      this.stop();
      return false;
    }
    while (this.cursor < last - 1 && this.elapsedMs >= frames[this.cursor + 1].timeMs) this.cursor++;
    const a: DeathReplayFrame = frames[this.cursor];
    const b: DeathReplayFrame = frames[this.cursor + 1];
    const t = Math.min(1, (this.elapsedMs - a.timeMs) / Math.max(1, b.timeMs - a.timeMs));
    camera.position.set(lerp(a.eye.x, b.eye.x, t), lerp(a.eye.y, b.eye.y, t), lerp(a.eye.z, b.eye.z, t));
    const offset = Math.atan2(Math.sin(b.yaw - a.yaw), Math.cos(b.yaw - a.yaw));
    yawPitchToDir(this.aim, a.yaw + offset * t, lerp(a.pitch, b.pitch, t));
    camera.setTarget(this.target.copyFrom(camera.position).addInPlaceFromFloats(this.aim.x, this.aim.y, this.aim.z));
    camera.rotation.z = 0;
    this.victim.set(lerp(a.victim.x, b.victim.x, t), lerp(a.victim.y, b.victim.y, t), lerp(a.victim.z, b.victim.z, t));
    return true;
  }
}
