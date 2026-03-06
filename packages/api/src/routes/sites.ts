import type { FastifyInstance } from 'fastify';
import { prisma } from '@ev-charger/shared';
import { requireOperator } from '../plugins/auth';
import { requirePolicy } from '../plugins/authorization';
import { getChargerUptime } from '../lib/uptime';

export async function siteRoutes(app: FastifyInstance) {
  // GET /sites — list operator's sites with charger counts
  app.get('/sites', {
    preHandler: [requireOperator, requirePolicy('site.list')],
  }, async (req) => {
    const operator = req.currentOperator!;
    const scopedSiteIds = operator.claims?.siteIds ?? [];

    const sites = await prisma.site.findMany({
      where: scopedSiteIds.length > 0 && !scopedSiteIds.includes('*')
        ? { id: { in: scopedSiteIds } }
        : { operatorId: operator.id },
      include: { chargers: { include: { connectors: true } } },
      orderBy: { createdAt: 'desc' },
    });

    return sites.map((site: {
      id: string; name: string; address: string; lat: number; lng: number; createdAt: Date;
      chargers: Array<{ status: string }>;
    }) => ({
      id: site.id,
      name: site.name,
      address: site.address,
      lat: site.lat,
      lng: site.lng,
      createdAt: site.createdAt,
      chargerCount: site.chargers.length,
      statusSummary: {
        online: site.chargers.filter((c) => c.status === 'ONLINE').length,
        offline: site.chargers.filter((c) => c.status === 'OFFLINE').length,
        faulted: site.chargers.filter((c) => c.status === 'FAULTED').length,
      },
    }));
  });

  // GET /sites/:id — site detail with chargers (no passwords)
  app.get<{ Params: { id: string } }>('/sites/:id', {
    preHandler: [requireOperator, requirePolicy('site.read', { getResourceSiteId: (req) => req.params.id })],
  }, async (req, reply) => {
    const site = await prisma.site.findUnique({
      where: { id: req.params.id },
      include: {
        chargers: {
          orderBy: { createdAt: 'asc' },
          include: { connectors: true },
        },
      },
    });

    if (!site) return reply.status(404).send({ error: 'Site not found' });

    return {
      id: site.id,
      name: site.name,
      address: site.address,
      lat: site.lat,
      lng: site.lng,
      createdAt: site.createdAt,
      chargers: site.chargers.map(({ password: _pw, ...c }: { password: string; [k: string]: unknown }) => c),
    };
  });

  // POST /sites — operator creates a site
  app.post<{
    Body: { name: string; address: string; lat: number; lng: number };
  }>('/sites', {
    preHandler: [requireOperator, requirePolicy('site.create')],
  }, async (req, reply) => {
    const operator = req.currentOperator!;
    const { name, address, lat, lng } = req.body;

    const site = await prisma.site.create({
      data: { name, address, lat, lng, operatorId: operator.id },
    });

    return reply.status(201).send(site);
  });

  // PUT /sites/:id — operator updates site details
  app.put<{
    Params: { id: string };
    Body: { name: string; address: string; lat: number; lng: number };
  }>('/sites/:id', {
    preHandler: [requireOperator, requirePolicy('site.update', { getResourceSiteId: (req) => req.params.id })],
  }, async (req, reply) => {
    const operator = req.currentOperator!;
    const existing = await prisma.site.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.operatorId !== operator.id) {
      return reply.status(404).send({ error: 'Site not found' });
    }

    const { name, address, lat, lng } = req.body;
    const site = await prisma.site.update({
      where: { id: req.params.id },
      data: { name, address, lat, lng },
    });

    return site;
  });



  // GET /sites/:id/uptime — aggregate uptime across site chargers
  app.get<{ Params: { id: string } }>('/sites/:id/uptime', {
    preHandler: [requireOperator, requirePolicy('site.uptime.read', { getResourceSiteId: (req) => req.params.id })],
  }, async (req, reply) => {
    const site = await prisma.site.findUnique({
      where: { id: req.params.id },
      include: { chargers: { select: { id: true, ocppId: true, status: true } } },
    });

    if (!site) return reply.status(404).send({ error: 'Site not found' });

    const perCharger = await Promise.all(site.chargers.map((c) => getChargerUptime(c.id)));
    const rows = perCharger.filter(Boolean) as NonNullable<Awaited<ReturnType<typeof getChargerUptime>>>[];

    const avg = (arr: number[]) => arr.length ? Math.round((arr.reduce((a,b)=>a+b,0)/arr.length) * 100) / 100 : 0;

    return {
      siteId: site.id,
      siteName: site.name,
      chargerCount: rows.length,
      uptimePercent24h: avg(rows.map(r => r.uptimePercent24h)),
      uptimePercent7d: avg(rows.map(r => r.uptimePercent7d)),
      uptimePercent30d: avg(rows.map(r => r.uptimePercent30d)),
      degradedChargers: rows.filter(r => r.currentStatus === 'DEGRADED').length,
      incidents: rows.flatMap(r => r.incidents.map(i => ({ ...i, chargerId: r.chargerId }))).slice(-50),
    };
  });

  // GET /sites/:id/analytics — variable range: sessions, kWh, revenue, uptime
  app.get<{ Params: { id: string }; Querystring: { periodDays?: string; startDate?: string; endDate?: string } }>('/sites/:id/analytics', {
    preHandler: [requireOperator, requirePolicy('site.analytics.read', { getResourceSiteId: (req) => req.params.id })],
  }, async (req, reply) => {
    const site = await prisma.site.findUnique({
      where: { id: req.params.id },
      include: { chargers: { include: { connectors: true } } },
    });

    if (!site) return reply.status(404).send({ error: 'Site not found' });

    const periodDaysRaw = Number.parseInt(req.query.periodDays ?? '30', 10);
    const periodDays = Number.isFinite(periodDaysRaw) && periodDaysRaw > 0 ? Math.min(periodDaysRaw, 120) : 30;

    const hasCustomRange = Boolean(req.query.startDate || req.query.endDate);
    if (hasCustomRange && (!req.query.startDate || !req.query.endDate)) {
      return reply.status(400).send({ error: 'startDate and endDate are required together for custom range' });
    }

    const endDate = req.query.endDate ? new Date(`${req.query.endDate}T23:59:59.999Z`) : new Date();
    const startDate = req.query.startDate
      ? new Date(`${req.query.startDate}T00:00:00.000Z`)
      : new Date(endDate.getTime() - (periodDays - 1) * 24 * 60 * 60 * 1000);

    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || startDate > endDate) {
      return reply.status(400).send({ error: 'Invalid analytics date range' });
    }

    const dayCount = Math.max(1, Math.floor((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000)) + 1);
    const connectorIds = site.chargers.flatMap((c: { connectors: Array<{ id: string }> }) => c.connectors.map((cn) => cn.id));

    const sessions = await prisma.session.findMany({
      where: {
        connectorId: { in: connectorIds },
        startedAt: { gte: startDate, lte: endDate },
        status: 'COMPLETED',
      },
      include: { payment: true },
    });

    const getEffectiveAmountCents = (s: { kwhDelivered: number | null; ratePerKwh: number | null; payment: { amountCents: number | null } | null }) => {
      if (s.payment?.amountCents != null) return s.payment.amountCents;
      if (s.kwhDelivered != null && s.ratePerKwh != null) return Math.round(s.kwhDelivered * s.ratePerKwh * 100);
      return 0;
    };

    const sessionsCount = sessions.length;
    const kwhDelivered = sessions.reduce((sum: number, s: { kwhDelivered: number | null }) => sum + (s.kwhDelivered ?? 0), 0);
    const revenueCents = sessions.reduce((sum: number, s: { kwhDelivered: number | null; ratePerKwh: number | null; payment: { amountCents: number | null } | null }) => sum + getEffectiveAmountCents(s), 0);

    // Uptime approximation: % of chargers currently ONLINE
    const totalChargers = site.chargers.length;
    const onlineChargers = site.chargers.filter((c: { status: string }) => c.status === 'ONLINE').length;
    const uptimePct = totalChargers > 0 ? Math.round((onlineChargers / totalChargers) * 100) : 0;

    // Build daily breakdown: group sessions by UTC date, fill gaps with zeros
    const dailyMap: Record<string, { date: string; sessions: number; kwhDelivered: number; revenueCents: number }> = {};
    sessions.forEach((s: { startedAt: Date; kwhDelivered: number | null; ratePerKwh: number | null; payment: { amountCents: number | null } | null }) => {
      const day = s.startedAt.toISOString().slice(0, 10);
      if (!dailyMap[day]) dailyMap[day] = { date: day, sessions: 0, kwhDelivered: 0, revenueCents: 0 };
      dailyMap[day].sessions++;
      dailyMap[day].kwhDelivered = Math.round((dailyMap[day].kwhDelivered + (s.kwhDelivered ?? 0)) * 1000) / 1000;
      dailyMap[day].revenueCents += getEffectiveAmountCents(s);
    });

    // Fill missing days with zeros so charts have a continuous selected range
    const daily: typeof dailyMap[string][] = [];
    for (let i = 0; i < dayCount; i++) {
      const d = new Date(startDate.getTime() + i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      daily.push(dailyMap[d] ?? { date: d, sessions: 0, kwhDelivered: 0, revenueCents: 0 });
    }

    return {
      siteId: site.id,
      siteName: site.name,
      periodDays: dayCount,
      sessionsCount,
      kwhDelivered: Math.round(kwhDelivered * 1000) / 1000,
      revenueCents,
      revenueUsd: revenueCents / 100,
      uptimePct,
      daily,
    };
  });
}
