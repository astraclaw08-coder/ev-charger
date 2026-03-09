import http from 'http';
import crypto from 'crypto';
import { prisma } from '@ev-charger/shared';
import { remoteStartTransaction, remoteStopTransaction, remoteReset } from './remote';

function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(json);
}

/**
 * Attach internal management REST routes to an existing http.Server.
 * Routes are mounted via prependListener so they run before any default handler.
 *
 * The OCPP WebSocket server and the management API share the same port —
 * required on Railway where only the declared PORT is reachable on the
 * private network.
 */
export function attachInternalRoutes(httpServer: http.Server): void {
  httpServer.prependListener('request', async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = req.url ?? '';
    const method = req.method ?? '';

    if (method === 'GET' && url === '/health') {
      return sendJson(res, 200, { status: 'ok' });
    }

    if (url === '/remote-start' || url === '/remote-stop' || url === '/reset' ||
        url === '/charger-reset-password' || url === '/charger-clear-password') {
      if (method !== 'POST') {
        return sendJson(res, 405, { error: 'Method not allowed' });
      }

      try {
        const body = await parseBody(req);

        if (url === '/remote-start') {
          const { ocppId, connectorId, idTag } = body as {
            ocppId: string; connectorId: number; idTag: string;
          };
          const status = await remoteStartTransaction(ocppId, connectorId, idTag);
          return sendJson(res, 200, { status });
        }

        if (url === '/remote-stop') {
          const { ocppId, transactionId } = body as {
            ocppId: string; transactionId: number;
          };
          const status = await remoteStopTransaction(ocppId, transactionId);
          return sendJson(res, 200, { status });
        }

        if (url === '/reset') {
          const { ocppId, type } = body as {
            ocppId: string; type?: 'Soft' | 'Hard';
          };
          const status = await remoteReset(ocppId, type ?? 'Soft');
          return sendJson(res, 200, { status });
        }

        // POST /charger-reset-password — set a new known OCPP password for a charger.
        // Returns the plaintext once; configure it on the physical charger.
        if (url === '/charger-reset-password') {
          const { ocppId } = body as { ocppId: string };
          if (!ocppId) return sendJson(res, 400, { error: 'ocppId required' });

          const charger = await prisma.charger.findUnique({ where: { ocppId } });
          if (!charger) return sendJson(res, 404, { error: `Charger ${ocppId} not found` });

          const rawPassword = crypto.randomBytes(16).toString('hex');
          const hashedPassword = crypto.createHash('sha256').update(rawPassword).digest('hex');

          await prisma.charger.update({
            where: { ocppId },
            data: { password: hashedPassword },
          });

          console.log(`[InternalHTTP] Password reset for charger ocppId=${ocppId}`);
          return sendJson(res, 200, {
            ocppId,
            ocppPassword: rawPassword,
            note: 'Configure this password on the physical charger. It will not be shown again.',
          });
        }

        // POST /charger-clear-password — allow a charger to connect with NO password.
        // Use when the charger doesn't send a password or you want to disable password auth.
        if (url === '/charger-clear-password') {
          const { ocppId } = body as { ocppId: string };
          if (!ocppId) return sendJson(res, 400, { error: 'ocppId required' });

          const charger = await prisma.charger.findUnique({ where: { ocppId } });
          if (!charger) return sendJson(res, 404, { error: `Charger ${ocppId} not found` });

          // Empty string = "no password required" sentinel (SHA-256 hashes are never empty).
          await prisma.charger.update({
            where: { ocppId },
            data: { password: '' },
          });

          console.log(`[InternalHTTP] Password cleared for charger ocppId=${ocppId}`);
          return sendJson(res, 200, { ocppId, note: 'Password cleared. Charger can now connect without a password.' });
        }
      } catch (err: unknown) {
        console.error('[InternalHTTP] Error:', err);
        return sendJson(res, 500, { error: 'Internal server error' });
      }
    }

    // Not a management route — fall through (no response written here).
    // The OCPP server returns 404 for non-WebSocket HTTP requests.
  });

  console.log('[InternalHTTP] Management routes attached (/health, /remote-start, /remote-stop, /reset, /charger-reset-password, /charger-clear-password)');
}
