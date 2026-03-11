import type { preHandlerHookHandler, FastifyRequest } from 'fastify';
import { prisma } from '@ev-charger/shared';
import { extractAuthProvider, normalizeRoleMetadata } from '../lib/authClaims';
import { parsePortalAccessClaims, type PortalAccessClaimsV1 } from '../lib/portalAccessClaims';
import { isBlocked, recordAuthFailure, recordAuthSuccess } from '../lib/authProtection';
import { introspectAccessToken, keycloakPasswordAuthEnabled } from '../lib/keycloakOidc';

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
      provider?: 'google' | 'apple' | 'unknown' | 'keycloak-password';
      roles?: string[];
      claims?: PortalAccessClaimsV1;
    };
  }
}

function bearerToken(req: FastifyRequest) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  return authHeader.slice(7);
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
  const token = bearerToken(req);
  if (!token) return null;

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
  } catch {
    req.log?.warn('Clerk token verification failed');
  }

  if (!keycloakPasswordAuthEnabled()) return null;

  try {
    const payload = await introspectAccessToken(token);
    if (!payload?.sub) return null;

    const authId = `kc:${payload.sub}`;
    let user = await prisma.user.findUnique({ where: { clerkId: authId } });
    if (!user) {
      const email = payload.email ?? payload.preferred_username ?? `${payload.sub}@keycloak.local`;
      const idTag = `KC${payload.sub.replace(/[^A-Z0-9]/gi, '').slice(-18)}`.toUpperCase().slice(0, 20);
      user = await prisma.user.create({
        data: {
          clerkId: authId,
          email,
          name: payload.preferred_username ?? null,
          idTag,
        },
      });
    }
    return user;
  } catch {
    return null;
  }
}

export const requireAuth: preHandlerHookHandler = async (req, reply) => {
  const blocked = isBlocked({ ip: req.ip, routeScope: 'user' });
  if (blocked.blocked) {
    reply.header('Retry-After', String(blocked.retryAfterSeconds));
    return reply.status(429).send({ error: 'Too many failed auth attempts', retryAfterSeconds: blocked.retryAfterSeconds });
  }

  const user = await getUserFromRequest(req);
  if (!user) {
    recordAuthFailure({ ip: req.ip, routeScope: 'user' });
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  recordAuthSuccess({ ip: req.ip, routeScope: 'user' });
  req.currentUser = user;
};

export const requireOperator: preHandlerHookHandler = async (req, reply) => {
  const blocked = isBlocked({ ip: req.ip, routeScope: 'operator' });
  if (blocked.blocked) {
    reply.header('Retry-After', String(blocked.retryAfterSeconds));
    return reply.status(429).send({ error: 'Too many failed auth attempts', retryAfterSeconds: blocked.retryAfterSeconds });
  }

  const clerkSecretKey = process.env.CLERK_SECRET_KEY;

  // Dev mode: accept x-dev-operator-id header
  if (!clerkSecretKey) {
    const devOperatorId = req.headers['x-dev-operator-id'] as string | undefined;
    if (!devOperatorId) {
      recordAuthFailure({ ip: req.ip, routeScope: 'operator' });
      return reply.status(401).send({ error: 'Unauthorized (dev mode: set x-dev-operator-id header)' });
    }
    recordAuthSuccess({ ip: req.ip, routeScope: 'operator' });
    req.currentOperator = {
      id: devOperatorId,
      roles: ['owner'],
      claims: {
        version: 1,
        orgId: null,
        roles: ['owner'],
        siteIds: ['*'],
        dataScopes: ['full'],
        source: 'legacy',
      },
    };
    return;
  }

  const token = bearerToken(req);
  if (!token) {
    recordAuthFailure({ ip: req.ip, routeScope: 'operator' });
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  try {
    const { verifyToken, createClerkClient } = await import('@clerk/backend');
    const payload = await verifyToken(token, { secretKey: clerkSecretKey });
    const clerk = createClerkClient({ secretKey: clerkSecretKey });
    const clerkUser = await clerk.users.getUser(payload.sub);
    const legacyRoles = normalizeRoleMetadata(clerkUser.publicMetadata);
    const claims = parsePortalAccessClaims({
      tokenPayload: payload as Record<string, unknown>,
      metadata: clerkUser.publicMetadata as Record<string, unknown>,
    });

    const effectiveRoles = claims.roles.length > 0 ? claims.roles : legacyRoles;

    if (!effectiveRoles.includes('operator') && !effectiveRoles.includes('owner')) {
      recordAuthFailure({ ip: req.ip, routeScope: 'operator' });
      return reply.status(403).send({
        error: 'Operator access required',
        denyReason: {
          code: 'INSUFFICIENT_OPERATOR_ROLE',
          reason: 'Token does not include operator or owner role',
        },
      });
    }

    recordAuthSuccess({ ip: req.ip, routeScope: 'operator' });
    req.currentOperator = {
      id: payload.sub,
      email: clerkUser.emailAddresses[0]?.emailAddress,
      provider: extractAuthProvider(payload as Record<string, unknown>),
      roles: effectiveRoles,
      claims: {
        ...claims,
        roles: effectiveRoles,
      },
    };
    return;
  } catch {
    // Fallback to Keycloak token introspection for portal password login.
  }

  if (!keycloakPasswordAuthEnabled()) {
    recordAuthFailure({ ip: req.ip, routeScope: 'operator' });
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  try {
    const payload = await introspectAccessToken(token);
    const claims = parsePortalAccessClaims({
      tokenPayload: (payload ?? {}) as Record<string, unknown>,
      metadata: {},
    });
    const effectiveRoles = claims.roles;

    if (!payload?.sub || (!effectiveRoles.includes('operator') && !effectiveRoles.includes('owner'))) {
      recordAuthFailure({ ip: req.ip, routeScope: 'operator' });
      return reply.status(403).send({
        error: 'Operator access required',
        denyReason: {
          code: 'INSUFFICIENT_OPERATOR_ROLE',
          reason: 'Token does not include operator or owner role',
        },
      });
    }

    req.currentOperator = {
      id: payload.sub,
      email: payload.email ?? payload.preferred_username,
      provider: 'keycloak-password',
      roles: effectiveRoles,
      claims: {
        ...claims,
        roles: effectiveRoles,
      },
    };
    recordAuthSuccess({ ip: req.ip, routeScope: 'operator' });
  } catch {
    recordAuthFailure({ ip: req.ip, routeScope: 'operator' });
    return reply.status(401).send({ error: 'Unauthorized' });
  }
};
