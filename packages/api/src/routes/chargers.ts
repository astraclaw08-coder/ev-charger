import type { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { prisma } from '@ev-charger/shared';
import { requireOperator } from '../plugins/auth';
import { remoteReset } from '../lib/ocppClient';
import { getChargerUptime } from '../lib/uptime';

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
        site: { select: { id: true, name: true, address: true, lat: true, lng: true } },
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
    preHandler: requireOperator,
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
    preHandler: requireOperator,
  }, async (req, reply) => {
    const { siteId, ocppId, serialNumber, model, vendor } = req.body;

    const site = await prisma.site.findUnique({ where: { id: siteId } });
    if (!site) return reply.status(404).send({ error: 'Site not found' });

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
    preHandler: requireOperator,
  }, async (req, reply) => {
    const charger = await prisma.charger.findUnique({
      where: { id: req.params.id },
      include: { connectors: { select: { id: true } } },
    });
    if (!charger) return reply.status(404).send({ error: 'Charger not found' });

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

    return sessions;
  });



  // GET /chargers/:id/uptime — rolling uptime windows + incidents
  app.get<{ Params: { id: string } }>('/chargers/:id/uptime', {
    preHandler: requireOperator,
  }, async (req, reply) => {
    const uptime = await getChargerUptime(req.params.id);
    if (!uptime) return reply.status(404).send({ error: 'Charger not found' });
    return uptime;
  });

  // POST /chargers/:id/reset — operator reboots a charger
  app.post<{
    Params: { id: string };
    Body: { type?: 'Soft' | 'Hard' };
  }>('/chargers/:id/reset', {
    preHandler: requireOperator,
  }, async (req, reply) => {
    const charger = await prisma.charger.findUnique({ where: { id: req.params.id } });
    if (!charger) return reply.status(404).send({ error: 'Charger not found' });

    const type = req.body?.type ?? 'Soft';
    const status = await remoteReset(charger.ocppId, type);
    return { status };
  });
}
