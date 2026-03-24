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
    // 30s heartbeat interval keeps the WebSocket alive through Railway's idle
    // proxy timeout (~60s). The previous value of 900s caused the charger to
    // go silent for 15 minutes, which Railway interpreted as an idle connection
    // and dropped with code 1006 — making the charger appear connected in the
    // DB (stale status) but not in the live registry, causing every
    // RemoteStartTransaction to return Rejected server-side.
    interval: 30,
    status: 'Accepted',
  };
}
