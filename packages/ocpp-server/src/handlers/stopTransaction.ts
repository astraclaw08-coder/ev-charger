import { prisma, splitTouDuration, captureSessionBillingSnapshot } from '@ev-charger/shared';
import { enqueueOcppEvent } from '../outbox';
import type { StopTransactionRequest, StopTransactionResponse } from '@ev-charger/shared';


function extractTransactionContextWh(
  params: StopTransactionRequest,
  targetContext: 'Transaction.Begin' | 'Transaction.End',
): number | null {
  const points = params.transactionData ?? [];
  let bestTs = -1;
  let bestWh: number | null = null;

  for (const mv of points) {
    const ts = Date.parse(mv.timestamp);
    for (const sv of mv.sampledValue ?? []) {
      const context = sv.context ?? '';
      const measurand = sv.measurand ?? 'Energy.Active.Import.Register';
      if (context !== targetContext) continue;
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

async function triggerBillingHook(sessionId: string, kwhDelivered: number, ratePerKwh: number, amountUsd: number) {
  console.log(
    `[Billing] Session ${sessionId} — ${kwhDelivered.toFixed(3)} kWh @ $${ratePerKwh.toFixed(4)}/kWh (effective) = $${amountUsd.toFixed(2)}`,
  );
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
    include: {
      connector: {
        include: {
          charger: {
            include: {
              site: {
                select: {
                  pricingMode: true,
                  pricePerKwhUsd: true,
                  idleFeePerMinUsd: true,
                  touWindows: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!session) {
    console.warn(`[StopTransaction] Session not found for transactionId=${transactionId}`);
    return {};
  }

  const transactionBeginWh = extractTransactionContextWh(params, 'Transaction.Begin');
  const transactionEndWh = extractTransactionContextWh(params, 'Transaction.End');

  // Fallback precedence for persisted meterStop: Transaction.End > latest MeterValues > StopTransaction.meterStop.
  const finalMeterStop = transactionEndWh ?? Math.max(meterStop, session.meterStop ?? meterStop);

  // Requested billing rule:
  // 1) kWh = (Transaction.End - Transaction.Begin)
  // 2) if Begin missing, assume 0
  // 3) if both Begin and End missing, use (meterStop - meterStart)
  const kwhDelivered = transactionEndWh != null
    ? Math.max(0, (transactionEndWh - (transactionBeginWh ?? 0)) / 1000)
    : session.meterStart != null
      ? Math.max(0, (finalMeterStop - session.meterStart) / 1000)
      : 0;

  console.log(
    `[StopTransaction] finalMeterStop=${finalMeterStop}Wh txBegin=${transactionBeginWh ?? 'n/a'} txEnd=${transactionEndWh ?? 'n/a'} sessionMeterStart=${session.meterStart ?? 'n/a'} sessionMeterStop=${session.meterStop ?? 'n/a'} kWh=${kwhDelivered.toFixed(6)}`,
  );

  const site = session.connector.charger.site;
  const durationSegments = splitTouDuration({
    startedAt: session.startedAt,
    stoppedAt: timestamp,
    pricingMode: site.pricingMode,
    defaultPricePerKwhUsd: site.pricePerKwhUsd,
    defaultIdleFeePerMinUsd: site.idleFeePerMinUsd,
    touWindows: site.touWindows,
  });
  const totalSegmentMinutes = durationSegments.reduce((sum, seg) => sum + seg.minutes, 0);
  const weightedRatePerKwh =
    totalSegmentMinutes > 0
      ? durationSegments.reduce((sum, seg) => sum + (seg.minutes / totalSegmentMinutes) * seg.pricePerKwhUsd, 0)
      : (session.ratePerKwh ?? site.pricePerKwhUsd ?? 0);
  const estimatedEnergyAmountUsd = kwhDelivered * weightedRatePerKwh;

  await prisma.$transaction(async (tx) => {
    await tx.session.update({
      where: { id: session.id },
      data: {
        meterStop: finalMeterStop,
        stoppedAt: new Date(timestamp),
        kwhDelivered,
        ratePerKwh: weightedRatePerKwh,
        status: 'COMPLETED',
      },
    });

    // Return connector to Available
    await tx.connector.update({
      where: { id: session.connector.id },
      data: { status: 'AVAILABLE' },
    });

    await enqueueOcppEvent(tx, {
      chargerId,
      eventType: 'StopTransaction',
      payload: params,
      idempotencyKey: `${chargerId}:StopTransaction:${transactionId}:${timestamp}`,
    });
  });

  if (weightedRatePerKwh > 0 || estimatedEnergyAmountUsd > 0) {
    await triggerBillingHook(session.id, kwhDelivered, weightedRatePerKwh, estimatedEnergyAmountUsd);
  }

  // Capture immutable billing snapshot — non-blocking, failure must not fail StopTransaction
  try {
    await captureSessionBillingSnapshot(session.id);
  } catch (snapErr) {
    console.error('[BillingSnapshot] Failed to capture snapshot on StopTransaction:', snapErr);
  }

  const response: StopTransactionResponse = {};
  if (idTag) {
    response.idTagInfo = { status: 'Accepted' };
  }
  return response;
}
