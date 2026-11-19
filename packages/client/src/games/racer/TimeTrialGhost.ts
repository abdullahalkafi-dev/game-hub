import { sanitizeCarSetup, type CarSetupConfig, type TrackId } from "@game/shared";

// Time in milliseconds, followed by position, yaw, pitch and roll.
export type GhostFrame = [number, number, number, number, number, number, number];

export interface TimeTrialGhost {
  lapTimeMs: number;
  setup: CarSetupConfig;
  frames: GhostFrame[];
}

export const GHOST_FRAME_INTERVAL_MS = 100;
const MAX_GHOST_FRAMES = 3602;

function storageKey(guestUuid: string, trackId: TrackId): string {
  return `apexdrive_ghost_v1:${guestUuid}:${trackId}`;
}

export function loadTimeTrialGhost(guestUuid: string, trackId: TrackId): TimeTrialGhost | null {
  try {
    const raw = localStorage.getItem(storageKey(guestUuid, trackId));
    if (!raw) return null;
    const data = JSON.parse(raw) as TimeTrialGhost;
    if (!data || !Number.isFinite(data.lapTimeMs) || data.lapTimeMs <= 0 || !data.setup ||
        !Array.isArray(data.frames) || data.frames.length < 2 || data.frames.length > MAX_GHOST_FRAMES) {
      return null;
    }
    let previousTime = -1;
    for (const frame of data.frames) {
      if (!Array.isArray(frame) || frame.length !== 7 || !frame.every(Number.isFinite) ||
          frame[0] <= previousTime || frame[0] > data.lapTimeMs) return null;
      previousTime = frame[0];
    }
    return { ...data, setup: sanitizeCarSetup(data.setup) };
  } catch {
    return null;
  }
}

export function saveTimeTrialGhost(guestUuid: string, trackId: TrackId, ghost: TimeTrialGhost): void {
  if (ghost.frames.length < 2 || ghost.frames.length > MAX_GHOST_FRAMES) return;
  try {
    localStorage.setItem(storageKey(guestUuid, trackId), JSON.stringify(ghost));
  } catch {
    // The race result can still be shown when browser storage is unavailable.
  }
}
