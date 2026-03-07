import type { FastifyInstance } from 'fastify';
import { prisma } from '@ev-charger/shared';
import { requireOperator } from '../plugins/auth';
import { requirePolicy } from '../plugins/authorization';
import { writeAdminAudit } from '../lib/adminAudit';

type OperatorReq = { currentOperator?: { id: string; claims?: { orgId?: string } } };

function scopeKey(req: OperatorReq) {
  return req.currentOperator?.claims?.orgId || 'global';
}

function trimOrNull(value: unknown, max = 120) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function cleanRouting(value: unknown) {
  if (typeof value !== 'string') return null;
  const digits = value.replace(/\D/g, '');
  return digits.length ? digits : null;
}

function cleanAccount(value: unknown) {
  if (typeof value !== 'string') return null;
  const digits = value.replace(/\D/g, '');
  return digits.length ? digits : null;
}

function maskAccount(account: string | null | undefined) {
  if (!account) return null;
  if (account.length <= 4) return account;
  return `${'*'.repeat(Math.max(0, account.length - 4))}${account.slice(-4)}`;
}

function validateSettings(body: Record<string, unknown>) {
  const routingNumber = cleanRouting(body.routingNumber);
  const accountNumber = cleanAccount(body.accountNumber);
  const remittanceEmail = trimOrNull(body.remittanceEmail, 200);

  if (routingNumber && routingNumber.length !== 9) {
    throw new Error('Routing number must be 9 digits');
  }

  if (accountNumber && (accountNumber.length < 4 || accountNumber.length > 17)) {
    throw new Error('Account number must be between 4 and 17 digits');
  }

  if (remittanceEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(remittanceEmail)) {
    throw new Error('Remittance email must be a valid email address');
  }

  return {
    organizationName: trimOrNull(body.organizationName, 120),
    organizationDefaultSite: trimOrNull(body.organizationDefaultSite, 120),
    organizationPortfolio: trimOrNull(body.organizationPortfolio, 120),
    organizationBillingAddress: trimOrNull(body.organizationBillingAddress, 250),
    supportContactEmail: trimOrNull(body.supportContactEmail, 200),
    supportContactPhone: trimOrNull(body.supportContactPhone, 40),
    profileDisplayName: trimOrNull(body.profileDisplayName, 120),
    profileTimezone: trimOrNull(body.profileTimezone, 80),
    remittanceBankName: trimOrNull(body.remittanceBankName, 120),
    remittanceAccountType: trimOrNull(body.remittanceAccountType, 30),
    remittanceEmail,
    routingNumber,
    accountNumber,
  };
}

export async function adminSettingsRoutes(app: FastifyInstance) {
  app.get('/admin/settings', {
    preHandler: [requireOperator, requirePolicy('admin.settings.read')],
  }, async (req) => {
    const settings = await prisma.portalSettings.findUnique({ where: { scopeKey: scopeKey(req as OperatorReq) } });
    return {
      settings,
      notificationPreferences: await prisma.operatorNotificationPreference.findUnique({ where: { operatorId: (req as OperatorReq).currentOperator!.id } }),
      chargerModels: await prisma.chargerModelCatalog.findMany({
        where: { scopeKey: scopeKey(req as OperatorReq) },
        orderBy: [{ isActive: 'desc' }, { vendor: 'asc' }, { modelCode: 'asc' }],
      }),
    };
  });

  app.put<{ Body: Record<string, unknown> }>('/admin/settings/org-profile', {
    preHandler: [requireOperator, requirePolicy('admin.settings.write')],
  }, async (req, reply) => {
    const reason = trimOrNull(req.body.reason, 500);
    if (!reason) return reply.status(400).send({ error: 'Change reason is required' });

    let validated;
    try {
      validated = validateSettings(req.body);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }

    const key = scopeKey(req as OperatorReq);
    const before = await prisma.portalSettings.findUnique({ where: { scopeKey: key } });

    const updated = await prisma.portalSettings.upsert({
      where: { scopeKey: key },
      create: {
        scopeKey: key,
        updatedByOperatorId: (req as OperatorReq).currentOperator!.id,
        ...validated,
      },
      update: {
        ...validated,
        updatedByOperatorId: (req as OperatorReq).currentOperator!.id,
      },
    });

    await writeAdminAudit({
      operatorId: (req as OperatorReq).currentOperator!.id,
      action: 'admin.settings.org-profile.update',
      metadata: {
        reason,
        scopeKey: key,
        before: {
          organizationName: before?.organizationName ?? null,
          remittanceAccountNumberMasked: maskAccount(before?.accountNumber),
          routingNumber: before?.routingNumber ?? null,
        },
        after: {
          organizationName: updated.organizationName,
          remittanceAccountNumberMasked: maskAccount(updated.accountNumber),
          routingNumber: updated.routingNumber,
        },
      },
    });

    return updated;
  });

  app.put<{ Body: { emailEnabled?: boolean; smsEnabled?: boolean; outageAlerts?: boolean; billingAlerts?: boolean; weeklyDigest?: boolean; reason?: string } }>(
    '/admin/settings/notifications',
    { preHandler: [requireOperator, requirePolicy('admin.settings.write')] },
    async (req, reply) => {
      const reason = trimOrNull(req.body.reason, 500);
      if (!reason) return reply.status(400).send({ error: 'Change reason is required' });

      const updated = await prisma.operatorNotificationPreference.upsert({
        where: { operatorId: (req as OperatorReq).currentOperator!.id },
        create: {
          operatorId: (req as OperatorReq).currentOperator!.id,
          emailEnabled: req.body.emailEnabled ?? true,
          smsEnabled: req.body.smsEnabled ?? false,
          outageAlerts: req.body.outageAlerts ?? true,
          billingAlerts: req.body.billingAlerts ?? true,
          weeklyDigest: req.body.weeklyDigest ?? true,
        },
        update: {
          emailEnabled: req.body.emailEnabled,
          smsEnabled: req.body.smsEnabled,
          outageAlerts: req.body.outageAlerts,
          billingAlerts: req.body.billingAlerts,
          weeklyDigest: req.body.weeklyDigest,
        },
      });

      await writeAdminAudit({
        operatorId: (req as OperatorReq).currentOperator!.id,
        action: 'admin.settings.notifications.update',
        metadata: { reason, ...updated },
      });

      return updated;
    },
  );

  app.post<{ Body: { modelCode?: string; vendor?: string; displayName?: string; maxKw?: number; connectorType?: string; reason?: string } }>('/admin/settings/charger-models', {
    preHandler: [requireOperator, requirePolicy('admin.settings.write')],
  }, async (req, reply) => {
    const reason = trimOrNull(req.body.reason, 500);
    const modelCode = trimOrNull(req.body.modelCode, 64);
    const vendor = trimOrNull(req.body.vendor, 120);
    const displayName = trimOrNull(req.body.displayName, 160);
    const connectorType = trimOrNull(req.body.connectorType, 64);
    const maxKw = Number(req.body.maxKw);

    if (!reason) return reply.status(400).send({ error: 'Change reason is required' });
    if (!modelCode || !vendor || !displayName || !connectorType) return reply.status(400).send({ error: 'modelCode, vendor, displayName, connectorType are required' });
    if (!Number.isFinite(maxKw) || maxKw <= 0 || maxKw > 1000) return reply.status(400).send({ error: 'maxKw must be a number between 0 and 1000' });

    const created = await prisma.chargerModelCatalog.create({
      data: {
        scopeKey: scopeKey(req as OperatorReq),
        modelCode,
        vendor,
        displayName,
        maxKw,
        connectorType,
        updatedByOperatorId: (req as OperatorReq).currentOperator!.id,
      },
    });

    await writeAdminAudit({
      operatorId: (req as OperatorReq).currentOperator!.id,
      action: 'admin.settings.charger-model.create',
      metadata: { reason, modelCode, vendor, maxKw, connectorType },
    });

    return created;
  });

  app.post<{ Params: { id: string }; Body: { isActive: boolean; reason?: string } }>('/admin/settings/charger-models/:id/toggle', {
    preHandler: [requireOperator, requirePolicy('admin.settings.write')],
  }, async (req, reply) => {
    const reason = trimOrNull(req.body.reason, 500);
    if (!reason) return reply.status(400).send({ error: 'Change reason is required' });

    const updated = await prisma.chargerModelCatalog.update({
      where: { id: req.params.id },
      data: {
        isActive: !!req.body.isActive,
        updatedByOperatorId: (req as OperatorReq).currentOperator!.id,
      },
    });

    await writeAdminAudit({
      operatorId: (req as OperatorReq).currentOperator!.id,
      action: 'admin.settings.charger-model.toggle',
      metadata: { reason, id: req.params.id, isActive: !!req.body.isActive },
    });

    return updated;
  });
}
