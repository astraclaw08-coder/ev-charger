import type { FastifyInstance } from 'fastify';
import { prisma } from '@ev-charger/shared';
import { requireOperator } from '../plugins/auth';
import { requirePolicy } from '../plugins/authorization';
import { getKeycloakAdminClient } from '../lib/keycloakAdmin';
import { getSecurityPostureSnapshot } from '../lib/securityConfig';
import { parseScimProvisioningEvent } from '../lib/scimContracts';

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

export async function adminSecurityRoutes(app: FastifyInstance) {
  app.get('/admin/security/posture', {
    preHandler: [requireOperator, requirePolicy('admin.security.posture.read')],
  }, async () => {
    return getSecurityPostureSnapshot();
  });

  app.post<{ Body: { userId: string; reason: string; incidentId: string; confirmEmergency: boolean; revokeSessions?: boolean } }>(
    '/admin/security/break-glass/grant-owner',
    { preHandler: [requireOperator, requirePolicy('admin.security.breakglass')] },
    async (req, reply) => {
      if (process.env.SECURITY_BREAK_GLASS_ENABLED !== 'true') {
        return reply.status(403).send({ error: 'Break-glass path is disabled' });
      }

      const headerSecret = req.headers['x-break-glass-secret'];
      const expectedSecret = process.env.SECURITY_BREAK_GLASS_SECRET;
      if (!expectedSecret || typeof headerSecret !== 'string' || headerSecret !== expectedSecret) {
        return reply.status(403).send({ error: 'Break-glass secret is invalid' });
      }

      const userId = req.body.userId?.trim();
      const incidentId = req.body.incidentId?.trim();
      const reason = parseOptionalReason(req.body.reason);
      if (!userId || !incidentId || !reason || req.body.confirmEmergency !== true) {
        return reply.status(400).send({ error: 'userId, incidentId, reason and confirmEmergency=true are required' });
      }

      const kc = getKeycloakAdminClient();
      await kc.addRealmRole(userId, 'owner');

      const revokeSessions = req.body.revokeSessions !== false;
      if (revokeSessions) {
        await kc.logoutUser(userId);
      }

      await writeAudit({
        operatorId: req.currentOperator!.id,
        action: 'security.break_glass.owner_granted',
        targetUserId: userId,
        metadata: {
          incidentId,
          reason,
          revokeSessions,
          invokedByIp: req.ip,
          authProvider: req.currentOperator?.provider,
        },
      });

      return {
        ok: true,
        userId,
        roleGranted: 'owner',
        incidentId,
      };
    },
  );

  app.post<{ Params: { eventType: string }; Body: unknown }>('/admin/scim/hooks/:eventType', {
    preHandler: [requireOperator, requirePolicy('admin.security.scim')],
  }, async (req, reply) => {
    if (process.env.SECURITY_SCIM_ENABLED !== 'true') {
      return reply.status(403).send({ error: 'SCIM hook is disabled' });
    }

    try {
      const event = parseScimProvisioningEvent(req.body, req.params.eventType);
      const dryRun = process.env.SECURITY_SCIM_DRY_RUN !== 'false' || event.dryRun;

      await writeAudit({
        operatorId: req.currentOperator!.id,
        action: `security.scim.${event.type}`,
        targetUserId: event.user?.externalId,
        targetEmail: event.user?.email,
        metadata: {
          tenantId: event.tenantId,
          correlationId: event.correlationId,
          dryRun,
          actor: event.actor,
          user: event.user,
          group: event.group,
        },
      });

      return {
        ok: true,
        accepted: true,
        eventId: event.id,
        eventType: event.type,
        dryRun,
      };
    } catch (err) {
      return reply.status(400).send({
        error: err instanceof Error ? err.message : 'Invalid SCIM event payload',
      });
    }
  });
}
