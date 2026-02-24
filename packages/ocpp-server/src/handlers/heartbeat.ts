import { prisma } from '@ev-charger/shared';
import type { HeartbeatResponse } from '@ev-charger/shared';

export async function handleHeartbeat(
  _client: any,
  chargerId: string,
  _params: Record<string, never>,
): Promise<HeartbeatResponse> {
  const now = new Date();
  console.log(`[Heartbeat] chargerId=${chargerId}`);

  await prisma.charger.update({
    where: { id: chargerId },
    data: { lastHeartbeat: now },
  });

  return { currentTime: now.toISOString() };
}
