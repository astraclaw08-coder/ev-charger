import { prisma } from '@ev-charger/shared';
import { recordUptimeEvent } from '../uptimeEvents';
import type { BootNotificationRequest, BootNotificationResponse } from '@ev-charger/shared';

export async function handleBootNotification(
  _client: any,
  chargerId: string,
  params: BootNotificationRequest,
): Promise<BootNotificationResponse> {
  console.log(`[BootNotification] chargerId=${chargerId} vendor=${params.chargePointVendor} model=${params.chargePointModel}`);

  await prisma.charger.update({
    where: { id: chargerId },
    data: {
      status: 'ONLINE',
      vendor: params.chargePointVendor,
      model: params.chargePointModel,
    },
  });

  await recordUptimeEvent(chargerId, 'ONLINE', { reason: 'BootNotification accepted' });

  return {
    currentTime: new Date().toISOString(),
    interval: 300,
    status: 'Accepted',
  };
}
