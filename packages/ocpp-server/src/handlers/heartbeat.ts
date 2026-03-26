import { prisma } from '@ev-charger/shared';
import { recordUptimeEvent } from '../uptimeEvents';
import { enqueueOcppEvent } from '../outbox';
import { applySmartChargingForCharger } from '../smartCharging';
import { clientRegistry } from '../clientRegistry';
import type { HeartbeatResponse } from '@ev-charger/shared';

export async function handleHeartbeat(
  _client: any,
  chargerId: string,
  _params: Record<string, never>,
): Promise<HeartbeatResponse> {
  const now = new Date();
  console.log(`[Heartbeat] chargerId=${chargerId}`);

  // Track heartbeat count for connection stability instrumentation
  const ocppId = (await prisma.charger.findUnique({ where: { id: chargerId }, select: { ocppId: true } }))?.ocppId;
  if (ocppId) clientRegistry.markHeartbeat(ocppId);

  const current = await prisma.charger.findUnique({ where: { id: chargerId }, select: { status: true } });
  const shouldRecover = current?.status === 'OFFLINE';

  await prisma.$transaction(async (tx: any) => {
    await tx.charger.update({
      where: { id: chargerId },
      data: { lastHeartbeat: now, status: shouldRecover ? 'ONLINE' : undefined },
    });

    await enqueueOcppEvent(tx, {
      chargerId,
      eventType: 'Heartbeat',
      payload: { currentTime: now.toISOString() },
      idempotencyKey: `${chargerId}:Heartbeat:${now.toISOString()}`,
    });
  });

  if (shouldRecover) {
    await recordUptimeEvent(chargerId, 'RECOVERED', { reason: 'Heartbeat restored' });
  }

  // Apply smart charging after heartbeat gating (not on raw boot/connect).
  await applySmartChargingForCharger(chargerId, shouldRecover ? 'heartbeat_recovered' : 'heartbeat');

  return { currentTime: now.toISOString() };
}
