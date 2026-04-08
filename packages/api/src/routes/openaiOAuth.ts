import { FastifyInstance } from 'fastify';
import { requireOperator } from '../plugins/auth';
import { requirePolicy } from '../plugins/authorization';
import { prisma } from '@ev-charger/shared';
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateAuthUrl,
  exchangeCode,
  encryptToken,
} from '../lib/openaiOAuth';
import crypto from 'crypto';

// In-memory PKCE verifier store (short-lived, keyed by state)
const pkceStore = new Map<string, { codeVerifier: string; operatorId: string; createdAt: number }>();

// Clean expired entries every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of pkceStore) {
    if (now - val.createdAt > 10 * 60 * 1000) pkceStore.delete(key);
  }
}, 5 * 60 * 1000);

export async function openaiOAuthRoutes(app: FastifyInstance) {
  // Get authorization URL
  app.get('/settings/openai/auth-url', {
    preHandler: [requireOperator, requirePolicy('admin.settings.write')],
  }, async (req, _reply) => {
    const operator = req.currentOperator!;
    const state = crypto.randomBytes(16).toString('hex');
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    pkceStore.set(state, {
      codeVerifier,
      operatorId: operator.id,
      createdAt: Date.now(),
    });

    const url = generateAuthUrl(state, codeChallenge);
    return { url, state };
  });

  // Exchange authorization code
  app.post('/settings/openai/callback', {
    preHandler: [requireOperator, requirePolicy('admin.settings.write')],
  }, async (req, reply) => {
    const { code, state } = req.body as { code: string; state: string };

    if (!code || !state) return reply.status(400).send({ error: 'Missing code or state' });

    const pkce = pkceStore.get(state);
    if (!pkce) return reply.status(400).send({ error: 'Invalid or expired state parameter' });
    pkceStore.delete(state);

    const operator = req.currentOperator!;
    // Verify the same operator who initiated the flow is completing it
    if (pkce.operatorId !== operator.id) {
      return reply.status(403).send({ error: 'State mismatch — different operator' });
    }

    try {
      const tokens = await exchangeCode(code, pkce.codeVerifier);
      const scopeKey = operator.claims?.orgId ?? 'default';

      await prisma.portalSettings.upsert({
        where: { scopeKey },
        create: {
          scopeKey,
          openaiAccessToken: encryptToken(tokens.accessToken),
          openaiRefreshToken: encryptToken(tokens.refreshToken),
          openaiTokenExpiresAt: tokens.expiresAt,
          openaiConnectedEmail: tokens.email ?? null,
          openaiConnectedAt: new Date(),
          updatedByOperatorId: operator.id,
        },
        update: {
          openaiAccessToken: encryptToken(tokens.accessToken),
          openaiRefreshToken: encryptToken(tokens.refreshToken),
          openaiTokenExpiresAt: tokens.expiresAt,
          openaiConnectedEmail: tokens.email ?? null,
          openaiConnectedAt: new Date(),
          updatedByOperatorId: operator.id,
        },
      });

      return { success: true, email: tokens.email };
    } catch (err: any) {
      app.log.error({ err }, 'OpenAI OAuth callback failed');
      return reply.status(500).send({ error: 'Failed to connect OpenAI', detail: err.message });
    }
  });

  // Disconnect OpenAI
  app.post('/settings/openai/disconnect', {
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

  // Get connection status
  app.get('/settings/openai/status', {
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
      email: settings.openaiConnectedEmail,
      connectedAt: settings.openaiConnectedAt,
      tokenExpiresAt: settings.openaiTokenExpiresAt,
    };
  });
}
