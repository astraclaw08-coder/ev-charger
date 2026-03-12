import type { FastifyInstance } from 'fastify';
import { prisma } from '@ev-charger/shared';
import { requireAuth } from '../plugins/auth';
import { remoteStart, remoteStop } from '../lib/ocppClient';
import { computeSessionAmounts } from '../lib/sessionBilling';

export async function sessionRoutes(app: FastifyInstance) {
  // POST /sessions/start — driver initiates a remote start
  app.post<{
    Body: { chargerId: string; connectorId: number; idTag?: string };
  }>('/sessions/start', {
    preHandler: requireAuth,
  }, async (req, reply) => {
    const user = req.currentUser!;
    const { chargerId, connectorId, idTag: requestedIdTag } = req.body;

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

    const appEnv = (process.env.APP_ENV ?? process.env.NODE_ENV ?? '').toLowerCase();
    const idTag = requestedIdTag?.trim() || user.idTag;

    if (appEnv !== 'development' && requestedIdTag && requestedIdTag.trim() !== user.idTag) {
      return reply.status(403).send({ error: 'idTag override is not allowed outside development' });
    }

    const status = await remoteStart(charger.ocppId, connectorId, idTag);

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
}
