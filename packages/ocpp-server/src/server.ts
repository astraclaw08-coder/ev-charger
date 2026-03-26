import http from 'http';
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
import { logOcppMessage } from './ocppLogger';

// ocpp-rpc ships as CommonJS without bundled TS types
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { RPCServer } = require('ocpp-rpc');

export interface OcppServerHandle {
  rpcServer: any;
  httpServer: http.Server;
}

export async function startServer(port: number): Promise<OcppServerHandle> {
  const server = new RPCServer({
    protocols: ['ocpp1.6'],
    strictMode: false,  // lenient for real-world charger quirks
    // pingIntervalMs DISABLED. ocpp-rpc's built-in keepAlive sends WS pings
    // and calls ws.terminate() if the charger doesn't pong within one interval.
    // Real OCPP chargers (e.g. 1A32 / LOOP firmware) do NOT respond to
    // server-initiated WS pings — their WS stack ignores ping frames entirely.
    // This caused deterministic 110s disconnects (2 × 55s ping interval).
    //
    // Keepalive strategy: charger-side websocketpinginterval (set to 30s via
    // OCPP ChangeConfiguration) sends pings TO the server. The ws library
    // auto-replies with pongs. Railway proxy sees bidirectional traffic every
    // 30s — well within its ~60s idle timeout.
    //
    // The server NEVER actively kills a WebSocket. Disconnects are left to
    // the charger firmware, TCP stack, or Railway proxy.
  });

  // ── Authentication ──────────────────────────────────────────────────────────
  server.auth(async (accept: any, reject: any, handshake: any) => {
    const ocppId: string = handshake.identity;
    const req = handshake.req ?? handshake.request;
    const remote = req?.headers?.['cf-connecting-ip']
      || req?.headers?.['x-forwarded-for']
      || req?.socket?.remoteAddress
      || 'n/a';
    const ua = req?.headers?.['user-agent'] ?? 'n/a';
    const path = req?.url ?? 'n/a';
    const host = req?.headers?.host ?? 'n/a';

    console.log(`[Auth] Attempt identity=${ocppId} host=${host} path=${path} remote=${remote} ua=${ua}`);

    const charger = await prisma.charger.findUnique({
      where: { ocppId },
      select: { id: true, ocppId: true, password: true },
    });
    if (!charger) {
      console.warn(`[Auth] Reject identity=${ocppId} reason=unknown_identity remote=${remote} host=${host} path=${path}`);
      reject(401, 'Unknown charger identity');
      return;
    }

    // Only enforce password if BOTH the charger sends one AND the DB has a non-empty hash.
    // Empty string password in DB = passwordless auth is allowed for this charger.
    if (handshake.password && charger.password) {
      const provided = handshake.password.toString('utf8');
      const hashed = createHash('sha256').update(provided).digest('hex');
      if (hashed !== charger.password) {
        console.warn(`[Auth] Reject identity=${ocppId} reason=invalid_password remote=${remote} host=${host} path=${path}`);
        reject(401, 'Invalid password');
        return;
      }
    }

    console.log(`[Auth] Accept identity=${ocppId} chargerId=${charger.id} remote=${remote} host=${host} path=${path}`);

    // Attach charger DB id to session so handlers can use it without a lookup
    accept({ chargerId: charger.id, ocppId: charger.ocppId });
  });

  // ── Client lifecycle ────────────────────────────────────────────────────────
  server.on('client', async (client: any) => {
    const ocppId: string    = client.identity;
    const chargerId: string = client.session?.chargerId ?? '';

    console.log(`[Server] Connected: ${ocppId} (db=${chargerId})`);
    clientRegistry.register(ocppId, client);

    // ── Ping/Pong instrumentation ─────────────────────────────────────────────
    // Log all WS-level ping/pong frames for diagnostics.
    // client._ws is the underlying WebSocket from the 'ws' library.
    const ws = client._ws;
    if (ws) {
      // Server sends ping → charger should reply with pong
      ws.on('pong', () => {
        console.log(`[WS pong] ← ${ocppId} responded to our ping`);
      });

      // Charger sends ping → server auto-replies with pong (ws library default)
      ws.on('ping', (data: Buffer) => {
        console.log(`[WS ping] ← ${ocppId} sent us a ping (${data.length} bytes)`);
      });

      // Hook into outbound pings from ocpp-rpc's keepAlive
      const origPing = ws.ping.bind(ws);
      ws.ping = (...args: any[]) => {
        console.log(`[WS ping] → ${ocppId} sending ping to charger`);
        return origPing(...args);
      };
    }

    const registerInboundHandler = (
      action: string,
      fn: (params: any) => Promise<any> | any,
    ) => {
      client.handle(action, async ({ params, messageId }: any) => {
        await logOcppMessage(chargerId, 'INBOUND', action, params, messageId);
        const response = await fn(params);
        await logOcppMessage(chargerId, 'OUTBOUND', action, response ?? {}, messageId ? `${messageId}:response` : undefined);
        return response;
      });
    };

    // ── Inbound handlers ──────────────────────────────────────────────────────
    registerInboundHandler('BootNotification', (params) =>
      handleBootNotification(client, chargerId, params));

    registerInboundHandler('Heartbeat', (params) =>
      handleHeartbeat(client, chargerId, params));

    registerInboundHandler('StatusNotification', (params) =>
      handleStatusNotification(client, chargerId, params));

    registerInboundHandler('Authorize', (params) =>
      handleAuthorize(client, chargerId, params));

    registerInboundHandler('StartTransaction', (params) =>
      handleStartTransaction(client, chargerId, params));

    registerInboundHandler('StopTransaction', (params) =>
      handleStopTransaction(client, chargerId, params));

    registerInboundHandler('MeterValues', (params) =>
      handleMeterValues(client, chargerId, params));

    // ── Stub handlers for common vendor messages ──────────────────────────────
    // Real chargers often send these; return sensible defaults to avoid CALLERROR.

    registerInboundHandler('GetConfiguration', (params) => {
      const keys: string[] = params?.key ?? [];
      console.log(`[GetConfiguration] chargerId=${chargerId} keys=${keys.join(',') || '*'}`);
      return { configurationKey: [], unknownKey: keys };
    });

    registerInboundHandler('DataTransfer', (params) => {
      console.log(`[DataTransfer] chargerId=${chargerId} vendorId=${params?.vendorId} messageId=${params?.messageId}`);
      return { status: 'Accepted' };
    });

    registerInboundHandler('FirmwareStatusNotification', (params) => {
      console.log(`[FirmwareStatusNotification] chargerId=${chargerId} status=${params?.status}`);
      return {};
    });

    registerInboundHandler('DiagnosticsStatusNotification', (params) => {
      console.log(`[DiagnosticsStatusNotification] chargerId=${chargerId} status=${params?.status}`);
      return {};
    });

    // Catch-all: log and return empty object — never throw (would send CALLERROR
    // which can cause real chargers to disconnect or log faults).
    client.handle(async ({ method, params, messageId }: any) => {
      console.warn(`[Server] Unhandled action: ${method}`, JSON.stringify(params));
      await logOcppMessage(chargerId, 'INBOUND', method, params, messageId);
      await logOcppMessage(chargerId, 'OUTBOUND', method, {}, messageId ? `${messageId}:response` : undefined);
      return {};
    });

    // ── Disconnect / diagnostics ──────────────────────────────────────────────
    client.on('error', (err: any) => {
      console.error(`[Server] Client error ${ocppId}:`, err?.message ?? err);
    });

    client.on('disconnect', (...args: any[]) => {
      const [rawCode, rawReason] = args;

      const parsedCode = typeof rawCode === 'number'
        ? rawCode
        : (rawCode && typeof rawCode === 'object' && typeof rawCode.code === 'number')
          ? rawCode.code
          : undefined;

      const parsedReason = typeof rawReason === 'string'
        ? rawReason
        : Buffer.isBuffer(rawReason)
          ? rawReason.toString('utf8')
          : (rawReason && typeof rawReason === 'object' && typeof rawReason.reason === 'string')
            ? rawReason.reason
            : undefined;

      const fallbackReasonFromCodeObject = rawCode && typeof rawCode === 'object' && typeof rawCode.reason === 'string'
        ? rawCode.reason
        : undefined;

      const reasonText = (parsedReason || fallbackReasonFromCodeObject || '').trim();
      const codeText = parsedCode != null ? String(parsedCode) : 'n/a';

      const safeRaw = (() => {
        try {
          return JSON.stringify(args, (_k, v) => Buffer.isBuffer(v) ? v.toString('utf8') : v);
        } catch {
          return '[unserializable disconnect args]';
        }
      })();

      console.warn(`[Server] Disconnected: ${ocppId} code=${codeText} reason=${reasonText || 'n/a'} raw=${safeRaw}`);
      clientRegistry.unregister(ocppId);

      prisma.charger.update({
        where: { id: chargerId },
        data: { status: 'DEGRADED' },
      }).catch(console.error);

      prisma.uptimeEvent.create({
        data: {
          chargerId,
          event: 'DEGRADED',
          reason: 'WebSocket disconnected; pending offline confirmation window',
        },
      }).catch(console.error);
    });
  });

  // Create our own http.Server so management REST routes can share the same
  // port as the OCPP WebSocket server. This is required on Railway where only
  // the single declared PORT is reachable on the private network.
  const httpServer = http.createServer();
  httpServer.on('upgrade', (req: http.IncomingMessage, socket, head) => {
    const forwardedFor = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const proto = req.headers['sec-websocket-protocol'];
    const ua = req.headers['user-agent'];
    const host = req.headers.host ?? 'n/a';
    const key = req.headers['sec-websocket-key'];
    const keyHint = typeof key === 'string' ? `${key.slice(0, 6)}...` : 'n/a';
    console.log(`[WS upgrade] host=${host} url=${req.url} from=${forwardedFor} proto=${proto ?? 'n/a'} key=${keyHint} ua=${ua ?? 'n/a'} headBytes=${head?.length ?? 0}`);

    socket.once('error', (err) => {
      console.warn(`[WS socket error] host=${host} url=${req.url} from=${forwardedFor} err=${err?.message ?? err}`);
    });
    socket.once('close', (hadError: boolean) => {
      console.warn(`[WS socket close] host=${host} url=${req.url} from=${forwardedFor} hadError=${hadError}`);
    });

    server.handleUpgrade(req, socket, head);
  });

  const host = '::'; // IPv6 dual-stack — required for Railway private network
  await new Promise<void>((resolve, reject) => {
    httpServer.listen({ port, host }, (err?: Error) => err ? reject(err) : resolve());
  });

  console.log(`[Server] OCPP 1.6J server listening on port ${port} (${host})`);
  console.log(`[Server] Chargers connect to: wss://HOST/${'{chargerIdentity}'}`);

  return { rpcServer: server, httpServer };
}
