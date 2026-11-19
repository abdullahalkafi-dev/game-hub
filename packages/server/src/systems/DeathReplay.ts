import {
  REPLAY_SAMPLE_HZ, REPLAY_SECONDS, RingBuffer, getCameraEyePosition,
  type DeathReplayFrame, type FpsPlayerState, type Vec3,
} from "@game/shared";

interface Subject {
  id: string;
  alive: boolean;
  state: FpsPlayerState;
}

interface Pose {
  position: Vec3;
  eye: Vec3;
  yaw: number;
  pitch: number;
}

export class DeathReplay {
  private readonly history = new RingBuffer<{ at: number; poses: Map<string, Pose> }>(Math.ceil(REPLAY_SECONDS * REPLAY_SAMPLE_HZ) + 1);

  record(at: number, players: Iterable<Subject>): void {
    const poses = new Map<string, Pose>();
    for (const { id, alive, state } of players) {
      if (!alive) continue;
      poses.set(id, { position: { ...state.position }, eye: getCameraEyePosition(state), yaw: state.yaw, pitch: state.pitch });
    }
    this.history.push({ at, poses });
  }

  capture(killer: Subject, victim: Subject): DeathReplayFrame[] {
    const frames: DeathReplayFrame[] = [];
    let startedAt = 0;
    for (let i = 0; i < this.history.length; i++) {
      const frame = this.history.getAt(i);
      const view = frame?.poses.get(killer.id);
      const target = frame?.poses.get(victim.id);
      if (!frame || !view || !target) {
        frames.length = 0;
        continue;
      }
      if (!frames.length) startedAt = frame.at;
      frames.push({ timeMs: frame.at - startedAt, eye: view.eye, yaw: view.yaw, pitch: view.pitch, victim: target.position });
    }
    if (frames.length < 6) return [];
    const last = frames[frames.length - 1];
    frames.push({ timeMs: last.timeMs + 1000 / REPLAY_SAMPLE_HZ, eye: getCameraEyePosition(killer.state),
      yaw: killer.state.yaw, pitch: killer.state.pitch, victim: { ...victim.state.position } });
    return frames;
  }

  clear(): void {
    this.history.clear();
  }
}
