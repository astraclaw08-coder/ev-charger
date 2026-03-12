import type { FastifyInstance } from 'fastify';
import { prisma } from '@ev-charger/shared';
import { requireAuth, requireOperator } from '../plugins/auth';
import { requirePolicy } from '../plugins/authorization';
import { writeAdminAudit } from '../lib/adminAudit';

type TargetMode = 'all' | 'user_ids' | 'emails';

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export async function notificationRoutes(app: FastifyInstance) {
  app.post<{ Body: { targetMode?: TargetMode; userIds?: string[]; emails?: string[]; title?: string; message?: string; actionLabel?: string; actionUrl?: string; deepLink?: string; reason?: string } }>(
    '/admin/notifications/send',
    { preHandler: [requireOperator, requirePolicy('admin.notifications.write')] },
    async (req, reply) => {
      const targetMode = req.body?.targetMode;
      const title = (req.body?.title ?? '').trim();
      const message = (req.body?.message ?? '').trim();
      const actionLabel = (req.body?.actionLabel ?? '').trim();
      const actionUrl = (req.body?.actionUrl ?? '').trim();
      const deepLink = (req.body?.deepLink ?? '').trim();

      if (!targetMode || !['all', 'user_ids', 'emails'].includes(targetMode)) {
        return reply.status(400).send({ error: 'targetMode must be one of: all, user_ids, emails' });
      }
      if (!title || !message) {
        return reply.status(400).send({ error: 'title and message are required' });
      }
      if (title.length > 120) {
        return reply.status(400).send({ error: 'title must be <= 120 chars' });
      }
      if (message.length > 1000) {
        return reply.status(400).send({ error: 'message must be <= 1000 chars' });
      }
      if (actionLabel.length > 50) {
        return reply.status(400).send({ error: 'actionLabel must be <= 50 chars' });
      }

      const requestedUserIds = [...new Set((req.body?.userIds ?? []).map((id) => id.trim()).filter(Boolean))];
      const requestedEmails = [...new Set((req.body?.emails ?? []).map(normalizeEmail).filter(Boolean))];

      if (targetMode === 'user_ids' && requestedUserIds.length === 0) {
        return reply.status(400).send({ error: 'userIds required when targetMode=user_ids' });
      }
      if (targetMode === 'emails' && requestedEmails.length === 0) {
        return reply.status(400).send({ error: 'emails required when targetMode=emails' });
      }

      let users: Array<{ id: string; email: string }> = [];
      if (targetMode === 'all') {
        users = await prisma.user.findMany({ select: { id: true, email: true } });
      } else if (targetMode === 'user_ids') {
        users = await prisma.user.findMany({ where: { id: { in: requestedUserIds } }, select: { id: true, email: true } });
      } else {
        users = await prisma.user.findMany({ where: { email: { in: requestedEmails } }, select: { id: true, email: true } });
      }

      if (users.length === 0) {
        return reply.status(400).send({ error: 'No matching users found for selected targeting' });
      }

      const resolvedUserIds = users.map((u) => u.id);
      const resolvedEmails = users.map((u) => u.email);

      const created = await prisma.inAppNotificationCampaign.create({
        data: {
          createdByOperatorId: req.currentOperator!.id,
          targetMode,
          targetUserIds: targetMode === 'all' ? [] : requestedUserIds,
          targetEmails: targetMode === 'emails' ? requestedEmails : [],
          title,
          message,
          actionLabel: actionLabel || null,
          actionUrl: actionUrl || null,
          deepLink: deepLink || null,
          deliveries: {
            createMany: {
              data: resolvedUserIds.map((userId) => ({ userId })),
            },
          },
        },
        include: {
          _count: { select: { deliveries: true } },
        },
      });

      await writeAdminAudit({
        operatorId: req.currentOperator!.id,
        action: 'admin.notifications.send',
        metadata: {
          campaignId: created.id,
          targetMode,
          requestedUserIds,
          requestedEmails,
          resolvedUserCount: resolvedUserIds.length,
          resolvedEmails,
          title,
          actionLabel: actionLabel || null,
          actionUrl: actionUrl || null,
          deepLink: deepLink || null,
          reason: (req.body?.reason ?? '').trim() || null,
        },
      });

      return {
        id: created.id,
        sentAt: created.sentAt,
        title: created.title,
        message: created.message,
        targetMode: created.targetMode,
        deliveryCount: created._count.deliveries,
      };
    },
  );

  app.get<{ Querystring: { limit?: string } }>('/admin/notifications/audit', {
    preHandler: [requireOperator, requirePolicy('admin.notifications.read')],
  }, async (req) => {
    const limitRaw = Number(req.query?.limit ?? 40);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, Math.trunc(limitRaw))) : 40;

    const rows = await prisma.inAppNotificationCampaign.findMany({
      orderBy: { sentAt: 'desc' },
      take: limit,
      include: {
        _count: { select: { deliveries: true } },
      },
    });

    return rows.map((row) => ({
      id: row.id,
      createdByOperatorId: row.createdByOperatorId,
      targetMode: row.targetMode,
      targetUserIds: row.targetUserIds,
      targetEmails: row.targetEmails,
      title: row.title,
      message: row.message,
      actionLabel: row.actionLabel,
      actionUrl: row.actionUrl,
      deepLink: row.deepLink,
      sentAt: row.sentAt,
      deliveryCount: row._count.deliveries,
    }));
  });

  app.get<{ Querystring: { limit?: string } }>('/me/notifications', {
    preHandler: requireAuth,
  }, async (req) => {
    const limitRaw = Number(req.query?.limit ?? 40);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, Math.trunc(limitRaw))) : 40;

    const rows = await prisma.inAppNotificationDelivery.findMany({
      where: { userId: req.currentUser!.id },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { campaign: true },
    });

    return rows.map((row) => ({
      id: row.id,
      campaignId: row.campaignId,
      title: row.campaign.title,
      message: row.campaign.message,
      actionLabel: row.campaign.actionLabel,
      actionUrl: row.campaign.actionUrl,
      deepLink: row.campaign.deepLink,
      sentAt: row.campaign.sentAt,
      createdAt: row.createdAt,
      readAt: row.readAt,
      isRead: !!row.readAt,
    }));
  });

  app.post<{ Params: { id: string } }>('/me/notifications/:id/read', {
    preHandler: requireAuth,
  }, async (req, reply) => {
    const existing = await prisma.inAppNotificationDelivery.findFirst({
      where: { id: req.params.id, userId: req.currentUser!.id },
      select: { id: true, readAt: true },
    });

    if (!existing) {
      return reply.status(404).send({ error: 'Notification not found' });
    }

    if (!existing.readAt) {
      await prisma.inAppNotificationDelivery.update({
        where: { id: existing.id },
        data: { readAt: new Date() },
      });
    }

    return { ok: true };
  });
}
