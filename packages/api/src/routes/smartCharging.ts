import type { FastifyInstance } from 'fastify';
import { prisma } from '@ev-charger/shared';
import { requireOperator } from '../plugins/auth';
import { requirePolicy } from '../plugins/authorization';
import {
  getSmartChargingConfig,
  previewEffectiveSmartChargingLimit,
  reconcileSmartChargingForCharger,
  reconcileSmartChargingForChargers,
  validateProfileSchedule,
} from '../lib/smartCharging';
const db: any = prisma;

function hasSiteAccess(siteId: string | null, siteIds: string[] | undefined) {
  if (!siteIds || siteIds.length === 0) return true;
  if (siteIds.includes('*')) return true;
  if (!siteId) return true; // unassigned chargers accessible
  return siteIds.includes(siteId);
}

function coerceIsoDate(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function normalizeNullableString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function affectedChargerIdsFromProfile(profile: {
  scope: 'SITE' | 'GROUP' | 'CHARGER';
  siteId: string | null;
  chargerGroupId: string | null;
  chargerId: string | null;
}): Promise<string[]> {
  if (profile.scope === 'CHARGER' && profile.chargerId) return [profile.chargerId];

  if (profile.scope === 'GROUP' && profile.chargerGroupId) {
    const chargers = await db.charger.findMany({ where: { groupId: profile.chargerGroupId }, select: { id: true } });
    return chargers.map((c: { id: string }) => c.id);
  }

  if (profile.scope === 'SITE' && profile.siteId) {
    const chargers = await db.charger.findMany({ where: { siteId: profile.siteId }, select: { id: true } });
    return chargers.map((c: { id: string }) => c.id);
  }

  return [];
}

export async function smartChargingRoutes(app: FastifyInstance) {
  app.get('/smart-charging/config', {
    preHandler: [requireOperator, requirePolicy('charger.status.read')],
  }, async () => getSmartChargingConfig());

  app.get<{
    Querystring: { siteId?: string };
  }>('/smart-charging/groups', {
    preHandler: [requireOperator, requirePolicy('charger.status.read')],
  }, async (req) => {
    const groups = await db.chargerGroup.findMany({
      where: req.query.siteId ? { siteId: req.query.siteId } : undefined,
      include: {
        chargers: { select: { id: true, ocppId: true, status: true } },
        site: { select: { id: true, name: true } },
      },
      orderBy: [{ updatedAt: 'desc' }],
    });

    return groups.filter((group: any) => !group.siteId || hasSiteAccess(group.siteId, req.currentOperator?.claims?.siteIds));
  });

  app.post<{
    Body: {
      name: string;
      description?: string;
      siteId?: string;
    };
  }>('/smart-charging/groups', {
    preHandler: [requireOperator, requirePolicy('charger.reset')],
  }, async (req, reply) => {
    const siteId = normalizeNullableString(req.body.siteId);
    if (siteId && !hasSiteAccess(siteId, req.currentOperator?.claims?.siteIds)) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const group = await db.chargerGroup.create({
      data: {
        name: req.body.name.trim(),
        description: normalizeNullableString(req.body.description),
        siteId,
      },
    });

    return reply.status(201).send(group);
  });

  app.put<{
    Params: { id: string };
    Body: {
      name?: string;
      description?: string;
      siteId?: string | null;
    };
  }>('/smart-charging/groups/:id', {
    preHandler: [requireOperator, requirePolicy('charger.reset')],
  }, async (req, reply) => {
    const existing = await db.chargerGroup.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'Group not found' });

    const nextSiteId = req.body.siteId === undefined
      ? existing.siteId
      : normalizeNullableString(req.body.siteId);

    if (nextSiteId && !hasSiteAccess(nextSiteId, req.currentOperator?.claims?.siteIds)) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const updated = await db.chargerGroup.update({
      where: { id: req.params.id },
      data: {
        ...(req.body.name !== undefined ? { name: req.body.name.trim() } : {}),
        ...(req.body.description !== undefined ? { description: normalizeNullableString(req.body.description) } : {}),
        ...(req.body.siteId !== undefined ? { siteId: nextSiteId } : {}),
      },
    });

    return updated;
  });

  app.delete<{ Params: { id: string } }>('/smart-charging/groups/:id', {
    preHandler: [requireOperator, requirePolicy('charger.reset')],
  }, async (req, reply) => {
    const group = await db.chargerGroup.findUnique({
      where: { id: req.params.id },
      include: { chargers: { select: { id: true } } },
    });

    if (!group) return reply.status(404).send({ error: 'Group not found' });

    const affectedIds = group.chargers.map((c: { id: string }) => c.id);
    await db.chargerGroup.delete({ where: { id: group.id } });

    const reconciled = await reconcileSmartChargingForChargers(affectedIds, 'group_deleted');
    return { deleted: true, affectedChargers: reconciled };
  });

  app.post<{ Params: { id: string; chargerId: string } }>('/smart-charging/groups/:id/chargers/:chargerId', {
    preHandler: [requireOperator, requirePolicy('charger.reset')],
  }, async (req, reply) => {
    const [group, charger] = await Promise.all([
      db.chargerGroup.findUnique({ where: { id: req.params.id } }),
      db.charger.findUnique({ where: { id: req.params.chargerId }, select: { id: true, siteId: true } }),
    ]);

    if (!group) return reply.status(404).send({ error: 'Group not found' });
    if (!charger) return reply.status(404).send({ error: 'Charger not found' });

    if (!hasSiteAccess(charger.siteId, req.currentOperator?.claims?.siteIds)) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    await db.charger.update({ where: { id: charger.id }, data: { groupId: group.id } });
    const reconciled = await reconcileSmartChargingForCharger(charger.id, 'group_assignment_changed');

    return { assigned: true, reconciled };
  });

  app.delete<{ Params: { id: string; chargerId: string } }>('/smart-charging/groups/:id/chargers/:chargerId', {
    preHandler: [requireOperator, requirePolicy('charger.reset')],
  }, async (req, reply) => {
    const charger = await db.charger.findUnique({
      where: { id: req.params.chargerId },
      select: { id: true, groupId: true, siteId: true },
    });

    if (!charger) return reply.status(404).send({ error: 'Charger not found' });
    if (charger.groupId !== req.params.id) return reply.status(409).send({ error: 'Charger is not assigned to this group' });

    if (!hasSiteAccess(charger.siteId, req.currentOperator?.claims?.siteIds)) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    await db.charger.update({ where: { id: charger.id }, data: { groupId: null } });
    const reconciled = await reconcileSmartChargingForCharger(charger.id, 'group_assignment_changed');

    return { unassigned: true, reconciled };
  });

  app.get<{
    Querystring: {
      scope?: 'CHARGER' | 'GROUP' | 'SITE';
      siteId?: string;
      chargerGroupId?: string;
      chargerId?: string;
      enabled?: 'true' | 'false';
    };
  }>('/smart-charging/profiles', {
    preHandler: [requireOperator, requirePolicy('charger.status.read')],
  }, async (req) => {
    return db.smartChargingProfile.findMany({
      where: {
        ...(req.query.scope ? { scope: req.query.scope } : {}),
        ...(req.query.siteId ? { siteId: req.query.siteId } : {}),
        ...(req.query.chargerGroupId ? { chargerGroupId: req.query.chargerGroupId } : {}),
        ...(req.query.chargerId ? { chargerId: req.query.chargerId } : {}),
        ...(req.query.enabled ? { enabled: req.query.enabled === 'true' } : {}),
      },
      orderBy: [{ scope: 'asc' }, { priority: 'desc' }, { updatedAt: 'desc' }],
    });
  });

  app.post<{
    Body: {
      name: string;
      scope: 'CHARGER' | 'GROUP' | 'SITE';
      enabled?: boolean;
      priority?: number;
      defaultLimitKw?: number | null;
      schedule?: unknown;
      validFrom?: string;
      validTo?: string;
      siteId?: string;
      chargerGroupId?: string;
      chargerId?: string;
    };
  }>('/smart-charging/profiles', {
    preHandler: [requireOperator, requirePolicy('charger.reset')],
  }, async (req, reply) => {
    const validFrom = coerceIsoDate(req.body.validFrom);
    const validTo = coerceIsoDate(req.body.validTo);
    if (req.body.validFrom && !validFrom) return reply.status(400).send({ error: 'validFrom must be an ISO date' });
    if (req.body.validTo && !validTo) return reply.status(400).send({ error: 'validTo must be an ISO date' });
    if (validFrom && validTo && validFrom > validTo) return reply.status(400).send({ error: 'validFrom must be <= validTo' });

    const scheduleValidation = validateProfileSchedule(req.body.schedule);
    if (!scheduleValidation.ok) return reply.status(400).send({ error: scheduleValidation.error });

    const data: Record<string, unknown> = {
      name: req.body.name.trim(),
      scope: req.body.scope,
      enabled: req.body.enabled ?? true,
      priority: req.body.priority ?? 0,
      defaultLimitKw: req.body.defaultLimitKw ?? null,
      schedule: scheduleValidation.normalized,
      validFrom,
      validTo,
      createdByOperatorId: req.currentOperator?.id ?? null,
      updatedByOperatorId: req.currentOperator?.id ?? null,
    };

    if (req.body.scope === 'CHARGER') {
      if (!req.body.chargerId) return reply.status(400).send({ error: 'chargerId is required for CHARGER scope' });
      const charger = await db.charger.findUnique({ where: { id: req.body.chargerId }, select: { id: true, siteId: true } });
      if (!charger) return reply.status(404).send({ error: 'Charger not found' });
      if (!hasSiteAccess(charger.siteId, req.currentOperator?.claims?.siteIds)) return reply.status(403).send({ error: 'Forbidden' });
      data.chargerId = charger.id;
    }

    if (req.body.scope === 'GROUP') {
      if (!req.body.chargerGroupId) return reply.status(400).send({ error: 'chargerGroupId is required for GROUP scope' });
      const group = await db.chargerGroup.findUnique({ where: { id: req.body.chargerGroupId } });
      if (!group) return reply.status(404).send({ error: 'Group not found' });
      if (group.siteId && !hasSiteAccess(group.siteId, req.currentOperator?.claims?.siteIds)) return reply.status(403).send({ error: 'Forbidden' });
      data.chargerGroupId = group.id;
    }

    if (req.body.scope === 'SITE') {
      if (!req.body.siteId) return reply.status(400).send({ error: 'siteId is required for SITE scope' });
      if (!hasSiteAccess(req.body.siteId, req.currentOperator?.claims?.siteIds)) return reply.status(403).send({ error: 'Forbidden' });
      data.siteId = req.body.siteId;
    }

    const profile = await db.smartChargingProfile.create({ data: data as any });
    const affectedChargerIds = await affectedChargerIdsFromProfile(profile);
    const reconciled = await reconcileSmartChargingForChargers(affectedChargerIds, 'profile_created');

    return reply.status(201).send({ profile, reconciled });
  });

  app.put<{
    Params: { id: string };
    Body: {
      name?: string;
      enabled?: boolean;
      priority?: number;
      defaultLimitKw?: number | null;
      schedule?: unknown;
      validFrom?: string | null;
      validTo?: string | null;
    };
  }>('/smart-charging/profiles/:id', {
    preHandler: [requireOperator, requirePolicy('charger.reset')],
  }, async (req, reply) => {
    const existing = await db.smartChargingProfile.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'Profile not found' });

    const validFrom = req.body.validFrom === null ? null : coerceIsoDate(req.body.validFrom ?? undefined);
    const validTo = req.body.validTo === null ? null : coerceIsoDate(req.body.validTo ?? undefined);
    if (req.body.validFrom !== undefined && req.body.validFrom !== null && !validFrom) {
      return reply.status(400).send({ error: 'validFrom must be an ISO date' });
    }
    if (req.body.validTo !== undefined && req.body.validTo !== null && !validTo) {
      return reply.status(400).send({ error: 'validTo must be an ISO date' });
    }

    const scheduleValidation = req.body.schedule !== undefined
      ? validateProfileSchedule(req.body.schedule)
      : null;
    if (scheduleValidation && !scheduleValidation.ok) {
      return reply.status(400).send({ error: scheduleValidation.error });
    }

    const updated = await db.smartChargingProfile.update({
      where: { id: existing.id },
      data: {
        ...(req.body.name !== undefined ? { name: req.body.name.trim() } : {}),
        ...(req.body.enabled !== undefined ? { enabled: req.body.enabled } : {}),
        ...(req.body.priority !== undefined ? { priority: req.body.priority } : {}),
        ...(req.body.defaultLimitKw !== undefined ? { defaultLimitKw: req.body.defaultLimitKw } : {}),
        ...(scheduleValidation?.ok ? { schedule: scheduleValidation.normalized } : {}),
        ...(req.body.validFrom !== undefined ? { validFrom } : {}),
        ...(req.body.validTo !== undefined ? { validTo } : {}),
        updatedByOperatorId: req.currentOperator?.id ?? null,
      },
    });

    const affectedChargerIds = await affectedChargerIdsFromProfile(updated);
    const reconciled = await reconcileSmartChargingForChargers(affectedChargerIds, 'profile_updated');
    return { profile: updated, reconciled };
  });

  app.delete<{ Params: { id: string } }>('/smart-charging/profiles/:id', {
    preHandler: [requireOperator, requirePolicy('charger.reset')],
  }, async (req, reply) => {
    const existing = await db.smartChargingProfile.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'Profile not found' });

    const affectedChargerIds = await affectedChargerIdsFromProfile(existing);
    await db.smartChargingProfile.delete({ where: { id: existing.id } });

    const reconciled = await reconcileSmartChargingForChargers(affectedChargerIds, 'profile_deleted');
    return { deleted: true, reconciled };
  });

  app.get<{ Params: { chargerId: string } }>('/smart-charging/chargers/:chargerId/effective', {
    preHandler: [requireOperator, requirePolicy('charger.status.read')],
  }, async (req, reply) => {
    const charger = await db.charger.findUnique({ where: { id: req.params.chargerId }, select: { siteId: true } });
    if (!charger) return reply.status(404).send({ error: 'Charger not found' });
    if (!hasSiteAccess(charger.siteId, req.currentOperator?.claims?.siteIds)) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    return previewEffectiveSmartChargingLimit(req.params.chargerId);
  });

  app.post<{ Params: { chargerId: string } }>('/smart-charging/chargers/:chargerId/reconcile', {
    preHandler: [requireOperator, requirePolicy('charger.reset')],
  }, async (req, reply) => {
    const charger = await db.charger.findUnique({ where: { id: req.params.chargerId }, select: { siteId: true } });
    if (!charger) return reply.status(404).send({ error: 'Charger not found' });
    if (!hasSiteAccess(charger.siteId, req.currentOperator?.claims?.siteIds)) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    return reconcileSmartChargingForCharger(req.params.chargerId, 'manual_reconcile');
  });

  app.get<{
    Querystring: { siteId?: string; status?: string };
  }>('/smart-charging/states', {
    preHandler: [requireOperator, requirePolicy('charger.status.read')],
  }, async (req) => {
    const states = await db.smartChargingState.findMany({
      where: {
        ...(req.query.status ? { status: req.query.status } : {}),
        ...(req.query.siteId
          ? {
              charger: {
                siteId: req.query.siteId,
              },
            }
          : {}),
      },
      include: {
        charger: { select: { id: true, ocppId: true, siteId: true, status: true } },
        sourceProfile: { select: { id: true, name: true, scope: true } },
      },
      orderBy: [{ updatedAt: 'desc' }],
      take: 200,
    });

    return states.filter((state: any) => hasSiteAccess(state.charger.siteId, req.currentOperator?.claims?.siteIds));
  });

  // Composite schedule — ask the charger for its own merged schedule view
  app.get<{ Params: { chargerId: string }; Querystring: { duration?: string } }>('/smart-charging/chargers/:chargerId/composite-schedule', {
    preHandler: [requireOperator, requirePolicy('charger.status.read')],
  }, async (req, reply) => {
    const charger = await db.charger.findUnique({ where: { id: req.params.chargerId }, select: { siteId: true, ocppId: true } });
    if (!charger) return reply.status(404).send({ error: 'Charger not found' });
    if (!hasSiteAccess(charger.siteId, req.currentOperator?.claims?.siteIds)) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const { getCompositeSchedule: getComposite } = await import('../lib/ocppClient');
    const duration = Number(req.query.duration) || 86400;
    const result = await getComposite(charger.ocppId, { connectorId: 0, duration });
    if (!result) return reply.status(502).send({ error: 'Charger not connected or call failed' });
    return result;
  });

  // Stacking preview — server-side merged schedule for all active profiles on a charger
  app.get<{ Params: { chargerId: string }; Querystring: { at?: string } }>('/smart-charging/chargers/:chargerId/stacking-preview', {
    preHandler: [requireOperator, requirePolicy('charger.status.read')],
  }, async (req, reply) => {
    const charger = await db.charger.findUnique({ where: { id: req.params.chargerId }, select: { siteId: true } });
    if (!charger) return reply.status(404).send({ error: 'Charger not found' });
    if (!hasSiteAccess(charger.siteId, req.currentOperator?.claims?.siteIds)) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const at = req.query.at ? new Date(req.query.at) : undefined;
    return previewEffectiveSmartChargingLimit(req.params.chargerId, at);
  });
}
