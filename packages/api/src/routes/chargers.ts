import type { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { prisma } from '@ev-charger/shared';
import { requireOperator } from '../plugins/auth';
import { requirePolicy } from '../plugins/authorization';
import { remoteReset, remoteStart, triggerHeartbeat, getConfiguration } from '../lib/ocppClient';
import { getChargerUptime } from '../lib/uptime';
import { computeSessionAmounts } from '../lib/sessionBilling';

function hasSiteAccess(siteId: string, siteIds: string[] | undefined) {
  if (!siteIds || siteIds.length === 0) return true;
  if (siteIds.includes('*')) return true;
  return siteIds.includes(siteId);
}

function hasSiteAccess(siteId: string, siteIds: string[] | undefined) {
  if (!siteIds || siteIds.length === 0) return true;
  if (siteIds.includes('*')) return true;
  return siteIds.includes(siteId);
}

export async function chargerRoutes(app: FastifyInstance) {
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
    const charger = await prisma.charger.findUnique({
      where: { id: req.params.id },
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

    const { password: _pw, ...safeCharger } = charger;
    return safeCharger;
  });

  // GET /chargers/:id/status — real-time state (operator only)
  app.get<{ Params: { id: string } }>('/chargers/:id/status', {
    preHandler: [requireOperator, requirePolicy('charger.status.read')],
  }, async (req, reply) => {
    const charger = await prisma.charger.findUnique({
      where: { id: req.params.id },
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

    const sessions = await prisma.session.findMany({
      where: { connectorId: { in: connectorIds } },
      orderBy: { startedAt: 'desc' },
      take: limit,
      include: {
        connector: { select: { connectorId: true } },
        user: { select: { name: true, email: true } },
        payment: { select: { status: true, amountCents: true } },
      },
    });

    return sessions.map((s: any) => {
      const amounts = computeSessionAmounts(s);
      return {
        ...s,
        kwhDelivered: amounts.kwhDelivered,
        effectiveAmountCents: amounts.effectiveAmountCents,
        estimatedAmountCents: amounts.estimatedAmountCents,
        amountState: amounts.amountState,
        amountLabel: amounts.amountLabel,
        isAmountFinal: amounts.isAmountFinal,
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

    const status = await triggerHeartbeat(charger.ocppId);
    if (status !== 'Accepted') {
      return reply.status(503).send({ error: 'Charger rejected heartbeat trigger', status });
    }
    return { status };
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
