import { prisma } from '@ev-charger/shared';
import { recordUptimeEvent, toUptimeEvent } from '../uptimeEvents';
import type { StatusNotificationRequest, ChargerStatus, ConnectorStatus } from '@ev-charger/shared';

// Map OCPP ChargePointStatus to Prisma ConnectorStatus
function toConnectorStatus(ocppStatus: string): ConnectorStatus {
  const map: Record<string, ConnectorStatus> = {
    Available:     'AVAILABLE',
    Preparing:     'PREPARING',
    Charging:      'CHARGING',
    SuspendedEVSE: 'SUSPENDED_EVSE',
    SuspendedEV:   'SUSPENDED_EV',
    Finishing:     'FINISHING',
    Reserved:      'RESERVED',
    Unavailable:   'UNAVAILABLE',
    Faulted:       'FAULTED',
  };
  return map[ocppStatus] ?? 'UNAVAILABLE';
}

// Map OCPP status for the charger-level (connectorId=0)
function toChargerStatus(ocppStatus: string): ChargerStatus {
  if (ocppStatus === 'Faulted') return 'FAULTED';
  if (ocppStatus === 'Unavailable') return 'OFFLINE';
  return 'ONLINE';
}

export async function handleStatusNotification(
  _client: any,
  chargerId: string,
  params: StatusNotificationRequest,
): Promise<Record<string, never>> {
  const { connectorId, status, errorCode } = params;
  console.log(`[StatusNotification] chargerId=${chargerId} connector=${connectorId} status=${status} error=${errorCode}`);

  if (connectorId === 0) {
    // ConnectorId 0 = the charger itself
    const mapped = toChargerStatus(status);
    await prisma.charger.update({
      where: { id: chargerId },
      data: { status: mapped },
    });
    await recordUptimeEvent(chargerId, toUptimeEvent(status), { reason: `StatusNotification connector=0 status=${status}`, errorCode });
  } else {
    // Upsert connector status (create if missing, update if exists)
    await prisma.connector.upsert({
      where: {
        chargerId_connectorId: { chargerId, connectorId },
      },
      update: { status: toConnectorStatus(status) },
      create: {
        chargerId,
        connectorId,
        status: toConnectorStatus(status),
      },
    });

    // connector-level fault/offline visibility for incidents
    if (status === 'Faulted' || status === 'Unavailable') {
      await recordUptimeEvent(chargerId, status === 'Faulted' ? 'FAULTED' : 'OFFLINE', {
        connectorId,
        reason: `StatusNotification connector=${connectorId} status=${status}`,
        errorCode,
      });
    }
  }

  return {};
}
