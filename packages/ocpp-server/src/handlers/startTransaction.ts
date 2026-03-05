import { prisma } from '@ev-charger/shared';
import type { StartTransactionRequest, StartTransactionResponse } from '@ev-charger/shared';

const DEFAULT_RATE_PER_KWH = 0.35; // USD — set per charger/site in Phase 3
const TX_ID_MIN = 10000;
const TX_ID_MAX = 99999;
const TX_ID_MAX_ATTEMPTS = 30;

function randomFiveDigitTransactionId(): number {
  return Math.floor(Math.random() * (TX_ID_MAX - TX_ID_MIN + 1)) + TX_ID_MIN;
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

  let session = null as Awaited<ReturnType<typeof prisma.session.create>> | null;
  let transactionId = 0;

  for (let attempt = 1; attempt <= TX_ID_MAX_ATTEMPTS; attempt++) {
    transactionId = randomFiveDigitTransactionId();
    try {
      session = await prisma.session.create({
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
      break;
    } catch (err: any) {
      // Prisma unique constraint violation => collision, retry with new random id
      if (err?.code === 'P2002') continue;
      throw err;
    }
  }

  if (!session) {
    throw new Error('Failed to allocate unique 5-digit transactionId after retries');
  }

  // Mark connector as Charging
  await prisma.connector.update({
    where: { id: connector.id },
    data: { status: 'CHARGING' },
  });

  console.log(`[StartTransaction] Session ${session.id} started, transactionId=${transactionId}`);

  return { idTagInfo: { status: 'Accepted' }, transactionId };
}
