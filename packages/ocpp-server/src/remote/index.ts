import { clientRegistry } from '../clientRegistry';
import { logOcppMessage } from '../ocppLogger';

/**
 * Send RemoteStartTransaction to a connected charger.
 * Called by the REST API when a driver taps "Start" in the app.
 *
 * Logging: OUTBOUND request + INBOUND response are written via
 * `logOcppMessage` (matching the pattern in `remoteTriggerMessage`,
 * `remoteSetChargingProfile`, etc.). On exception, a synthetic Rejected
 * response is logged so the TASK-0198 ChargerEvent extractor surfaces a
 * REMOTE_START_FAILED row even when the underlying RPC threw. All logging
 * is non-fatal — wrapped in try/catch so a logging failure can never
 * disrupt the OCPP control flow or the API response to the caller.
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

  const chargerId = client?.session?.chargerId ?? '';
  const payload = { connectorId, idTag };
  if (chargerId) {
    try { await logOcppMessage(chargerId, 'OUTBOUND', 'RemoteStartTransaction', payload); }
    catch (logErr) { console.error('[RemoteStart] OUTBOUND log failed:', logErr); }
  }

  try {
    const result = await client.call('RemoteStartTransaction', payload);
    console.log(`[RemoteStart] Charger ${ocppId} responded: ${result.status}`);
    if (chargerId) {
      try { await logOcppMessage(chargerId, 'INBOUND', 'RemoteStartTransactionResponse', result ?? {}); }
      catch (logErr) { console.error('[RemoteStart] INBOUND log failed:', logErr); }
    }
    return result.status as 'Accepted' | 'Rejected';
  } catch (err) {
    console.error(`[RemoteStart] Error calling charger ${ocppId}:`, err);
    if (chargerId) {
      const synthetic = { status: 'Rejected', error: err instanceof Error ? err.message : String(err) };
      try { await logOcppMessage(chargerId, 'INBOUND', 'RemoteStartTransactionResponse', synthetic); }
      catch (logErr) { console.error('[RemoteStart] INBOUND-on-exception log failed:', logErr); }
    }
    return 'Rejected';
  }
}

/**
 * Send RemoteStopTransaction to a connected charger.
 * Called by the REST API when a driver taps "Stop" in the app.
 *
 * Logging mirrors `remoteStartTransaction` — see that function's doc.
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

  const chargerId = client?.session?.chargerId ?? '';
  const payload = { transactionId };
  if (chargerId) {
    try { await logOcppMessage(chargerId, 'OUTBOUND', 'RemoteStopTransaction', payload); }
    catch (logErr) { console.error('[RemoteStop] OUTBOUND log failed:', logErr); }
  }

  try {
    const result = await client.call('RemoteStopTransaction', payload);
    console.log(`[RemoteStop] Charger ${ocppId} responded: ${result.status}`);
    if (chargerId) {
      try { await logOcppMessage(chargerId, 'INBOUND', 'RemoteStopTransactionResponse', result ?? {}); }
      catch (logErr) { console.error('[RemoteStop] INBOUND log failed:', logErr); }
    }
    return result.status as 'Accepted' | 'Rejected';
  } catch (err) {
    console.error(`[RemoteStop] Error calling charger ${ocppId}:`, err);
    if (chargerId) {
      const synthetic = { status: 'Rejected', error: err instanceof Error ? err.message : String(err) };
      try { await logOcppMessage(chargerId, 'INBOUND', 'RemoteStopTransactionResponse', synthetic); }
      catch (logErr) { console.error('[RemoteStop] INBOUND-on-exception log failed:', logErr); }
    }
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
): Promise<{ status: 'Accepted' | 'Rejected'; error?: string; detail?: string; registry?: Record<string, unknown> | null }> {
  const client = clientRegistry.get(ocppId);
  const registry = clientRegistry.debug(ocppId);
  if (!client) {
    const detail = 'Charger is not connected to the live OCPP registry';
    console.warn(`[RemoteTriggerMessage] Charger ${ocppId} is not connected registry=${JSON.stringify(registry)}`);
    return { status: 'Rejected', error: 'not_connected', detail, registry };
  }

  try {
    const payload: any = { requestedMessage };
    if (typeof connectorId === 'number') payload.connectorId = connectorId;
    console.log(`[RemoteTriggerMessage] -> ${ocppId} payload=${JSON.stringify(payload)} registry=${JSON.stringify(registry)}`);
    const result = await client.call('TriggerMessage', payload);
    const chargerId = client?.session?.chargerId ?? '';
    if (chargerId) {
      await logOcppMessage(chargerId, 'OUTBOUND', 'TriggerMessage', payload);
      await logOcppMessage(chargerId, 'INBOUND', 'TriggerMessageResponse', result ?? {});
    }
    console.log(`[RemoteTriggerMessage] <- ${ocppId} requestedMessage=${requestedMessage} responded: ${result.status}`);
    return { status: (result.status as 'Accepted' | 'Rejected') ?? 'Rejected', registry };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[RemoteTriggerMessage] Error calling charger ${ocppId}:`, err);
    return { status: 'Rejected', error: 'call_failed', detail, registry };
  }
}

/**
 * Send ChangeConfiguration to a connected charger.
 * Writes a single config key on the charger.
 * Returns the charger's OCPP 1.6 status: Accepted | Rejected | RebootRequired | NotSupported.
 */
export async function remoteChangeConfiguration(
  ocppId: string,
  key: string,
  value: string,
): Promise<{ status: 'Accepted' | 'Rejected' | 'RebootRequired' | 'NotSupported' } | { error: string }> {
  const client = clientRegistry.get(ocppId);
  if (!client) {
    console.warn(`[RemoteChangeConfiguration] Charger ${ocppId} is not connected`);
    return { error: 'Charger not connected' };
  }

  try {
    const payload = { key, value };
    const result = await client.call('ChangeConfiguration', payload);
    const chargerRow = await import('@ev-charger/shared').then((m) => m.prisma.charger.findUnique({ where: { ocppId }, select: { id: true } }));
    if (chargerRow) {
      await logOcppMessage(chargerRow.id, 'OUTBOUND', 'ChangeConfiguration', payload);
      await logOcppMessage(chargerRow.id, 'INBOUND', 'ChangeConfigurationResponse', result ?? {});
    }
    console.log(`[RemoteChangeConfiguration] ${ocppId} key=${key} value=${value} -> ${result?.status ?? 'no response'}`);
    return { status: (result?.status as 'Accepted' | 'Rejected' | 'RebootRequired' | 'NotSupported') ?? 'Rejected' };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[RemoteChangeConfiguration] Error calling charger ${ocppId}:`, err);
    return { error: `ChangeConfiguration failed: ${detail}` };
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
    // Audit log for debugging smart charging issues
    const chargerId = client?.session?.chargerId ?? '';
    if (chargerId) {
      await logOcppMessage(chargerId, 'OUTBOUND', 'ClearChargingProfile', payload);
      await logOcppMessage(chargerId, 'INBOUND', 'ClearChargingProfileResponse', result ?? {});
    }
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
    // Audit log for debugging smart charging issues
    const chargerId = client?.session?.chargerId ?? '';
    if (chargerId) {
      await logOcppMessage(chargerId, 'OUTBOUND', 'SetChargingProfile', profile);
      await logOcppMessage(chargerId, 'INBOUND', 'SetChargingProfileResponse', result ?? {});
    }
    return result.status as 'Accepted' | 'Rejected' | 'NotSupported';
  } catch (err) {
    console.error(`[RemoteSetChargingProfile] Error calling charger ${ocppId}:`, err);
    return 'Rejected';
  }
}

/**
 * Send ReserveNow to a connected charger (OCPP 1.6J §5.10).
 * Called by the REST API when a driver reserves a connector.
 */
export async function remoteReserveNow(
  ocppId: string,
  connectorId: number,
  expiryDate: string,
  idTag: string,
  reservationId: number,
): Promise<'Accepted' | 'Rejected' | 'Faulted' | 'Occupied' | 'Unavailable'> {
  const client = clientRegistry.get(ocppId);
  if (!client) {
    console.warn(`[RemoteReserveNow] Charger ${ocppId} is not connected`);
    return 'Rejected';
  }

  try {
    const result = await client.call('ReserveNow', {
      connectorId,
      expiryDate,
      idTag,
      reservationId,
    });
    console.log(`[RemoteReserveNow] Charger ${ocppId} responded: ${result.status}`);
    return result.status as 'Accepted' | 'Rejected' | 'Faulted' | 'Occupied' | 'Unavailable';
  } catch (err) {
    console.error(`[RemoteReserveNow] Error calling charger ${ocppId}:`, err);
    return 'Rejected';
  }
}

/**
 * Send CancelReservation to a connected charger (OCPP 1.6J §5.2).
 * Called when a reservation is cancelled or expires (if originally OCPP-sent).
 */
export async function remoteCancelReservation(
  ocppId: string,
  reservationId: number,
): Promise<'Accepted' | 'Rejected'> {
  const client = clientRegistry.get(ocppId);
  if (!client) {
    console.warn(`[RemoteCancelReservation] Charger ${ocppId} is not connected`);
    return 'Rejected';
  }

  try {
    const result = await client.call('CancelReservation', { reservationId });
    console.log(`[RemoteCancelReservation] Charger ${ocppId} responded: ${result.status}`);
    return result.status as 'Accepted' | 'Rejected';
  } catch (err) {
    console.error(`[RemoteCancelReservation] Error calling charger ${ocppId}:`, err);
    return 'Rejected';
  }
}

export async function remoteGetCompositeSchedule(
  ocppId: string,
  payload: { connectorId: number; duration: number; chargingRateUnit?: string },
): Promise<{ status: string; connectorId?: number; scheduleStart?: string; chargingSchedule?: unknown } | null> {
  const client = clientRegistry.get(ocppId);
  if (!client) {
    console.warn(`[RemoteGetCompositeSchedule] Charger ${ocppId} is not connected`);
    return null;
  }

  try {
    const result = await client.call('GetCompositeSchedule', {
      connectorId: payload.connectorId,
      duration: payload.duration,
      ...(payload.chargingRateUnit ? { chargingRateUnit: payload.chargingRateUnit } : {}),
    });
    console.log(`[RemoteGetCompositeSchedule] Charger ${ocppId} responded: ${result.status}`);
    return result as { status: string; connectorId?: number; scheduleStart?: string; chargingSchedule?: unknown };
  } catch (err) {
    console.error(`[RemoteGetCompositeSchedule] Error calling charger ${ocppId}:`, err);
    return null;
  }
}
