import type { preHandlerHookHandler, FastifyRequest } from 'fastify';
import { prisma } from '@ev-charger/shared';

// Attach to request so route handlers can access the authenticated user
declare module 'fastify' {
  interface FastifyRequest {
    currentUser?: {
      id: string;
      clerkId: string;
      email: string;
      name: string | null;
      idTag: string;
    };
    currentOperator?: {
      id: string;
      email?: string;
    };
  }
}

async function getUserFromRequest(req: FastifyRequest) {
  const clerkSecretKey = process.env.CLERK_SECRET_KEY;

  // Dev mode: no CLERK_SECRET_KEY — accept x-dev-user-id header (Prisma User.id)
  if (!clerkSecretKey) {
    const devUserId = req.headers['x-dev-user-id'] as string | undefined;
    if (!devUserId) return null;
    return prisma.user.findUnique({ where: { id: devUserId } });
  }

  // Production: verify Clerk JWT
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;

  const token = authHeader.slice(7);
  try {
    const { verifyToken, createClerkClient } = await import('@clerk/backend');
    const payload = await verifyToken(token, { secretKey: clerkSecretKey });
    const clerkUserId = payload.sub;

    let user = await prisma.user.findUnique({ where: { clerkId: clerkUserId } });
    if (!user) {
      const clerk = createClerkClient({ secretKey: clerkSecretKey });
      const clerkUser = await clerk.users.getUser(clerkUserId);
      const email = clerkUser.emailAddresses[0]?.emailAddress ?? '';
      const name = [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(' ') || null;
      const idTag = `CL${clerkUserId.replace(/[^A-Z0-9]/gi, '').slice(-18)}`.toUpperCase().slice(0, 20);

      user = await prisma.user.create({
        data: { clerkId: clerkUserId, email, name, idTag },
      });
    }
    return user;
  } catch (err) {
    req.log?.warn('Clerk token verification failed');
    return null;
  }
}

export const requireAuth: preHandlerHookHandler = async (req, reply) => {
  const user = await getUserFromRequest(req);
  if (!user) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }
  req.currentUser = user;
};

export const requireOperator: preHandlerHookHandler = async (req, reply) => {
  const clerkSecretKey = process.env.CLERK_SECRET_KEY;

  // Dev mode: accept x-dev-operator-id header
  if (!clerkSecretKey) {
    const devOperatorId = req.headers['x-dev-operator-id'] as string | undefined;
    if (!devOperatorId) {
      return reply.status(401).send({ error: 'Unauthorized (dev mode: set x-dev-operator-id header)' });
    }
    req.currentOperator = { id: devOperatorId };
    return;
  }

  // Production: verify Clerk JWT and check operator role
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const token = authHeader.slice(7);
  try {
    const { verifyToken, createClerkClient } = await import('@clerk/backend');
    const payload = await verifyToken(token, { secretKey: clerkSecretKey });
    const clerk = createClerkClient({ secretKey: clerkSecretKey });
    const clerkUser = await clerk.users.getUser(payload.sub);
    const role = (clerkUser.publicMetadata as Record<string, unknown>)?.role;

    if (role !== 'operator') {
      return reply.status(403).send({ error: 'Operator access required' });
    }

    req.currentOperator = {
      id: payload.sub,
      email: clerkUser.emailAddresses[0]?.emailAddress,
    };
  } catch {
    return reply.status(401).send({ error: 'Unauthorized' });
  }
};
