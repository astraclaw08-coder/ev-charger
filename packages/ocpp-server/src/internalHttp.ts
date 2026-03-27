import http from 'http';
import crypto from 'crypto';
import { prisma } from '@ev-charger/shared';
import { clientRegistry } from './clientRegistry';
import { remoteStartTransaction, remoteStopTransaction, remoteReset, remoteTriggerMessage, remoteGetConfiguration, remoteSetChargingProfile } from './remote';

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

    // GET /status — live connection state, bypasses Railway log delay entirely
    if (method === 'GET' && url === '/status') {
      const connected = Array.from(clientRegistry.all().keys());
      const chargers = await prisma.charger.findMany({
        select: { ocppId: true, status: true, lastHeartbeat: true },
        orderBy: { lastHeartbeat: 'desc' },
        take: 20,
      });
      return sendJson(res, 200, {
        ts: new Date().toISOString(),
        onlineCount: connected.length,
        connected,
        recentChargers: chargers,
      });
    }

    if (url === '/remote-start' || url === '/remote-stop' || url === '/reset' || url === '/trigger-message' || url === '/get-configuration' || url === '/set-charging-profile' ||
        url === '/charger-reset-password' || url === '/charger-clear-password' || url === '/charger-add' || url === '/get-composite-schedule') {
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

        // POST /trigger-message — request charger to send a specific OCPP message (e.g., Heartbeat)
        if (url === '/trigger-message') {
          const { ocppId, requestedMessage, connectorId } = body as {
            ocppId: string;
            requestedMessage: 'Heartbeat' | 'MeterValues' | 'StatusNotification' | 'BootNotification';
            connectorId?: number;
          };
          if (!ocppId || !requestedMessage) {
            return sendJson(res, 400, { error: 'ocppId and requestedMessage required' });
          }
          const status = await remoteTriggerMessage(ocppId, requestedMessage, connectorId);
          return sendJson(res, 200, { status });
        }

        // POST /get-configuration — pull OCPP configuration keys from a connected charger
        if (url === '/get-configuration') {
          const { ocppId, key } = body as { ocppId: string; key?: string[] };
          if (!ocppId) return sendJson(res, 400, { error: 'ocppId required' });
          const response = await remoteGetConfiguration(ocppId, key);
          return sendJson(res, 200, response);
        }

        if (url === '/set-charging-profile') {
          const { ocppId, profile } = body as { ocppId: string; profile: Record<string, unknown> };
          if (!ocppId || !profile || typeof profile !== 'object') {
            return sendJson(res, 400, { error: 'ocppId and profile are required' });
          }
          const status = await remoteSetChargingProfile(ocppId, profile);
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

        // POST /charger-add — register a new charger directly (no Clerk auth required).
        // Used for onboarding real hardware without going through the portal.
        if (url === '/charger-add') {
          const { ocppId, siteId, serialNumber, model, vendor } = body as {
            ocppId: string; siteId: string; serialNumber?: string; model?: string; vendor?: string;
          };
          if (!ocppId || !siteId) return sendJson(res, 400, { error: 'ocppId and siteId required' });

          const existing = await prisma.charger.findUnique({ where: { ocppId } });
          if (existing) return sendJson(res, 409, { error: `ocppId "${ocppId}" already registered`, charger: existing });

          const rawPassword = crypto.randomBytes(16).toString('hex');
          const hashedPassword = crypto.createHash('sha256').update(rawPassword).digest('hex');

          const charger = await prisma.charger.create({
            data: {
              ocppId,
              siteId,
              serialNumber: serialNumber ?? ocppId,
              model: model ?? 'Unknown',
              vendor: vendor ?? 'Unknown',
              password: '',  // passwordless — charger connects without password
              connectors: { create: [{ connectorId: 1 }] },
            },
          });

          console.log(`[InternalHTTP] Registered new charger ocppId=${ocppId} siteId=${siteId}`);
          return sendJson(res, 201, {
            id: charger.id,
            ocppId: charger.ocppId,
            ocppEndpoint: `wss://ocpp-server-production.up.railway.app/${ocppId}`,
            ocppPassword: null,
            note: 'Charger registered with no password. Connect using the ocppEndpoint above.',
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

        if (url === '/get-composite-schedule') {
          const { ocppId, connectorId, duration, chargingRateUnit } = body as {
            ocppId: string; connectorId?: number; duration?: number; chargingRateUnit?: string;
          };
          if (!ocppId) return sendJson(res, 400, { error: 'ocppId required' });

          const { remoteGetCompositeSchedule: getComposite } = await import('./remote');
          const result = await getComposite(ocppId, {
            connectorId: connectorId ?? 0,
            duration: duration ?? 86400,
            chargingRateUnit,
          });
          if (!result) return sendJson(res, 502, { error: 'Charger not connected or call failed' });
          return sendJson(res, 200, result);
        }
      } catch (err: unknown) {
        console.error('[InternalHTTP] Error:', err);
        return sendJson(res, 500, { error: 'Internal server error' });
      }
    }

    // Not a management route — fall through (no response written here).
    // The OCPP server returns 404 for non-WebSocket HTTP requests.
  });

  console.log('[InternalHTTP] Management routes attached (/health, /status, /remote-start, /remote-stop, /reset, /trigger-message, /get-configuration, /set-charging-profile, /charger-add, /charger-reset-password, /charger-clear-password)');
}
