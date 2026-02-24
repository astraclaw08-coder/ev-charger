import { prisma } from '@ev-charger/shared';
import type { StartTransactionRequest, StartTransactionResponse } from '@ev-charger/shared';

const DEFAULT_RATE_PER_KWH = 0.35; // USD — set per charger/site in Phase 3

async function nextTransactionId(): Promise<number> {
  const last = await prisma.session.findFirst({
    where: { transactionId: { not: null } },
    orderBy: { transactionId: 'desc' },
    select: { transactionId: true },
  });
  return (last?.transactionId ?? 0) + 1;
}

export async function handleStartTransaction(
  _client: any,
  chargerId: string,
  params: StartTransactionRequest,
): Promise<StartTransactionResponse> {
  const { connectorId, idTag, meterStart, timestamp } = params;
  console.log(`[StartTransaction] chargerId=${chargerId} connector=${connectorId} idTag=${idTag} meterStart=${meterStart}`);

  // Resolve user and connector
  const [user, connector] = await Promise.all([
    prisma.user.findUnique({ where: { idTag } }),
    prisma.connector.findUnique({
      where: { chargerId_connectorId: { chargerId, connectorId } },
    }),
  ]);

  if (!user) {
    console.warn(`[StartTransaction] Unknown idTag=${idTag}, rejecting`);
    return {
      idTagInfo: { status: 'Invalid' },
      transactionId: 0,
    };
  }

  if (!connector) {
    console.warn(`[StartTransaction] Connector not found chargerId=${chargerId} connectorId=${connectorId}`);
    return {
      idTagInfo: { status: 'Invalid' },
      transactionId: 0,
    };
  }

  const transactionId = await nextTransactionId();

  const session = await prisma.session.create({
    data: {
      connectorId: connector.id,
      userId: user.id,
      transactionId,
      idTag,
      startedAt: new Date(timestamp),
      meterStart,
      ratePerKwh: DEFAULT_RATE_PER_KWH,
      status: 'ACTIVE',
    },
  });

  // Mark connector as Charging
  await prisma.connector.update({
    where: { id: connector.id },
    data: { status: 'CHARGING' },
  });

  console.log(`[StartTransaction] Session ${session.id} started, transactionId=${transactionId}`);

  return {
    idTagInfo: { status: 'Accepted' },
    transactionId,
  };
}
