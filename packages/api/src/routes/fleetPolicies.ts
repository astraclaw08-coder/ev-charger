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
    createdByOperatorId: p.createdByOperatorId,
    updatedByOperatorId: p.updatedByOperatorId,
    createdAt: p.createdAt instanceof Date ? p.createdAt.toISOString() : p.createdAt,
    updatedAt: p.updatedAt instanceof Date ? p.updatedAt.toISOString() : p.updatedAt,
  };
}

async function loadSiblings(siteId: string): Promise<SiblingPolicy[]> {
  const rows = await db.fleetPolicy.findMany({
    where: { siteId },
    select: { id: true, idTagPrefix: true, status: true },
  });
  return rows.map((r: any) => ({
    id: r.id,
    idTagPrefix: r.idTagPrefix,
    status: r.status as FleetPolicyStatusLiteral,
  }));
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

    const siblings = await loadSiblings(siteId);
    const validation = validateFleetPolicyInput(
      {
        name: req.body.name,
        idTagPrefix: req.body.idTagPrefix,
        maxAmps: req.body.maxAmps,
        ocppStackLevel: req.body.ocppStackLevel,
        windowsJson: req.body.windowsJson,
        notes: req.body.notes,
      },
      { siblingPolicies: siblings, requireWindows: false },
    );
    if (!validation.ok) {
      return reply.status(400).send({ error: 'ValidationError', errors: validation.errors });
    }
    const n = validation.normalized;

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
          createdByOperatorId: operator.id,
          updatedByOperatorId: operator.id,
        },
      });
      return reply.status(201).send(serialize(created));
    } catch (err: any) {
      // Unique constraint on (siteId, idTagPrefix) — race between two operators
      if (err?.code === 'P2002') {
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
          updatedByOperatorId: operator.id,
        },
      });
      return serialize(updated);
    } catch (err: any) {
      if (err?.code === 'P2002') {
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
