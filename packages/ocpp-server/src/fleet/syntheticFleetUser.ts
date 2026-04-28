/**
 * Synthetic fleet user resolver (TASK-0208 Phase 3 Slice C).
 *
 * Background:
 *   `Session.userId` is `NOT NULL` in the schema. Fleet-Auto sessions are
 *   server-initiated — there's no real driver/User on the other side. We
 *   need to populate `userId` with *something* that is:
 *     - distinguishable from real driver users (so receipts/analytics can
 *       segregate them)
 *     - stable across restarts (so the same fleet policy always uses the
 *       same synthetic user — easy to query "all sessions on policy X")
 *     - cheap to ensure exists at runtime (fleet auto-start hot path)
 *
 *   We get-or-create one synthetic User row per FleetPolicy. The User's
 *   `idTag` matches `policy.autoStartIdTag` so the existing Authorize
 *   handler's `prisma.user.findUnique({ where: { idTag } })` lookup
 *   succeeds without modifying that hot path.
 *
 * Naming convention (kept grep-stable):
 *   - idTag         = policy.autoStartIdTag (the on-the-wire OCPP idTag)
 *   - email         = `fleet-policy-{policyId}@fleet.local`
 *   - clerkId       = `synthetic-fleet-{policyId}`
 *   - name          = `Fleet Policy {policyName}` (best-effort label)
 *
 *   The .local TLD avoids any chance of routing to a real mailbox; the
 *   synthetic user is never expected to receive email.
 *
 * Idempotency:
 *   `prisma.user.upsert` keyed by `idTag` (existing unique constraint).
 *   First call creates; subsequent calls return the existing row. Safe to
 *   call on every fleet auto-start.
 *
 * Slice C scope:
 *   - This module is the only place that writes synthetic User rows.
 *   - Slice G (Hybrid-B retirement) will revisit whether to add a marker
 *     column on User (e.g. `kind: REAL | FLEET_SYNTHETIC`) if downstream
 *     queries need to filter them more precisely than by idTag prefix.
 */

import { prisma } from '@ev-charger/shared';

/** Policy fields needed to materialize a synthetic user row. */
export type SyntheticFleetUserPolicy = {
  id: string;
  name: string;
  autoStartIdTag: string;
};

/** What we return — the User row's id is what callers need for Session.userId. */
export type SyntheticFleetUser = {
  id: string;
  idTag: string;
};

/**
 * Get-or-create the synthetic User row for a fleet policy. Idempotent.
 *
 * If `policy.autoStartIdTag` is null/empty the caller is misconfigured;
 * we throw so the auto-start decision matrix can log and skip. Callers
 * MUST gate the call on `policy.autoStartIdTag` being non-null.
 */
export async function getOrCreateSyntheticFleetUser(
  policy: SyntheticFleetUserPolicy,
): Promise<SyntheticFleetUser> {
  if (!policy.autoStartIdTag || policy.autoStartIdTag.trim().length === 0) {
    throw new Error(
      `synthetic fleet user requires non-empty autoStartIdTag (policyId=${policy.id})`,
    );
  }

  const idTag = policy.autoStartIdTag;
  const email = `fleet-policy-${policy.id}@fleet.local`;
  const clerkId = `synthetic-fleet-${policy.id}`;
  const displayName = `Fleet Policy ${policy.name ?? policy.id}`;

  // Use upsert keyed on the unique idTag column. Update path is intentionally
  // a no-op (`update: {}`) — we don't want to flap the displayName/email
  // every call in case the operator renames a policy. If renaming-tracking
  // is desired later, swap to `update: { name: displayName }` and audit.
  const user = await (prisma as any).user.upsert({
    where: { idTag },
    update: {},
    create: {
      idTag,
      email,
      clerkId,
      name: displayName,
    },
    select: { id: true, idTag: true },
  });

  return user as SyntheticFleetUser;
}
