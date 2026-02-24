import { prisma } from '@ev-charger/shared';
import type { StatusNotificationRequest } from '@ev-charger/shared';
import type { ChargerStatus, ConnectorStatus } from '@prisma/client';

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
    await prisma.charger.update({
      where: { id: chargerId },
      data: { status: toChargerStatus(status) },
    });
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
  }

  return {};
}
