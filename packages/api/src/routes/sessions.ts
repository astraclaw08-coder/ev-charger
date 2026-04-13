import type { FastifyInstance } from 'fastify';
import { prisma, resolveSessionStatusTimings } from '@ev-charger/shared';
import type { StatusLogLike, SessionLikeForIdle } from '@ev-charger/shared';
import { requireAuth } from '../plugins/auth';
import { remoteStart, remoteStop } from '../lib/ocppClient';
import { computeSessionAmounts } from '../lib/sessionBilling';

function extractPowerActiveImportW(payload: unknown, transactionId?: number | null, connectorId?: number | null): number | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as { transactionId?: number; connectorId?: number; meterValue?: Array<{ sampledValue?: Array<{ measurand?: string; value?: string | number }> }> };
  if (transactionId != null && p.transactionId != null && p.transactionId !== transactionId) return null;
  if (connectorId != null && p.connectorId != null && p.connectorId !== connectorId) return null;
  if (!Array.isArray(p.meterValue)) return null;

  for (const mv of p.meterValue) {
    for (const sv of mv.sampledValue ?? []) {
      if (sv.measurand !== 'Power.Active.Import') continue;
      const n = Number(sv.value);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

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
    // Allow RESERVED connectors if the requesting user holds the reservation
    if (connector.status === 'RESERVED') {
      const activeReservation = await prisma.reservation.findFirst({
        where: {
          connectorRefId: connector.id,
          status: { in: ['PENDING', 'CONFIRMED'] },
        },
        select: { userId: true },
      });
      if (activeReservation && activeReservation.userId === user.id) {
        // Reservation holder — allow start
      } else {
        return reply.status(409).send({
          error: 'Connector is RESERVED by another user',
        });
      }
    } else if (!startableStates.has(connector.status)) {
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
    const sessionId = req.params.id;

    req.log.info({ sessionId }, '[Stop] received stop request');

    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: { connector: { include: { charger: true } } },
    });

    if (!session) {
      req.log.warn({ sessionId }, '[Stop] session not found');
      return reply.status(404).send({ error: 'Session not found' });
    }
    if (session.userId !== user.id) {
      req.log.warn({ sessionId, userId: user.id }, '[Stop] forbidden — not owner');
      return reply.status(403).send({ error: 'Not your session' });
    }
    if (session.status !== 'ACTIVE') {
      req.log.warn({ sessionId, status: session.status }, '[Stop] session is not ACTIVE');
      return reply.status(409).send({ error: 'Session is not active' });
    }
    if (!session.transactionId) {
      req.log.warn({ sessionId }, '[Stop] session has no transactionId yet');
      return reply.status(409).send({ error: 'Session has no transactionId yet' });
    }

    // Ensure transactionId is a proper integer (DB stores as Int but TypeScript type is Int|null)
    const transactionId = Number(session.transactionId);
    const ocppId = session.connector.charger.ocppId;

    req.log.info({ sessionId, transactionId, ocppId }, '[Stop] calling remoteStop');

    if (!Number.isInteger(transactionId)) {
      req.log.error({ sessionId, transactionId }, '[Stop] transactionId is not a valid integer');
      return reply.status(422).send({ error: 'Invalid transactionId — cannot send stop to charger' });
    }

    const status = await remoteStop(ocppId, transactionId);

    req.log.info({ sessionId, transactionId, ocppId, status }, '[Stop] remoteStop response');
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
                  site: {
                    select: {
                      name: true,
                      address: true,
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
                  },
                },
              },
            },
          },
          payments: { where: { purpose: 'CHARGING' }, orderBy: { createdAt: 'desc' }, take: 1 },
          billingSnapshot: { select: { billingBreakdownJson: true, grossAmountUsd: true, kwhDelivered: true, capturedAt: true } },
        },
      }),
      prisma.session.count({ where: { userId: user.id } }),
    ]);

    const chargerIds = Array.from(new Set(
      sessions
        .map((s: any) => s.connector?.charger?.id)
        .filter(Boolean),
    ));
    const activeChargerIds = Array.from(new Set(
      sessions
        .filter((s: any) => s.status === 'ACTIVE')
        .map((s: any) => s.connector?.charger?.id)
        .filter(Boolean),
    ));

    const [recentMeterLogs, recentStatusLogs] = await Promise.all([
      activeChargerIds.length > 0
        ? prisma.ocppLog.findMany({
            where: { chargerId: { in: activeChargerIds }, action: 'MeterValues' },
            orderBy: { createdAt: 'desc' },
            take: 300,
          })
        : Promise.resolve([]),
      chargerIds.length > 0
        ? prisma.ocppLog.findMany({
            where: { chargerId: { in: chargerIds }, action: 'StatusNotification' },
            orderBy: { createdAt: 'desc' },
            take: 10000,
          })
        : Promise.resolve([]),
    ]);

    const meterLogsByCharger = new Map<string, any[]>();
    for (const row of recentMeterLogs) {
      const arr = meterLogsByCharger.get(row.chargerId) ?? [];
      arr.push(row);
      meterLogsByCharger.set(row.chargerId, arr);
    }
    const statusLogsByCharger = new Map<string, StatusLogLike[]>();
    for (const row of recentStatusLogs) {
      const arr = statusLogsByCharger.get(row.chargerId) ?? [];
      arr.push({ chargerId: row.chargerId, createdAt: row.createdAt, payload: row.payload });
      statusLogsByCharger.set(row.chargerId, arr);
    }

    const sessionsForClient = sessions.map((s: any) => {
      const sessionTimings = resolveSessionStatusTimings(
        s,
        statusLogsByCharger.get(s.connector?.charger?.id) ?? [],
      );
      const amounts = computeSessionAmounts({
        ...s,
        payment: s.payments?.[0] ?? null,
        startedAt: s.startedAt,
        stoppedAt: s.stoppedAt,
        pricingMode: s.connector?.charger?.site?.pricingMode,
        pricePerKwhUsd: s.connector?.charger?.site?.pricePerKwhUsd,
        idleFeePerMinUsd: s.connector?.charger?.site?.idleFeePerMinUsd,
        activationFeeUsd: s.connector?.charger?.site?.activationFeeUsd,
        gracePeriodMin: s.connector?.charger?.site?.gracePeriodMin,
        touWindows: s.connector?.charger?.site?.touWindows,
        softwareVendorFeeMode: s.connector?.charger?.site?.softwareVendorFeeMode,
        softwareVendorFeeValue: s.connector?.charger?.site?.softwareVendorFeeValue,
        softwareFeeIncludesActivation: s.connector?.charger?.site?.softwareFeeIncludesActivation,
        idleStartedAt: sessionTimings.idleStartedAt,
        idleStoppedAt: sessionTimings.idleStoppedAt,
        idleWindows: sessionTimings.idleWindows,
      });
      let powerActiveImportW: number | null = null;
      if (s.status === 'ACTIVE') {
        const logs = meterLogsByCharger.get(s.connector?.charger?.id) ?? [];
        for (const log of logs) {
          const w = extractPowerActiveImportW(log.payload, s.transactionId, s.connector?.connectorId);
          if (w != null) {
            powerActiveImportW = w;
            break;
          }
        }
      }
      const snapshot = (s as any).billingSnapshot;
      const snapshotGrossUsd = snapshot?.grossAmountUsd != null ? Number(snapshot.grossAmountUsd) : null;
      const snapshotGrossCents = snapshotGrossUsd != null ? Math.round(snapshotGrossUsd * 100) : null;
      const { payments: _payments, ...sRest } = s;
      return {
        ...sRest,
        payment: s.payments?.[0] ?? null,
        startedAt: s.startedAt,
        stoppedAt: sessionTimings.plugOutAt ? new Date(sessionTimings.plugOutAt) : s.stoppedAt,
        plugInAt: sessionTimings.plugInAt ? new Date(sessionTimings.plugInAt) : undefined,
        plugOutAt: sessionTimings.plugOutAt ? new Date(sessionTimings.plugOutAt) : undefined,
        ocppTransactionId: s.transactionId,
        kwhDelivered: snapshot?.kwhDelivered ?? amounts.kwhDelivered,
        endedAt: sessionTimings.plugOutAt ? new Date(sessionTimings.plugOutAt) : s.stoppedAt,
        effectiveAmountCents: snapshotGrossCents ?? amounts.effectiveAmountCents,
        costEstimateCents: snapshotGrossCents ?? amounts.costEstimateCents,
        estimatedAmountCents: snapshotGrossCents ?? amounts.estimatedAmountCents,
        amountState: snapshot ? 'FINAL' : amounts.amountState,
        amountLabel: snapshot ? 'Final' : amounts.amountLabel,
        isAmountFinal: snapshot ? true : amounts.isAmountFinal,
        billingBreakdown: snapshot?.billingBreakdownJson ?? amounts.billingBreakdown,
        powerActiveImportW,
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
                site: {
                  select: {
                    name: true,
                    address: true,
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
                },
              },
            },
          },
        },
        payments: { where: { purpose: 'CHARGING' }, orderBy: { createdAt: 'desc' }, take: 1 },
        billingSnapshot: { select: { billingBreakdownJson: true, grossAmountUsd: true, netAmountUsd: true, vendorFeeUsd: true, kwhDelivered: true, capturedAt: true } },
      },
    });

    if (!session) return reply.status(404).send({ error: 'Session not found' });
    if (session.userId !== user.id) return reply.status(403).send({ error: 'Not your session' });

    const sessionStartForLogs = new Date(session.startedAt);
    const sessionStopForLogs = session.stoppedAt ? new Date(session.stoppedAt) : null;
    const statusLogs = await prisma.ocppLog.findMany({
      where: {
        chargerId: session.connector.charger.id,
        action: 'StatusNotification',
        createdAt: {
          gte: new Date(sessionStartForLogs.getTime() - (24 * 60 * 60 * 1000)),
          lte: new Date((sessionStopForLogs?.getTime() ?? Date.now()) + (2 * 60 * 60 * 1000)),
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 10000,
    });
    const sessionTimings = resolveSessionStatusTimings(
      session,
      statusLogs.map((row: { chargerId: string; createdAt: Date; payload: unknown }) => ({ chargerId: row.chargerId, createdAt: row.createdAt, payload: row.payload })),
    );

    const amounts = computeSessionAmounts({
      ...session,
      payment: (session as any).payments?.[0] ?? null,
      startedAt: session.startedAt,
      stoppedAt: session.stoppedAt,
      pricingMode: session.connector?.charger?.site?.pricingMode,
      pricePerKwhUsd: session.connector?.charger?.site?.pricePerKwhUsd,
      idleFeePerMinUsd: session.connector?.charger?.site?.idleFeePerMinUsd,
      activationFeeUsd: session.connector?.charger?.site?.activationFeeUsd,
      gracePeriodMin: session.connector?.charger?.site?.gracePeriodMin,
      touWindows: session.connector?.charger?.site?.touWindows,
      softwareVendorFeeMode: session.connector?.charger?.site?.softwareVendorFeeMode,
      softwareVendorFeeValue: session.connector?.charger?.site?.softwareVendorFeeValue,
      softwareFeeIncludesActivation: session.connector?.charger?.site?.softwareFeeIncludesActivation,
      idleStartedAt: sessionTimings.idleStartedAt,
      idleStoppedAt: sessionTimings.idleStoppedAt,
      idleWindows: sessionTimings.idleWindows,
    });

    let powerActiveImportW: number | null = null;
    if (session.status === 'ACTIVE') {
      const logs = await prisma.ocppLog.findMany({
        where: { chargerId: session.connector.charger.id, action: 'MeterValues' },
        orderBy: { createdAt: 'desc' },
        take: 30,
      });
      for (const log of logs) {
        const w = extractPowerActiveImportW(log.payload, session.transactionId, session.connector.connectorId);
        if (w != null) {
          powerActiveImportW = w;
          break;
        }
      }
    }

    const { payments: _payments, ...sessionRest } = session as any;
    return {
      ...sessionRest,
      payment: (session as any).payments?.[0] ?? null,
      startedAt: session.startedAt,
      stoppedAt: sessionTimings.plugOutAt ? new Date(sessionTimings.plugOutAt) : session.stoppedAt,
      plugInAt: sessionTimings.plugInAt ? new Date(sessionTimings.plugInAt) : undefined,
      plugOutAt: sessionTimings.plugOutAt ? new Date(sessionTimings.plugOutAt) : undefined,
      ocppTransactionId: session.transactionId,
      kwhDelivered: amounts.kwhDelivered,
      endedAt: sessionTimings.plugOutAt ? new Date(sessionTimings.plugOutAt) : session.stoppedAt,
      costEstimateCents: amounts.costEstimateCents,
      estimatedAmountCents: amounts.estimatedAmountCents,
      effectiveAmountCents: amounts.effectiveAmountCents,
      amountState: amounts.amountState,
      amountLabel: amounts.amountLabel,
      isAmountFinal: amounts.isAmountFinal,
      // Use persisted snapshot when available (immutable — not affected by future pricing changes)
      // Fall back to compute-on-read for active sessions or sessions without a snapshot
      billingBreakdown: (session as any).billingSnapshot?.billingBreakdownJson ?? amounts.billingBreakdown,
      powerActiveImportW,
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
          payments: { where: { purpose: 'CHARGING' }, select: { status: true, amountCents: true }, orderBy: { createdAt: 'desc' }, take: 1 },
          billingSnapshot: { select: { billingBreakdownJson: true, grossAmountUsd: true, netAmountUsd: true, vendorFeeUsd: true, kwhDelivered: true, capturedAt: true } },
          connector: {
            include: {
              charger: {
                select: {
                  id: true,
                  ocppId: true,
                  model: true,
                  vendor: true,
                  site: {
                    select: {
                      id: true,
                      name: true,
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
                  },
                },
              },
            },
          },
        },
      }),
      prisma.session.count({ where }),
    ]);

    const txChargerIds = Array.from(new Set(rows.map((row: any) => row.connector?.charger?.id).filter(Boolean)));
    const txStatusLogs = txChargerIds.length > 0
      ? await prisma.ocppLog.findMany({
          where: { chargerId: { in: txChargerIds }, action: 'StatusNotification' },
          orderBy: { createdAt: 'desc' },
          take: 10000,
        })
      : [];
    const txStatusLogsByCharger = new Map<string, StatusLogLike[]>();
    for (const row of txStatusLogs) {
      const arr = txStatusLogsByCharger.get(row.chargerId) ?? [];
      arr.push({ chargerId: row.chargerId, createdAt: row.createdAt, payload: row.payload });
      txStatusLogsByCharger.set(row.chargerId, arr);
    }

    return {
      total,
      limit,
      offset,
      transactions: rows.map((row: any) => {
        const sessionTimings = resolveSessionStatusTimings(
          row,
          txStatusLogsByCharger.get(row.connector?.charger?.id) ?? [],
        );
        const amounts = computeSessionAmounts({
          ...row,
          startedAt: row.startedAt,
          stoppedAt: row.stoppedAt,
          pricingMode: row.connector?.charger?.site?.pricingMode,
          pricePerKwhUsd: row.connector?.charger?.site?.pricePerKwhUsd,
          idleFeePerMinUsd: row.connector?.charger?.site?.idleFeePerMinUsd,
          activationFeeUsd: row.connector?.charger?.site?.activationFeeUsd,
          gracePeriodMin: row.connector?.charger?.site?.gracePeriodMin,
          touWindows: row.connector?.charger?.site?.touWindows,
          softwareVendorFeeMode: row.connector?.charger?.site?.softwareVendorFeeMode,
          softwareVendorFeeValue: row.connector?.charger?.site?.softwareVendorFeeValue,
          softwareFeeIncludesActivation: row.connector?.charger?.site?.softwareFeeIncludesActivation,
          idleStartedAt: sessionTimings.idleStartedAt,
          idleStoppedAt: sessionTimings.idleStoppedAt,
          idleWindows: sessionTimings.idleWindows,
        });
        return {
          id: row.id,
          sessionId: row.id,
          transactionId: row.transactionId,
          status: row.status,
          startedAt: row.startedAt,
          stoppedAt: sessionTimings.plugOutAt ? new Date(sessionTimings.plugOutAt) : row.stoppedAt,
          plugInAt: sessionTimings.plugInAt ? new Date(sessionTimings.plugInAt) : undefined,
          plugOutAt: sessionTimings.plugOutAt ? new Date(sessionTimings.plugOutAt) : undefined,
          energyKwh: amounts.kwhDelivered,
          revenueUsd: ((amounts.effectiveAmountCents ?? amounts.estimatedAmountCents ?? row.payments?.[0]?.amountCents ?? 0) / 100),
          payment: row.payments?.[0] ?? null,
          effectiveAmountCents: amounts.effectiveAmountCents,
          estimatedAmountCents: amounts.estimatedAmountCents,
          amountState: amounts.amountState,
          amountLabel: amounts.amountLabel,
          isAmountFinal: amounts.isAmountFinal,
          billingBreakdown: row.billingSnapshot?.billingBreakdownJson ?? amounts.billingBreakdown,
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
