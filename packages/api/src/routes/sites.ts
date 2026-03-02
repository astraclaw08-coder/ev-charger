import type { FastifyInstance } from 'fastify';
import { prisma } from '@ev-charger/shared';
import { requireOperator } from '../plugins/auth';

export async function siteRoutes(app: FastifyInstance) {
  // GET /sites — list operator's sites with charger counts
  app.get('/sites', {
    preHandler: requireOperator,
  }, async (req) => {
    const operator = req.currentOperator!;

    const sites = await prisma.site.findMany({
      where: { operatorId: operator.id },
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
    preHandler: requireOperator,
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
    preHandler: requireOperator,
  }, async (req, reply) => {
    const operator = req.currentOperator!;
    const { name, address, lat, lng } = req.body;

    const site = await prisma.site.create({
      data: { name, address, lat, lng, operatorId: operator.id },
    });

    return reply.status(201).send(site);
  });

  // GET /sites/:id/analytics — last 30 days: sessions, kWh, revenue, uptime
  app.get<{ Params: { id: string } }>('/sites/:id/analytics', {
    preHandler: requireOperator,
  }, async (req, reply) => {
    const site = await prisma.site.findUnique({
      where: { id: req.params.id },
      include: { chargers: { include: { connectors: true } } },
    });

    if (!site) return reply.status(404).send({ error: 'Site not found' });

    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const connectorIds = site.chargers.flatMap((c: { connectors: Array<{ id: string }> }) => c.connectors.map((cn) => cn.id));

    const sessions = await prisma.session.findMany({
      where: {
        connectorId: { in: connectorIds },
        startedAt: { gte: since },
        status: 'COMPLETED',
      },
      include: { payment: true },
    });

    const sessionsCount = sessions.length;
    const kwhDelivered = sessions.reduce((sum: number, s: { kwhDelivered: number | null }) => sum + (s.kwhDelivered ?? 0), 0);
    const revenueCents = sessions.reduce((sum: number, s: { payment: { amountCents: number | null } | null }) => sum + (s.payment?.amountCents ?? 0), 0);

    // Uptime approximation: % of chargers currently ONLINE
    const totalChargers = site.chargers.length;
    const onlineChargers = site.chargers.filter((c: { status: string }) => c.status === 'ONLINE').length;
    const uptimePct = totalChargers > 0 ? Math.round((onlineChargers / totalChargers) * 100) : 0;

    // Build daily breakdown: group sessions by UTC date, fill gaps with zeros
    const dailyMap: Record<string, { date: string; sessions: number; kwhDelivered: number; revenueCents: number }> = {};
    sessions.forEach((s: { startedAt: Date; kwhDelivered: number | null; payment: { amountCents: number | null } | null }) => {
      const day = s.startedAt.toISOString().slice(0, 10);
      if (!dailyMap[day]) dailyMap[day] = { date: day, sessions: 0, kwhDelivered: 0, revenueCents: 0 };
      dailyMap[day].sessions++;
      dailyMap[day].kwhDelivered = Math.round((dailyMap[day].kwhDelivered + (s.kwhDelivered ?? 0)) * 1000) / 1000;
      dailyMap[day].revenueCents += s.payment?.amountCents ?? 0;
    });

    // Fill missing days with zeros so charts have a continuous 30-day range
    const daily: typeof dailyMap[string][] = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      daily.push(dailyMap[d] ?? { date: d, sessions: 0, kwhDelivered: 0, revenueCents: 0 });
    }

    return {
      siteId: site.id,
      siteName: site.name,
      periodDays: 30,
      sessionsCount,
      kwhDelivered: Math.round(kwhDelivered * 1000) / 1000,
      revenueCents,
      revenueUsd: revenueCents / 100,
      uptimePct,
      daily,
    };
  });
}
