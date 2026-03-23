import type { preHandlerHookHandler, FastifyRequest } from 'fastify';
import { prisma } from '@ev-charger/shared';
import { parsePortalAccessClaims, type PortalAccessClaimsV1 } from '../lib/portalAccessClaims';
import { isBlocked, recordAuthFailure, recordAuthSuccess } from '../lib/authProtection';
import { introspectAccessToken, keycloakPasswordAuthEnabled } from '../lib/keycloakOidc';

// Attach to request so route handlers can access the authenticated user
declare module 'fastify' {
  interface FastifyRequest {
    currentUser?: {
      id: string;
      authId: string;
      email: string;
      name: string | null;
      idTag: string;
    };
    currentOperator?: {
      id: string;
      email?: string;
      provider?: 'keycloak-password';
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
  const appEnv = (process.env.APP_ENV ?? process.env.NODE_ENV ?? '').toLowerCase();

  // Dev override for local QA/guest transact flows only
  const devUserId = req.headers['x-dev-user-id'] as string | undefined;
  if (appEnv === 'development' && devUserId) {
    return prisma.user.findUnique({ where: { id: devUserId } });
  }

  if (!keycloakPasswordAuthEnabled()) return null;

  const token = bearerToken(req);
  if (!token) return null;

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
  const token = bearerToken(req);
  const devUserId = req.headers['x-dev-user-id'] as string | undefined;
  if (!token && !devUserId) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

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
  req.currentUser = {
    id: user.id,
    authId: user.clerkId,
    email: user.email,
    name: user.name,
    idTag: user.idTag,
  };
};

export const requireOperator: preHandlerHookHandler = async (req, reply) => {
  const blocked = isBlocked({ ip: req.ip, routeScope: 'operator' });
  if (blocked.blocked) {
    reply.header('Retry-After', String(blocked.retryAfterSeconds));
    return reply.status(429).send({ error: 'Too many failed auth attempts', retryAfterSeconds: blocked.retryAfterSeconds });
  }

  // Local-only dev shell fallback
  if (!keycloakPasswordAuthEnabled()) {
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
