import {
  LAG_REWIND_BUFFER_FRAMES,
  MAX_LAG_REWIND_MS,
  RingBuffer,
  clamp,
  lerp,
  type PlayerHitboxes,
} from "@game/shared";

export interface WorldHitboxFrame {
  timestampMs: number;
  hitboxes: Map<string, PlayerHitboxes>;
}

/**
 * Maintains a 1-second (60-frame) history of every player's 3-zone hitboxes
 * (including lean & crouch state) so server hitscan rewinds targets to shooter's ping.
 */
export class LagCompensator {
  private readonly history = new RingBuffer<WorldHitboxFrame>(LAG_REWIND_BUFFER_FRAMES);

  recordFrame(timestampMs: number, hitboxes: Map<string, PlayerHitboxes>): void {
    const cloned = new Map<string, PlayerHitboxes>();
    for (const [id, hb] of hitboxes.entries()) {
      cloned.set(id, {
        playerId: hb.playerId,
        headCenter: { ...hb.headCenter },
        headRadius: hb.headRadius,
        chestMin: { ...hb.chestMin },
        chestMax: { ...hb.chestMax },
        limbMin: { ...hb.limbMin },
        limbMax: { ...hb.limbMax },
      });
    }
    this.history.push({ timestampMs, hitboxes: cloned });
  }

  getRewoundHitboxes(
    targetPlayerId: string,
    rewindMs: number,
    nowMs: number
  ): PlayerHitboxes | null {
    const len = this.history.length;
    if (len === 0) return null;

    const clampedRewind = clamp(rewindMs, 0, MAX_LAG_REWIND_MS);
    const targetTime = nowMs - clampedRewind;

    // Walk backwards from newest frame to find bracketing pair
    let newer: WorldHitboxFrame | undefined;
    let older: WorldHitboxFrame | undefined;

    for (let i = len - 1; i >= 0; i--) {
      const frame = this.history.getAt(i);
      if (!frame) continue;
      if (frame.timestampMs <= targetTime) {
        older = frame;
        newer = i + 1 < len ? this.history.getAt(i + 1) : undefined;
        break;
      }
      newer = frame;
    }

    if (!older && newer) {
      return newer.hitboxes.get(targetPlayerId) ?? null;
    }
    if (older && !newer) {
      return older.hitboxes.get(targetPlayerId) ?? null;
    }
    if (!older || !newer) return null;

    const hbOld = older.hitboxes.get(targetPlayerId);
    const hbNew = newer.hitboxes.get(targetPlayerId);
    if (!hbOld) return hbNew ?? null;
    if (!hbNew) return hbOld;

    const span = newer.timestampMs - older.timestampMs;
    const t = span > 0.001 ? clamp((targetTime - older.timestampMs) / span, 0, 1) : 0;

    return {
      playerId: targetPlayerId,
      headRadius: hbNew.headRadius,
      headCenter: {
        x: lerp(hbOld.headCenter.x, hbNew.headCenter.x, t),
        y: lerp(hbOld.headCenter.y, hbNew.headCenter.y, t),
        z: lerp(hbOld.headCenter.z, hbNew.headCenter.z, t),
      },
      chestMin: {
        x: lerp(hbOld.chestMin.x, hbNew.chestMin.x, t),
        y: lerp(hbOld.chestMin.y, hbNew.chestMin.y, t),
        z: lerp(hbOld.chestMin.z, hbNew.chestMin.z, t),
      },
      chestMax: {
        x: lerp(hbOld.chestMax.x, hbNew.chestMax.x, t),
        y: lerp(hbOld.chestMax.y, hbNew.chestMax.y, t),
        z: lerp(hbOld.chestMax.z, hbNew.chestMax.z, t),
      },
      limbMin: {
        x: lerp(hbOld.limbMin.x, hbNew.limbMin.x, t),
        y: lerp(hbOld.limbMin.y, hbNew.limbMin.y, t),
        z: lerp(hbOld.limbMin.z, hbNew.limbMin.z, t),
      },
      limbMax: {
        x: lerp(hbOld.limbMax.x, hbNew.limbMax.x, t),
        y: lerp(hbOld.limbMax.y, hbNew.limbMax.y, t),
        z: lerp(hbOld.limbMax.z, hbNew.limbMax.z, t),
      },
    };
  }

  clear(): void {
    this.history.clear();
  }
}
