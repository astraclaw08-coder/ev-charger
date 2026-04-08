import type { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { prisma, resolveSessionStatusTimings } from '@ev-charger/shared';
import { requireOperator } from '../plugins/auth';
import { requirePolicy } from '../plugins/authorization';
import { remoteReset, remoteStart, triggerHeartbeat, getConfiguration } from '../lib/ocppClient';
import { getChargerUptime } from '../lib/uptime';
import { computeSessionAmounts } from '../lib/sessionBilling';
import { assessChargerHealth } from '../lib/chargerHealthAgent';

function hasSiteAccess(siteId: string | null, siteIds: string[] | undefined) {
  if (!siteIds || siteIds.length === 0) return true;
  if (siteIds.includes('*')) return true;
  if (!siteId) return true; // unassigned chargers are accessible to any scoped operator
  return siteIds.includes(siteId);
}

/**
 * Resolve a charger by exact UUID, exact ocppId/serialNumber,
 * or partial prefix match on id/ocppId/serialNumber.
 */
async function resolveChargerId(param: string): Promise<string | null> {
  // 1. Exact UUID match
  if (param.length === 36) {
    const c = await prisma.charger.findUnique({ where: { id: param }, select: { id: true } });
    if (c) return c.id;
  }

  // 2. Exact ocppId match
  const byOcpp = await prisma.charger.findUnique({ where: { ocppId: param }, select: { id: true } });
  if (byOcpp) return byOcpp.id;

  // 3. Exact serialNumber match
  const bySerial = await prisma.charger.findUnique({ where: { serialNumber: param }, select: { id: true } });
  if (bySerial) return bySerial.id;

  // 4. Partial prefix match on id, ocppId, or serialNumber (case-insensitive)
  const byPartial = await prisma.charger.findFirst({
    where: {
      OR: [
        { id: { startsWith: param } },
        { ocppId: { startsWith: param, mode: 'insensitive' } },
        { serialNumber: { startsWith: param, mode: 'insensitive' } },
      ],
    },
    select: { id: true },
  });
  return byPartial?.id ?? null;
}

export async function chargerRoutes(app: FastifyInstance) {
  // GET /chargers/search?q=... — partial match on ocppId, serialNumber, or site name
  app.get<{ Querystring: { q?: string; limit?: string } }>('/chargers/search', async (req) => {
    const q = (req.query.q ?? '').trim();
    const limit = Math.min(parseInt(req.query.limit ?? '10', 10) || 10, 25);
    if (q.length < 2) return [];

    const chargers = await prisma.charger.findMany({
      where: {
        OR: [
          { ocppId: { contains: q, mode: 'insensitive' } },
          { serialNumber: { contains: q, mode: 'insensitive' } },
          { site: { name: { contains: q, mode: 'insensitive' } } },
        ],
      },
      take: limit,
      include: {
        site: { select: { id: true, name: true, address: true } },
        connectors: { select: { id: true, connectorId: true, status: true } },
      },
    });

    return chargers.map(({ password: _pw, ...c }: { password: unknown;[k: string]: unknown }) => c);
  });

  // GET /chargers — list chargers with optional bbox filter
  app.get<{
    Querystring: { minLat?: string; maxLat?: string; minLng?: string; maxLng?: string };
  }>('/chargers', async (req) => {
    const { minLat, maxLat, minLng, maxLng } = req.query;
    const hasBbox = minLat && maxLat && minLng && maxLng;

    const chargers = await prisma.charger.findMany({
      where: hasBbox
        ? {
            site: {
              lat: { gte: parseFloat(minLat!), lte: parseFloat(maxLat!) },
              lng: { gte: parseFloat(minLng!), lte: parseFloat(maxLng!) },
            },
          }
        : undefined,
      include: {
        site: {
          select: {
            id: true,
            name: true,
            address: true,
            lat: true,
            lng: true,
            pricingMode: true,
            pricePerKwhUsd: true,
            idleFeePerMinUsd: true,
            activationFeeUsd: true,
            gracePeriodMin: true,
            touWindows: true,
          },
        },
        connectors: { select: { id: true, connectorId: true, status: true } },
      },
    });

    return chargers.map(({ password: _pw, ...c }: { password: string; [k: string]: unknown }) => c);
  });

  // GET /chargers/:id — full charger detail
  app.get<{ Params: { id: string } }>('/chargers/:id', async (req, reply) => {
    const resolvedId = await resolveChargerId(req.params.id);
    if (!resolvedId) return reply.status(404).send({ error: 'Charger not found' });

    const charger = await prisma.charger.findUnique({
      where: { id: resolvedId },
      include: {
        site: true,
        connectors: {
          include: {
            sessions: { where: { status: 'ACTIVE' }, take: 1 },
          },
        },
      },
    });

    if (!charger) return reply.status(404).send({ error: 'Charger not found' });

    // Fetch latest PLUG_OUT transition per connector so mobile can detect
    // session-end even before the session API catches up.
    const plugOutTransitions = await prisma.connectorStateTransition.findMany({
      where: {
        chargerId: resolvedId,
        transitionType: 'PLUG_OUT',
      },
      orderBy: { occurredAt: 'desc' },
      distinct: ['connectorId'],
      select: { connectorId: true, occurredAt: true },
    });
    const plugOutMap = new Map(plugOutTransitions.map((t) => [t.connectorId, t.occurredAt]));

    const { password: _pw, ...safeCharger } = charger;
    return {
      ...safeCharger,
      connectors: safeCharger.connectors.map((c: any) => ({
        ...c,
        lastPlugOutAt: plugOutMap.get(c.connectorId)?.toISOString() ?? null,
      })),
    };
  });

  // GET /chargers/:id/status — real-time state (operator only)
  app.get<{ Params: { id: string } }>('/chargers/:id/status', {
    preHandler: [requireOperator, requirePolicy('charger.status.read')],
  }, async (req, reply) => {
    const resolvedStatusId = await resolveChargerId(req.params.id);
    if (!resolvedStatusId) return reply.status(404).send({ error: 'Charger not found' });

    const charger = await prisma.charger.findUnique({
      where: { id: resolvedStatusId },
      include: {
        connectors: {
          include: {
            sessions: {
              where: { status: 'ACTIVE' },
              take: 1,
              include: { user: { select: { id: true, name: true, email: true } } },
            },
          },
        },
      },
    });

    if (!charger) return reply.status(404).send({ error: 'Charger not found' });
    if (!hasSiteAccess(charger.siteId, req.currentOperator?.claims?.siteIds)) {
      return reply.status(403).send({
        error: 'Forbidden',
        denyReason: { code: 'SITE_OUT_OF_SCOPE', reason: `Site ${charger.siteId} is not in granted siteIds`, policy: 'charger.status.read' },
      });
    }

    return {
      id: charger.id,
      ocppId: charger.ocppId,
      status: charger.status,
      lastHeartbeat: charger.lastHeartbeat,
      connectors: charger.connectors.map((c: { connectorId: number; status: string; sessions: Array<unknown> }) => ({
        connectorId: c.connectorId,
        status: c.status,
        activeSession: c.sessions[0] ?? null,
      })),
    };
  });

  // POST /chargers — register a charger to a site (operator only)
  app.post<{
    Body: { siteId: string; ocppId: string; serialNumber: string; model: string; vendor: string };
  }>('/chargers', {
    preHandler: [requireOperator, requirePolicy('charger.register')],
  }, async (req, reply) => {
    const { siteId, ocppId, serialNumber, model, vendor } = req.body;

    const site = await prisma.site.findUnique({ where: { id: siteId } });
    if (!site) return reply.status(404).send({ error: 'Site not found' });
    if (!hasSiteAccess(site.id, req.currentOperator?.claims?.siteIds)) {
      return reply.status(403).send({
        error: 'Forbidden',
        denyReason: { code: 'SITE_OUT_OF_SCOPE', reason: `Site ${site.id} is not in granted siteIds`, policy: 'charger.register' },
      });
    }

    const existing = await prisma.charger.findFirst({ where: { ocppId } });
    if (existing) return reply.status(409).send({ error: `ocppId "${ocppId}" is already registered` });

    const rawPassword = crypto.randomBytes(16).toString('hex');
    const hashedPassword = crypto.createHash('sha256').update(rawPassword).digest('hex');

    const charger = await prisma.charger.create({
      data: {
        siteId,
        ocppId,
        serialNumber,
        model,
        vendor,
        password: hashedPassword,
        connectors: { create: [{ connectorId: 1 }] },
      },
    });

    const ocppEndpoint = `${process.env.OCPP_WS_URL ?? 'ws://localhost:9000'}/${ocppId}`;

    return reply.status(201).send({
      id: charger.id,
      ocppId: charger.ocppId,
      serialNumber: charger.serialNumber,
      ocppEndpoint,
      password: rawPassword, // shown once — store it on the charger
    });
  });

  // POST /chargers/:id/unassign — remove charger from its site (preserves all historical sessions)
  app.post<{
    Params: { id: string };
    Body: { reason?: string };
  }>('/chargers/:id/unassign', {
    preHandler: [requireOperator, requirePolicy('charger.register')],
  }, async (req, reply) => {
    const resolvedId = await resolveChargerId(req.params.id);
    if (!resolvedId) return reply.status(404).send({ error: 'Charger not found' });

    const charger = await prisma.charger.findUnique({
      where: { id: resolvedId },
      select: { id: true, ocppId: true, siteId: true, site: { select: { name: true } } },
    });
    if (!charger) return reply.status(404).send({ error: 'Charger not found' });
    if (!charger.siteId) return reply.status(400).send({ error: 'Charger is not assigned to any site' });

    if (!hasSiteAccess(charger.siteId, req.currentOperator?.claims?.siteIds)) {
      return reply.status(403).send({
        error: 'Forbidden',
        denyReason: { code: 'SITE_OUT_OF_SCOPE', reason: `Site ${charger.siteId} is not in granted siteIds`, policy: 'charger.register' },
      });
    }

    const previousSiteId = charger.siteId;
    const previousSiteName = charger.site?.name ?? previousSiteId;

    // Unassign: set siteId to null — sessions linked via Connector are preserved
    await prisma.charger.update({
      where: { id: resolvedId },
      data: { siteId: null },
    });

    // Audit log
    await prisma.adminAuditEvent.create({
      data: {
        operatorId: req.currentOperator?.id ?? 'unknown',
        action: 'charger.unassign',
        metadata: {
          chargerId: resolvedId,
          ocppId: charger.ocppId,
          previousSiteId,
          previousSiteName,
          reason: req.body?.reason ?? null,
        },
      },
    });

    return {
      unassigned: true,
      chargerId: resolvedId,
      ocppId: charger.ocppId,
      previousSiteId,
      previousSiteName,
    };
  });

  // GET /chargers/:id/sessions — recent sessions on this charger (operator only)
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/chargers/:id/sessions', {
    preHandler: [requireOperator, requirePolicy('charger.sessions.read')],
  }, async (req, reply) => {
    const charger = await prisma.charger.findUnique({
      where: { id: req.params.id },
      include: { connectors: { select: { id: true } } },
    });
    if (!charger) return reply.status(404).send({ error: 'Charger not found' });
    if (!hasSiteAccess(charger.siteId, req.currentOperator?.claims?.siteIds)) {
      return reply.status(403).send({
        error: 'Forbidden',
        denyReason: { code: 'SITE_OUT_OF_SCOPE', reason: `Site ${charger.siteId} is not in granted siteIds`, policy: 'charger.sessions.read' },
      });
    }

    const connectorIds = charger.connectors.map((c: { id: string }) => c.id);
    const limit = Math.min(parseInt(req.query.limit ?? '20', 10), 100);
    const site = charger.siteId ? await prisma.site.findUnique({
      where: { id: charger.siteId },
      select: {
        pricingMode: true,
        pricePerKwhUsd: true,
        idleFeePerMinUsd: true,
        activationFeeUsd: true,
        gracePeriodMin: true,
        touWindows: true,
        softwareVendorFeeMode: true,
        softwareVendorFeeValue: true,
        softwareFeeIncludesActivation: true,
      },
    }) : null;

    const sessions = await prisma.session.findMany({
      where: { connectorId: { in: connectorIds } },
      orderBy: { startedAt: 'desc' },
      take: limit,
      include: {
        connector: {
          select: {
            connectorId: true,
            charger: { select: { id: true } },
          },
        },
        user: { select: { name: true, email: true } },
        payment: { select: { status: true, amountCents: true } },
        billingSnapshot: {
          select: {
            kwhDelivered: true,
            grossAmountUsd: true,
            billingBreakdownJson: true,
          },
        },
      },
    });

    const chargerStatusLogs = await prisma.ocppLog.findMany({
      where: {
        chargerId: charger.id,
        action: 'StatusNotification',
      },
      orderBy: { createdAt: 'desc' },
      take: 10000,
    });

    return sessions.map((s: any) => {
      const sessionTimings = resolveSessionStatusTimings(s, chargerStatusLogs);
      const amounts = computeSessionAmounts({
        ...s,
        startedAt: sessionTimings.plugOutAt ? s.startedAt : s.startedAt,
        stoppedAt: sessionTimings.plugOutAt ? new Date(sessionTimings.plugOutAt) : s.stoppedAt,
        plugOutAt: sessionTimings.plugOutAt ? new Date(sessionTimings.plugOutAt) : undefined,
        pricingMode: site?.pricingMode,
        pricePerKwhUsd: site?.pricePerKwhUsd,
        idleFeePerMinUsd: site?.idleFeePerMinUsd,
        activationFeeUsd: site?.activationFeeUsd,
        gracePeriodMin: site?.gracePeriodMin,
        touWindows: site?.touWindows,
        softwareVendorFeeMode: site?.softwareVendorFeeMode,
        softwareVendorFeeValue: site?.softwareVendorFeeValue,
        softwareFeeIncludesActivation: site?.softwareFeeIncludesActivation,
      });
      const snapshot = s.billingSnapshot;
      const snapshotGrossCents = snapshot?.grossAmountUsd != null ? Math.round(Number(snapshot.grossAmountUsd) * 100) : null;
      return {
        ...s,
        plugInAt: sessionTimings.plugInAt ?? s.startedAt,
        plugOutAt: sessionTimings.plugOutAt ?? s.stoppedAt,
        kwhDelivered: snapshot?.kwhDelivered ?? amounts.kwhDelivered,
        effectiveAmountCents: snapshotGrossCents ?? amounts.effectiveAmountCents,
        estimatedAmountCents: snapshotGrossCents ?? amounts.estimatedAmountCents,
        amountState: snapshot ? 'FINAL' : amounts.amountState,
        amountLabel: snapshot ? 'Final' : amounts.amountLabel,
        isAmountFinal: snapshot ? true : amounts.isAmountFinal,
        billingBreakdown: snapshot?.billingBreakdownJson ?? amounts.billingBreakdown,
      };
    });
  });



  // GET /chargers/:id/uptime — rolling uptime windows + incidents
  app.get<{ Params: { id: string } }>('/chargers/:id/uptime', {
    preHandler: [requireOperator, requirePolicy('charger.uptime.read')],
  }, async (req, reply) => {
    const charger = await prisma.charger.findUnique({ where: { id: req.params.id }, select: { siteId: true } });
    if (!charger) return reply.status(404).send({ error: 'Charger not found' });
    if (!hasSiteAccess(charger.siteId, req.currentOperator?.claims?.siteIds)) {
      return reply.status(403).send({
        error: 'Forbidden',
        denyReason: { code: 'SITE_OUT_OF_SCOPE', reason: `Site ${charger.siteId} is not in granted siteIds`, policy: 'charger.uptime.read' },
      });
    }

    const uptime = await getChargerUptime(req.params.id);
    if (!uptime) return reply.status(404).send({ error: 'Charger not found' });
    return uptime;
  });

  // GET /chargers/:id/connection-events — recent transport lifecycle events (operator only)
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/chargers/:id/connection-events', {
    preHandler: [requireOperator, requirePolicy('charger.uptime.read')],
  }, async (req, reply) => {
    const resolvedId = await resolveChargerId(req.params.id);
    if (!resolvedId) return reply.status(404).send({ error: 'Charger not found' });

    const charger = await prisma.charger.findUnique({
      where: { id: resolvedId },
      select: { id: true, ocppId: true, siteId: true },
    });
    if (!charger) return reply.status(404).send({ error: 'Charger not found' });
    if (!hasSiteAccess(charger.siteId, req.currentOperator?.claims?.siteIds)) {
      return reply.status(403).send({
        error: 'Forbidden',
        denyReason: { code: 'SITE_OUT_OF_SCOPE', reason: `Site ${charger.siteId} is not in granted siteIds`, policy: 'charger.uptime.read' },
      });
    }

    const limit = Math.min(parseInt(req.query.limit ?? '50', 10) || 50, 200);
    const events = await prisma.chargerConnectionEvent.findMany({
      where: { chargerId: charger.id },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return {
      chargerId: charger.id,
      ocppId: charger.ocppId,
      events: events.map((e: any) => ({
        id: e.id,
        event: e.event,
        sessionId: e.sessionId,
        connectedAt: e.connectedAt?.toISOString() ?? null,
        disconnectedAt: e.disconnectedAt?.toISOString() ?? null,
        durationMs: e.durationMs,
        closeCode: e.closeCode,
        closeReason: e.closeReason,
        remoteAddress: e.remoteAddress,
        host: e.host,
        path: e.path,
        userAgent: e.userAgent,
        transportMeta: e.transportMeta,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  });

  // GET /chargers/:id/health-assessment — AI-powered charger health diagnostic (operator only)
  app.get<{
    Params: { id: string };
    Querystring: { connectorId?: string };
  }>('/chargers/:id/health-assessment', {
    preHandler: [requireOperator, requirePolicy('charger.status.read')],
  }, async (req, reply) => {
    const resolvedId = await resolveChargerId(req.params.id);
    if (!resolvedId) return reply.status(404).send({ error: 'Charger not found' });

    const charger = await prisma.charger.findUnique({
      where: { id: resolvedId },
      select: { siteId: true },
    });
    if (!charger) return reply.status(404).send({ error: 'Charger not found' });
    if (!hasSiteAccess(charger.siteId, req.currentOperator?.claims?.siteIds)) {
      return reply.status(403).send({
        error: 'Forbidden',
        denyReason: { code: 'SITE_OUT_OF_SCOPE', reason: `Site ${charger.siteId} is not in granted siteIds`, policy: 'charger.status.read' },
      });
    }

    const connectorId = req.query.connectorId ? parseInt(req.query.connectorId, 10) : undefined;

    try {
      const report = await assessChargerHealth(resolvedId, connectorId);

      // Persist assessment for audit trail
      await prisma.chargerHealthAssessment.create({
        data: {
          chargerId: resolvedId,
          connectorId: connectorId ?? null,
          overallScore: report.overallScore,
          overallStatus: report.overallStatus,
          reportJson: report as any,
          requestedBy: req.currentOperator?.id ?? 'unknown',
        },
      });

      return report;
    } catch (err: any) {
      req.log.error({ err, chargerId: resolvedId }, 'Health assessment failed');
      return reply.status(500).send({ error: 'Health assessment failed', detail: err?.message });
    }
  });

  // POST /chargers/:id/reset — operator reboots a charger
  app.post<{
    Params: { id: string };
    Body: { type?: 'Soft' | 'Hard' };
  }>('/chargers/:id/reset', {
    preHandler: [requireOperator, requirePolicy('charger.reset')],
  }, async (req, reply) => {
    const charger = await prisma.charger.findUnique({ where: { id: req.params.id } });
    if (!charger) return reply.status(404).send({ error: 'Charger not found' });
    if (!hasSiteAccess(charger.siteId, req.currentOperator?.claims?.siteIds)) {
      return reply.status(403).send({
        error: 'Forbidden',
        denyReason: { code: 'SITE_OUT_OF_SCOPE', reason: `Site ${charger.siteId} is not in granted siteIds`, policy: 'charger.reset' },
      });
    }

    const type = req.body?.type ?? 'Soft';
    const status = await remoteReset(charger.ocppId, type);
    return { status };
  });

  // POST /chargers/:id/remote-start — operator initiates remote start
  app.post<{
    Params: { id: string };
    Body: { connectorId: number; idTag?: string };
  }>('/chargers/:id/remote-start', {
    preHandler: [requireOperator],
  }, async (req, reply) => {
    const charger = await prisma.charger.findUnique({
      where: { id: req.params.id },
      include: { connectors: { where: { connectorId: req.body.connectorId } } },
    });
    if (!charger) return reply.status(404).send({ error: 'Charger not found' });
    if (!hasSiteAccess(charger.siteId, req.currentOperator?.claims?.siteIds)) {
      return reply.status(403).send({
        error: 'Forbidden',
        denyReason: { code: 'SITE_OUT_OF_SCOPE', reason: `Site ${charger.siteId} is not in granted siteIds`, policy: 'charger.remote_start' },
      });
    }

    const connector = charger.connectors[0];
    if (!connector) return reply.status(404).send({ error: 'Connector not found' });

    const idTag = req.body.idTag ?? 'TESTDRIVER0001';
    const status = await remoteStart(charger.ocppId, req.body.connectorId, idTag);

    if (status !== 'Accepted') {
      return reply.status(503).send({ error: 'Charger rejected the start request', status });
    }

    return { status };
  });

  // POST /chargers/:id/trigger-heartbeat — operator requests immediate heartbeat
  app.post<{ Params: { id: string } }>('/chargers/:id/trigger-heartbeat', {
    preHandler: [requireOperator],
  }, async (req, reply) => {
    const charger = await prisma.charger.findUnique({ where: { id: req.params.id } });
    if (!charger) return reply.status(404).send({ error: 'Charger not found' });
    if (!hasSiteAccess(charger.siteId, req.currentOperator?.claims?.siteIds)) {
      return reply.status(403).send({
        error: 'Forbidden',
        denyReason: { code: 'SITE_OUT_OF_SCOPE', reason: `Site ${charger.siteId} is not in granted siteIds`, policy: 'charger.trigger_heartbeat' },
      });
    }

    const result = await triggerHeartbeat(charger.ocppId);
    if (result.status !== 'Accepted') {
      return reply.status(503).send({ error: 'Charger rejected heartbeat trigger', ...result });
    }
    return result;
  });

  // POST /chargers/:id/get-configuration — operator requests current config keys
  app.post<{ Params: { id: string } }>('/chargers/:id/get-configuration', {
    preHandler: [requireOperator],
  }, async (req, reply) => {
    const charger = await prisma.charger.findUnique({ where: { id: req.params.id } });
    if (!charger) return reply.status(404).send({ error: 'Charger not found' });
    if (!hasSiteAccess(charger.siteId, req.currentOperator?.claims?.siteIds)) {
      return reply.status(403).send({
        error: 'Forbidden',
        denyReason: { code: 'SITE_OUT_OF_SCOPE', reason: `Site ${charger.siteId} is not in granted siteIds`, policy: 'charger.get_configuration' },
      });
    }

    const response = await getConfiguration(charger.ocppId);
    return response;
  });
}
