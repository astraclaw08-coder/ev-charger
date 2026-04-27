/**
 * TASK-0208 Phase 2 (PR-c) — compute minutes spent gated before energy flow.
 *
 * Pure function. preDeliveryGatedMinutes = (firstEnergyAt - plugInAt) clamped
 * to ≥ 0 and reported in floating-point minutes.
 *
 * Semantics:
 *   - Both timestamps required. If either is null/missing, return null —
 *     the snapshot column stays null (means "not applicable for this session").
 *   - If firstEnergyAt < plugInAt (clock skew or data error), clamp to 0
 *     rather than emitting a negative number.
 *   - A session that never delivered energy (firstEnergyAt remains null at
 *     StopTransaction) returns null from this helper — callers should
 *     decide whether to persist null or derive a different value (e.g.
 *     total gated minutes = stoppedAt - plugInAt).
 *
 * Observation-only in Phase 2. No side effects.
 */

export function computePreDeliveryGatedMinutes(
  plugInAt: Date | null | undefined,
  firstEnergyAt: Date | null | undefined,
): number | null {
  if (!plugInAt || !firstEnergyAt) return null;
  const diffMs = firstEnergyAt.getTime() - plugInAt.getTime();
  if (!Number.isFinite(diffMs)) return null;
  const minutes = Math.max(0, diffMs / 60_000);
  return minutes;
}
