import type { FastifyInstance } from 'fastify';
import { prisma } from '@ev-charger/shared';
import { requireOperator } from '../plugins/auth';
import { requirePolicy } from '../plugins/authorization';
import { computeSessionAmounts } from '../lib/sessionBilling';

type DateRangeQuery = { startDate?: string; endDate?: string };

function parseDateRange(query: DateRangeQuery, fallbackDays: number): { start: Date; end: Date } | { error: string } {
  const hasCustomRange = Boolean(query.startDate || query.endDate);
  if (hasCustomRange && (!query.startDate || !query.endDate)) {
    return { error: 'startDate and endDate are required together' };
  }

  const end = query.endDate ? new Date(`${query.endDate}T23:59:59.999Z`) : new Date();
  const start = query.startDate
    ? new Date(`${query.startDate}T00:00:00.000Z`)
    : new Date(end.getTime() - (Math.max(1, fallbackDays) - 1) * 24 * 60 * 60 * 1000);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    return { error: 'Invalid date range' };
  }

  return { start, end };
}

function toNumber(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number.parseFloat(value);
  if (typeof value === 'object' && value && 'toString' in value) return Number.parseFloat(String(value));
  return 0;
}

function hasSiteAccess(siteId: string, siteIds: string[] | undefined) {
  if (!siteIds || siteIds.length === 0) return true;
  if (siteIds.includes('*')) return true;
  return siteIds.includes(siteId);
}

type StatusLogLike = {
  chargerId: string;
  createdAt: Date;
  payload: unknown;
};

function parseConnectorStatus(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/[-\s]/g, '_').toUpperCase();
  const map: Record<string, string> = {
    AVAILABLE: 'AVAILABLE',
    PREPARING: 'PREPARING',
    CHARGING: 'CHARGING',
    FINISHING: 'FINISHING',
    SUSPENDEDEV: 'SUSPENDED_EV',
    SUSPENDED_EV: 'SUSPENDED_EV',
    SUSPENDEDEVSE: 'SUSPENDED_EVSE',
    SUSPENDED_EVSE: 'SUSPENDED_EVSE',
    RESERVED: 'RESERVED',
    UNAVAILABLE: 'UNAVAILABLE',
    FAULTED: 'FAULTED',
  };
  return map[normalized] ?? null;
}

function extractStatusEvent(log: StatusLogLike): { connectorId: number; status: string; at: Date } | null {
  if (!log.payload || typeof log.payload !== 'object') return null;
  const payload = log.payload as { connectorId?: number | string; status?: string; timestamp?: string };
  const connectorId = Number(payload.connectorId);
  const status = parseConnectorStatus(payload.status);
  if (!Number.isInteger(connectorId) || connectorId <= 0 || !status) return null;
  const timestamp = payload.timestamp ? new Date(payload.timestamp) : null;
  const at = timestamp && Number.isFinite(timestamp.getTime()) ? timestamp : log.createdAt;
  return { connectorId, status, at };
}

function resolveSessionStatusTimings(input: {
  startedAt?: Date | string | null;
  stoppedAt?: Date | string | null;
  connectorId?: number | null;
  statusLogs: StatusLogLike[];
}): { idleStartedAt?: string; idleStoppedAt?: string; plugInAt?: string; plugOutAt?: string } {
  if (!input.startedAt || !input.connectorId) return {};
  const sessionStart = new Date(input.startedAt);
  if (!Number.isFinite(sessionStart.getTime())) return {};

  const sessionStop = input.stoppedAt ? new Date(input.stoppedAt) : null;
  const lookbackMs = 24 * 60 * 60 * 1000;
  const hardStartMs = sessionStart.getTime() - lookbackMs;
  const hardEndMs = sessionStop && Number.isFinite(sessionStop.getTime())
    ? sessionStop.getTime() + (2 * 60 * 60 * 1000)
    : Date.now() + (2 * 60 * 60 * 1000);

  const baseEvents = input.statusLogs
    .map(extractStatusEvent)
    .filter((e): e is { connectorId: number; status: string; at: Date } => Boolean(e))
    .filter((e) => e.connectorId === input.connectorId)
    .filter((e) => {
      const atMs = e.at.getTime();
      return atMs >= hardStartMs && atMs <= hardEndMs;
    })
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  if (baseEvents.length === 0) {
    return { plugInAt: sessionStart.toISOString() };
  }

  const events = baseEvents.map((e, idx) => ({
    ...e,
    prevStatus: idx > 0 ? baseEvents[idx - 1].status : null as string | null,
  }));

  const plugInCandidates = events.filter((e) =>
    e.prevStatus === 'AVAILABLE'
    && e.status === 'PREPARING'
    && e.at.getTime() <= sessionStart.getTime(),
  );
  const preparingCandidates = events.filter((e) =>
    e.status === 'PREPARING'
    && e.at.getTime() <= sessionStart.getTime(),
  );
  const plugIn = plugInCandidates.length > 0
    ? plugInCandidates[plugInCandidates.length - 1]
    : (preparingCandidates.length > 0 ? preparingCandidates[preparingCandidates.length - 1] : null);

  const plugOutCandidates = events.filter((e) =>
    e.status === 'AVAILABLE'
    && !!e.prevStatus
    && new Set(['FINISHING', 'SUSPENDED_EV', 'SUSPENDED_EVSE']).has(e.prevStatus)
    && (!sessionStop || e.at.getTime() >= sessionStop.getTime()),
  );
  const plugOut = plugOutCandidates.length > 0
    ? plugOutCandidates[0]
    : events.find((e) =>
      e.status === 'AVAILABLE'
      && !!e.prevStatus
      && new Set(['FINISHING', 'SUSPENDED_EV', 'SUSPENDED_EVSE']).has(e.prevStatus),
    );

  const idleStart = events.find((e) =>
    e.at.getTime() >= sessionStart.getTime()
    && e.prevStatus === 'CHARGING'
    && (e.status === 'SUSPENDED_EV' || e.status === 'SUSPENDED_EVSE'),
  ) ?? events.find((e) =>
    e.at.getTime() >= sessionStart.getTime()
    && e.prevStatus === 'CHARGING'
    && e.status === 'FINISHING',
  );

  const idleEnd = idleStart
    ? events.find((e) =>
      e.at.getTime() >= idleStart.at.getTime()
      && e.status === 'AVAILABLE'
      && (
        e.prevStatus === 'FINISHING'
        || e.prevStatus === 'SUSPENDED_EV'
        || e.prevStatus === 'SUSPENDED_EVSE'
      ),
    )
    : null;

  const resolvedIdleEnd = idleEnd?.at ?? plugOut?.at ?? sessionStop ?? null;

  return {
    idleStartedAt: idleStart?.at && resolvedIdleEnd && resolvedIdleEnd.getTime() > idleStart.at.getTime()
      ? idleStart.at.toISOString()
      : undefined,
    idleStoppedAt: idleStart?.at && resolvedIdleEnd && resolvedIdleEnd.getTime() > idleStart.at.getTime()
      ? resolvedIdleEnd.toISOString()
      : undefined,
    plugInAt: plugIn?.at?.toISOString() ?? sessionStart.toISOString(),
    plugOutAt: plugOut?.at?.toISOString(),
  };
}

export async function readModelRoutes(app: FastifyInstance) {
  // GET /analytics/portfolio-summary — org/portfolio/site rollups from SiteDailyFact
  app.get<{
    Querystring: {
      startDate?: string;
      endDate?: string;
      siteId?: string;
      organizationName?: string;
      portfolioName?: string;
    };
  }>('/analytics/portfolio-summary', {
    preHandler: [requireOperator, requirePolicy('site.analytics.read')],
  }, async (req, reply) => {
    const range = parseDateRange(req.query, 30);
    if ('error' in range) return reply.status(400).send({ error: range.error });

    const scopedSiteIds = req.currentOperator?.claims?.siteIds ?? [];
    const siteId = req.query.siteId;

    if (siteId && !hasSiteAccess(siteId, scopedSiteIds)) {
      return reply.status(403).send({
        error: 'Forbidden',
        denyReason: { code: 'SITE_OUT_OF_SCOPE', reason: `Site ${siteId} is not in granted siteIds`, policy: 'site.analytics.read' },
      });
    }

    const rows = await prisma.siteDailyFact.findMany({
      where: {
        day: { gte: range.start, lte: range.end },
        ...(siteId ? { siteId } : {}),
        ...(scopedSiteIds.length > 0 && !scopedSiteIds.includes('*') ? { siteId: { in: scopedSiteIds } } : {}),
        ...(req.query.organizationName ? { site: { organizationName: req.query.organizationName } } : {}),
        ...(req.query.portfolioName ? { site: { portfolioName: req.query.portfolioName } } : {}),
      },
      include: {
        site: {
          select: {
            id: true,
            name: true,
            organizationName: true,
            portfolioName: true,
          },
        },
      },
      orderBy: [{ day: 'asc' }],
    });

    const siteMap = new Map<string, {
      siteId: string;
      siteName: string;
      organizationName: string | null;
      portfolioName: string | null;
      sessionsCount: number;
      totalEnergyKwh: number;
      totalRevenueUsd: number;
    }>();

    for (const row of rows) {
      const existing = siteMap.get(row.siteId) ?? {
        siteId: row.siteId,
        siteName: row.site.name,
        organizationName: row.site.organizationName,
        portfolioName: row.site.portfolioName,
        sessionsCount: 0,
        totalEnergyKwh: 0,
        totalRevenueUsd: 0,
      };

      existing.sessionsCount += row.sessionsCount;
      existing.totalEnergyKwh += toNumber(row.totalEnergyKwh);
      existing.totalRevenueUsd += toNumber(row.totalRevenueUsd);
      siteMap.set(row.siteId, existing);
    }

    const sites = Array.from(siteMap.values()).map((site) => ({
      ...site,
      totalEnergyKwh: Number(site.totalEnergyKwh.toFixed(6)),
      totalRevenueUsd: Number(site.totalRevenueUsd.toFixed(6)),
    }));

    const orgMap = new Map<string, {
      organizationName: string;
      sessionsCount: number;
      totalEnergyKwh: number;
      totalRevenueUsd: number;
      portfolios: Map<string, {
        portfolioName: string;
        sessionsCount: number;
        totalEnergyKwh: number;
        totalRevenueUsd: number;
        siteCount: number;
      }>;
      siteIds: Set<string>;
    }>();

    for (const site of sites) {
      const orgKey = site.organizationName ?? 'Unassigned';
      const portfolioKey = site.portfolioName ?? 'Unassigned';
      const org = orgMap.get(orgKey) ?? {
        organizationName: orgKey,
        sessionsCount: 0,
        totalEnergyKwh: 0,
        totalRevenueUsd: 0,
        portfolios: new Map(),
        siteIds: new Set<string>(),
      };

      org.sessionsCount += site.sessionsCount;
      org.totalEnergyKwh += site.totalEnergyKwh;
      org.totalRevenueUsd += site.totalRevenueUsd;
      org.siteIds.add(site.siteId);

      const portfolio = org.portfolios.get(portfolioKey) ?? {
        portfolioName: portfolioKey,
        sessionsCount: 0,
        totalEnergyKwh: 0,
        totalRevenueUsd: 0,
        siteCount: 0,
      };
      portfolio.sessionsCount += site.sessionsCount;
      portfolio.totalEnergyKwh += site.totalEnergyKwh;
      portfolio.totalRevenueUsd += site.totalRevenueUsd;
      portfolio.siteCount += 1;
      org.portfolios.set(portfolioKey, portfolio);

      orgMap.set(orgKey, org);
    }

    const organizations = Array.from(orgMap.values()).map((org) => ({
      organizationName: org.organizationName,
      siteCount: org.siteIds.size,
      sessionsCount: org.sessionsCount,
      totalEnergyKwh: Number(org.totalEnergyKwh.toFixed(6)),
      totalRevenueUsd: Number(org.totalRevenueUsd.toFixed(6)),
      portfolios: Array.from(org.portfolios.values()).map((portfolio) => ({
        portfolioName: portfolio.portfolioName,
        siteCount: portfolio.siteCount,
        sessionsCount: portfolio.sessionsCount,
        totalEnergyKwh: Number(portfolio.totalEnergyKwh.toFixed(6)),
        totalRevenueUsd: Number(portfolio.totalRevenueUsd.toFixed(6)),
      })),
    }));

    const totals = sites.reduce((acc, site) => ({
      siteCount: acc.siteCount + 1,
      sessionsCount: acc.sessionsCount + site.sessionsCount,
      totalEnergyKwh: acc.totalEnergyKwh + site.totalEnergyKwh,
      totalRevenueUsd: acc.totalRevenueUsd + site.totalRevenueUsd,
    }), { siteCount: 0, sessionsCount: 0, totalEnergyKwh: 0, totalRevenueUsd: 0 });

    return {
      range: {
        startDate: range.start.toISOString().slice(0, 10),
        endDate: range.end.toISOString().slice(0, 10),
      },
      totals: {
        ...totals,
        totalEnergyKwh: Number(totals.totalEnergyKwh.toFixed(6)),
        totalRevenueUsd: Number(totals.totalRevenueUsd.toFixed(6)),
      },
      organizations,
      sites,
    };
  });

  // GET /transactions/enriched — SessionFact records plus related session/charger/site metadata
  app.get<{
    Querystring: {
      limit?: string;
      offset?: string;
      siteId?: string;
      chargerId?: string;
      status?: string;
      startDate?: string;
      endDate?: string;
    };
  }>('/transactions/enriched', {
    preHandler: [requireOperator, requirePolicy('charger.sessions.read')],
  }, async (req, reply) => {
    const range = parseDateRange(req.query, 30);
    if ('error' in range) return reply.status(400).send({ error: range.error });

    const limit = Math.min(Math.max(Number.parseInt(req.query.limit ?? '50', 10), 1), 200);
    const offset = Math.max(Number.parseInt(req.query.offset ?? '0', 10), 0);
    const scopedSiteIds = req.currentOperator?.claims?.siteIds ?? [];

    if (req.query.siteId && !hasSiteAccess(req.query.siteId, scopedSiteIds)) {
      return reply.status(403).send({
        error: 'Forbidden',
        denyReason: { code: 'SITE_OUT_OF_SCOPE', reason: `Site ${req.query.siteId} is not in granted siteIds`, policy: 'charger.sessions.read' },
      });
    }

    const where = {
      startedAt: { gte: range.start, lte: range.end },
      ...(req.query.siteId ? { siteId: req.query.siteId } : {}),
      ...(req.query.chargerId ? { chargerId: req.query.chargerId } : {}),
      ...(req.query.status ? { status: req.query.status as 'ACTIVE' | 'COMPLETED' | 'FAILED' } : {}),
      ...(scopedSiteIds.length > 0 && !scopedSiteIds.includes('*') ? { siteId: { in: scopedSiteIds } } : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.sessionFact.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        take: limit,
        skip: offset,
        include: {
          site: {
            select: {
              id: true,
              name: true,
              organizationName: true,
              portfolioName: true,
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
          charger: { select: { id: true, ocppId: true, serialNumber: true, model: true, vendor: true } },
          session: {
            select: {
              id: true,
              transactionId: true,
              idTag: true,
              meterStart: true,
              meterStop: true,
              kwhDelivered: true,
              ratePerKwh: true,
              connector: { select: { connectorId: true } },
              payment: { select: { status: true, amountCents: true } },
            },
          },
        },
      }),
      prisma.sessionFact.count({ where }),
    ]);

    const chargerIds = Array.from(new Set(rows.map((row: any) => row.charger?.id).filter(Boolean)));
    const statusLogs = chargerIds.length > 0
      ? await prisma.ocppLog.findMany({
          where: { chargerId: { in: chargerIds }, action: 'StatusNotification' },
          orderBy: { createdAt: 'desc' },
          take: 10000,
        })
      : [];
    const statusLogsByCharger = new Map<string, StatusLogLike[]>();
    for (const log of statusLogs) {
      const arr = statusLogsByCharger.get(log.chargerId) ?? [];
      arr.push({ chargerId: log.chargerId, createdAt: log.createdAt, payload: log.payload });
      statusLogsByCharger.set(log.chargerId, arr);
    }

    return {
      total,
      limit,
      offset,
      transactions: rows.map((row: any) => {
        const energyKwh = Number(toNumber(row.energyKwh).toFixed(6));
        const revenueUsd = Number(toNumber(row.revenueUsd).toFixed(6));
        const sessionTimings = resolveSessionStatusTimings({
          startedAt: row.startedAt,
          stoppedAt: row.stoppedAt,
          connectorId: row.session?.connector?.connectorId,
          statusLogs: statusLogsByCharger.get(row.charger?.id) ?? [],
        });
        const amounts = computeSessionAmounts({
          meterStart: row.session.meterStart,
          meterStop: row.session.meterStop,
          kwhDelivered: row.session.kwhDelivered ?? energyKwh,
          ratePerKwh: row.session.ratePerKwh,
          payment: row.session.payment,
          revenueUsd,
          durationMinutes: row.durationMinutes,
          startedAt: row.startedAt,
          stoppedAt: row.stoppedAt,
          pricingMode: row.site.pricingMode,
          pricePerKwhUsd: row.site.pricePerKwhUsd,
          idleFeePerMinUsd: row.site.idleFeePerMinUsd,
          activationFeeUsd: row.site.activationFeeUsd,
          gracePeriodMin: row.site.gracePeriodMin,
          touWindows: row.site.touWindows,
          softwareVendorFeeMode: row.site.softwareVendorFeeMode,
          softwareVendorFeeValue: row.site.softwareVendorFeeValue,
          softwareFeeIncludesActivation: row.site.softwareFeeIncludesActivation,
          idleStartedAt: sessionTimings.idleStartedAt,
          idleStoppedAt: sessionTimings.idleStoppedAt,
        });

        return {
          id: row.id,
          sessionId: row.sessionId,
          transactionId: row.session.transactionId,
          idTag: row.session.idTag,
          status: row.status,
          startedAt: row.startedAt,
          stoppedAt: sessionTimings.plugOutAt ? new Date(sessionTimings.plugOutAt) : row.stoppedAt,
          plugInAt: sessionTimings.plugInAt ? new Date(sessionTimings.plugInAt) : undefined,
          plugOutAt: sessionTimings.plugOutAt ? new Date(sessionTimings.plugOutAt) : undefined,
          durationMinutes: row.durationMinutes,
          energyKwh,
          revenueUsd,
          payment: row.session.payment,
          meterStart: row.session.meterStart,
          meterStop: row.session.meterStop,
          effectiveAmountCents: amounts.effectiveAmountCents,
          estimatedAmountCents: amounts.estimatedAmountCents,
          amountState: amounts.amountState,
          amountLabel: amounts.amountLabel,
          isAmountFinal: amounts.isAmountFinal,
          billingBreakdown: amounts.billingBreakdown,
          site: row.site,
          charger: row.charger,
          sourceVersion: row.sourceVersion,
        };
      }),
    };
  });

  // GET /rebates/intervals — query 15m rebate intervals (RebateInterval15m)
  app.get<{
    Querystring: {
      siteId?: string;
      chargerId?: string;
      sessionId?: string;
      startDate?: string;
      endDate?: string;
      limit?: string;
      offset?: string;
    };
  }>('/rebates/intervals', {
    preHandler: [requireOperator, requirePolicy('site.analytics.read')],
  }, async (req, reply) => {
    const range = parseDateRange(req.query, 7);
    if ('error' in range) return reply.status(400).send({ error: range.error });

    const limit = Math.min(Math.max(Number.parseInt(req.query.limit ?? '200', 10), 1), 1000);
    const offset = Math.max(Number.parseInt(req.query.offset ?? '0', 10), 0);
    const scopedSiteIds = req.currentOperator?.claims?.siteIds ?? [];

    if (req.query.siteId && !hasSiteAccess(req.query.siteId, scopedSiteIds)) {
      return reply.status(403).send({
        error: 'Forbidden',
        denyReason: { code: 'SITE_OUT_OF_SCOPE', reason: `Site ${req.query.siteId} is not in granted siteIds`, policy: 'site.analytics.read' },
      });
    }

    const where = {
      intervalStart: { gte: range.start, lte: range.end },
      ...(req.query.siteId ? { siteId: req.query.siteId } : {}),
      ...(req.query.chargerId ? { chargerId: req.query.chargerId } : {}),
      ...(req.query.sessionId ? { sessionId: req.query.sessionId } : {}),
      ...(scopedSiteIds.length > 0 && !scopedSiteIds.includes('*') ? { siteId: { in: scopedSiteIds } } : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.rebateInterval15m.findMany({
        where,
        orderBy: { intervalStart: 'asc' },
        take: limit,
        skip: offset,
        include: {
          site: { select: { id: true, name: true, softwareVendorFeeMode: true, softwareVendorFeeValue: true } },
          charger: { select: { id: true, ocppId: true } },
          session: { select: { id: true, transactionId: true } },
        },
      }),
      prisma.rebateInterval15m.count({ where }),
    ]);

    const summary = rows.reduce((acc: any, row: any) => {
      acc.totalEnergyKwh += toNumber(row.energyKwh);
      acc.avgPowerKwSum += toNumber(row.avgPowerKw);
      if (row.maxPowerKw != null) {
        acc.maxPowerKw = Math.max(acc.maxPowerKw, toNumber(row.maxPowerKw));
      }
      return acc;
    }, { totalEnergyKwh: 0, avgPowerKwSum: 0, maxPowerKw: 0 });

    return {
      total,
      limit,
      offset,
      range: {
        startDate: range.start.toISOString(),
        endDate: range.end.toISOString(),
      },
      summary: {
        totalEnergyKwh: Number(summary.totalEnergyKwh.toFixed(6)),
        avgPowerKw: rows.length ? Number((summary.avgPowerKwSum / rows.length).toFixed(6)) : 0,
        maxPowerKw: Number(summary.maxPowerKw.toFixed(6)),
      },
      intervals: rows.map((row: any) => ({
        id: row.id,
        site: row.site,
        charger: row.charger,
        session: row.session,
        connectorId: row.connectorId,
        intervalStart: row.intervalStart,
        intervalEnd: row.intervalEnd,
        intervalMinutes: row.intervalMinutes,
        energyKwh: Number(toNumber(row.energyKwh).toFixed(6)),
        avgPowerKw: Number(toNumber(row.avgPowerKw).toFixed(6)),
        maxPowerKw: row.maxPowerKw == null ? null : Number(toNumber(row.maxPowerKw).toFixed(6)),
        portStatus: row.portStatus,
        vehicleConnected: row.vehicleConnected,
        dataQualityFlag: row.dataQualityFlag,
        sourceVersion: row.sourceVersion,
      })),
    };
  });
}
