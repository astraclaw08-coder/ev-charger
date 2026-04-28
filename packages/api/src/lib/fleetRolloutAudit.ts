/**
 * Fleet-Auto rollout flag audit helper (TASK-0208 Phase 3 Slice A).
 *
 * Wraps the generic `writeAdminAudit()` with the standard action + metadata
 * shape we use whenever someone flips a Fleet-Auto rollout flag — whether
 * via the operator portal (Slice B) or an admin SQL path (incident rollback).
 *
 * Two scopes:
 *   - `site`      — `Site.fleetAutoRolloutEnabled`
 *   - `connector` — `Connector.fleetAutoRolloutEnabled` (per-connector override)
 *
 * Both flips are sensitive: turning a site/connector ON allows the OCPP
 * server to auto-start fleet sessions for that scope when all other gate
 * conditions hold (env kill switch, FLEET_AUTO chargingMode, ENABLED policy).
 * Turning OFF is the canonical, restart-free rollback path. Either way,
 * every flip writes an audit row capturing who/when/what/old/new.
 *
 * Slice A scope: helper exists, callers wire up in Slice B (portal API
 * routes) and Slice F (prod pilot SQL helper). No runtime code reads the
 * flag yet; that lands in Slice C.
 *
 * The action namespace (`fleet.rollout.*`) is reserved for this concern
 * and must not be reused for anything else — search-grepability matters
 * for incident response.
 */

import { writeAdminAudit } from './adminAudit';

/** Audit action constants — keep grep-stable. */
export const FLEET_ROLLOUT_AUDIT_ACTION_SITE =
  'fleet.rollout.site.update' as const;
export const FLEET_ROLLOUT_AUDIT_ACTION_CONNECTOR =
  'fleet.rollout.connector.update' as const;

export type FleetRolloutScope = 'site' | 'connector';

export type FleetRolloutFlipArgs = {
  /** Operator who initiated the flip (Keycloak sub or service account id). */
  operatorId: string;
  /** Which scope was flipped. */
  scope: FleetRolloutScope;
  /** Site.id when scope=site; Connector.id when scope=connector. */
  scopeId: string;
  /** Connector's parent Charger.id, when scope=connector. Optional helper for ops queries. */
  chargerId?: string;
  /** Site.id, when scope=connector. Optional helper for ops queries. */
  siteId?: string;
  /**
   * Previous flag value. `null` means "no explicit override" — only meaningful
   * for connector scope where `Connector.fleetAutoRolloutEnabled` is nullable
   * (null = inherit from site).
   */
  oldValue: boolean | null;
  /** New flag value. Same null semantics as oldValue. */
  newValue: boolean | null;
  /** Free-form context (incident ticket id, change-management ref, etc.). */
  reason?: string;
};

/**
 * Write a single rollout-flag flip event to AdminAuditEvent.
 *
 * Does NOT short-circuit on no-op flips (oldValue === newValue) — callers
 * should guard if they want to skip. The audit log is intentionally
 * write-once, append-only; we'd rather have a redundant row than miss one.
 */
export async function writeFleetRolloutAudit(
  args: FleetRolloutFlipArgs,
): Promise<void> {
  const action =
    args.scope === 'site'
      ? FLEET_ROLLOUT_AUDIT_ACTION_SITE
      : FLEET_ROLLOUT_AUDIT_ACTION_CONNECTOR;

  await writeAdminAudit({
    operatorId: args.operatorId,
    action,
    metadata: {
      // Stable shape for downstream queries / dashboards. Do not rename keys
      // without coordinating with whoever queries adminAuditEvent.
      key: 'fleetAutoRolloutEnabled',
      scope: args.scope,
      scopeId: args.scopeId,
      chargerId: args.chargerId ?? null,
      siteId: args.siteId ?? null,
      oldValue: args.oldValue,
      newValue: args.newValue,
      reason: args.reason ?? null,
    },
  });
}
