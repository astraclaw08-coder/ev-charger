import type { FastifyInstance } from 'fastify';
import { prisma } from '@ev-charger/shared';
import { requireAuth } from '../plugins/auth';
import { remoteStart, remoteStop } from '../lib/ocppClient';
import { computeSessionAmounts } from '../lib/sessionBilling';

function parseHistoryRange(query: { startDate?: string; endDate?: string }, fallbackDays = 30) {
  const hasCustomRange = Boolean(query.startDate || query.endDate);
  if (hasCustomRange && (!query.startDate || !query.endDate)) {
    return { error: 'startDate and endDate are required together' } as const;
  }

  const end = query.endDate ? new Date(`${query.endDate}T23:59:59.999Z`) : new Date();
  const start = query.startDate
    ? new Date(`${query.startDate}T00:00:00.000Z`)
    : new Date(end.getTime() - (Math.max(1, fallbackDays) - 1) * 24 * 60 * 60 * 1000);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    return { error: 'Invalid date range' } as const;
  }
  return { start, end } as const;
}

export async function sessionRoutes(app: FastifyInstance) {
  // POST /sessions/start — driver initiates a remote start
  app.post<{
    Body: { chargerId: string; connectorId: number };
  }>('/sessions/start', {
    preHandler: requireAuth,
  }, async (req, reply) => {
    const user = req.currentUser!;
    const { chargerId, connectorId } = req.body;

    const charger = await prisma.charger.findUnique({
      where: { id: chargerId },
      include: { connectors: { where: { connectorId } } },
    });

    if (!charger) return reply.status(404).send({ error: 'Charger not found' });

    const connector = charger.connectors[0];
    if (!connector) return reply.status(404).send({ error: 'Connector not found' });

    const startableStates = new Set(['AVAILABLE', 'PREPARING', 'SUSPENDED_EV']);
    if (!startableStates.has(connector.status)) {
      return reply.status(409).send({
        error: `Connector is ${connector.status}, not startable (requires AVAILABLE, PREPARING, or SUSPENDED_EV)`,
      });
    }

    const status = await remoteStart(charger.ocppId, connectorId, user.idTag);

    if (status !== 'Accepted') {
      return reply.status(503).send({ error: 'Charger rejected the start request', status });
    }

    // Session is created when the charger sends StartTransaction back to the OCPP server.
    // Return enough info for the client to poll for the active session.
    return {
      accepted: true,
      chargerId: charger.id,
      ocppId: charger.ocppId,
      connectorId,
    };
  });

  // POST /sessions/:id/stop — driver stops an active session
  app.post<{ Params: { id: string } }>('/sessions/:id/stop', {
    preHandler: requireAuth,
  }, async (req, reply) => {
    const user = req.currentUser!;

    const session = await prisma.session.findUnique({
      where: { id: req.params.id },
      include: { connector: { include: { charger: true } } },
    });

    if (!session) return reply.status(404).send({ error: 'Session not found' });
    if (session.userId !== user.id) return reply.status(403).send({ error: 'Not your session' });
    if (session.status !== 'ACTIVE') return reply.status(409).send({ error: 'Session is not active' });
    if (!session.transactionId) return reply.status(409).send({ error: 'Session has no transactionId yet' });

    const status = await remoteStop(session.connector.charger.ocppId, session.transactionId);
    return { status };
  });

  // GET /sessions — driver's session history
  app.get<{
    Querystring: { limit?: string; offset?: string };
  }>('/sessions', {
    preHandler: requireAuth,
  }, async (req) => {
    const user = req.currentUser!;
    const limit = Math.min(parseInt(req.query.limit ?? '20', 10), 100);
    const offset = parseInt(req.query.offset ?? '0', 10);

    const [sessions, total] = await Promise.all([
      prisma.session.findMany({
        where: { userId: user.id },
        orderBy: { startedAt: 'desc' },
        take: limit,
        skip: offset,
        include: {
          connector: {
            include: {
              charger: {
                select: {
                  id: true, ocppId: true, model: true, vendor: true, status: true,
                  site: { select: { name: true, address: true } },
                },
              },
            },
          },
          payment: true,
        },
      }),
      prisma.session.count({ where: { userId: user.id } }),
    ]);

    const sessionsForClient = sessions.map((s: any) => {
      const amounts = computeSessionAmounts(s);
      return {
        ...s,
        ocppTransactionId: s.transactionId,
        kwhDelivered: amounts.kwhDelivered,
        endedAt: s.stoppedAt,
        effectiveAmountCents: amounts.effectiveAmountCents,
        costEstimateCents: amounts.costEstimateCents,
        estimatedAmountCents: amounts.estimatedAmountCents,
        amountState: amounts.amountState,
        amountLabel: amounts.amountLabel,
        isAmountFinal: amounts.isAmountFinal,
      };
    });

    return { sessions: sessionsForClient, total, limit, offset };
  });

  // GET /sessions/:id — live session detail with cost estimate
  app.get<{ Params: { id: string } }>('/sessions/:id', {
    preHandler: requireAuth,
  }, async (req, reply) => {
    const user = req.currentUser!;

    const session = await prisma.session.findUnique({
      where: { id: req.params.id },
      include: {
        connector: {
          include: {
            charger: {
              select: {
                id: true, ocppId: true, model: true, vendor: true, status: true,
                site: { select: { name: true, address: true } },
              },
            },
          },
        },
        payment: true,
      },
    });

    if (!session) return reply.status(404).send({ error: 'Session not found' });
    if (session.userId !== user.id) return reply.status(403).send({ error: 'Not your session' });

    const amounts = computeSessionAmounts(session);

    return {
      ...session,
      ocppTransactionId: session.transactionId,
      kwhDelivered: amounts.kwhDelivered,
      endedAt: session.stoppedAt,
      costEstimateCents: amounts.costEstimateCents,
      estimatedAmountCents: amounts.estimatedAmountCents,
      effectiveAmountCents: amounts.effectiveAmountCents,
      amountState: amounts.amountState,
      amountLabel: amounts.amountLabel,
      isAmountFinal: amounts.isAmountFinal,
    };
  });

  // GET /me/transactions/enriched — user-scoped transaction history projection
  app.get<{
    Querystring: {
      limit?: string;
      offset?: string;
      status?: string;
      startDate?: string;
      endDate?: string;
    };
  }>('/me/transactions/enriched', {
    preHandler: requireAuth,
  }, async (req, reply) => {
    const user = req.currentUser!;
    const range = parseHistoryRange(req.query, 30);
    if ('error' in range) return reply.status(400).send({ error: range.error });

    const limit = Math.min(Math.max(Number.parseInt(req.query.limit ?? '50', 10), 1), 200);
    const offset = Math.max(Number.parseInt(req.query.offset ?? '0', 10), 0);
    const status = req.query.status;

    if (status && !['ACTIVE', 'COMPLETED', 'FAILED'].includes(status)) {
      return reply.status(400).send({ error: 'status must be ACTIVE, COMPLETED, or FAILED' });
    }

    const where = {
      userId: user.id,
      startedAt: { gte: range.start, lte: range.end },
      ...(status ? { status: status as 'ACTIVE' | 'COMPLETED' | 'FAILED' } : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.session.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        take: limit,
        skip: offset,
        include: {
          payment: { select: { status: true, amountCents: true } },
          connector: {
            include: {
              charger: {
                select: {
                  id: true,
                  ocppId: true,
                  model: true,
                  vendor: true,
                  site: { select: { id: true, name: true } },
                },
              },
            },
          },
        },
      }),
      prisma.session.count({ where }),
    ]);

    return {
      total,
      limit,
      offset,
      transactions: rows.map((row: any) => {
        const amounts = computeSessionAmounts(row);
        return {
          id: row.id,
          sessionId: row.id,
          transactionId: row.transactionId,
          status: row.status,
          startedAt: row.startedAt,
          stoppedAt: row.stoppedAt,
          energyKwh: amounts.kwhDelivered,
          revenueUsd: ((amounts.effectiveAmountCents ?? amounts.estimatedAmountCents ?? row.payment?.amountCents ?? 0) / 100),
          payment: row.payment,
          effectiveAmountCents: amounts.effectiveAmountCents,
          estimatedAmountCents: amounts.estimatedAmountCents,
          amountState: amounts.amountState,
          amountLabel: amounts.amountLabel,
          isAmountFinal: amounts.isAmountFinal,
          meterStart: row.meterStart,
          meterStop: row.meterStop,
          site: row.connector.charger.site,
          charger: {
            id: row.connector.charger.id,
            ocppId: row.connector.charger.ocppId,
            model: row.connector.charger.model,
            vendor: row.connector.charger.vendor,
          },
        };
      }),
    };
  });
}
