import { prisma } from '@ev-charger/shared';
import { recordUptimeEvent, toUptimeEvent } from '../uptimeEvents';
import { enqueueOcppEvent } from '../outbox';
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

  await prisma.$transaction(async (tx: any) => {
    if (connectorId === 0) {
      // ConnectorId 0 = the charger itself
      const mapped = toChargerStatus(status);
      await tx.charger.update({
        where: { id: chargerId },
        data: { status: mapped },
      });
    } else {
      const nextStatus = toConnectorStatus(status);
      const previous = await tx.connector.findUnique({
        where: { chargerId_connectorId: { chargerId, connectorId } },
        select: { id: true, status: true },
      });

      const connector = await tx.connector.upsert({
        where: {
          chargerId_connectorId: { chargerId, connectorId },
        },
        update: { status: nextStatus },
        create: {
          chargerId,
          connectorId,
          status: nextStatus,
        },
        select: { id: true },
      });

      const prevStatus = previous?.status;
      if (prevStatus && prevStatus !== nextStatus) {
        const transitionType = (() => {
          if (prevStatus === 'AVAILABLE' && nextStatus === 'PREPARING') return 'PLUG_IN';
          if (
            (prevStatus === 'FINISHING' || prevStatus === 'SUSPENDED_EV' || prevStatus === 'SUSPENDED_EVSE')
            && nextStatus === 'AVAILABLE'
          ) return 'PLUG_OUT';
          if (prevStatus === 'CHARGING' && (nextStatus === 'SUSPENDED_EV' || nextStatus === 'SUSPENDED_EVSE')) return 'IDLE_START';
          if (
            (prevStatus === 'FINISHING' || prevStatus === 'SUSPENDED_EV' || prevStatus === 'SUSPENDED_EVSE')
            && nextStatus === 'AVAILABLE'
          ) return 'IDLE_END';
          return 'STATUS_CHANGE';
        })();

        const payloadTs = params.timestamp ? new Date(params.timestamp) : null;
        const occurredAt = payloadTs && Number.isFinite(payloadTs.getTime()) ? payloadTs : new Date();

        await tx.connectorStateTransition.create({
          data: {
            chargerId,
            connectorRefId: connector.id,
            connectorId,
            fromStatus: prevStatus,
            toStatus: nextStatus,
            transitionType,
            occurredAt,
            payloadTs: payloadTs && Number.isFinite(payloadTs.getTime()) ? payloadTs : null,
          },
        });
      }
    }

    await enqueueOcppEvent(tx, {
      chargerId,
      eventType: 'StatusNotification',
      payload: params,
      idempotencyKey: `${chargerId}:StatusNotification:${connectorId}:${status}:${params.timestamp ?? 'na'}`,
    });
  });

  if (connectorId === 0) {
    await recordUptimeEvent(chargerId, toUptimeEvent(status), { reason: `StatusNotification connector=0 status=${status}`, errorCode });
  } else if (status === 'Faulted' || status === 'Unavailable') {
    // Record connector-level down signal; uptime math later applies >1s persistence filter.
    await recordUptimeEvent(chargerId, status === 'Faulted' ? 'FAULTED' : 'OFFLINE', {
      connectorId,
      reason: `StatusNotification connector=${connectorId} status=${status}`,
      errorCode,
    });
  } else {
    // Record connector recovery only if last connector-level signal was down.
    const last = await prisma.uptimeEvent.findFirst({
      where: { chargerId, connectorId },
      orderBy: { createdAt: 'desc' },
      select: { event: true },
    });
    if (last && (last.event === 'FAULTED' || last.event === 'OFFLINE')) {
      await recordUptimeEvent(chargerId, 'RECOVERED', {
        connectorId,
        reason: `StatusNotification connector=${connectorId} status=${status}`,
      });
    }
  }

  return {};
}
