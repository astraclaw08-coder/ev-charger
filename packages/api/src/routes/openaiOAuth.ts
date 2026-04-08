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

// In-memory PKCE store (short-lived, keyed by state param)
const pkceStore = new Map<string, { codeVerifier: string; operatorId: string; scopeKey: string; createdAt: number }>();

// Clean expired entries every 5 min (10 min TTL)
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of pkceStore) {
    if (now - val.createdAt > 10 * 60 * 1000) pkceStore.delete(key);
  }
}, 5 * 60 * 1000);

export async function openaiOAuthRoutes(app: FastifyInstance) {

  // ── Get authorization URL ─────────────────────────────────────────────────
  // Authenticated JSON endpoint. Portal calls this, gets the OpenAI auth URL,
  // then opens it in a popup window. The state param links back to the PKCE
  // verifier and operator stored in memory.
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
      scopeKey: operator.claims?.orgId ?? 'default',
      createdAt: Date.now(),
    });

    const url = generateAuthUrl(state, codeChallenge);
    return { url };
  });

  // ── OAuth callback (receives redirect from OpenAI) ────────────────────────
  // Unauthenticated — OpenAI redirects the user's browser here with
  // ?code=...&state=... The state param maps to the PKCE verifier + operator
  // stored during auth-url generation. Returns HTML that postMessages back to
  // the opener (portal) window and closes the popup.
  app.get('/settings/openai/callback', async (req, reply) => {
    const { code, state, error } = req.query as { code?: string; state?: string; error?: string };

    function respondHtml(payload: { success: boolean; email?: string; error?: string }) {
      const escaped = JSON.stringify({ type: 'openai-oauth-result', ...payload })
        .replace(/</g, '\\u003c'); // Prevent XSS via </script> in error messages
      const html = `<!DOCTYPE html>
<html><head><title>OpenAI Connection</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f8fafc}
.card{text-align:center;padding:2rem;border-radius:12px;background:white;box-shadow:0 1px 3px rgba(0,0,0,.1)}
.ok{color:#16a34a}.err{color:#dc2626}</style></head>
<body><div class="card">
<p class="${payload.success ? 'ok' : 'err'}">${payload.success ? 'Connected successfully! This window will close.' : 'Connection failed. Please close this window and try again.'}</p>
</div>
<script>
try { window.opener.postMessage(${escaped}, '*'); } catch(e) {}
setTimeout(function() { window.close(); }, 2000);
</script>
</body></html>`;
      return reply.type('text/html').send(html);
    }

    if (error) {
      return respondHtml({ success: false, error: `OpenAI authorization error: ${error}` });
    }

    if (!code || !state) {
      return respondHtml({ success: false, error: 'Missing code or state parameter' });
    }

    const pkce = pkceStore.get(state);
    if (!pkce) {
      return respondHtml({ success: false, error: 'Invalid or expired state. Please try connecting again.' });
    }
    pkceStore.delete(state);

    try {
      const tokens = await exchangeCode(code, pkce.codeVerifier);

      await prisma.portalSettings.upsert({
        where: { scopeKey: pkce.scopeKey },
        create: {
          scopeKey: pkce.scopeKey,
          openaiAccessToken: encryptToken(tokens.accessToken),
          openaiRefreshToken: encryptToken(tokens.refreshToken),
          openaiTokenExpiresAt: tokens.expiresAt,
          openaiConnectedEmail: tokens.email ?? null,
          openaiConnectedAt: new Date(),
          updatedByOperatorId: pkce.operatorId,
        },
        update: {
          openaiAccessToken: encryptToken(tokens.accessToken),
          openaiRefreshToken: encryptToken(tokens.refreshToken),
          openaiTokenExpiresAt: tokens.expiresAt,
          openaiConnectedEmail: tokens.email ?? null,
          openaiConnectedAt: new Date(),
          updatedByOperatorId: pkce.operatorId,
        },
      });

      return respondHtml({ success: true, email: tokens.email });
    } catch (err: any) {
      app.log.error({ err }, 'OpenAI OAuth callback failed');
      return respondHtml({ success: false, error: err.message ?? 'Token exchange failed' });
    }
  });

  // ── Disconnect OpenAI ─────────────────────────────────────────────────────
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

  // ── Connection status ─────────────────────────────────────────────────────
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
