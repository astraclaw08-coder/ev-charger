import type { FastifyInstance } from 'fastify';
import { prisma } from '@ev-charger/shared';
import { requireOperator } from '../plugins/auth';
import { getKeycloakAdminClient } from '../lib/keycloakAdmin';

const DEFAULT_ASSIGNABLE_ROLES = ['owner', 'operator', 'customer_support', 'network_reliability', 'analyst'];

function getAssignableRoles() {
  const fromEnv = process.env.KEYCLOAK_ASSIGNABLE_ROLES?.split(',').map((v) => v.trim()).filter(Boolean);
  return fromEnv?.length ? fromEnv : DEFAULT_ASSIGNABLE_ROLES;
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function parseIntRange(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function parseOptionalReason(reason: unknown) {
  if (reason == null) return undefined;
  if (typeof reason !== 'string') return undefined;
  const trimmed = reason.trim();
  return trimmed.length ? trimmed.slice(0, 500) : undefined;
}

async function writeAudit(args: {
  operatorId: string;
  action: string;
  targetUserId?: string;
  targetEmail?: string;
  metadata?: Record<string, unknown>;
}) {
  await prisma.adminAuditEvent.create({
    data: {
      operatorId: args.operatorId,
      action: args.action,
      targetUserId: args.targetUserId,
      targetEmail: args.targetEmail,
      metadata: (args.metadata ?? {}) as any,
    },
  });
}

export async function adminUserRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { search?: string; first?: string; max?: string } }>('/admin/users', {
    preHandler: requireOperator,
  }, async (req) => {
    const kc = getKeycloakAdminClient();
    const users = await kc.listUsers({
      search: req.query.search?.trim() || undefined,
      first: parseIntRange(req.query.first, 0, 0, 10_000),
      max: parseIntRange(req.query.max, 50, 1, 200),
    });

    const usersWithRoles = await Promise.all(users.map(async (user) => {
      const realmRoles = await kc.listRealmRolesForUser(user.id).catch(() => []);
      return {
        ...user,
        realmRoles: realmRoles.map((role) => role.name),
      };
    }));

    return usersWithRoles;
  });

  app.post<{ Body: { email: string; firstName?: string; lastName?: string; sendInvite?: boolean; temporaryPassword?: string } }>(
    '/admin/users',
    { preHandler: requireOperator },
    async (req, reply) => {
      const email = normalizeEmail(req.body.email || '');
      if (!isValidEmail(email)) {
        return reply.status(400).send({ error: 'Valid email is required' });
      }

      const firstName = req.body.firstName?.trim() || undefined;
      const lastName = req.body.lastName?.trim() || undefined;
      const temporaryPassword = req.body.temporaryPassword?.trim() || undefined;

      const kc = getKeycloakAdminClient();
      const user = await kc.createUser({
        email,
        firstName,
        lastName,
        sendInvite: !!req.body.sendInvite,
        temporaryPassword,
      });

      await writeAudit({
        operatorId: req.currentOperator!.id,
        action: 'keycloak.user.create',
        targetUserId: user.id,
        targetEmail: user.email,
        metadata: {
          sendInvite: !!req.body.sendInvite,
          hasTemporaryPassword: !!temporaryPassword,
        },
      });

      return reply.status(201).send({ ...user, realmRoles: [] });
    },
  );

  app.post<{ Params: { userId: string }; Body: { role: string; reason?: string } }>('/admin/users/:userId/roles/add', {
    preHandler: requireOperator,
  }, async (req, reply) => {
    const role = req.body.role?.trim();
    const assignableRoles = getAssignableRoles();

    if (!role || !assignableRoles.includes(role)) {
      return reply.status(400).send({ error: `Role is required and must be one of: ${assignableRoles.join(', ')}` });
    }

    const kc = getKeycloakAdminClient();
    await kc.addRealmRole(req.params.userId, role);
    await kc.logoutUser(req.params.userId);

    await writeAudit({
      operatorId: req.currentOperator!.id,
      action: 'keycloak.user.role.add',
      targetUserId: req.params.userId,
      metadata: {
        role,
        reason: parseOptionalReason(req.body.reason),
        sessionsRevoked: true,
      },
    });

    return { ok: true };
  });

  app.post<{ Params: { userId: string }; Body: { role: string; reason?: string; confirmPrivilegedRoleRemoval?: boolean } }>('/admin/users/:userId/roles/remove', {
    preHandler: requireOperator,
  }, async (req, reply) => {
    const role = req.body.role?.trim();
    const assignableRoles = getAssignableRoles();

    if (!role || !assignableRoles.includes(role)) {
      return reply.status(400).send({ error: `Role is required and must be one of: ${assignableRoles.join(', ')}` });
    }

    const isPrivilegedRole = role === 'owner';
    if (isPrivilegedRole && !req.body.confirmPrivilegedRoleRemoval) {
      return reply.status(400).send({ error: 'confirmPrivilegedRoleRemoval=true required when removing owner role' });
    }

    const kc = getKeycloakAdminClient();
    await kc.removeRealmRole(req.params.userId, role);
    await kc.logoutUser(req.params.userId);

    await writeAudit({
      operatorId: req.currentOperator!.id,
      action: 'keycloak.user.role.remove',
      targetUserId: req.params.userId,
      metadata: {
        role,
        reason: parseOptionalReason(req.body.reason),
        sessionsRevoked: true,
      },
    });

    return { ok: true };
  });

  app.post<{ Params: { userId: string }; Body: { reason?: string; revokeSessions?: boolean } }>('/admin/users/:userId/deactivate', {
    preHandler: requireOperator,
  }, async (req) => {
    const kc = getKeycloakAdminClient();
    const revokeSessions = req.body?.revokeSessions !== false;
    await kc.setEnabled(req.params.userId, false);

    if (revokeSessions) {
      await kc.logoutUser(req.params.userId);
    }

    await writeAudit({
      operatorId: req.currentOperator!.id,
      action: 'keycloak.user.deactivate',
      targetUserId: req.params.userId,
      metadata: {
        reason: parseOptionalReason(req.body?.reason),
        sessionsRevoked: revokeSessions,
      },
    });
    return { ok: true };
  });

  app.post<{ Params: { userId: string }; Body: { reason?: string } }>('/admin/users/:userId/reactivate', {
    preHandler: requireOperator,
  }, async (req) => {
    const kc = getKeycloakAdminClient();
    await kc.setEnabled(req.params.userId, true);
    await writeAudit({
      operatorId: req.currentOperator!.id,
      action: 'keycloak.user.reactivate',
      targetUserId: req.params.userId,
      metadata: {
        reason: parseOptionalReason(req.body?.reason),
      },
    });
    return { ok: true };
  });

  app.post<{ Params: { userId: string }; Body: { reason?: string; revokeSessions?: boolean } }>('/admin/users/:userId/reset-credentials', {
    preHandler: requireOperator,
  }, async (req) => {
    const kc = getKeycloakAdminClient();
    const revokeSessions = req.body?.revokeSessions !== false;

    await kc.executeActionsEmail(req.params.userId, ['UPDATE_PASSWORD']);
    if (revokeSessions) {
      await kc.logoutUser(req.params.userId);
    }

    await writeAudit({
      operatorId: req.currentOperator!.id,
      action: 'keycloak.user.reset-credentials',
      targetUserId: req.params.userId,
      metadata: {
        reason: parseOptionalReason(req.body?.reason),
        sessionsRevoked: revokeSessions,
      },
    });

    return { ok: true };
  });

  app.post<{ Params: { userId: string }; Body: { reason?: string } }>('/admin/users/:userId/revoke-sessions', {
    preHandler: requireOperator,
  }, async (req) => {
    const kc = getKeycloakAdminClient();
    await kc.logoutUser(req.params.userId);
    await writeAudit({
      operatorId: req.currentOperator!.id,
      action: 'keycloak.user.revoke-sessions',
      targetUserId: req.params.userId,
      metadata: {
        reason: parseOptionalReason(req.body?.reason),
      },
    });
    return { ok: true };
  });

  app.get<{ Querystring: { limit?: string } }>('/admin/users/audit', {
    preHandler: requireOperator,
  }, async (req) => {
    const limit = parseIntRange(req.query.limit, 50, 1, 200);
    return prisma.adminAuditEvent.findMany({
      take: limit,
      orderBy: { createdAt: 'desc' },
    });
  });
}
