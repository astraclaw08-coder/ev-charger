/**
 * TASK-0208 Phase 2 (PR-c) — in-memory prior meter-sample state per session.
 *
 * Stores the last observed meter register (Wh) and wall-clock timestamp for
 * each ACTIVE fleet-linked session, so MeterValues can compute energy-flow
 * deltas across frames.
 *
 * Constraints / semantics:
 *   - Keyed by session.id (string UUID).
 *   - Bounded by an LRU cap (defensive against process leak if clears miss).
 *   - TTL sweeps entries that haven't been touched in a long time — a
 *     session that goes silent for > TTL will seed fresh from
 *     session.meterStart on the next frame (safe: same behavior as the
 *     very first frame of a session).
 *   - clear(sessionId) is called by StopTransaction and orphan-session
 *     auto-close in StatusNotification. Not fatal if the entry was already
 *     gone (idempotent delete).
 *
 * NOT persisted. Process restart means the first qualifying frame after
 * restart seeds again from Session.meterStart — which is fine: at most one
 * frame of accuracy is lost, and fleet enforcement in PR-d tolerates this.
 */

export interface PriorEnergySample {
  /** Last observed Energy.Active.Import.Register value in Wh. */
  lastWh: number;
  /** Wall-clock ms of the sample (Date.parse(meterValue.timestamp)). */
  lastTsMs: number;
  /** Monotonic ms when this entry was last written (for LRU + TTL). */
  touchedAtMs: number;
}

const DEFAULT_MAX_ENTRIES = 1_000;
const DEFAULT_TTL_MS = 6 * 60 * 60_000; // 6h — longer than any realistic session gap

export const PRIOR_ENERGY_STATE_LIMITS = {
  maxEntries: DEFAULT_MAX_ENTRIES,
  ttlMs: DEFAULT_TTL_MS,
} as const;

// Map preserves insertion order → cheap LRU: delete+re-set on write to move
// to tail, shift() from head to evict oldest.
const state = new Map<string, PriorEnergySample>();

export function putPriorEnergy(
  sessionId: string,
  sample: { lastWh: number; lastTsMs: number },
  now: () => number = Date.now,
): void {
  if (state.has(sessionId)) state.delete(sessionId);
  state.set(sessionId, {
    lastWh: sample.lastWh,
    lastTsMs: sample.lastTsMs,
    touchedAtMs: now(),
  });

  // LRU eviction
  while (state.size > PRIOR_ENERGY_STATE_LIMITS.maxEntries) {
    const oldestKey = state.keys().next().value;
    if (oldestKey === undefined) break;
    state.delete(oldestKey);
  }
}

/**
 * Read prior state if present and fresh. Returns null if missing or TTL-expired.
 * Expired entries are removed as a side effect.
 */
export function getPriorEnergy(
  sessionId: string,
  now: () => number = Date.now,
): PriorEnergySample | null {
  const entry = state.get(sessionId);
  if (!entry) return null;
  if (now() - entry.touchedAtMs > PRIOR_ENERGY_STATE_LIMITS.ttlMs) {
    state.delete(sessionId);
    return null;
  }
  return entry;
}

/**
 * Idempotent clear. Called by StopTransaction and orphan-session auto-close
 * in StatusNotification. Safe if the entry was already missing.
 */
export function clearPriorEnergy(sessionId: string): void {
  state.delete(sessionId);
}

export function getPriorEnergyStateSize(): number {
  return state.size;
}

export function __resetPriorEnergyStateForTests(): void {
  state.clear();
}
