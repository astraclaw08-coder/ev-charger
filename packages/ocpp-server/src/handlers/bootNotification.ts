import { prisma } from '@ev-charger/shared';
import { recordUptimeEvent } from '../uptimeEvents';
import { enqueueOcppEvent } from '../outbox';
import { applySmartChargingForCharger } from '../smartCharging';
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
  await applySmartChargingForCharger(chargerId, 'boot_notification');

  return {
    currentTime: new Date().toISOString(),
    interval: 900,
    status: 'Accepted',
  };
}
