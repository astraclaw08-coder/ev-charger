import type { FastifyInstance } from 'fastify';
import { prisma } from '@ev-charger/shared';
import { requireAuth } from '../plugins/auth';

export async function profileRoutes(app: FastifyInstance) {
  app.get('/me/profile', { preHandler: requireAuth }, async (req) => {
    const user = req.currentUser!;
    const fresh = await prisma.user.findUnique({ where: { id: user.id } });
    return {
      id: fresh!.id,
      name: fresh!.name,
      email: fresh!.email,
      phone: fresh!.phone,
      homeAddress: fresh!.homeAddress,
      paymentProfile: fresh!.paymentProfile,
    };
  });

  app.put<{
    Body: {
      name?: string;
      email?: string;
      phone?: string | null;
      homeAddress?: string | null;
      paymentProfile?: string | null;
    };
  }>('/me/profile', { preHandler: requireAuth }, async (req) => {
    const user = req.currentUser!;
    const body = req.body ?? {};

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        name: body.name ?? undefined,
        email: body.email ?? undefined,
        phone: body.phone ?? undefined,
        homeAddress: body.homeAddress ?? undefined,
        paymentProfile: body.paymentProfile ?? undefined,
      },
    });

    return {
      id: updated.id,
      name: updated.name,
      email: updated.email,
      phone: updated.phone,
      homeAddress: updated.homeAddress,
      paymentProfile: updated.paymentProfile,
    };
  });
}
