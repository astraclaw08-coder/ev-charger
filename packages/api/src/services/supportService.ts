import { prisma } from '@ev-charger/shared';

/**
 * Lookup drivers by email or phone — mirrors GET /admin/support/driver-lookup.
 */
export async function lookupDriver(query: string) {
  const q = query.trim();
  if (q.length < 3) return { error: 'Query must be at least 3 characters' };

  const isEmail = q.includes('@');
  const where = isEmail
    ? { email: q.toLowerCase() }
    : { phone: { contains: q.replace(/[\s\-()]/g, '') } };

  const users = await prisma.user.findMany({
    where,
    select: {
      id: true,
      email: true,
      phone: true,
      name: true,
      idTag: true,
      createdAt: true,
      _count: { select: { sessions: true } },
    },
    take: 10,
  });

  return users.map((u: any) => ({
    id: u.id,
    email: u.email,
    phone: u.phone,
    name: u.name,
    idTag: u.idTag,
    createdAt: u.createdAt,
    sessionCount: u._count.sessions,
  }));
}

/**
 * Get driver profile detail — mirrors GET /admin/support/drivers/:id.
 */
export async function getDriverDetail(driverId: string) {
  const user = await prisma.user.findUnique({
    where: { id: driverId },
    include: {
      _count: { select: { sessions: true, payments: true } },
    },
  });

  if (!user) return { error: 'Driver not found' };

  const { updatedAt: _, _count, ...rest } = user as any;
  return {
    ...rest,
    sessionCount: _count.sessions,
    paymentCount: _count.payments,
  };
}

/**
 * Get driver's session history — mirrors GET /admin/support/drivers/:id/sessions.
 */
export async function getDriverSessions(
  driverId: string,
  params: { page?: number; limit?: number; status?: string; from?: string; to?: string },
) {
  const page = Math.max(params.page ?? 1, 1);
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
  const skip = (page - 1) * limit;

  const where: any = { userId: driverId };
  if (params.status) where.status = params.status;
  if (params.from || params.to) {
    where.startedAt = {};
    if (params.from) where.startedAt.gte = new Date(params.from);
    if (params.to) where.startedAt.lte = new Date(params.to);
  }

  const [sessions, total] = await Promise.all([
    prisma.session.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      skip,
      take: limit,
      include: {
        connector: {
          include: {
            charger: {
              select: { ocppId: true, site: { select: { name: true } } },
            },
          },
        },
      },
    }),
    prisma.session.count({ where }),
  ]);

  return {
    sessions: sessions.map((s: any) => ({
      id: s.id,
      status: s.status,
      startedAt: s.startedAt,
      stoppedAt: s.stoppedAt,
      energyKwh: s.kwhDelivered,
      costUsd: s.ratePerKwh && s.kwhDelivered ? Number(s.ratePerKwh) * Number(s.kwhDelivered) : null,
      ratePerKwh: s.ratePerKwh ? Number(s.ratePerKwh) : null,
      chargerOcppId: s.connector?.charger?.ocppId ?? null,
      siteName: s.connector?.charger?.site?.name ?? null,
      connectorId: s.connector?.connectorId ?? null,
    })),
    total,
    pages: Math.ceil(total / limit),
    page,
    limit,
  };
}
