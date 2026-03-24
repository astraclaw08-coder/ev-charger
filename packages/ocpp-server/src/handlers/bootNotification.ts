import { prisma } from '@ev-charger/shared';
import { recordUptimeEvent } from '../uptimeEvents';
import { enqueueOcppEvent } from '../outbox';
import type { BootNotificationRequest, BootNotificationResponse } from '@ev-charger/shared';

export async function handleBootNotification(
  _client: any,
  chargerId: string,
  params: BootNotificationRequest,
): Promise<BootNotificationResponse> {
  console.log(`[BootNotification] chargerId=${chargerId} vendor=${params.chargePointVendor} model=${params.chargePointModel}`);

  await prisma.$transaction(async (tx) => {
    await tx.charger.update({
      where: { id: chargerId },
      data: {
        status: 'ONLINE',
        vendor: params.chargePointVendor,
        model: params.chargePointModel,
      },
    });

    await enqueueOcppEvent(tx, {
      chargerId,
      eventType: 'BootNotification',
      payload: params,
      idempotencyKey: `${chargerId}:BootNotification:${params.chargePointVendor}:${params.chargePointModel}`,
    });
  });

  await recordUptimeEvent(chargerId, 'ONLINE', { reason: 'BootNotification accepted' });

  // Reset smart charging state to PENDING_OFFLINE on boot so the heartbeat gate
  // forces a fresh GetConfiguration-style re-apply cycle after the charger reboots.
  // Without this, the idempotency check sees status=APPLIED from the prior session
  // and skips re-applying — even though the charger's in-memory profile was wiped on reboot.
  await prisma.smartChargingState.updateMany({
    where: { chargerId },
    data: { status: 'PENDING_OFFLINE' },
  });

  return {
    currentTime: new Date().toISOString(),
    // 300s OCPP heartbeat interval. The WebSocket is kept alive independently
    // via server-side WS ping frames (pingIntervalMs: 50s in RPCServer config),
    // so the OCPP Heartbeat is only needed for application-level liveness checks
    // — not as a proxy keepalive workaround.
    interval: 300,
    status: 'Accepted',
  };
}
