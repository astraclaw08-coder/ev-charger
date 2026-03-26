import type { FastifyInstance } from 'fastify';
import { prisma } from '@ev-charger/shared';
import { requireOperator } from '../plugins/auth';
import { requirePolicy } from '../plugins/authorization';
import { getKeycloakAdminClient } from '../lib/keycloakAdmin';
import { recordSensitiveAction } from '../lib/sensitiveActionLimiter';
import { writeAdminAudit } from '../lib/adminAudit';

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

function requireReason(reason: unknown) {
  const parsed = parseOptionalReason(reason);
  return parsed && parsed.length > 0 ? parsed : null;
}

function uniqueSorted(values: string[]) {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

async function guardSensitiveAction(req: { currentOperator?: { id: string }; ip: string }, reply: { header: (n: string, v: string) => void; status: (code: number) => { send: (payload: unknown) => unknown } }) {
  const operatorId = req.currentOperator?.id;
  if (!operatorId) return;

  const allowance = recordSensitiveAction(operatorId, req.ip);
  if (!allowance.allowed) {
    reply.header('Retry-After', String(allowance.retryAfterSeconds));
    return reply.status(429).send({
      error: 'Too many sensitive admin actions. Slow down and retry.',
      retryAfterSeconds: allowance.retryAfterSeconds,
    });
  }
}

export async function adminUserRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { search?: string; first?: string; max?: string } }>('/admin/users', {
    preHandler: [requireOperator, requirePolicy('admin.users.read')],
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
    { preHandler: [requireOperator, requirePolicy('admin.users.write'), guardSensitiveAction as any] },
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

      await writeAdminAudit({
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
    preHandler: [requireOperator, requirePolicy('admin.users.write'), guardSensitiveAction as any],
  }, async (req, reply) => {
    const role = req.body.role?.trim();
    const reason = requireReason(req.body.reason);
    const assignableRoles = getAssignableRoles();

    if (!role || !assignableRoles.includes(role)) {
      return reply.status(400).send({ error: `Role is required and must be one of: ${assignableRoles.join(', ')}` });
    }
    if (!reason) {
      return reply.status(400).send({ error: 'Non-empty reason is required for role changes' });
    }

    const kc = getKeycloakAdminClient();
    const beforeRoles = uniqueSorted((await kc.listRealmRolesForUser(req.params.userId)).map((r) => r.name).filter(Boolean));
    await kc.addRealmRole(req.params.userId, role);
    await kc.logoutUser(req.params.userId);
    const afterRoles = uniqueSorted((await kc.listRealmRolesForUser(req.params.userId)).map((r) => r.name).filter(Boolean));

    await writeAdminAudit({
      operatorId: req.currentOperator!.id,
      action: 'keycloak.user.role.add',
      targetUserId: req.params.userId,
      metadata: {
        actor: { operatorId: req.currentOperator!.id },
        target: { userId: req.params.userId },
        timestamp: new Date().toISOString(),
        role,
        reason,
        before: { roles: beforeRoles },
        after: { roles: afterRoles },
        sessionsRevoked: true,
      },
    });

    return { ok: true };
  });

  app.post<{ Params: { userId: string }; Body: { role: string; reason?: string; confirmPrivilegedRoleRemoval?: boolean } }>('/admin/users/:userId/roles/remove', {
    preHandler: [requireOperator, requirePolicy('admin.users.write'), guardSensitiveAction as any],
  }, async (req, reply) => {
    const role = req.body.role?.trim();
    const reason = requireReason(req.body.reason);
    const assignableRoles = getAssignableRoles();

    if (!role || !assignableRoles.includes(role)) {
      return reply.status(400).send({ error: `Role is required and must be one of: ${assignableRoles.join(', ')}` });
    }
    if (!reason) {
      return reply.status(400).send({ error: 'Non-empty reason is required for role changes' });
    }

    const isPrivilegedRole = role === 'owner';
    if (isPrivilegedRole && !req.body.confirmPrivilegedRoleRemoval) {
      return reply.status(400).send({ error: 'confirmPrivilegedRoleRemoval=true required when removing owner role' });
    }

    const kc = getKeycloakAdminClient();
    const beforeRoles = uniqueSorted((await kc.listRealmRolesForUser(req.params.userId)).map((r) => r.name).filter(Boolean));
    await kc.removeRealmRole(req.params.userId, role);
    await kc.logoutUser(req.params.userId);
    const afterRoles = uniqueSorted((await kc.listRealmRolesForUser(req.params.userId)).map((r) => r.name).filter(Boolean));

    await writeAdminAudit({
      operatorId: req.currentOperator!.id,
      action: 'keycloak.user.role.remove',
      targetUserId: req.params.userId,
      metadata: {
        actor: { operatorId: req.currentOperator!.id },
        target: { userId: req.params.userId },
        timestamp: new Date().toISOString(),
        role,
        reason,
        before: { roles: beforeRoles },
        after: { roles: afterRoles },
        sessionsRevoked: true,
      },
    });

    return { ok: true };
  });

  app.post<{ Params: { userId: string }; Body: { reason?: string; revokeSessions?: boolean } }>('/admin/users/:userId/deactivate', {
    preHandler: [requireOperator, requirePolicy('admin.users.write'), guardSensitiveAction as any],
  }, async (req) => {
    const kc = getKeycloakAdminClient();
    const revokeSessions = req.body?.revokeSessions !== false;
    await kc.setEnabled(req.params.userId, false);

    if (revokeSessions) {
      await kc.logoutUser(req.params.userId);
    }

    await writeAdminAudit({
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
    preHandler: [requireOperator, requirePolicy('admin.users.write'), guardSensitiveAction as any],
  }, async (req) => {
    const kc = getKeycloakAdminClient();
    await kc.setEnabled(req.params.userId, true);
    await writeAdminAudit({
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
    preHandler: [requireOperator, requirePolicy('admin.users.write'), guardSensitiveAction as any],
  }, async (req) => {
    const kc = getKeycloakAdminClient();
    const revokeSessions = req.body?.revokeSessions !== false;

    await kc.executeActionsEmail(req.params.userId, ['UPDATE_PASSWORD']);
    if (revokeSessions) {
      await kc.logoutUser(req.params.userId);
    }

    await writeAdminAudit({
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
    preHandler: [requireOperator, requirePolicy('admin.users.write'), guardSensitiveAction as any],
  }, async (req) => {
    const kc = getKeycloakAdminClient();
    await kc.logoutUser(req.params.userId);
    await writeAdminAudit({
      operatorId: req.currentOperator!.id,
      action: 'keycloak.user.revoke-sessions',
      targetUserId: req.params.userId,
      metadata: {
        reason: parseOptionalReason(req.body?.reason),
      },
    });
    return { ok: true };
  });

  // ── Update user ────────────────────────────────────────────────────────────
  app.put<{
    Params: { userId: string };
    Body: { email?: string; firstName?: string; lastName?: string };
  }>('/admin/users/:userId', {
    preHandler: [requireOperator, requirePolicy('admin.users.write'), guardSensitiveAction as any],
  }, async (req, reply) => {
    const kc = getKeycloakAdminClient();
    const patch: Record<string, unknown> = {};
    if (req.body.email) {
      const email = normalizeEmail(req.body.email);
      if (!isValidEmail(email)) return reply.status(400).send({ error: 'Valid email is required' });
      patch.email = email;
      patch.username = email.toLowerCase();
    }
    if (req.body.firstName !== undefined) patch.firstName = req.body.firstName.trim();
    if (req.body.lastName !== undefined) patch.lastName = req.body.lastName.trim();

    await kc.updateUser(req.params.userId, patch);

    await writeAdminAudit({
      operatorId: req.currentOperator!.id,
      action: 'keycloak.user.update',
      targetUserId: req.params.userId,
      metadata: { fields: Object.keys(patch) },
    });

    const updated = await kc.getUser(req.params.userId);
    return reply.send(updated);
  });

  // ── Delete user ───────────────────────────────────────────────────────────
  app.delete<{
    Params: { userId: string };
    Body: { reason?: string };
  }>('/admin/users/:userId', {
    preHandler: [requireOperator, requirePolicy('admin.users.write'), guardSensitiveAction as any],
  }, async (req, reply) => {
    const kc = getKeycloakAdminClient();
    const user = await kc.getUser(req.params.userId);

    await kc.deleteUser(req.params.userId);

    await writeAdminAudit({
      operatorId: req.currentOperator!.id,
      action: 'keycloak.user.delete',
      targetUserId: req.params.userId,
      targetEmail: user.email,
      metadata: { reason: parseOptionalReason(req.body?.reason) },
    });

    return reply.send({ ok: true });
  });

  app.get<{ Querystring: { limit?: string } }>('/admin/users/audit', {
    preHandler: [requireOperator, requirePolicy('admin.audit.read')],
  }, async (req) => {
    const limit = parseIntRange(req.query.limit, 50, 1, 200);
    return prisma.adminAuditEvent.findMany({
      take: limit,
      orderBy: { createdAt: 'desc' },
    });
  });
}
