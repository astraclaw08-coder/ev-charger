import { prisma, resolveTouRateAt } from '@ev-charger/shared';
import { enqueueOcppEvent } from '../outbox';
import type { StartTransactionRequest, StartTransactionResponse } from '@ev-charger/shared';

const DEFAULT_RATE_PER_KWH = 0.35; // USD fallback when site pricing is missing
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
      include: {
        charger: {
          include: {
            site: {
              select: {
                pricingMode: true,
                pricePerKwhUsd: true,
                idleFeePerMinUsd: true,
                touWindows: true,
                timeZone: true,
              },
            },
          },
        },
      },
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
      const cSite = connector.charger.site;
      const resolvedRate = resolveTouRateAt({
        at: timestamp,
        pricingMode: cSite?.pricingMode,
        defaultPricePerKwhUsd: cSite?.pricePerKwhUsd ?? DEFAULT_RATE_PER_KWH,
        defaultIdleFeePerMinUsd: cSite?.idleFeePerMinUsd ?? 0,
        touWindows: cSite?.touWindows,
        timeZone: cSite?.timeZone ?? 'America/Los_Angeles',
      });
      session = await prisma.session.create({
        data: {
          connectorId: connector.id,
          userId: user.id,
          transactionId,
          idTag,
          startedAt: new Date(timestamp),
          meterStart,
          ratePerKwh: resolvedRate.pricePerKwhUsd,
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

  // Mark connector as Charging and enqueue OCPP event for downstream processing.
  await prisma.$transaction(async (tx: any) => {
    await tx.connector.update({
      where: { id: connector.id },
      data: { status: 'CHARGING' },
    });

    await enqueueOcppEvent(tx, {
      chargerId,
      eventType: 'StartTransaction',
      payload: params,
      idempotencyKey: `${chargerId}:StartTransaction:${transactionId}:${timestamp}`,
    });
  });

  console.log(`[StartTransaction] Session ${session.id} started, transactionId=${transactionId}`);

  return { idTagInfo: { status: 'Accepted' }, transactionId };
}
