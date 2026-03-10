import { prisma } from '@ev-charger/shared';
import { recordUptimeEvent } from '../uptimeEvents';
import { enqueueOcppEvent } from '../outbox';
import type { HeartbeatResponse } from '@ev-charger/shared';

export async function handleHeartbeat(
  _client: any,
  chargerId: string,
  _params: Record<string, never>,
): Promise<HeartbeatResponse> {
  const now = new Date();
  console.log(`[Heartbeat] chargerId=${chargerId}`);

  const current = await prisma.charger.findUnique({ where: { id: chargerId }, select: { status: true } });
  const shouldRecover = current?.status === 'DEGRADED' || current?.status === 'OFFLINE';

  await prisma.$transaction(async (tx) => {
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

  return { currentTime: now.toISOString() };
}
