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
        `Replacing registry entry only — NOT closing old socket.`,
      );
      // Do NOT call existing.client.close() or terminate().
      // The server never actively kills a WebSocket. Let the old socket
      // die naturally via TCP timeout or charger-side close.
      clients.delete(ocppId);
    }

    clients.set(ocppId, {
      client,
      connectedAt: Date.now(),
      bootReceived: false,
      heartbeatCount: 0,
    });
    console.log(`[Registry] + ${ocppId} connected. Total online: ${clients.size}`);
  },

  /**
   * Unregister and log connection lifetime stats for diagnostics.
   */
  unregister(ocppId: string): void {
    const entry = clients.get(ocppId);
    if (entry) {
      const durationSec = ((Date.now() - entry.connectedAt) / 1000).toFixed(1);
      console.log(
        `[Registry] - ${ocppId} disconnected after ${durationSec}s ` +
        `(boot=${entry.bootReceived}, hb=${entry.heartbeatCount}). ` +
        `Total online: ${clients.size - 1}`,
      );
    } else {
      console.log(`[Registry] - ${ocppId} disconnected (was not in registry). Total online: ${clients.size}`);
    }
    clients.delete(ocppId);
  },

  get(ocppId: string): any | undefined {
    return clients.get(ocppId)?.client;
  },

  has(ocppId: string): boolean {
    return clients.has(ocppId);
  },

  /** Mark that a BootNotification was received for this session. */
  markBoot(ocppId: string): void {
    const entry = clients.get(ocppId);
    if (entry) entry.bootReceived = true;
  },

  /** Increment heartbeat counter for this session. */
  markHeartbeat(ocppId: string): void {
    const entry = clients.get(ocppId);
    if (entry) entry.heartbeatCount++;
  },

  /** Get connection stats for a specific charger. */
  getStats(ocppId: string): { connectedAt: number; bootReceived: boolean; heartbeatCount: number } | null {
    const entry = clients.get(ocppId);
    if (!entry) return null;
    return { connectedAt: entry.connectedAt, bootReceived: entry.bootReceived, heartbeatCount: entry.heartbeatCount };
  },

  all(): Map<string, any> {
    // Return client objects only for backward compat
    const result = new Map<string, any>();
    for (const [k, v] of clients) result.set(k, v.client);
    return result;
  },
};
