import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../plugins/auth';
import { normalizeRoleMetadata } from '../lib/authClaims';

type BootstrapBody = {
  bootstrapKey: string;
  role?: 'operator' | 'owner';
};

export async function authRoutes(app: FastifyInstance) {
  app.post<{ Body: BootstrapBody }>('/auth/bootstrap-operator', { preHandler: requireAuth }, async (req, reply) => {
    const clerkSecretKey = process.env.CLERK_SECRET_KEY;
    const expectedKey = process.env.OPERATOR_BOOTSTRAP_KEY;

    if (!clerkSecretKey) {
      return reply.status(501).send({ error: 'Bootstrap requires Clerk production configuration' });
    }

    if (!expectedKey) {
      return reply.status(503).send({ error: 'Bootstrap is not configured' });
    }

    const provided = req.body?.bootstrapKey?.trim();
    if (!provided) {
      return reply.status(400).send({ error: 'bootstrapKey is required' });
    }
    if (provided !== expectedKey) {
      return reply.status(403).send({ error: 'Invalid bootstrap key' });
    }

    const targetRole = req.body?.role ?? 'operator';
    if (!['operator', 'owner'].includes(targetRole)) {
      return reply.status(400).send({ error: 'role must be operator or owner' });
    }

    const { createClerkClient } = await import('@clerk/backend');
    const clerk = createClerkClient({ secretKey: clerkSecretKey });

    const current = await clerk.users.getUser(req.currentUser!.clerkId);
    const existingRoles = normalizeRoleMetadata(current.publicMetadata);

    if (existingRoles.includes(targetRole)) {
      return {
        ok: true,
        alreadyBootstrapped: true,
        clerkId: req.currentUser!.clerkId,
        roles: existingRoles,
      };
    }

    const nextRoles = Array.from(new Set([...existingRoles, targetRole]));
    const nextPublicMetadata = {
      ...(current.publicMetadata as Record<string, unknown>),
      role: nextRoles[0],
      roles: nextRoles,
      roleBootstrapAt: new Date().toISOString(),
    };

    await clerk.users.updateUser(req.currentUser!.clerkId, { publicMetadata: nextPublicMetadata });

    req.log.info({ clerkId: req.currentUser!.clerkId, role: targetRole }, 'Operator role bootstrapped');

    return {
      ok: true,
      alreadyBootstrapped: false,
      clerkId: req.currentUser!.clerkId,
      roles: nextRoles,
    };
  });
}
