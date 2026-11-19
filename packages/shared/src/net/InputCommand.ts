export const INPUT_FLAG_FORWARD = 1 << 0;
export const INPUT_FLAG_BACK = 1 << 1;
export const INPUT_FLAG_LEFT = 1 << 2;
export const INPUT_FLAG_RIGHT = 1 << 3;
export const INPUT_FLAG_SPRINT = 1 << 4;
export const INPUT_FLAG_CROUCH = 1 << 5;
export const INPUT_FLAG_JUMP = 1 << 6;
export const INPUT_FLAG_LEAN_LEFT = 1 << 7;
export const INPUT_FLAG_LEAN_RIGHT = 1 << 8;
export const INPUT_FLAG_FIRE = 1 << 9;
export const INPUT_FLAG_ADS = 1 << 10;
export const INPUT_FLAG_RELOAD = 1 << 11;
export const INPUT_FLAG_HOLD_BREATH = 1 << 12;
export const INPUT_FLAG_INTERACT = 1 << 13;

export interface InputCommand {
  seq: number;
  flags: number;
  yaw: number;
  pitch: number;
  dt: number;
  activeSlot: 0 | 1;
}

export function createEmptyInputCommand(seq = 0): InputCommand {
  return {
    seq,
    flags: 0,
    yaw: 0,
    pitch: 0,
    dt: 1 / 60,
    activeSlot: 0,
  };
}
