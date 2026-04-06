// Registry of currently connected OCPP charger clients.
// ocppId (e.g. "CP001") → RPCServerClient object
// Used by remote/* functions so the REST API can send server-initiated calls.

interface ClientEntry {
  client: any;
  connectedAt: number;     // Date.now() at registration
  bootReceived: boolean;
  heartbeatCount: number;
}

const clients = new Map<string, ClientEntry>();

function describeClient(client: any): string {
  const identity = client?.identity ?? 'n/a';
  const sessionChargerId = client?.session?.chargerId ?? 'n/a';
  const wsReadyState = client?._ws?.readyState;
  const hasCall = typeof client?.call === 'function';
  return `identity=${identity} db=${sessionChargerId} wsReady=${wsReadyState ?? 'n/a'} hasCall=${hasCall}`;
}

export const clientRegistry = {
  /**
   * Register a new client. If an existing session exists for the same identity,
   * close it first to prevent overlapping/duplicate sessions.
   */
  register(ocppId: string, client: any): void {
    const existing = clients.get(ocppId);
    if (existing && existing.client !== client) {
      const durationSec = ((Date.now() - existing.connectedAt) / 1000).toFixed(1);
      console.warn(
        `[Registry] Superseding existing session for ${ocppId} ` +
        `(was connected ${durationSec}s, boot=${existing.bootReceived}, hb=${existing.heartbeatCount}). ` +
        `old={${describeClient(existing.client)}} new={${describeClient(client)}} Closing old socket in 5s.`,
      );
      const staleClient = existing.client;
      setTimeout(() => {
        try {
          staleClient.close?.(1000, 'Superseded by new connection');
        } catch {
          // Best effort — old socket may already be dead
        }
      }, 5_000);
      clients.delete(ocppId);
    }

    clients.set(ocppId, {
      client,
      connectedAt: Date.now(),
      bootReceived: false,
      heartbeatCount: 0,
    });
    console.log(`[Registry] + ${ocppId} connected. ${describeClient(client)} Total online: ${clients.size}`);
  },

  /**
   * Unregister and log connection lifetime stats for diagnostics.
   */
  unregister(ocppId: string, client?: any): void {
    const entry = clients.get(ocppId);
    if (!entry) {
      console.log(`[Registry] - ${ocppId} disconnected (was not in registry). Total online: ${clients.size}`);
      return;
    }

    if (client && entry.client && entry.client !== client) {
      console.warn(
        `[Registry] ignore stale disconnect for ${ocppId}. ` +
        `incoming={${describeClient(client)}} current={${describeClient(entry.client)}}`,
      );
      return;
    }

    const durationSec = ((Date.now() - entry.connectedAt) / 1000).toFixed(1);
    console.log(
      `[Registry] - ${ocppId} disconnected after ${durationSec}s ` +
      `(boot=${entry.bootReceived}, hb=${entry.heartbeatCount}) ` +
      `${describeClient(entry.client)} Total online: ${clients.size - 1}`,
    );
    clients.delete(ocppId);
  },

  get(ocppId: string): any | undefined {
    const entry = clients.get(ocppId);
    const client = entry?.client;
    if (!client) return undefined;

    const wsReadyState = client?._ws?.readyState;
    if (typeof wsReadyState === 'number' && wsReadyState !== 1) {
      console.warn(`[Registry] get(${ocppId}) found non-open client; evicting stale entry. ${describeClient(client)}`);
      clients.delete(ocppId);
      return undefined;
    }
    return client;
  },

  has(ocppId: string): boolean {
    return !!this.get(ocppId);
  },

  markBoot(ocppId: string): void {
    const entry = clients.get(ocppId);
    if (entry) entry.bootReceived = true;
  },

  markHeartbeat(ocppId: string): void {
    const entry = clients.get(ocppId);
    if (entry) entry.heartbeatCount++;
  },

  getStats(ocppId: string): { connectedAt: number; bootReceived: boolean; heartbeatCount: number } | null {
    const entry = clients.get(ocppId);
    if (!entry) return null;
    return { connectedAt: entry.connectedAt, bootReceived: entry.bootReceived, heartbeatCount: entry.heartbeatCount };
  },

  debug(ocppId: string): Record<string, unknown> | null {
    const entry = clients.get(ocppId);
    if (!entry) return null;
    return {
      ocppId,
      connectedAt: entry.connectedAt,
      bootReceived: entry.bootReceived,
      heartbeatCount: entry.heartbeatCount,
      description: describeClient(entry.client),
    };
  },

  all(): Map<string, any> {
    const result = new Map<string, any>();
    for (const [k, v] of clients) {
      const client = this.get(k);
      if (client) result.set(k, client);
    }
    return result;
  },
};
