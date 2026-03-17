import { clientRegistry } from '../clientRegistry';

/**
 * Send RemoteStartTransaction to a connected charger.
 * Called by the REST API when a driver taps "Start" in the app.
 */
export async function remoteStartTransaction(
  ocppId: string,
  connectorId: number,
  idTag: string,
): Promise<'Accepted' | 'Rejected'> {
  const client = clientRegistry.get(ocppId);
  if (!client) {
    console.warn(`[RemoteStart] Charger ${ocppId} is not connected`);
    return 'Rejected';
  }

  try {
    const result = await client.call('RemoteStartTransaction', { connectorId, idTag });
    console.log(`[RemoteStart] Charger ${ocppId} responded: ${result.status}`);
    return result.status as 'Accepted' | 'Rejected';
  } catch (err) {
    console.error(`[RemoteStart] Error calling charger ${ocppId}:`, err);
    return 'Rejected';
  }
}

/**
 * Send RemoteStopTransaction to a connected charger.
 * Called by the REST API when a driver taps "Stop" in the app.
 */
export async function remoteStopTransaction(
  ocppId: string,
  transactionId: number,
): Promise<'Accepted' | 'Rejected'> {
  const client = clientRegistry.get(ocppId);
  if (!client) {
    console.warn(`[RemoteStop] Charger ${ocppId} is not connected`);
    return 'Rejected';
  }

  try {
    const result = await client.call('RemoteStopTransaction', { transactionId });
    console.log(`[RemoteStop] Charger ${ocppId} responded: ${result.status}`);
    return result.status as 'Accepted' | 'Rejected';
  } catch (err) {
    console.error(`[RemoteStop] Error calling charger ${ocppId}:`, err);
    return 'Rejected';
  }
}

/**
 * Send Reset to a connected charger.
 * Called by the REST API when an operator reboots a charger.
 */
export async function remoteReset(
  ocppId: string,
  type: 'Soft' | 'Hard' = 'Soft',
): Promise<'Accepted' | 'Rejected'> {
  const client = clientRegistry.get(ocppId);
  if (!client) {
    console.warn(`[RemoteReset] Charger ${ocppId} is not connected`);
    return 'Rejected';
  }

  try {
    const result = await client.call('Reset', { type });
    console.log(`[RemoteReset] Charger ${ocppId} responded: ${result.status}`);
    return result.status as 'Accepted' | 'Rejected';
  } catch (err) {
    console.error(`[RemoteReset] Error calling charger ${ocppId}:`, err);
    return 'Rejected';
  }
}

/**
 * Send TriggerMessage (e.g. Heartbeat, MeterValues, StatusNotification)
 */
export async function remoteTriggerMessage(
  ocppId: string,
  requestedMessage: 'Heartbeat' | 'MeterValues' | 'StatusNotification' | 'BootNotification',
  connectorId?: number,
): Promise<'Accepted' | 'Rejected'> {
  const client = clientRegistry.get(ocppId);
  if (!client) {
    console.warn(`[RemoteTriggerMessage] Charger ${ocppId} is not connected`);
    return 'Rejected';
  }

  try {
    const payload: any = { requestedMessage };
    if (typeof connectorId === 'number') payload.connectorId = connectorId;
    const result = await client.call('TriggerMessage', payload);
    console.log(`[RemoteTriggerMessage] Charger ${ocppId} requestedMessage=${requestedMessage} responded: ${result.status}`);
    return result.status as 'Accepted' | 'Rejected';
  } catch (err) {
    console.error(`[RemoteTriggerMessage] Error calling charger ${ocppId}:`, err);
    return 'Rejected';
  }
}

/**
 * Send GetConfiguration to a connected charger.
 */
export async function remoteGetConfiguration(
  ocppId: string,
  key?: string[],
): Promise<{ configurationKey?: unknown[]; unknownKey?: string[] } | { error: string }> {
  const client = clientRegistry.get(ocppId);
  if (!client) {
    console.warn(`[RemoteGetConfiguration] Charger ${ocppId} is not connected`);
    return { error: 'Charger not connected' };
  }

  try {
    const payload = key && key.length > 0 ? { key } : {};
    const result = await client.call('GetConfiguration', payload);
    console.log(`[RemoteGetConfiguration] Charger ${ocppId} returned config keys=${result?.configurationKey?.length ?? 0}`);
    return result as { configurationKey?: unknown[]; unknownKey?: string[] };
  } catch (err) {
    console.error(`[RemoteGetConfiguration] Error calling charger ${ocppId}:`, err);
    return { error: 'GetConfiguration failed' };
  }
}

export async function remoteClearChargingProfile(
  ocppId: string,
  payload: Record<string, unknown>,
): Promise<'Accepted' | 'Rejected' | 'Unknown'> {
  const client = clientRegistry.get(ocppId);
  if (!client) {
    console.warn(`[RemoteClearChargingProfile] Charger ${ocppId} is not connected`);
    return 'Rejected';
  }

  try {
    const result = await client.call('ClearChargingProfile', payload);
    console.log(`[RemoteClearChargingProfile] Charger ${ocppId} responded: ${result.status}`);
    return result.status as 'Accepted' | 'Rejected' | 'Unknown';
  } catch (err) {
    console.error(`[RemoteClearChargingProfile] Error calling charger ${ocppId}:`, err);
    return 'Rejected';
  }
}

export async function remoteSetChargingProfile(
  ocppId: string,
  profile: Record<string, unknown>,
): Promise<'Accepted' | 'Rejected' | 'NotSupported'> {
  const client = clientRegistry.get(ocppId);
  if (!client) {
    console.warn(`[RemoteSetChargingProfile] Charger ${ocppId} is not connected`);
    return 'Rejected';
  }

  try {
    const result = await client.call('SetChargingProfile', profile);
    console.log(`[RemoteSetChargingProfile] Charger ${ocppId} responded: ${result.status}`);
    return result.status as 'Accepted' | 'Rejected' | 'NotSupported';
  } catch (err) {
    console.error(`[RemoteSetChargingProfile] Error calling charger ${ocppId}:`, err);
    return 'Rejected';
  }
}
