/**
 * TASK-0208 Phase 2 (PR-c) — energy-flow predicate for fleet-gated sessions.
 *
 * Pure function. Given two meter samples (prev, curr) returns whether the
 * delivery is currently "flowing" along with the raw delta values.
 *
 * Thresholds (any one ⇒ flowing):
 *   A. Instantaneous power ≥ 50 W, measured as (deltaWh / deltaHours).
 *      Requires a positive time delta.
 *   B. Delta energy ≥ 10 Wh over ≤ 60 s. Short-interval safety net for
 *      chargers that stream MeterValues every few seconds — power math can
 *      be noisy on sub-second deltas, so a small Wh delta in a short window
 *      is a reliable positive signal.
 *   C. Fallback: delta energy ≥ 50 Wh regardless of interval. Covers
 *      infrequent MeterValue frames where instantaneous power would be
 *      badly underestimated by long deltaHours, but real energy clearly
 *      moved.
 *
 * Non-flow cases return flowing=false but still report the deltas so
 * callers can log / persist. Negative deltas (meter regression, clock
 * skew) always return flowing=false.
 *
 * Observation-only in Phase 2: no decisions about SetChargingProfile are
 * made here. Scheduler (PR-d) will consume flowing transitions.
 */

export interface EnergyFlowInput {
  prevWh: number;
  prevTsMs: number;
  currWh: number;
  currTsMs: number;
}

export interface EnergyFlowResult {
  flowing: boolean;
  /** currWh - prevWh. May be negative; caller decides what to do. */
  deltaWh: number;
  /**
   * Inferred instantaneous power in watts. null if the time delta is
   * non-positive (same timestamp or clock went backwards).
   */
  deltaW: number | null;
  /** currTsMs - prevTsMs in milliseconds. */
  deltaMs: number;
}

/** Minimum instantaneous power (W) to declare flow. */
export const FLOW_THRESHOLD_W = 50;
/** Short-window small-delta threshold (Wh). */
export const FLOW_SHORT_WINDOW_WH = 10;
/** Short-window max duration (ms). */
export const FLOW_SHORT_WINDOW_MS = 60_000;
/** Any-window fallback threshold (Wh). */
export const FLOW_FALLBACK_WH = 50;

export function evaluateEnergyFlow(input: EnergyFlowInput): EnergyFlowResult {
  const deltaWh = input.currWh - input.prevWh;
  const deltaMs = input.currTsMs - input.prevTsMs;

  let deltaW: number | null = null;
  if (deltaMs > 0) {
    const deltaHours = deltaMs / 3_600_000;
    deltaW = deltaWh / deltaHours;
  }

  // Negative / zero deltas → not flowing, regardless of thresholds.
  if (deltaWh <= 0) {
    return { flowing: false, deltaWh, deltaW, deltaMs };
  }

  // Rule A: instantaneous power ≥ 50 W (requires positive time delta).
  if (deltaW != null && deltaW >= FLOW_THRESHOLD_W) {
    return { flowing: true, deltaWh, deltaW, deltaMs };
  }

  // Rule B: ≥ 10 Wh over ≤ 60 s window.
  if (deltaMs > 0 && deltaMs <= FLOW_SHORT_WINDOW_MS && deltaWh >= FLOW_SHORT_WINDOW_WH) {
    return { flowing: true, deltaWh, deltaW, deltaMs };
  }

  // Rule C: fallback ≥ 50 Wh regardless of interval.
  if (deltaWh >= FLOW_FALLBACK_WH) {
    return { flowing: true, deltaWh, deltaW, deltaMs };
  }

  return { flowing: false, deltaWh, deltaW, deltaMs };
}
