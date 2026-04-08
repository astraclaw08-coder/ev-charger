import { FastifyInstance } from 'fastify';
import { requireOperator } from '../plugins/auth';
import { requirePolicy } from '../plugins/authorization';
import { prisma } from '@ev-charger/shared';
import { encryptKey } from '../lib/llmProvider';

// Route name kept as openaiOAuth for backward compat; now manages OpenRouter API key.

export async function openaiOAuthRoutes(app: FastifyInstance) {

  // ── Save API key ──────��───────────────────────────────���───────────────────
  app.post('/settings/ai/connect', {
    preHandler: [requireOperator, requirePolicy('admin.settings.write')],
  }, async (req, reply) => {
    const { apiKey } = req.body as { apiKey?: string };
    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length < 10) {
      return reply.status(400).send({ error: 'A valid API key is required' });
    }

    const operator = req.currentOperator!;
    const scopeKey = operator.claims?.orgId ?? 'default';

    await prisma.portalSettings.upsert({
      where: { scopeKey },
      create: {
        scopeKey,
        openaiAccessToken: encryptKey(apiKey.trim()),
        openaiConnectedAt: new Date(),
        updatedByOperatorId: operator.id,
      },
      update: {
        openaiAccessToken: encryptKey(apiKey.trim()),
        openaiRefreshToken: null,
        openaiTokenExpiresAt: null,
        openaiConnectedEmail: null,
        openaiConnectedAt: new Date(),
        updatedByOperatorId: operator.id,
      },
    });

    return { success: true };
  });

  // ── Disconnect (remove key) ───────────────────────────────────────────────
  app.post('/settings/ai/disconnect', {
    preHandler: [requireOperator, requirePolicy('admin.settings.write')],
  }, async (req, _reply) => {
    const operator = req.currentOperator!;
    const scopeKey = operator.claims?.orgId ?? 'default';

    await prisma.portalSettings.updateMany({
      where: { scopeKey },
      data: {
        openaiAccessToken: null,
        openaiRefreshToken: null,
        openaiTokenExpiresAt: null,
        openaiConnectedEmail: null,
        openaiConnectedAt: null,
      },
    });

    return { success: true };
  });

  // ── Connection status ───��──────────────────────��──────────────────────────
  app.get('/settings/ai/status', {
    preHandler: [requireOperator, requirePolicy('admin.settings.read')],
  }, async (req, _reply) => {
    const operator = req.currentOperator!;
    const scopeKey = operator.claims?.orgId ?? 'default';

    const settings = await prisma.portalSettings.findUnique({ where: { scopeKey } });
    if (!settings?.openaiAccessToken) {
      return { connected: false };
    }

    return {
      connected: true,
      connectedAt: settings.openaiConnectedAt,
    };
  });
}
