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
      stripeCustomerId: string | null;
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

/**
 * Decode the `sub` claim from a JWT without verifying the signature.
 * Used only to scope rate-limit buckets — not for access control.
 */
function jwtSubject(token: string): string | null {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as { sub?: unknown };
    return typeof payload.sub === 'string' && payload.sub.trim() ? payload.sub.trim() : null;
  } catch {
    return null;
  }
}

type IntrospectResult =
  | { ok: true; sub: string; payload: NonNullable<Awaited<ReturnType<typeof introspectAccessToken>>> }
  | { ok: false; reason: 'expired' | 'introspection-error' | 'no-token' };

async function introspectBearer(req: FastifyRequest): Promise<IntrospectResult> {
  const token = bearerToken(req);
  if (!token) return { ok: false, reason: 'no-token' };

  try {
    const payload = await introspectAccessToken(token);
    if (!payload?.sub) {
      // Token was presented but Keycloak says it's inactive (expired / revoked).
      // Return a typed result so callers can decide whether to count this as a
      // suspicious failure or just a normal token-refresh race.
      return { ok: false, reason: 'expired' };
    }
    return { ok: true, sub: payload.sub, payload };
  } catch {
    return { ok: false, reason: 'introspection-error' };
  }
}

async function getUserFromRequest(req: FastifyRequest): Promise<{
  user: Awaited<ReturnType<typeof prisma.user.findUnique>>;
  sub: string | null;
  failureReason: 'expired' | 'introspection-error' | 'no-token' | 'no-user' | null;
}> {
  const appEnv = (process.env.APP_ENV ?? process.env.NODE_ENV ?? '').toLowerCase();

  // Dev override for local QA/guest transact flows only
  const devUserId = req.headers['x-dev-user-id'] as string | undefined;
  if (appEnv === 'development' && devUserId) {
    const user = await prisma.user.findUnique({ where: { id: devUserId } });
    return { user, sub: null, failureReason: user ? null : 'no-user' };
  }

  if (!keycloakPasswordAuthEnabled()) {
    return { user: null, sub: null, failureReason: 'no-token' };
  }

  const result = await introspectBearer(req);
  if (!result.ok) {
    return { user: null, sub: null, failureReason: result.reason };
  }

  const { sub, payload } = result;
  try {
    const authId = `kc:${sub}`;
    const email = payload.email ?? payload.preferred_username ?? `${sub}@keycloak.local`;
    const normalizedEmail = email.trim().toLowerCase();
    let user = await prisma.user.findUnique({ where: { clerkId: authId } });

    if (!user) {
      // Migration-safe path: older/local rows may already exist under the same email
      // with a stale clerkId from a previous auth provider or Keycloak realm. In that
      // case, adopt the existing row instead of hard-failing with 401 on unique email.
      const existingByEmail = await prisma.user.findUnique({ where: { email: normalizedEmail } });
      if (existingByEmail) {
        user = await prisma.user.update({
          where: { id: existingByEmail.id },
          data: {
            clerkId: authId,
            email: normalizedEmail,
            name: (payload.preferred_username as string | undefined) ?? existingByEmail.name,
          },
        });
      } else {
        const idTag = `KC${sub.replace(/[^A-Z0-9]/gi, '').slice(-18)}`.toUpperCase().slice(0, 20);
        user = await prisma.user.create({
          data: {
            clerkId: authId,
            email: normalizedEmail,
            name: (payload.preferred_username as string | undefined) ?? null,
            idTag,
          },
        });
      }
    }
    return { user, sub, failureReason: null };
  } catch {
    return { user: null, sub, failureReason: 'no-user' };
  }
}

export const requireAuth: preHandlerHookHandler = async (req, reply) => {
  const token = bearerToken(req);
  const devUserId = req.headers['x-dev-user-id'] as string | undefined;
  if (!token && !devUserId) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  // Peek at the JWT sub (unverified) so the block-check is scoped per-user,
  // not per-IP. This prevents one user's expired token from poisoning other
  // users' buckets when they share an IP (carrier NAT, office WiFi, etc.).
  const tokenSub = token ? jwtSubject(token) : null;
  const bucketKey = { ip: req.ip, sub: tokenSub ?? undefined, routeScope: 'user' };

  const blocked = isBlocked(bucketKey);
  if (blocked.blocked) {
    reply.header('Retry-After', String(blocked.retryAfterSeconds));
    return reply.status(429).send({ error: 'Too many failed auth attempts', retryAfterSeconds: blocked.retryAfterSeconds });
  }

  const { user, sub, failureReason } = await getUserFromRequest(req);

  if (!user) {
    // Expired/inactive tokens are a normal mobile race-condition (app resumes
    // while refresh is in-flight). Don't count them against the block quota —
    // the mobile client will retry with a fresh token automatically.
    if (failureReason !== 'expired') {
      const failSub = sub ?? tokenSub ?? undefined;
      recordAuthFailure({ ip: req.ip, sub: failSub, routeScope: 'user' });
    }
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  recordAuthSuccess({ ip: req.ip, sub: sub ?? undefined, routeScope: 'user' });
  req.currentUser = {
    id: user.id,
    authId: user.clerkId,
    email: user.email,
    name: user.name,
    idTag: user.idTag,
    stripeCustomerId: user.stripeCustomerId,
  };
};

export const requireOperator: preHandlerHookHandler = async (req, reply) => {
  const token = bearerToken(req);
  const tokenSub = token ? jwtSubject(token) : null;
  const bucketKey = { ip: req.ip, sub: tokenSub ?? undefined, routeScope: 'operator' };

  const blocked = isBlocked(bucketKey);
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
      roles: ['super_admin'],
      claims: {
        version: 1,
        orgId: null,
        roles: ['super_admin'],
        siteIds: ['*'],
        dataScopes: ['full'],
        source: 'legacy',
      },
    };
    return;
  }

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

    const isOperatorLike = effectiveRoles.includes('operator')
      || effectiveRoles.includes('owner')
      || effectiveRoles.includes('admin')
      || effectiveRoles.includes('super_admin');

    if (!payload?.sub || !isOperatorLike) {
      // Expired token → don't record as suspicious failure
      const isExpired = !payload?.sub;
      if (!isExpired) {
        recordAuthFailure({ ip: req.ip, sub: payload?.sub, routeScope: 'operator' });
      }
      return reply.status(403).send({
        error: 'Operator access required',
        denyReason: {
          code: 'INSUFFICIENT_OPERATOR_ROLE',
          reason: 'Token does not include an operator-capable role (operator, owner, admin, or super_admin)',
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
    recordAuthSuccess({ ip: req.ip, sub: payload.sub, routeScope: 'operator' });
  } catch {
    recordAuthFailure({ ip: req.ip, sub: tokenSub ?? undefined, routeScope: 'operator' });
    return reply.status(401).send({ error: 'Unauthorized' });
  }
};
