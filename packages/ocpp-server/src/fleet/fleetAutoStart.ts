/**
 * Fleet-Auto runtime auto-start (TASK-0208 Phase 3 Slice C).
 *
 * Wired into `handleStatusNotification` for connector plug-in transitions.
 * Decides whether to issue a server-initiated `RemoteStartTransaction`
 * for a connector configured as `chargingMode = FLEET_AUTO`.
 *
 * Two-tier rollout gate (per redesign doc §0 #5 + §4 decision matrix):
 *
 *   1) env(FLEET_GATED_SESSIONS_ENABLED) === 'true'     emergency global kill switch
 *   2) site OR connector rollout flag enabled            DB-backed pilot toggle
 *   3) charger ready (BootNotification + ≥1 Heartbeat)   prevents pre-boot commands
 *   4) connector.chargingMode === 'FLEET_AUTO'           operator-configured
 *   5) connector.fleetPolicyId !== null                  policy assigned
 *   6) policy.status === 'ENABLED'                       policy in active state
 *   7) policy.autoStartIdTag truthy                      synthetic-user can resolve
 *   8) no ACTIVE session on the connector                idempotent re-trigger guard
 *   9) no recent pending auto-start attempt              in-process retry guard
 *
 * On a successful pass, this module:
 *   - upserts the synthetic fleet user (so the existing Authorize handler's
 *     `findUnique({ idTag })` succeeds without modifying that hot path)
 *   - sends RemoteStartTransaction with the policy's `autoStartIdTag`
 *   - retries once after ~6 s on Rejected/error (per F5h finding: first
 *     RemoteStart can silently drop on charger firmware flake)
 *   - records the attempt in an in-memory pending map; cleared on the
 *     subsequent StartTransaction (or on TTL).
 *
 * Failure modes are non-fatal — auto-start is best-effort. Anything that
 * goes wrong is logged and we move on. The caller (StatusNotification
 * handler) does NOT await this; it's fire-and-forget.
 *
 * What this module DOES NOT do:
 *   - Profile pushing (0 A deny / maxAmps allow) — that's
 *     `applyFleetPolicyProfile.ts` + `fleetScheduler.ts`, untouched.
 *   - Hybrid-B prefix matching — Slice G removes that path; this module
 *     deliberately does not consult it.
 *   - Anything to do with mobile / driver app — those don't see fleet
 *     connectors (mobile filter lands in Slice D).
 */

import { prisma } from '@ev-charger/shared';
import { remoteStartTransaction } from '../remote';
import { connectionReadyForSmartCharging } from '../smartCharging';
import { isRolloutEnabled } from './rolloutFlagCache';
import { getOrCreateSyntheticFleetUser } from './syntheticFleetUser';

// ─── Types ──────────────────────────────────────────────────────────────────

export type AutoStartTriggerArgs = {
  /** Charger.id (DB row id). */
  chargerId: string;
  /** Charger.ocppId (used by remoteStartTransaction). */
  ocppId: string;
  /** OCPP connectorId (1-indexed integer; 0 is whole-charger and never auto-starts). */
  connectorId: number;
  /** Current OCPP status (e.g. 'Preparing'). */
  newStatus: string;
  /** Previous OCPP status (or null on cold start). */
  prevStatus: string | null;
};

export type AutoStartDecision =
  | { ok: true; reason: 'started'; sessionPendingKey: string; idTag: string }
  | { ok: false; reason: AutoStartSkipReason; detail?: Record<string, unknown> };

export type AutoStartSkipReason =
  | 'flag-off'
  | 'rollout-disabled'
  | 'not-plug-in'
  | 'connector-zero'
  | 'connector-not-found'
  | 'mode-public'
  | 'no-policy-assigned'
  | 'policy-missing'
  | 'policy-not-enabled'
  | 'autoStartIdTag-null'
  | 'charger-not-ready'
  | 'active-session'
  | 'pending-attempt'
  | 'remote-start-rejected'
  | 'error';

// ─── Trigger filter (pure, testable) ───────────────────────────────────────
//
// Primary trigger is `Preparing` (the vehicle plug-in transition every
// well-behaved charger reports). `SuspendedEVSE`/`SuspendedEV` are
// accepted as defensive fallback for firmware variants that skip
// Preparing — but ONLY on a transition out of `Available`. Without the
// `Available` precondition we'd re-fire on every dwell flip mid-session
// (e.g. PowerSwitchFailure blip during 0 A gating per F5h).

export function isPlugInTrigger(newStatus: string, prevStatus: string | null): boolean {
  if (newStatus === 'Preparing') return true;
  if ((newStatus === 'SuspendedEVSE' || newStatus === 'SuspendedEV') && prevStatus === 'Available') {
    return true;
  }
  return false;
}

// ─── Pending-attempt map ────────────────────────────────────────────────────
//
// Prevents stale plug-in transitions from triggering parallel RemoteStart
// calls while a previous attempt is still in flight. Lifetime is short —
// a successful StartTransaction or two retry windows is more than enough.
//
// Keyed by `${chargerId}:${connectorId}`. The connectorId is the OCPP
// integer (Connector.connectorId), not the DB row id, so it matches the
// shape we get from StatusNotification.

type PendingEntry = {
  startedAt: number;
  fleetPolicyId: string;
  idTag: string;
  /** Set by the StartTransaction handler when it successfully attaches. */
  resolved: boolean;
};

const pending = new Map<string, PendingEntry>();
const PENDING_TTL_MS = 2 * 60_000; // 2 min — long enough for retry + StartTransaction settle

function pendingKey(chargerId: string, connectorId: number): string {
  return `${chargerId}:${connectorId}`;
}

function isPendingFresh(entry: PendingEntry | undefined): boolean {
  if (!entry) return false;
  if (entry.resolved) return false;
  return Date.now() - entry.startedAt < PENDING_TTL_MS;
}

/**
 * Mark a previously-pending auto-start as resolved. Called by the
 * StartTransaction handler when it sees idTag === policy.autoStartIdTag
 * for a FLEET_AUTO connector. Safe no-op if not present.
 */
export function markFleetAutoStartResolved(args: { chargerId: string; connectorId: number }): void {
  const key = pendingKey(args.chargerId, args.connectorId);
  const entry = pending.get(key);
  if (entry) {
    entry.resolved = true;
    pending.delete(key);
  }
}

/** Test seam — clears the pending map. */
export function __resetFleetAutoStartForTests(): void {
  pending.clear();
}

// ─── Main entry point ──────────────────────────────────────────────────────

/**
 * Decide-and-act on a connector status transition. Fire-and-forget; the
 * caller MUST NOT await this in any path that needs to return promptly.
 *
 * Returns an `AutoStartDecision` for testability. Production callers
 * ignore the return value.
 */
export async function maybeAutoStartFleet(
  args: AutoStartTriggerArgs,
): Promise<AutoStartDecision> {
  // Tier-1 gate: env emergency kill switch.
  if (process.env.FLEET_GATED_SESSIONS_ENABLED !== 'true') {
    return logSkip(args, 'flag-off');
  }

  // OCPP semantics: connectorId 0 is "the whole charger" — never auto-start.
  if (args.connectorId < 1) {
    return logSkip(args, 'connector-zero');
  }

  if (!isPlugInTrigger(args.newStatus, args.prevStatus)) {
    return logSkip(args, 'not-plug-in');
  }

  // Load the connector + policy + chargingMode in one trip. We need:
  //   - connector.id (for the rollout cache key + active-session check)
  //   - connector.chargingMode (gate)
  //   - connector.fleetPolicyId + linked policy (gate + autoStartIdTag)
  //   - charger.siteId (for the rollout cache + ready check)
  let connector: any;
  try {
    connector = await (prisma as any).connector.findUnique({
      where: { chargerId_connectorId: { chargerId: args.chargerId, connectorId: args.connectorId } },
      include: {
        charger: { select: { id: true, ocppId: true, siteId: true } },
        fleetPolicy: {
          select: {
            id: true,
            name: true,
            status: true,
            autoStartIdTag: true,
            siteId: true,
          },
        },
      },
    });
  } catch (err) {
    return logSkip(args, 'error', { err: err instanceof Error ? err.message : String(err) });
  }
  if (!connector) {
    return logSkip(args, 'connector-not-found');
  }

  if (connector.chargingMode !== 'FLEET_AUTO') {
    // This is the silent-debug case — most connectors are PUBLIC. We don't
    // log to avoid noise on every plug-in across the fleet.
    return { ok: false, reason: 'mode-public' };
  }

  if (!connector.fleetPolicyId || !connector.fleetPolicy) {
    return logSkip(args, 'no-policy-assigned');
  }

  if (connector.fleetPolicy.status !== 'ENABLED') {
    return logSkip(args, 'policy-not-enabled', {
      policyId: connector.fleetPolicy.id,
      policyStatus: connector.fleetPolicy.status,
    });
  }

  const autoStartIdTag = connector.fleetPolicy.autoStartIdTag;
  if (!autoStartIdTag || typeof autoStartIdTag !== 'string' || autoStartIdTag.trim().length === 0) {
    return logSkip(args, 'autoStartIdTag-null', { policyId: connector.fleetPolicy.id });
  }

  // Tier-2 gate: per-connector or per-site DB rollout flag.
  const rolloutOk = await isRolloutEnabled({
    connectorId: connector.id,
    siteId: connector.charger?.siteId ?? null,
  });
  if (!rolloutOk) {
    return logSkip(args, 'rollout-disabled');
  }

  // Charger readiness: BootNotification + ≥1 Heartbeat. The smart-charging
  // helper already encodes the "live WS bypasses DB check" optimization.
  const readiness = await connectionReadyForSmartCharging(args.chargerId, args.ocppId);
  if (!readiness.ready) {
    return logSkip(args, 'charger-not-ready', { readinessReason: readiness.reason });
  }

  // Idempotency: don't auto-start if a session is already ACTIVE on this
  // connector (covers both real-driver and prior-fleet sessions).
  let activeSession: any;
  try {
    activeSession = await (prisma as any).session.findFirst({
      where: {
        connector: { chargerId: args.chargerId, connectorId: args.connectorId },
        status: 'ACTIVE',
      },
      select: { id: true, idTag: true },
    });
  } catch (err) {
    return logSkip(args, 'error', { err: err instanceof Error ? err.message : String(err) });
  }
  if (activeSession) {
    return logSkip(args, 'active-session', { sessionId: activeSession.id });
  }

  // In-process retry guard: don't re-fire while a previous attempt for the
  // same connector is still in flight. Stale entries are TTL'd out.
  const key = pendingKey(args.chargerId, args.connectorId);
  const existingPending = pending.get(key);
  if (isPendingFresh(existingPending)) {
    return logSkip(args, 'pending-attempt', { pendingSince: existingPending!.startedAt });
  }
  // Clear stale entries (TTL expired) before recording the new attempt.
  if (existingPending) pending.delete(key);

  // Pre-create / resolve the synthetic User so the existing Authorize
  // handler's `findUnique({ idTag })` succeeds without modifications.
  // Idempotent.
  try {
    await getOrCreateSyntheticFleetUser({
      id: connector.fleetPolicy.id,
      name: connector.fleetPolicy.name,
      autoStartIdTag,
    });
  } catch (err) {
    return logSkip(args, 'error', {
      stage: 'syntheticUser',
      err: err instanceof Error ? err.message : String(err),
    });
  }

  // Record the attempt and fire RemoteStart. Retry once if the charger
  // rejects or errors — per F5h finding, the first call after a Faulted
  // recovery may silently drop. Two attempts is the design contract;
  // anything beyond invites command storms.
  pending.set(key, {
    startedAt: Date.now(),
    fleetPolicyId: connector.fleetPolicy.id,
    idTag: autoStartIdTag,
    resolved: false,
  });

  console.log(
    `[fleet.auto-start] Decision: ACCEPTED chargerId=${args.chargerId} ocppId=${args.ocppId} connectorId=${args.connectorId} policyId=${connector.fleetPolicy.id} idTag=${autoStartIdTag}`,
  );

  let lastStatus: string = 'Rejected';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      lastStatus = await remoteStartTransaction(args.ocppId, args.connectorId, autoStartIdTag);
    } catch (err) {
      console.warn(
        `[fleet.auto-start] RemoteStart threw on attempt ${attempt}: ocppId=${args.ocppId} connectorId=${args.connectorId} err=${err instanceof Error ? err.message : String(err)}`,
      );
      lastStatus = 'Rejected';
    }
    if (lastStatus === 'Accepted') {
      console.log(
        `[fleet.auto-start] RemoteStart Accepted on attempt ${attempt}: ocppId=${args.ocppId} connectorId=${args.connectorId} idTag=${autoStartIdTag}`,
      );
      return { ok: true, reason: 'started', sessionPendingKey: key, idTag: autoStartIdTag };
    }
    if (attempt < 2) {
      // F5h: 5–8 s buffer for charger to recover from Faulted-blip on first call.
      await new Promise<void>((r) => setTimeout(r, 6000));
    }
  }

  // Both attempts rejected → clean up pending, log, audit (logging only —
  // no AdminAuditEvent write because fleet-auto failures aren't operator
  // actions). Slice C surfaces these in logs; portal diagnostics in a
  // future slice can read them off the OcppLog if needed.
  pending.delete(key);
  console.warn(
    `[fleet.auto-start] FAILED after retry: ocppId=${args.ocppId} connectorId=${args.connectorId} idTag=${autoStartIdTag} lastStatus=${lastStatus}`,
  );
  return logSkip(args, 'remote-start-rejected', { lastStatus });
}

// ─── Internal helpers ──────────────────────────────────────────────────────

function logSkip(
  args: AutoStartTriggerArgs,
  reason: AutoStartSkipReason,
  detail?: Record<string, unknown>,
): AutoStartDecision {
  // Skip log levels:
  //   - 'flag-off', 'mode-public'                    → silent (extreme volume)
  //   - 'rollout-disabled', 'not-plug-in'            → debug-ish (high volume)
  //   - misconfig (no-policy, autoStartIdTag-null)   → warn (operator action needed)
  //   - 'error'                                      → error
  //   - everything else                              → info
  const fields = `chargerId=${args.chargerId} connectorId=${args.connectorId} reason=${reason}`;
  if (reason === 'flag-off' || reason === 'mode-public' || reason === 'not-plug-in' || reason === 'connector-zero') {
    // silent — these are expected high-volume cases
  } else if (reason === 'no-policy-assigned' || reason === 'policy-not-enabled' || reason === 'autoStartIdTag-null') {
    console.warn(`[fleet.auto-start] Skipped (misconfig): ${fields}`, detail ?? {});
  } else if (reason === 'error') {
    console.error(`[fleet.auto-start] Skipped (error): ${fields}`, detail ?? {});
  } else {
    console.log(`[fleet.auto-start] Skipped: ${fields}`, detail ?? {});
  }
  return { ok: false, reason, detail };
}
