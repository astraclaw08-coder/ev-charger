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

/** Stable prefix for synthetic-user clerkId values. Grep-stable. */
const SYNTHETIC_CLERK_ID_PREFIX = 'synthetic-fleet-' as const;

/** Compute the expected synthetic clerkId for a given policy. */
export function syntheticClerkIdFor(policyId: string): string {
  return `${SYNTHETIC_CLERK_ID_PREFIX}${policyId}`;
}

/**
 * Thrown when the requested `autoStartIdTag` already maps to a User row that
 * is NOT the expected synthetic-fleet user for this policy (i.e. it would
 * hijack a real driver's account or another policy's synthetic). Callers
 * (the auto-start decision matrix) treat this as a hard skip — never attach
 * a fleet session to a foreign user.
 */
export class SyntheticFleetUserCollisionError extends Error {
  readonly policyId: string;
  readonly existingClerkId: string | null;
  constructor(policyId: string, existingClerkId: string | null) {
    super(
      `idTag is already in use by a non-synthetic-fleet user (policyId=${policyId}, existingClerkId=${existingClerkId ?? 'null'})`,
    );
    this.name = 'SyntheticFleetUserCollisionError';
    this.policyId = policyId;
    this.existingClerkId = existingClerkId;
  }
}

/**
 * Get-or-create the synthetic User row for a fleet policy. Idempotent.
 *
 * Hijack prevention:
 *   The User table's `idTag` column is unique. If the requested
 *   `policy.autoStartIdTag` collides with an existing User row, that row
 *   could be:
 *     (a) A previously-created synthetic for THIS policy → reuse, fine.
 *     (b) A previously-created synthetic for a DIFFERENT policy →
 *         operator misconfigured by reusing an autoStartIdTag across
 *         policies (Slice B's API validator should now reject this on
 *         create/update; this is defense-in-depth at runtime).
 *     (c) A real human driver who happens to have this idTag → MUST
 *         reject. Otherwise fleet sessions would get attached to a real
 *         user's account, polluting their session history and billing.
 *
 *   We resolve this with a find-first / create-only pattern instead of
 *   upsert, so we can inspect the row before deciding to use it. On
 *   collision (b) or (c) we throw `SyntheticFleetUserCollisionError`.
 *
 * Throws:
 *   - Error                              — autoStartIdTag null/empty
 *   - SyntheticFleetUserCollisionError   — idTag bound to a non-synthetic
 *                                          user, or to a different policy's
 *                                          synthetic
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
  const clerkId = syntheticClerkIdFor(policy.id);
  const displayName = `Fleet Policy ${policy.name ?? policy.id}`;

  // Step 1: see if a row already exists.
  const existing = await (prisma as any).user.findUnique({
    where: { idTag },
    select: { id: true, idTag: true, clerkId: true },
  }) as { id: string; idTag: string; clerkId: string } | null;

  if (existing) {
    if (existing.clerkId !== clerkId) {
      // Hijack guard: never reuse a foreign User row for a fleet session.
      throw new SyntheticFleetUserCollisionError(policy.id, existing.clerkId ?? null);
    }
    return { id: existing.id, idTag: existing.idTag };
  }

  // Step 2: no row → create. Race-safe via the unique constraint on idTag:
  // if a parallel request created the row between our find and create, the
  // P2002 fires; we recover by re-reading and re-applying the hijack check.
  try {
    const created = await (prisma as any).user.create({
      data: {
        idTag,
        email,
        clerkId,
        name: displayName,
      },
      select: { id: true, idTag: true },
    });
    return created as SyntheticFleetUser;
  } catch (err: any) {
    if (err?.code === 'P2002') {
      // Re-read and verify it's our synthetic.
      const racedRow = await (prisma as any).user.findUnique({
        where: { idTag },
        select: { id: true, idTag: true, clerkId: true },
      }) as { id: string; idTag: string; clerkId: string } | null;
      if (racedRow && racedRow.clerkId === clerkId) {
        return { id: racedRow.id, idTag: racedRow.idTag };
      }
      throw new SyntheticFleetUserCollisionError(policy.id, racedRow?.clerkId ?? null);
    }
    throw err;
  }
}
