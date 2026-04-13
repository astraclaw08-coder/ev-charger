import type { FastifyInstance } from 'fastify';
import { prisma } from '@ev-charger/shared';
import { requireOperator } from '../plugins/auth';
import { requirePolicy } from '../plugins/authorization';
import { writeAdminAudit } from '../lib/adminAudit';

function isEmail(q: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q);
}

function isPhone(q: string) {
  return /^\+?\d[\d\s\-()]{6,}$/.test(q.replace(/\s/g, ''));
}

export async function supportDriverRoutes(app: FastifyInstance) {
  // ── Lookup ─────────────────────────────────────────────────────────────
  app.get<{ Querystring: { q?: string } }>('/admin/support/driver-lookup', {
    preHandler: [requireOperator, requirePolicy('admin.users.read')],
  }, async (req, reply) => {
    const q = req.query.q?.trim();
    if (!q || q.length < 3) {
      return reply.status(400).send({ error: 'Provide an email or phone number (min 3 chars).' });
    }

    if (!isEmail(q) && !isPhone(q)) {
      return reply.status(400).send({ error: 'Query must be a valid email or phone number.' });
    }

    const where = isEmail(q)
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
  });

  // ── Driver detail ──────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/admin/support/drivers/:id', {
    preHandler: [requireOperator, requirePolicy('admin.users.read')],
  }, async (req, reply) => {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: {
        _count: { select: { sessions: true, payments: true } },
      },
    });
    if (!user) return reply.status(404).send({ error: 'Driver not found.' });

    const { updatedAt, ...rest } = user;
    return {
      ...rest,
      sessionCount: user._count.sessions,
      paymentCount: user._count.payments,
    };
  });

  // ── Update driver profile ──────────────────────────────────────────────
  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>('/admin/support/drivers/:id', {
    preHandler: [requireOperator, requirePolicy('admin.users.read')],
  }, async (req, reply) => {
    const allowed = ['name', 'phone', 'homeAddress', 'homeSiteAddress', 'homeCity', 'homeState', 'homeZipCode', 'idTag'];
    const data: Record<string, unknown> = {};
    for (const key of allowed) {
      if (key in (req.body as Record<string, unknown>)) {
        data[key] = (req.body as Record<string, unknown>)[key];
      }
    }
    if (Object.keys(data).length === 0) {
      return reply.status(400).send({ error: 'No valid fields to update.' });
    }

    try {
      const updated = await prisma.user.update({ where: { id: req.params.id }, data });
      await writeAdminAudit({
        action: 'support.driver.update',
        operatorId: (req as any).currentOperator?.id ?? 'unknown',
        targetUserId: req.params.id,
        metadata: { fields: Object.keys(data) },
      });
      return updated;
    } catch (e: any) {
      if (e.code === 'P2025') return reply.status(404).send({ error: 'Driver not found.' });
      throw e;
    }
  });

  // ── Driver sessions ────────────────────────────────────────────────────
  app.get<{ Params: { id: string }; Querystring: { page?: string; limit?: string; status?: string; from?: string; to?: string } }>('/admin/support/drivers/:id/sessions', {
    preHandler: [requireOperator, requirePolicy('admin.users.read')],
  }, async (req) => {
    const page = Math.max(1, parseInt(req.query.page ?? '1', 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit ?? '20', 10) || 20));
    const skip = (page - 1) * limit;

    const where: any = { userId: req.params.id };
    if (req.query.status) where.status = req.query.status;
    if (req.query.from || req.query.to) {
      where.startedAt = {};
      if (req.query.from) where.startedAt.gte = new Date(req.query.from);
      if (req.query.to) where.startedAt.lte = new Date(req.query.to);
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
              charger: { select: { ocppId: true, site: { select: { name: true } } } },
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
        energyKwh: s.energyKwh,
        costUsd: s.costUsd,
        ratePerKwh: s.ratePerKwh,
        chargerOcppId: s.connector?.charger?.ocppId ?? null,
        siteName: s.connector?.charger?.site?.name ?? null,
        connectorId: s.connector?.connectorId ?? null,
      })),
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    };
  });

  // ── Payment methods (redacted) ─────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/admin/support/drivers/:id/payment-methods', {
    preHandler: [requireOperator, requirePolicy('admin.users.read')],
  }, async (req, reply) => {
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) {
      return reply.status(501).send({ error: 'Stripe not configured.' });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: { stripeCustomerId: true, email: true },
    });
    if (!user) return reply.status(404).send({ error: 'Driver not found.' });
    if (!user.stripeCustomerId) return { cards: [] };

    try {
      const { default: Stripe } = await import('stripe');
      const stripe = new Stripe(stripeKey);
      const paymentMethods = await stripe.paymentMethods.list({
        customer: user.stripeCustomerId,
        type: 'card',
        limit: 10,
      });

      return {
        cards: paymentMethods.data.map((pm) => ({
          id: pm.id,
          brand: pm.card?.brand ?? 'unknown',
          last4: pm.card?.last4 ?? '****',
          expMonth: pm.card?.exp_month,
          expYear: pm.card?.exp_year,
          isDefault: false, // Could check default_payment_method if needed
        })),
      };
    } catch (e: any) {
      app.log.error(`Stripe error for user ${req.params.id}: ${e.message}`);
      return reply.status(502).send({ error: 'Failed to fetch payment methods.' });
    }
  });
}
