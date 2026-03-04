import { prisma } from '@ev-charger/shared';
import type { StopTransactionRequest, StopTransactionResponse } from '@ev-charger/shared';


function extractTransactionEndWh(params: StopTransactionRequest): number | null {
  const points = params.transactionData ?? [];
  let bestTs = -1;
  let bestWh: number | null = null;

  for (const mv of points) {
    const ts = Date.parse(mv.timestamp);
    for (const sv of mv.sampledValue ?? []) {
      const context = sv.context ?? '';
      const measurand = sv.measurand ?? 'Energy.Active.Import.Register';
      if (context !== 'Transaction.End') continue;
      if (measurand !== 'Energy.Active.Import.Register') continue;

      const raw = Number(sv.value);
      if (!Number.isFinite(raw)) continue;
      const unit = sv.unit ?? 'Wh';
      const wh = unit === 'kWh' ? raw * 1000 : raw;

      if (ts >= bestTs) {
        bestTs = ts;
        bestWh = wh;
      }
    }
  }

  return bestWh;
}

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

  // For LOOP EX-1762 chargers, transactionData/Transaction.End is the most
  // accurate terminal reading (can include sub-Wh decimals). Prefer it when present.
  const transactionEndWh = extractTransactionEndWh(params);

  // Fallback precedence: Transaction.End > latest MeterValues > StopTransaction.meterStop.
  const finalMeterStop = transactionEndWh ?? Math.max(meterStop, session.meterStop ?? meterStop);

  const kwhDelivered = session.meterStart != null
    ? Math.max(0, (finalMeterStop - session.meterStart) / 1000)
    : 0;

  console.log(`[StopTransaction] finalMeterStop=${finalMeterStop}Wh transactionEndWh=${transactionEndWh ?? 'n/a'} sessionMeterStop=${session.meterStop ?? 'n/a'}`);

  await prisma.session.update({
    where: { id: session.id },
    data: {
      meterStop: finalMeterStop,
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
