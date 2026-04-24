/**
 * TASK-0208 Phase 2 — fleet profile id derivation.
 *
 * Every charger gets ONE stable OCPP chargingProfileId for fleet-policy pushes.
 * Separate namespace from operator-defined SmartChargingProfile ids (those use
 * incrementing small integers, e.g. 1, 2, 3 ...).
 *
 * Scheme:
 *   id = (fnv1a32(chargerId) & 0x7fffffff) | 0x40000000
 *
 * Properties:
 *   - Top bit 30 always set → ids always in [0x40000000, 0x7fffffff]
 *     (1_073_741_824 – 2_147_483_647). OCPP 1.6 allows int32, so we stay
 *     within positive-int range.
 *   - Bit 31 cleared → never negative when coerced to int32 by any client.
 *   - Namespace is clearly distinct from small operator ids (<1e6 typical).
 *   - Stable across process restarts: pure function of chargerId.
 *   - Collision risk: 2^30 buckets, well beyond expected charger count.
 *
 * Same-id replacement is the whole point — field-validated on LOOP firmware
 * in F5h (2026-04-24): pushing the same chargingProfileId replaces the prior
 * profile in charger RAM, regardless of stackLevel change. This lets us
 * demote the fleet profile (stackLevel 90 → 1) to release the gate without
 * ever issuing ClearChargingProfile.
 */

const FLEET_PROFILE_ID_MIN = 0x40000000; // 1_073_741_824
const FLEET_PROFILE_ID_MAX = 0x7fffffff; // 2_147_483_647

/**
 * FNV-1a 32-bit hash. Pure, deterministic, no crypto dependency.
 */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5; // offset basis
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // 32-bit multiply by FNV prime (0x01000193), truncate to 32 bits
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function fleetProfileIdFor(chargerId: string): number {
  if (!chargerId || typeof chargerId !== 'string') {
    throw new Error('fleetProfileIdFor: chargerId must be a non-empty string');
  }
  const raw = fnv1a32(chargerId);
  // Strip bit 31 so we stay positive int32, then set bit 30 so we're
  // guaranteed ≥ 0x40000000 (distinct from small operator ids).
  const id = (raw & 0x3fffffff) | FLEET_PROFILE_ID_MIN;
  return id;
}

export const FLEET_PROFILE_ID_BOUNDS = Object.freeze({
  min: FLEET_PROFILE_ID_MIN,
  max: FLEET_PROFILE_ID_MAX,
});
