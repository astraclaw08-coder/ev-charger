import { prisma } from '@ev-charger/shared';
import type { StopTransactionRequest, StopTransactionResponse } from '@ev-charger/shared';

async function triggerBillingHook(sessionId: string, kwhDelivered: number, ratePerKwh: number) {
  const amountUsd = kwhDelivered * ratePerKwh;
  console.log(`[Billing] Session ${sessionId} — ${kwhDelivered.toFixed(3)} kWh × $${ratePerKwh}/kWh = $${amountUsd.toFixed(2)}`);
  // TODO Phase 3: initiate Stripe capture here
}

export async function handleStopTransaction(
  _client: any,
  chargerId: string,
  params: StopTransactionRequest,
): Promise<StopTransactionResponse> {
  const { transactionId, meterStop, timestamp, idTag, reason } = params;
  console.log(`[StopTransaction] chargerId=${chargerId} transactionId=${transactionId} meterStop=${meterStop} reason=${reason}`);

  const session = await prisma.session.findUnique({
    where: { transactionId },
    include: { connector: true },
  });

  if (!session) {
    console.warn(`[StopTransaction] Session not found for transactionId=${transactionId}`);
    return {};
  }

  const kwhDelivered = session.meterStart != null
    ? (meterStop - session.meterStart) / 1000
    : 0;

  await prisma.session.update({
    where: { id: session.id },
    data: {
      meterStop,
      stoppedAt: new Date(timestamp),
      kwhDelivered,
      status: 'COMPLETED',
    },
  });

  // Return connector to Available
  await prisma.connector.update({
    where: { id: session.connector.id },
    data: { status: 'AVAILABLE' },
  });

  if (session.ratePerKwh != null) {
    await triggerBillingHook(session.id, kwhDelivered, session.ratePerKwh);
  }

  const response: StopTransactionResponse = {};
  if (idTag) {
    response.idTagInfo = { status: 'Accepted' };
  }
  return response;
}
