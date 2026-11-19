/** One phase unit is one footfall, and two units complete a left/right stride. */
export function advanceStepPhase(phase: number, distance: number, speed: number, crouching: boolean): number {
  const stepDistance = crouching ? 1.05 : speed > 5.8 ? 1.85 : 1.42;
  return (phase + distance / stepDistance) % 2;
}
