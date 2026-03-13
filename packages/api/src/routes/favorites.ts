import type { FastifyInstance } from 'fastify';
import { prisma } from '@ev-charger/shared';
import { requireAuth } from '../plugins/auth';

function normalizeIds(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of input) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export async function favoriteRoutes(app: FastifyInstance) {
  app.get('/me/favorites', { preHandler: requireAuth }, async (req) => {
    const rows = await prisma.$queryRaw<Array<{ chargerId: string }>>`
      SELECT "chargerId"
      FROM "UserFavoriteCharger"
      WHERE "userId" = ${req.currentUser!.id}
      ORDER BY "createdAt" DESC
    `;

    return { chargerIds: rows.map((row) => row.chargerId) };
  });

  app.put<{ Body: { chargerIds?: unknown } }>('/me/favorites', { preHandler: requireAuth }, async (req, reply) => {
    const chargerIds = normalizeIds(req.body?.chargerIds);
    if (chargerIds.length > 500) {
      return reply.status(400).send({ error: 'Too many favorites (max 500)' });
    }

    const existingChargers = chargerIds.length
      ? await prisma.charger.findMany({ where: { id: { in: chargerIds } }, select: { id: true } })
      : [];
    const validSet = new Set(existingChargers.map((row) => row.id));
    const validIds = chargerIds.filter((id) => validSet.has(id));

    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        DELETE FROM "UserFavoriteCharger"
        WHERE "userId" = ${req.currentUser!.id}
      `;
      if (!validIds.length) return;
      for (const chargerId of validIds) {
        await tx.$executeRaw`
          INSERT INTO "UserFavoriteCharger" ("userId", "chargerId")
          VALUES (${req.currentUser!.id}, ${chargerId})
          ON CONFLICT ("userId", "chargerId") DO NOTHING
        `;
      }
    });

    return { chargerIds: validIds };
  });

  app.post<{ Body: { chargerId?: string } }>('/me/favorites', { preHandler: requireAuth }, async (req, reply) => {
    const chargerId = req.body?.chargerId?.trim();
    if (!chargerId) return reply.status(400).send({ error: 'chargerId is required' });

    const charger = await prisma.charger.findUnique({ where: { id: chargerId }, select: { id: true } });
    if (!charger) return reply.status(404).send({ error: 'Charger not found' });

    await prisma.$executeRaw`
      INSERT INTO "UserFavoriteCharger" ("userId", "chargerId")
      VALUES (${req.currentUser!.id}, ${chargerId})
      ON CONFLICT ("userId", "chargerId") DO NOTHING
    `;

    return { ok: true };
  });

  app.delete<{ Params: { chargerId: string } }>('/me/favorites/:chargerId', { preHandler: requireAuth }, async (req) => {
    const chargerId = req.params.chargerId.trim();
    if (!chargerId) return { ok: true };

    await prisma.$executeRaw`
      DELETE FROM "UserFavoriteCharger"
      WHERE "userId" = ${req.currentUser!.id}
        AND "chargerId" = ${chargerId}
    `;

    return { ok: true };
  });
}
