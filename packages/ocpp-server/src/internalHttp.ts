import http from 'http';
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

export function startInternalHttpServer(port: number): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '';
    const method = req.method ?? '';

    if (method === 'GET' && url === '/health') {
      return sendJson(res, 200, { status: 'ok' });
    }

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

      return sendJson(res, 404, { error: 'Not found' });
    } catch (err: unknown) {
      console.error('[InternalHTTP] Error:', err);
      return sendJson(res, 500, { error: 'Internal server error' });
    }
  });

  const host = process.env.OCPP_INTERNAL_HOST ?? '127.0.0.1';
  server.listen(port, host, () => {
    console.log(`[InternalHTTP] Listening on http://${host}:${port}`);
  });

  return server;
}
