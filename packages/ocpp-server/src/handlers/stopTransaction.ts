import { prisma, splitTouDuration, captureSessionBillingSnapshot } from '@ev-charger/shared';
import { enqueueOcppEvent } from '../outbox';
import type { StopTransactionRequest, StopTransactionResponse } from '@ev-charger/shared';
import { clearPriorEnergy } from '../fleet/priorEnergyState';
import { computePreDeliveryGatedMinutes } from '../fleet/preDeliveryGatedMinutes';
import { onSessionEnd as fleetSchedulerOnSessionEnd } from '../fleet/fleetScheduler';

// Flag read at call-time so tests and runtime env changes are honored.
function fleetFlagEnabled(): boolean {
  return process.env.FLEET_GATED_SESSIONS_ENABLED === 'true';
}


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

/**
 * Fire-and-forget POST to API internal receipt endpoint.
 * Uses native fetch — no additional dependencies required.
 */
function triggerReceiptEmail(sessionId: string): void {
  const apiUrl = process.env.API_INTERNAL_URL || 'http://localhost:3001';
  const internalToken = process.env.INTERNAL_API_TOKEN;

  if (!internalToken) {
    console.log(`[Receipt] skipped: INTERNAL_API_TOKEN not configured sessionId=${sessionId}`);
    return;
  }

  fetch(`${apiUrl}/internal/sessions/${sessionId}/send-receipt`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Token': internalToken,
    },
  })
    .then(async (res) => {
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error(`[Receipt] API responded ${res.status} sessionId=${sessionId}: ${text}`);
      }
    })
    .catch((err) => {
      console.error(`[Receipt] failed to reach API sessionId=${sessionId}:`, err.message || err);
    });
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
                  timeZone: true,
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

  // Detect relative vs absolute Transaction.End.
  // Some chargers report Transaction.End as a session-relative offset (energy delivered)
  // rather than the absolute meter register. If the value is far below meterStart,
  // convert to absolute by adding to meterStart.
  let resolvedEndWh = transactionEndWh;
  if (resolvedEndWh != null && session.meterStart != null && resolvedEndWh < session.meterStart * 0.5) {
    console.log(`[StopTransaction] Detected relative Transaction.End: ${resolvedEndWh}Wh → absolute: ${session.meterStart + resolvedEndWh}Wh`);
    resolvedEndWh = session.meterStart + resolvedEndWh;
  }

  // Fallback precedence for persisted meterStop: resolved Transaction.End > latest MeterValues > StopTransaction.meterStop.
  const finalMeterStop = resolvedEndWh ?? Math.max(meterStop, session.meterStop ?? meterStop);

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
    pricingMode: site?.pricingMode,
    defaultPricePerKwhUsd: site?.pricePerKwhUsd,
    defaultIdleFeePerMinUsd: site?.idleFeePerMinUsd,
    touWindows: site?.touWindows,
    timeZone: site?.timeZone ?? 'America/Los_Angeles',
  });
  const totalSegmentMinutes = durationSegments.reduce((sum, seg) => sum + seg.minutes, 0);
  const weightedRatePerKwh =
    totalSegmentMinutes > 0
      ? durationSegments.reduce((sum, seg) => sum + (seg.minutes / totalSegmentMinutes) * seg.pricePerKwhUsd, 0)
      : (session.ratePerKwh ?? site?.pricePerKwhUsd ?? 0);
  const estimatedEnergyAmountUsd = kwhDelivered * weightedRatePerKwh;

  await prisma.$transaction(async (tx: any) => {
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
    const prevConnectorStatus = session.connector.status;
    await tx.connector.update({
      where: { id: session.connector.id },
      data: { status: 'AVAILABLE' },
    });

    // Record PLUG_OUT transition so the API can synthesise lastPlugOutAt.
    // Without this, the subsequent StatusNotification(Available) is often a
    // no-op (prev === next) because we just set the connector to AVAILABLE
    // above, so the transition record would never be written.
    const PLUGGED_STATES = ['CHARGING', 'FINISHING', 'SUSPENDED_EV', 'SUSPENDED_EVSE'];
    if (PLUGGED_STATES.includes(prevConnectorStatus)) {
      const stopTs = new Date(timestamp);
      const occurredAt = Number.isFinite(stopTs.getTime()) ? stopTs : new Date();
      await tx.connectorStateTransition.create({
        data: {
          chargerId,
          connectorRefId: session.connector.id,
          connectorId: session.connector.connectorId,
          fromStatus: prevConnectorStatus,
          toStatus: 'AVAILABLE',
          transitionType: 'PLUG_OUT',
          occurredAt,
          payloadTs: Number.isFinite(stopTs.getTime()) ? stopTs : null,
        },
      });
    }

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
  let snapshotCaptured = false;
  try {
    await captureSessionBillingSnapshot(session.id);
    snapshotCaptured = true;
  } catch (snapErr) {
    console.error('[BillingSnapshot] Failed to capture snapshot on StopTransaction:', snapErr);
  }

  // ── Fleet-observation snapshot fields (TASK-0208 Phase 2 PR-c) ────────
  // Observation-only: if this session carried a fleet policy, stash the
  // pre-delivery gated minutes and mark the snapshot as fleet-gated. Both
  // columns already exist on SessionBillingSnapshot (Phase 1 additive
  // migration). Any failure here is non-fatal — we must not roll back
  // StopTransaction for an observation write.
  //
  // `gatedPricingMode` is the literal string `'gated'` when the session
  // was fleet-linked, else left null. It does NOT mirror site.pricingMode.
  // The final vocabulary (`'gated-free' | 'gated-flat' | 'gated-tou'` etc.)
  // is still open — see tasks/task-0208-phase2-design-note.md Q2. Until
  // that's resolved, `'gated'` is the minimal marker value.
  if (snapshotCaptured && fleetFlagEnabled() && session.fleetPolicyId && session.plugInAt) {
    try {
      // Re-read session to pick up firstEnergyAt written by MeterValues.
      const fresh = await prisma.session.findUnique({
        where: { id: session.id },
        select: { firstEnergyAt: true },
      });
      const firstEnergyAt = fresh?.firstEnergyAt ?? null;
      const preDeliveryGatedMinutes = computePreDeliveryGatedMinutes(session.plugInAt, firstEnergyAt);
      const gatedPricingMode: string = 'gated';

      await prisma.sessionBillingSnapshot.update({
        where: { sessionId: session.id },
        data: {
          ...(preDeliveryGatedMinutes != null ? { preDeliveryGatedMinutes } : {}),
          gatedPricingMode,
        },
      });
      console.log(
        `[StopTransaction] fleet observation written sessionId=${session.id} policy=${session.fleetPolicyId} preDeliveryGatedMinutes=${preDeliveryGatedMinutes?.toFixed(2) ?? 'n/a'} gatedPricingMode=${gatedPricingMode}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[StopTransaction] fleet observation snapshot update failed (non-fatal): sessionId=${session.id} err=${msg}`,
      );
    }
  }

  // Always clear any in-memory prior-energy state for this session —
  // idempotent, safe whether flag is on/off or entry was ever written.
  clearPriorEnergy(session.id);

  // Fleet scheduler cleanup (TASK-0208 Phase 2 PR-d). Flag-gated and
  // non-fatal. Clears the per-charger edge timer; the next reconcile tick
  // will re-evaluate remaining fleet sessions on this charger.
  if (fleetFlagEnabled() && session.fleetPolicyId) {
    try {
      fleetSchedulerOnSessionEnd(chargerId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[StopTransaction] fleet scheduler onSessionEnd failed (non-fatal): sessionId=${session.id} chargerId=${chargerId} fleetPolicyId=${session.fleetPolicyId} err=${msg}`,
      );
    }
  }

  // Trigger receipt email via API — fire-and-forget, never blocks session completion
  if (snapshotCaptured) {
    triggerReceiptEmail(session.id);
  }

  const response: StopTransactionResponse = {};
  if (idTag) {
    response.idTagInfo = { status: 'Accepted' };
  }
  return response;
}
