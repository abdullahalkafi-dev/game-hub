// Button indices in the browser's Standard Gamepad layout.
export const RACE_PAD = {
  throttle: { index: 7, label: "RT / R2" },
  brake: { index: 6, label: "LT / L2" },
  accelerateButton: { index: 0, label: "A / Cross" },
  brakeButton: { index: 2, label: "X / Square" },
  drift: { index: 4, label: "LB / L1" },
  driftButton: { index: 1, label: "B / Circle" },
  nitro: { index: 5, label: "RB / R1" },
  camera: { index: 3, label: "Y / Triangle" },
  rearLeft: { index: 10, label: "L3" },
  rearRight: { index: 11, label: "R3" },
  shiftUp: { index: 12, label: "D-pad Up" },
  shiftDown: { index: 13, label: "D-pad Down" },
  standings: { index: 14, label: "D-pad Left" },
  reset: { index: 8, label: "Back / Share" },
  menu: { index: 9, label: "Start / Options" },
} as const;

export const RACE_TOUCH_CONTROLS = [
  { id: "camera", label: "Change camera", display: "Cam" },
  { id: "reset", label: "Reset car on track", display: "Reset" },
  { id: "left", label: "Steer left", display: "◀" },
  { id: "right", label: "Steer right", display: "▶" },
  { id: "brake", label: "Brake or reverse", display: "Brake" },
  { id: "throttle", label: "Accelerate", display: "Gas" },
  { id: "drift", label: "Handbrake", display: "Drift" },
  { id: "nitro", label: "Nitro boost", display: "Nitro" },
  { id: "shiftDown", label: "Shift down", display: "− Gear" },
  { id: "shiftUp", label: "Shift up", display: "+ Gear" },
] as const;

export type RaceTouchControl = (typeof RACE_TOUCH_CONTROLS)[number]["id"];
