/**
 * Internal API routes — service-to-service only.
 *
 * Authenticated via X-Internal-Token header (shared secret).
 * Not exposed to public clients (portal, mobile).
 */
import type { FastifyInstance } from 'fastify';
import { processReceiptEmail } from '../lib/receiptEmail';

const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN;

function verifyInternalToken(token: string | undefined): boolean {
  if (!INTERNAL_TOKEN) {
    // If no token configured, reject all internal requests
    // (safe default — forces explicit configuration)
    return false;
  }
  return token === INTERNAL_TOKEN;
}

export async function internalRoutes(app: FastifyInstance) {
  // ── Auth guard for all /internal/* routes ────────────────────────────
  app.addHook('onRequest', async (req, reply) => {
    // Allow health-style probes without auth
    if (req.url === '/internal/health') return;

    const token = req.headers['x-internal-token'] as string | undefined;
    if (!verifyInternalToken(token)) {
      return reply.status(401).send({ error: 'Invalid or missing internal token' });
    }
  });

  // ── Health check ─────────────────────────────────────────────────────
  app.get('/internal/health', async () => ({ status: 'ok', service: 'internal' }));

  // ── Send receipt email for a completed session ───────────────────────
  app.post<{
    Params: { id: string };
    Querystring: { preview?: string };
  }>('/internal/sessions/:id/send-receipt', async (req, reply) => {
    const sessionId = req.params.id;
    const preview = req.query.preview === '1' || req.query.preview === 'true';

    try {
      const result = await processReceiptEmail(sessionId, { preview });

      if (preview && result.html) {
        reply.header('content-type', 'text/html');
        return result.html;
      }

      const status = result.sent ? 200 : result.reason === 'send_failed' ? 502 : 200;
      return reply.status(status).send(result);
    } catch (err) {
      req.log.error({ err, sessionId }, '[Receipt] Unexpected error processing receipt');
      return reply.status(500).send({ sent: false, reason: 'internal_error' });
    }
  });
}
