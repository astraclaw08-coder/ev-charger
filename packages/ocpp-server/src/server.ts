import { createHash } from 'crypto';
import { prisma } from '@ev-charger/shared';
import { clientRegistry } from './clientRegistry';
import { handleBootNotification } from './handlers/bootNotification';
import { handleHeartbeat } from './handlers/heartbeat';
import { handleStatusNotification } from './handlers/statusNotification';
import { handleAuthorize } from './handlers/authorize';
import { handleStartTransaction } from './handlers/startTransaction';
import { handleStopTransaction } from './handlers/stopTransaction';
import { handleMeterValues } from './handlers/meterValues';

// ocpp-rpc ships as CommonJS without bundled TS types
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { RPCServer } = require('ocpp-rpc');

export async function startServer(port: number): Promise<any> {
  const server = new RPCServer({
    protocols: ['ocpp1.6'],
    strictMode: false,  // lenient for real-world charger quirks
  });

  // ── Authentication ──────────────────────────────────────────────────────────
  server.auth(async (accept: any, reject: any, handshake: any) => {
    const ocppId: string = handshake.identity;

    const charger = await prisma.charger.findUnique({ where: { ocppId } });
    if (!charger) {
      console.warn(`[Auth] Unknown charger identity: "${ocppId}"`);
      reject(401, 'Unknown charger identity');
      return;
    }

    if (handshake.password) {
      const provided = handshake.password.toString('utf8');
      const hashed = createHash('sha256').update(provided).digest('hex');
      if (hashed !== charger.password) {
        console.warn(`[Auth] Bad password for charger: "${ocppId}"`);
        reject(401, 'Invalid password');
        return;
      }
    }

    // Attach charger DB id to session so handlers can use it without a lookup
    accept({ chargerId: charger.id, ocppId: charger.ocppId });
  });

  // ── Client lifecycle ────────────────────────────────────────────────────────
  server.on('client', async (client: any) => {
    const ocppId: string    = client.identity;
    const chargerId: string = client.session?.chargerId ?? '';

    console.log(`[Server] Connected: ${ocppId} (db=${chargerId})`);
    clientRegistry.register(ocppId, client);

    // ── Inbound handlers ──────────────────────────────────────────────────────
    client.handle('BootNotification', async ({ params }: any) =>
      handleBootNotification(client, chargerId, params));

    client.handle('Heartbeat', async ({ params }: any) =>
      handleHeartbeat(client, chargerId, params));

    client.handle('StatusNotification', async ({ params }: any) =>
      handleStatusNotification(client, chargerId, params));

    client.handle('Authorize', async ({ params }: any) =>
      handleAuthorize(client, chargerId, params));

    client.handle('StartTransaction', async ({ params }: any) =>
      handleStartTransaction(client, chargerId, params));

    client.handle('StopTransaction', async ({ params }: any) =>
      handleStopTransaction(client, chargerId, params));

    client.handle('MeterValues', async ({ params }: any) =>
      handleMeterValues(client, chargerId, params));

    // Catch-all for unhandled actions
    client.handle(({ method }: any) => {
      console.warn(`[Server] Unhandled action: ${method}`);
      throw new Error(`NotImplemented: ${method}`);
    });

    // ── Disconnect ────────────────────────────────────────────────────────────
    client.on('disconnect', () => {
      console.log(`[Server] Disconnected: ${ocppId}`);
      clientRegistry.unregister(ocppId);

      prisma.charger.update({
        where: { id: chargerId },
        data: { status: 'OFFLINE' },
      }).catch(console.error);
    });
  });

  await server.listen(port);
  console.log(`[Server] OCPP 1.6J server listening on port ${port}`);
  console.log(`[Server] Chargers connect to: ws://HOST:${port}/ENDPOINT/{chargerIdentity}`);

  return server;
}
