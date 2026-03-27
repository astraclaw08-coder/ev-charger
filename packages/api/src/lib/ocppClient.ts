const OCPP_INTERNAL_URL = process.env.OCPP_INTERNAL_URL ?? 'http://127.0.0.1:9001';

async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${OCPP_INTERNAL_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OCPP internal server error ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}

export async function remoteStart(
  ocppId: string,
  connectorId: number,
  idTag: string,
): Promise<'Accepted' | 'Rejected'> {
  try {
    const data = await post<{ status: string }>('/remote-start', { ocppId, connectorId, idTag });
    return data.status as 'Accepted' | 'Rejected';
  } catch (err) {
    console.error('[OcppClient] remoteStart failed:', err);
    return 'Rejected';
  }
}

export async function remoteStop(
  ocppId: string,
  transactionId: number,
): Promise<'Accepted' | 'Rejected'> {
  try {
    const data = await post<{ status: string }>('/remote-stop', { ocppId, transactionId });
    return data.status as 'Accepted' | 'Rejected';
  } catch (err) {
    console.error('[OcppClient] remoteStop failed:', err);
    return 'Rejected';
  }
}

export async function remoteReset(
  ocppId: string,
  type: 'Soft' | 'Hard' = 'Soft',
): Promise<'Accepted' | 'Rejected'> {
  try {
    const data = await post<{ status: string }>('/reset', { ocppId, type });
    return data.status as 'Accepted' | 'Rejected';
  } catch (err) {
    console.error('[OcppClient] remoteReset failed:', err);
    return 'Rejected';
  }
}

export async function triggerHeartbeat(
  ocppId: string,
): Promise<'Accepted' | 'Rejected'> {
  try {
    const data = await post<{ status: string }>('/trigger-message', {
      ocppId,
      requestedMessage: 'Heartbeat',
    });
    return data.status as 'Accepted' | 'Rejected';
  } catch (err) {
    console.error('[OcppClient] triggerHeartbeat failed:', err);
    return 'Rejected';
  }
}

export async function getConfiguration(
  ocppId: string,
): Promise<{ configurationKey?: unknown[]; unknownKey?: string[] } | { error: string }> {
  try {
    return await post<{ configurationKey?: unknown[]; unknownKey?: string[] }>('/get-configuration', {
      ocppId,
    });
  } catch (err) {
    console.error('[OcppClient] getConfiguration failed:', err);
    return { error: 'GetConfiguration failed' };
  }
}

export async function setChargingProfile(
  ocppId: string,
  profile: Record<string, unknown>,
): Promise<'Accepted' | 'Rejected' | 'NotSupported'> {
  try {
    const data = await post<{ status: string }>('/set-charging-profile', { ocppId, profile });
    return data.status as 'Accepted' | 'Rejected' | 'NotSupported';
  } catch (err) {
    console.error('[OcppClient] setChargingProfile failed:', err);
    return 'Rejected';
  }
}

export async function getCompositeSchedule(
  ocppId: string,
  payload: { connectorId?: number; duration?: number; chargingRateUnit?: string },
): Promise<{ status: string; connectorId?: number; scheduleStart?: string; chargingSchedule?: unknown } | null> {
  try {
    const data = await post<{ status: string; connectorId?: number; scheduleStart?: string; chargingSchedule?: unknown }>(
      '/get-composite-schedule',
      { ocppId, ...payload },
    );
    return data;
  } catch (err) {
    console.error('[OcppClient] getCompositeSchedule failed:', err);
    return null;
  }
}
