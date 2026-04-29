/**
 * Fleet Policy CRUD routes (TASK-0208 Phase 2.5 PR-A).
 *
 * Endpoints:
 *   GET    /sites/:siteId/fleet-policies
 *   POST   /sites/:siteId/fleet-policies
 *   PATCH  /fleet-policies/:id
 *   POST   /fleet-policies/:id/enable
 *   POST   /fleet-policies/:id/disable
 *   DELETE /fleet-policies/:id
 *   POST   /fleet-policies/:id/preview      (advisory, non-mutating)
 *
 * Status model:
 *   DRAFT    — editable, not enforced
 *   ENABLED  — enforced by scheduler; edits BLOCKED (must DISABLE first)
 *   DISABLED — editable, not enforced
 *
 * All writes stamp createdByOperatorId / updatedByOperatorId.
 * Feature flag FLEET_GATED_SESSIONS_ENABLED is NOT checked here — these
 * endpoints manage data only. Scheduler is the flag-gated consumer.
 */

import type { FastifyInstance } from 'fastify';
import {
  prisma,
  validateFleetPolicyInput,
  evaluateFleetWindowAt,
  type FleetPolicyStatusLiteral,
  type SiblingPolicy,
} from '@ev-charger/shared';
import { requireOperator } from '../plugins/auth';
import { requirePolicy } from '../plugins/authorization';

const db: any = prisma;

function hasSiteAccess(siteId: string | null | undefined, siteIds: string[] | undefined): boolean {
  if (!siteIds || siteIds.length === 0) return true;
  if (siteIds.includes('*')) return true;
  if (!siteId) return false;
  return siteIds.includes(siteId);
}

function serialize(p: any) {
  return {
    id: p.id,
    siteId: p.siteId,
    name: p.name,
    status: p.status as FleetPolicyStatusLiteral,
    idTagPrefix: p.idTagPrefix,
    maxAmps: p.maxAmps,
    ocppStackLevel: p.ocppStackLevel,
    windowsJson: p.windowsJson,
    notes: p.notes,
    // Phase 3 Slice A/B — Fleet-Auto fields exposed on every response so
    // operator UI can read/edit them without a separate fetch.
    alwaysOn: p.alwaysOn ?? false,
    autoStartIdTag: p.autoStartIdTag ?? null,
    createdByOperatorId: p.createdByOperatorId,
    updatedByOperatorId: p.updatedByOperatorId,
    createdAt: p.createdAt instanceof Date ? p.createdAt.toISOString() : p.createdAt,
    updatedAt: p.updatedAt instanceof Date ? p.updatedAt.toISOString() : p.updatedAt,
  };
}

async function loadSiblings(siteId: string): Promise<SiblingPolicy[]> {
  const rows = await db.fleetPolicy.findMany({
    where: { siteId },
    // autoStartIdTag is required for findAutoStartIdTagCollision() to detect
    // the new error case (AUTOSTART_COLLISION) at validation time.
    select: { id: true, idTagPrefix: true, status: true, autoStartIdTag: true },
  });
  return rows.map((r: any) => ({
    id: r.id,
    idTagPrefix: r.idTagPrefix,
    status: r.status as FleetPolicyStatusLiteral,
    autoStartIdTag: r.autoStartIdTag ?? null,
  }));
}

/**
 * Reject an `autoStartIdTag` if it collides with an existing real-driver
 * `User.idTag`. Defense-in-depth alongside the OCPP-server-side hijack
 * guard in `getOrCreateSyntheticFleetUser()` — failing here means
 * operators get the validation error at policy-edit time instead of
 * silently disabling auto-start at runtime.
 *
 * Returns null on no-collision, or a structured error on collision.
 * The check is opt-out — pass null/undefined autoStartIdTag and we
 * skip (PATCH paths that don't change the field).
 */
async function findUserIdTagCollision(
  autoStartIdTag: string | null | undefined,
): Promise<{ field: 'autoStartIdTag'; code: string; message: string } | null> {
  if (!autoStartIdTag) return null;
  const colliding = await db.user.findUnique({
    where: { idTag: autoStartIdTag },
    select: { id: true, clerkId: true },
  }) as { id: string; clerkId: string } | null;
  if (!colliding) return null;
  // If the existing row is a synthetic-fleet-* user we still reject from
  // this path because the same idTag mapping to a different policy's
  // synthetic is still a misconfiguration. The synthetic clerkId encodes
  // the policy id, so cross-policy reuse will not match.
  return {
    field: 'autoStartIdTag',
    code: 'USER_IDTAG_COLLISION',
    message:
      `autoStartIdTag is already in use by an existing user (idTag is unique on User). ` +
      `Pick a different value to avoid attaching fleet sessions to a non-fleet account.`,
  };
}

export async function fleetPolicyRoutes(app: FastifyInstance) {
  // ─── GET /sites/:siteId/fleet-policies ──────────────────────────────
  app.get<{ Params: { siteId: string } }>('/sites/:siteId/fleet-policies', {
    preHandler: [requireOperator, requirePolicy('fleet.policy.read')],
  }, async (req, reply) => {
    const operator = req.currentOperator!;
    if (!hasSiteAccess(req.params.siteId, operator.claims?.siteIds)) {
      return reply.status(403).send({ error: 'Forbidden' });
    }
    const site = await db.site.findUnique({ where: { id: req.params.siteId }, select: { id: true } });
    if (!site) return reply.status(404).send({ error: 'Site not found' });

    const policies = await db.fleetPolicy.findMany({
      where: { siteId: req.params.siteId },
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
    });
    return policies.map(serialize);
  });

  // ─── POST /sites/:siteId/fleet-policies ─────────────────────────────
  app.post<{
    Params: { siteId: string };
    Body: {
      name: string;
      idTagPrefix: string;
      maxAmps: number;
      ocppStackLevel?: number;
      windowsJson: unknown;
      notes?: string | null;
      // Phase 3 Slice B — Fleet-Auto fields. `autoStartIdTag` is REQUIRED at
      // the API layer for new policies so Slice C can rely on every policy
      // having a valid value at runtime. The shared validator keeps it
      // optional to support PATCH paths that don't always re-send it.
      alwaysOn?: boolean;
      autoStartIdTag?: string;
    };
  }>('/sites/:siteId/fleet-policies', {
    preHandler: [requireOperator, requirePolicy('fleet.policy.write')],
  }, async (req, reply) => {
    const operator = req.currentOperator!;
    const { siteId } = req.params;
    if (!hasSiteAccess(siteId, operator.claims?.siteIds)) {
      return reply.status(403).send({ error: 'Forbidden' });
    }
    const site = await db.site.findUnique({ where: { id: siteId }, select: { id: true } });
    if (!site) return reply.status(404).send({ error: 'Site not found' });

    // Required-on-create check. Empty/whitespace also rejected — the shared
    // validator treats whitespace-only as "not provided" which is correct
    // for PATCH but not what we want here.
    const rawAutoStart = typeof req.body.autoStartIdTag === 'string'
      ? req.body.autoStartIdTag.trim()
      : '';
    if (rawAutoStart.length === 0) {
      return reply.status(400).send({
        error: 'ValidationError',
        errors: [{
          field: 'autoStartIdTag',
          code: 'REQUIRED',
          message: 'autoStartIdTag is required when creating a fleet policy',
        }],
      });
    }

    const siblings = await loadSiblings(siteId);
    const validation = validateFleetPolicyInput(
      {
        name: req.body.name,
        idTagPrefix: req.body.idTagPrefix,
        maxAmps: req.body.maxAmps,
        ocppStackLevel: req.body.ocppStackLevel,
        windowsJson: req.body.windowsJson,
        notes: req.body.notes,
        alwaysOn: req.body.alwaysOn,
        autoStartIdTag: rawAutoStart,
      },
      { siblingPolicies: siblings, requireWindows: false },
    );
    if (!validation.ok) {
      return reply.status(400).send({ error: 'ValidationError', errors: validation.errors });
    }
    const n = validation.normalized;

    // Hijack guard: refuse to assign an autoStartIdTag that already names a
    // real (or otherwise foreign) User row. See findUserIdTagCollision().
    const userCollision = await findUserIdTagCollision(n.autoStartIdTag);
    if (userCollision) {
      return reply.status(400).send({ error: 'ValidationError', errors: [userCollision] });
    }

    try {
      const created = await db.fleetPolicy.create({
        data: {
          siteId,
          name: n.name,
          status: 'DRAFT',
          idTagPrefix: n.idTagPrefix,
          maxAmps: n.maxAmps,
          ocppStackLevel: n.ocppStackLevel,
          windowsJson: n.windowsJson,
          notes: n.notes,
          alwaysOn: n.alwaysOn,
          autoStartIdTag: n.autoStartIdTag,
          createdByOperatorId: operator.id,
          updatedByOperatorId: operator.id,
        },
      });
      return reply.status(201).send(serialize(created));
    } catch (err: any) {
      // Unique constraint races. P2002 surfaces from either:
      //   - existing @@unique([siteId, idTagPrefix])
      //   - partial unique index on (siteId, autoStartIdTag) WHERE active
      // Use err.meta.target to disambiguate when present.
      if (err?.code === 'P2002') {
        const target = (err?.meta?.target as string[] | string | undefined);
        const tStr = Array.isArray(target) ? target.join(',') : (target ?? '');
        if (tStr.includes('autoStartIdTag')) {
          return reply.status(409).send({
            error: 'Conflict',
            errors: [{
              field: 'autoStartIdTag',
              code: 'AUTOSTART_COLLISION',
              message: `autoStartIdTag "${n.autoStartIdTag}" already exists at this site`,
            }],
          });
        }
        return reply.status(409).send({
          error: 'Conflict',
          errors: [{
            field: 'idTagPrefix',
            code: 'PREFIX_COLLISION',
            message: `idTagPrefix "${n.idTagPrefix}" already exists at this site`,
          }],
        });
      }
      throw err;
    }
  });

  // ─── PATCH /fleet-policies/:id ──────────────────────────────────────
  app.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      idTagPrefix?: string;
      maxAmps?: number;
      ocppStackLevel?: number;
      windowsJson?: unknown;
      notes?: string | null;
      alwaysOn?: boolean;
      autoStartIdTag?: string;
    };
  }>('/fleet-policies/:id', {
    preHandler: [requireOperator, requirePolicy('fleet.policy.write')],
  }, async (req, reply) => {
    const operator = req.currentOperator!;
    const existing = await db.fleetPolicy.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'FleetPolicy not found' });
    if (!hasSiteAccess(existing.siteId, operator.claims?.siteIds)) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    // Edits forbidden while ENABLED — must DISABLE first.
    if (existing.status === 'ENABLED') {
      return reply.status(409).send({
        error: 'PolicyEnabledImmutable',
        code: 'POLICY_ENABLED_IMMUTABLE',
        message: 'Fleet policy is ENABLED and cannot be edited — disable it first',
      });
    }

    const siblings = await loadSiblings(existing.siteId);
    const merged = {
      name: req.body.name ?? existing.name,
      idTagPrefix: req.body.idTagPrefix ?? existing.idTagPrefix,
      maxAmps: req.body.maxAmps ?? existing.maxAmps,
      ocppStackLevel: req.body.ocppStackLevel ?? existing.ocppStackLevel,
      windowsJson: req.body.windowsJson === undefined ? existing.windowsJson : req.body.windowsJson,
      notes: req.body.notes === undefined ? existing.notes : req.body.notes,
      alwaysOn: req.body.alwaysOn === undefined ? (existing.alwaysOn ?? false) : req.body.alwaysOn,
      autoStartIdTag:
        req.body.autoStartIdTag === undefined
          ? (existing.autoStartIdTag ?? undefined)
          : req.body.autoStartIdTag,
    };
    const validation = validateFleetPolicyInput(merged, {
      siblingPolicies: siblings,
      selfId: existing.id,
      requireWindows: false,
    });
    if (!validation.ok) {
      return reply.status(400).send({ error: 'ValidationError', errors: validation.errors });
    }
    const n = validation.normalized;

    // Hijack guard on update: only check when the autoStartIdTag is
    // actually changing relative to the existing row. Re-saving the same
    // value should be a no-op.
    if (n.autoStartIdTag && n.autoStartIdTag !== existing.autoStartIdTag) {
      const userCollision = await findUserIdTagCollision(n.autoStartIdTag);
      if (userCollision) {
        return reply.status(400).send({ error: 'ValidationError', errors: [userCollision] });
      }
    }

    try {
      const updated = await db.fleetPolicy.update({
        where: { id: existing.id },
        data: {
          name: n.name,
          idTagPrefix: n.idTagPrefix,
          maxAmps: n.maxAmps,
          ocppStackLevel: n.ocppStackLevel,
          windowsJson: n.windowsJson,
          notes: n.notes,
          alwaysOn: n.alwaysOn,
          // PATCH may either set a new value, keep existing (undefined in
          // input → resolved by merge above), or explicitly null it. The
          // validator returns null when the caller passed an explicit empty
          // string; we forward that through so operators can clear the
          // field on a DRAFT/DISABLED policy.
          autoStartIdTag: n.autoStartIdTag,
          updatedByOperatorId: operator.id,
        },
      });
      return serialize(updated);
    } catch (err: any) {
      if (err?.code === 'P2002') {
        const target = (err?.meta?.target as string[] | string | undefined);
        const tStr = Array.isArray(target) ? target.join(',') : (target ?? '');
        if (tStr.includes('autoStartIdTag')) {
          return reply.status(409).send({
            error: 'Conflict',
            errors: [{
              field: 'autoStartIdTag',
              code: 'AUTOSTART_COLLISION',
              message: `autoStartIdTag "${n.autoStartIdTag}" already exists at this site`,
            }],
          });
        }
        return reply.status(409).send({
          error: 'Conflict',
          errors: [{
            field: 'idTagPrefix',
            code: 'PREFIX_COLLISION',
            message: `idTagPrefix "${n.idTagPrefix}" already exists at this site`,
          }],
        });
      }
      throw err;
    }
  });

  // ─── POST /fleet-policies/:id/enable ────────────────────────────────
  app.post<{ Params: { id: string } }>('/fleet-policies/:id/enable', {
    preHandler: [requireOperator, requirePolicy('fleet.policy.write')],
  }, async (req, reply) => {
    const operator = req.currentOperator!;
    const existing = await db.fleetPolicy.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'FleetPolicy not found' });
    if (!hasSiteAccess(existing.siteId, operator.claims?.siteIds)) {
      return reply.status(403).send({ error: 'Forbidden' });
    }
    if (existing.status === 'ENABLED') {
      return serialize(existing); // idempotent
    }

    // Re-run full validation with requireWindows=true. Collision check must
    // ignore DISABLED siblings + self but catch any newly-added DRAFT/ENABLED
    // policy that landed while this one was disabled.
    const siblings = await loadSiblings(existing.siteId);
    const validation = validateFleetPolicyInput(
      {
        name: existing.name,
        idTagPrefix: existing.idTagPrefix,
        maxAmps: existing.maxAmps,
        ocppStackLevel: existing.ocppStackLevel,
        windowsJson: existing.windowsJson,
        notes: existing.notes,
      },
      { siblingPolicies: siblings, selfId: existing.id, requireWindows: true },
    );
    if (!validation.ok) {
      return reply.status(400).send({
        error: 'ValidationError',
        message: 'Cannot enable — policy fails validation',
        errors: validation.errors,
      });
    }

    const updated = await db.fleetPolicy.update({
      where: { id: existing.id },
      data: { status: 'ENABLED', updatedByOperatorId: operator.id },
    });
    return serialize(updated);
  });

  // ─── POST /fleet-policies/:id/disable ───────────────────────────────
  app.post<{ Params: { id: string } }>('/fleet-policies/:id/disable', {
    preHandler: [requireOperator, requirePolicy('fleet.policy.write')],
  }, async (req, reply) => {
    const operator = req.currentOperator!;
    const existing = await db.fleetPolicy.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'FleetPolicy not found' });
    if (!hasSiteAccess(existing.siteId, operator.claims?.siteIds)) {
      return reply.status(403).send({ error: 'Forbidden' });
    }
    if (existing.status === 'DISABLED') {
      return serialize(existing); // idempotent
    }
    const updated = await db.fleetPolicy.update({
      where: { id: existing.id },
      data: { status: 'DISABLED', updatedByOperatorId: operator.id },
    });
    return serialize(updated);
  });

  // ─── DELETE /fleet-policies/:id ─────────────────────────────────────
  app.delete<{ Params: { id: string } }>('/fleet-policies/:id', {
    preHandler: [requireOperator, requirePolicy('fleet.policy.write')],
  }, async (req, reply) => {
    const operator = req.currentOperator!;
    const existing = await db.fleetPolicy.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'FleetPolicy not found' });
    if (!hasSiteAccess(existing.siteId, operator.claims?.siteIds)) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    // Block delete if any Session ever referenced this policy — it carries
    // receipt context that a past billing snapshot may point at indirectly.
    // Operators must disable instead.
    const linkedSessionCount = await db.session.count({
      where: { fleetPolicyId: existing.id },
    });
    if (linkedSessionCount > 0) {
      return reply.status(409).send({
        error: 'PolicyInUse',
        code: 'POLICY_IN_USE',
        message:
          `Cannot delete fleet policy — ${linkedSessionCount} session(s) reference it. ` +
          `Disable the policy instead.`,
        detail: { linkedSessionCount },
      });
    }

    await db.fleetPolicy.delete({ where: { id: existing.id } });
    return reply.status(204).send();
  });

  // ─── POST /fleet-policies/:id/preview ───────────────────────────────
  // Advisory/non-mutating. Given optional `at` (defaults to now), return
  // intended gating mode + window match for diagnostic display in the UI.
  // Does NOT mutate any row and does NOT call the scheduler.
  app.post<{
    Params: { id: string };
    Body?: { at?: string };
  }>('/fleet-policies/:id/preview', {
    preHandler: [requireOperator, requirePolicy('fleet.policy.read')],
  }, async (req, reply) => {
    const operator = req.currentOperator!;
    const existing = await db.fleetPolicy.findUnique({
      where: { id: req.params.id },
      include: { site: { select: { timeZone: true } } },
    });
    if (!existing) return reply.status(404).send({ error: 'FleetPolicy not found' });
    if (!hasSiteAccess(existing.siteId, operator.claims?.siteIds)) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const atRaw = req.body?.at;
    const at = atRaw ? new Date(atRaw) : new Date();
    if (Number.isNaN(at.getTime())) {
      return reply.status(400).send({ error: 'BadRequest', message: 'invalid `at` timestamp' });
    }

    const evalResult = evaluateFleetWindowAt({
      at,
      windows: existing.windowsJson,
      timeZone: existing.site?.timeZone ?? null,
      alwaysOn: existing.alwaysOn,
    });

    return {
      advisory: true as const,
      policyId: existing.id,
      policyStatus: existing.status,
      at: at.toISOString(),
      timeZone: existing.site?.timeZone ?? null,
      active: evalResult.active,
      intendedMode: evalResult.active ? 'ALLOW' : 'GATE_ACTIVE',
      matchedWindow: evalResult.matchedWindow,
      nextTransitionAt: evalResult.nextTransitionAt?.toISOString() ?? null,
    };
  });
}
