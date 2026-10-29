/** Accumulates wheel deltas into signed navigation steps. */
export interface WheelStepAccumulator {
  push(delta: number): number;
  reset(): void;
}

export function createWheelStepAccumulator(threshold = 100): WheelStepAccumulator {
  const stepThreshold = Number.isFinite(threshold) && threshold > 0 ? threshold : 100;
  let remainder = 0;

  return {
    push(delta: number): number {
      if (!Number.isFinite(delta) || delta === 0) return 0;
      remainder += delta;
      const steps = remainder > 0
        ? Math.floor(remainder / stepThreshold)
        : Math.ceil(remainder / stepThreshold);
      remainder -= steps * stepThreshold;
      return steps;
    },
    reset(): void {
      remainder = 0;
    },
  };
}
