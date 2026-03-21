import type { Prisma } from '@prisma/client';

export type OutboxEventType =
  | 'BootNotification'
  | 'Heartbeat'
  | 'StatusNotification'
  | 'StartTransaction'
  | 'MeterValues'
  | 'StopTransaction';

export async function enqueueOcppEvent(
  tx: Prisma.TransactionClient,
  params: {
    chargerId: string;
    eventType: OutboxEventType;
    payload: unknown;
    idempotencyKey: string;
  },
): Promise<void> {
  await tx.ocppEventOutbox.upsert({
    where: { idempotencyKey: params.idempotencyKey },
    update: {},
    create: {
      chargerId: params.chargerId,
      eventType: params.eventType,
      payload: params.payload as Prisma.JsonObject,
      idempotencyKey: params.idempotencyKey,
      status: 'PENDING',
    },
  });
}
