/**
 * Fixed simulation and networking cadence constants shared across client and server.
 */
export const PHYSICS_TICK_HZ = 60;
export const FIXED_DT = 1 / PHYSICS_TICK_HZ;
export const NET_TICK_HZ = 20;
export const NET_TICK_INTERVAL_MS = 1000 / NET_TICK_HZ;
export const INTERPOLATION_DELAY_MS = 100;
export const MAX_ACCUMULATOR_SEC = 0.25;
export const LAG_REWIND_BUFFER_FRAMES = 60; // 1.0s at 60Hz
export const MAX_LAG_REWIND_MS = 400;
