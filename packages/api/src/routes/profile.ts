import type { FastifyInstance } from 'fastify';
import { prisma } from '@ev-charger/shared';
import { requireAuth } from '../plugins/auth';

export async function profileRoutes(app: FastifyInstance) {
  app.get('/me/profile', { preHandler: requireAuth }, async (req) => {
    const user = req.currentUser!;
    const fresh = await prisma.user.findUnique({ where: { id: user.id } });
    return {
      id: fresh!.id,
      idTag: fresh!.idTag,
      name: fresh!.name,
      email: fresh!.email,
      phone: fresh!.phone,
      homeAddress: fresh!.homeAddress,
      homeSiteAddress: fresh!.homeSiteAddress,
      homeCity: fresh!.homeCity,
      homeState: fresh!.homeState,
      homeZipCode: fresh!.homeZipCode,
      paymentProfile: fresh!.paymentProfile,
    };
  });

  app.put<{
    Body: {
      name?: string;
      email?: string;
      phone?: string | null;
      homeAddress?: string | null;
      homeSiteAddress?: string | null;
      homeCity?: string | null;
      homeState?: string | null;
      homeZipCode?: string | null;
      paymentProfile?: string | null;
    };
  }>('/me/profile', { preHandler: requireAuth }, async (req) => {
    const user = req.currentUser!;
    const body = req.body ?? {};

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        name: body.name !== undefined ? body.name : undefined,
        email: body.email !== undefined ? body.email : undefined,
        phone: body.phone !== undefined ? body.phone : undefined,
        homeAddress: body.homeAddress !== undefined ? body.homeAddress : undefined,
        homeSiteAddress: body.homeSiteAddress !== undefined ? body.homeSiteAddress : undefined,
        homeCity: body.homeCity !== undefined ? body.homeCity : undefined,
        homeState: body.homeState !== undefined ? body.homeState : undefined,
        homeZipCode: body.homeZipCode !== undefined ? body.homeZipCode : undefined,
        paymentProfile: body.paymentProfile !== undefined ? body.paymentProfile : undefined,
      },
    });

    return {
      id: updated.id,
      idTag: updated.idTag,
      name: updated.name,
      email: updated.email,
      phone: updated.phone,
      homeAddress: updated.homeAddress,
      homeSiteAddress: updated.homeSiteAddress,
      homeCity: updated.homeCity,
      homeState: updated.homeState,
      homeZipCode: updated.homeZipCode,
      paymentProfile: updated.paymentProfile,
    };
  });
}
