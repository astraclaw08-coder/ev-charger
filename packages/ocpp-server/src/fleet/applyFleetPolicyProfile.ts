/**
 * TASK-0208 Phase 2 — applyFleetPolicyProfile.
 *
 * Single load-bearing helper for fleet-policy charging-profile enforcement.
 * Called by the fleet scheduler (PR-c) and by the BootNotification re-apply
 * path (Phase 2.5). NOT called by handlers directly.
 *
 * Two modes (both push at stackLevel=90 — fleet profile owns sL=90 on the
 * charger, varying only the limit):
 *   GATE_ACTIVE   → force 0 A:    stackLevel=90, limit=0
 *   GATE_RELEASED → cap at policy: stackLevel=90, limit=maxAmps
 *
 * Why same stackLevel for both modes? OCPP 1.6 ChargePointMaxProfile
 * resolution picks the HIGHEST stackLevel when multiple CPMax profiles are
 * installed. LOOP firmware ships with a built-in CPMax baseline at sL=60
 * limit=25 A on 1A32 (F5h, 2026-04-24). A release push at sL=1 loses to
 * that baseline — `FleetPolicy.maxAmps` would be silently a no-op. Pushing
 * release at the same sL=90 the deny used means same-id replacement
 * REPLACES the prior fleet entry, and the fleet entry continues to dominate
 * any baseline at sL ≤ 89 (Tier 4-Windowed evidence 2026-04-29).
 *
 * Removal mechanism is SAME-ID REPLACEMENT, never ClearChargingProfile. The
 * reconciler at /reconcile-smart-charging is not a reliable override-removal
 * path (proven in F5h: it compares against SmartChargingState and skips
 * work when tracked state already matches; out-of-band fleet pushes are
 * invisible to it).
 *
 * RAM-state tracking is in-memory only (Phase 2). Process restart clears
 * the map; the scheduler's next tick re-evaluates and re-pushes. LOOP
 * firmware accepts same-id same-content re-pushes without disruption
 * (field-validated 2026-04-24). Durability becomes a concern only if we
 * find scheduler ticks are too slow to bridge a restart — at which point
 * we add a proper FleetChargingState table (own FK to FleetPolicy, not
 * overloaded onto SmartChargingState).
 *
 * Flag-gated: FLEET_GATED_SESSIONS_ENABLED=false → no-op.
 */

import { connectionReadyForSmartCharging } from '../smartCharging';
import { remoteSetChargingProfile } from '../remote';
import { fleetProfileIdFor } from './fleetProfileId';

export type FleetGateMode = 'GATE_ACTIVE' | 'GATE_RELEASED';

export interface FleetPolicyLike {
  id: string;
  maxAmps: number; // clamped inside helper (see MIN/MAX_MAX_AMPS)
}

export interface FleetProfileRamState {
  chargerId: string;
  profileId: number;
  mode: FleetGateMode;
  /** Always STACK_LEVEL_FLEET (=90). Field is preserved for diagnostics + RAM-state idempotency. */
  stackLevel: number;
  limitAmps: number;
  lastAttemptAt: Date;
  lastAppliedAt: Date | null;
  lastError: string | null;
  policyId: string;
}

export type ApplyResult =
  | { ok: true; action: 'pushed' | 'skipped-idempotent'; state: FleetProfileRamState }
  | { ok: false; skipped: 'flag-off' | 'offline'; reason: string }
  | { ok: false; error: 'rejected' | 'exception'; reason: string; state: FleetProfileRamState };

// Guards. fleet policies with insane values shouldn't hammer the charger.
const MIN_MAX_AMPS = 6;  // OCPP spec floor for usable AC charging
const MAX_MAX_AMPS = 80; // CCS1/J1772 theoretical; practical chargers cap lower

// Single stackLevel for both deny + release. Field-validated 2026-04-29
// (Tier 4-Windowed): the charger's underlying CPMax baseline at sL=60
// limit=25 A overrode our prior sL=1 release push, so FleetPolicy.maxAmps
// was silently a no-op. Owning sL=90 for the fleet profile and rewriting
// limit (0 vs maxAmps) keeps fleet dominant for both modes.
const STACK_LEVEL_FLEET = 90;

// Module-level RAM state. Keyed by chargerId (not ocppId) because FleetPolicy
// + Session relations are all on chargerId.
const ramState = new Map<string, FleetProfileRamState>();

function isFlagEnabled(): boolean {
  return process.env.FLEET_GATED_SESSIONS_ENABLED === 'true';
}

function clampAmps(raw: number): number {
  if (!Number.isFinite(raw)) return MIN_MAX_AMPS;
  return Math.max(MIN_MAX_AMPS, Math.min(MAX_MAX_AMPS, Math.floor(raw)));
}

function buildProfilePayload(
  profileId: number,
  stackLevel: number,
  limitAmps: number,
): Record<string, unknown> {
  return {
    connectorId: 0,
    csChargingProfiles: {
      chargingProfileId: profileId,
      stackLevel,
      chargingProfilePurpose: 'ChargePointMaxProfile',
      chargingProfileKind: 'Absolute',
      chargingSchedule: {
        chargingRateUnit: 'A',
        chargingSchedulePeriod: [{ startPeriod: 0, limit: limitAmps }],
      },
    },
  };
}

/**
 * Idempotency predicate. Only skips the push when the tracked RAM state
 * exactly matches what we're about to push. Any mismatch → re-push.
 */
function ramStateMatches(
  existing: FleetProfileRamState | undefined,
  desired: { mode: FleetGateMode; stackLevel: number; limitAmps: number; policyId: string },
): boolean {
  if (!existing) return false;
  return (
    existing.mode === desired.mode &&
    existing.stackLevel === desired.stackLevel &&
    existing.limitAmps === desired.limitAmps &&
    existing.policyId === desired.policyId
  );
}

export interface ApplyFleetPolicyProfileOpts {
  chargerId: string;
  ocppId: string;
  policy: FleetPolicyLike;
  mode: FleetGateMode;
  /**
   * Dependency seam for tests. Default uses real `remoteSetChargingProfile`.
   */
  sendProfile?: typeof remoteSetChargingProfile;
  /**
   * Dependency seam for tests. Default uses real `connectionReadyForSmartCharging`.
   */
  readiness?: typeof connectionReadyForSmartCharging;
  /**
   * Dependency seam for tests. Default reads `process.env`.
   */
  flagEnabled?: () => boolean;
}

export async function applyFleetPolicyProfile(
  opts: ApplyFleetPolicyProfileOpts,
): Promise<ApplyResult> {
  const {
    chargerId,
    ocppId,
    policy,
    mode,
    sendProfile = remoteSetChargingProfile,
    readiness = connectionReadyForSmartCharging,
    flagEnabled = isFlagEnabled,
  } = opts;

  if (!flagEnabled()) {
    return { ok: false, skipped: 'flag-off', reason: 'FLEET_GATED_SESSIONS_ENABLED is not true' };
  }

  const maxAmps = clampAmps(policy.maxAmps);
  const profileId = fleetProfileIdFor(chargerId);
  // Both modes push at the same stackLevel; only `limitAmps` differs.
  const stackLevel = STACK_LEVEL_FLEET;
  const limitAmps = mode === 'GATE_ACTIVE' ? 0 : maxAmps;

  const existing = ramState.get(chargerId);
  if (ramStateMatches(existing!, { mode, stackLevel, limitAmps, policyId: policy.id })) {
    // Update lastAttemptAt but skip the CALL.
    const updated: FleetProfileRamState = {
      ...existing!,
      lastAttemptAt: new Date(),
    };
    ramState.set(chargerId, updated);
    return { ok: true, action: 'skipped-idempotent', state: updated };
  }

  const ready = await readiness(chargerId, ocppId);
  if (!ready.ready) {
    // Record the attempt so PR-c scheduler can see "we tried but offline".
    // Do NOT mutate the existing applied state.
    return { ok: false, skipped: 'offline', reason: ready.reason };
  }

  const payload = buildProfilePayload(profileId, stackLevel, limitAmps);
  const now = new Date();

  let status: 'Accepted' | 'Rejected' | 'NotSupported';
  try {
    status = await sendProfile(ocppId, payload);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const state: FleetProfileRamState = {
      chargerId,
      profileId,
      mode,
      stackLevel,
      limitAmps,
      lastAttemptAt: now,
      lastAppliedAt: existing?.lastAppliedAt ?? null,
      lastError: reason,
      policyId: policy.id,
    };
    ramState.set(chargerId, state);
    return { ok: false, error: 'exception', reason, state };
  }

  if (status !== 'Accepted') {
    const state: FleetProfileRamState = {
      chargerId,
      profileId,
      mode,
      stackLevel,
      limitAmps,
      lastAttemptAt: now,
      lastAppliedAt: existing?.lastAppliedAt ?? null,
      lastError: `SetChargingProfile status=${status}`,
      policyId: policy.id,
    };
    ramState.set(chargerId, state);
    return { ok: false, error: 'rejected', reason: `SetChargingProfile ${status}`, state };
  }

  const state: FleetProfileRamState = {
    chargerId,
    profileId,
    mode,
    stackLevel,
    limitAmps,
    lastAttemptAt: now,
    lastAppliedAt: now,
    lastError: null,
    policyId: policy.id,
  };
  ramState.set(chargerId, state);
  return { ok: true, action: 'pushed', state };
}

// --- test/diagnostic helpers (intentional exports) ---

/**
 * Read-only view for the PR-c scheduler and diagnostics endpoints.
 * Returns a shallow clone so callers can't mutate internal state.
 */
export function getFleetRamState(chargerId: string): FleetProfileRamState | null {
  const s = ramState.get(chargerId);
  return s ? { ...s } : null;
}

/**
 * Test-only. Resets the in-memory map. Never call from production code.
 */
export function __resetFleetRamStateForTests(): void {
  ramState.clear();
}
