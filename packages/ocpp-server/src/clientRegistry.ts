// Registry of currently connected OCPP charger clients.
// ocppId (e.g. "CP001") → RPCServerClient object
// Used by remote/* functions so the REST API can send server-initiated calls.

const clients = new Map<string, any>();

export const clientRegistry = {
  register(ocppId: string, client: any): void {
    clients.set(ocppId, client);
    console.log(`[Registry] + ${ocppId} connected. Total online: ${clients.size}`);
  },

  unregister(ocppId: string): void {
    clients.delete(ocppId);
    console.log(`[Registry] - ${ocppId} disconnected. Total online: ${clients.size}`);
  },

  get(ocppId: string): any | undefined {
    return clients.get(ocppId);
  },

  has(ocppId: string): boolean {
    return clients.has(ocppId);
  },

  all(): Map<string, any> {
    return clients;
  },
};
