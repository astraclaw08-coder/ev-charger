import { FastifyInstance } from 'fastify';
import { requireOperator } from '../plugins/auth';
import { requirePolicy } from '../plugins/authorization';
import { prisma } from '@ev-charger/shared';
import { encryptKey, DEFAULT_MODEL } from '../lib/llmProvider';

export async function openaiOAuthRoutes(app: FastifyInstance) {

  // ── Save API key (+ optional model) ───────────────────────────────────────
  app.post('/settings/ai/connect', {
    preHandler: [requireOperator, requirePolicy('admin.settings.write')],
  }, async (req, reply) => {
    const { apiKey, model } = req.body as { apiKey?: string; model?: string };
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
        openaiConnectedEmail: model || DEFAULT_MODEL, // repurposed: stores LLM model ID
        openaiConnectedAt: new Date(),
        updatedByOperatorId: operator.id,
      },
      update: {
        openaiAccessToken: encryptKey(apiKey.trim()),
        openaiRefreshToken: null,
        openaiTokenExpiresAt: null,
        openaiConnectedEmail: model || DEFAULT_MODEL,
        openaiConnectedAt: new Date(),
        updatedByOperatorId: operator.id,
      },
    });

    return { success: true };
  });

  // ── Update model only ─────────────────────────────────────────────────────
  app.post('/settings/ai/model', {
    preHandler: [requireOperator, requirePolicy('admin.settings.write')],
  }, async (req, reply) => {
    const { model } = req.body as { model?: string };
    if (!model || typeof model !== 'string') {
      return reply.status(400).send({ error: 'Model is required' });
    }

    const operator = req.currentOperator!;
    const scopeKey = operator.claims?.orgId ?? 'default';

    await prisma.portalSettings.updateMany({
      where: { scopeKey },
      data: { openaiConnectedEmail: model },
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

  // ── Connection status ─────────────────────────────────────────────────────
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
      model: settings.openaiConnectedEmail || DEFAULT_MODEL,
    };
  });
}
