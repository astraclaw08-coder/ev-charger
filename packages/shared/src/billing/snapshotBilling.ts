/**
 * SessionBillingSnapshot — immutable billing record captured at session completion.
 *
 * Data integrity rules:
 * - Captured once on StopTransaction (OCPP) or session close (API)
 * - Snapshot locks: pricing inputs, TOU windows, timezone, computed amounts, timings
 * - NEVER overwritten when payment.status is CAPTURED or REFUNDED
 * - May be re-captured programmatically for error correction (non-final payments only)
 * - API routes serve from snapshot when present, fall back to compute-on-read for active sessions
 */
import { prisma } from '../db';
import { splitTouDuration } from '../touPricing';
import { computeSessionAmounts, computeDeliveredKwh, deriveChargingWindows } from './sessionBilling';
import { extractMeterReadings, interpolateMeterAtBoundaries, computeSegmentKwh } from './meterInterpolation';
import { resolveSessionStatusTimings } from './sessionTimings';

const FINAL_STATUSES = new Set(['CAPTURED', 'REFUNDED']);

/**
 * Capture or refresh a billing snapshot for a session.
 *
 * - Skips if payment is CAPTURED/REFUNDED (locked forever)
 * - Upserts otherwise — safe to call multiple times (idempotent for same billing state)
 */
export async function captureSessionBillingSnapshot(sessionId: string): Promise<boolean> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: {
      payment: { select: { status: true, amountCents: true } },
      billingSnapshot: { select: { id: true } },
      connector: {
        include: {
          charger: {
            include: {
              site: {
                select: {
                  pricingMode: true,
                  pricePerKwhUsd: true,
                  idleFeePerMinUsd: true,
                  activationFeeUsd: true,
                  gracePeriodMin: true,
                  touWindows: true,
                  softwareVendorFeeMode: true,
                  softwareVendorFeeValue: true,
                  softwareFeeIncludesActivation: true,
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
    console.warn(`[BillingSnapshot] Session not found: ${sessionId}`);
    return false;
  }

  // Immutability guard — never overwrite a finalised payment
  if (session.billingSnapshot && session.payment && FINAL_STATUSES.has(session.payment.status)) {
    console.log(`[BillingSnapshot] Skipping — payment finalised (${session.payment.status}) for session ${sessionId}`);
    return false;
  }

  const site = session.connector.charger.site;
  if (!site) {
    console.log(`[BillingSnapshot] Skipping — charger is not assigned to any site for session ${sessionId}`);
    return false;
  }
  const chargerId = session.connector.charger.id;

  // Fetch status logs for idle/plugOut timing
  const statusLogs = await prisma.ocppLog.findMany({
    where: {
      chargerId,
      action: 'StatusNotification',
      createdAt: {
        gte: new Date(session.startedAt.getTime() - 24 * 60 * 60_000),
        lte: new Date((session.stoppedAt?.getTime() ?? Date.now()) + 2 * 60 * 60_000),
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 10_000,
  });

  const timings = resolveSessionStatusTimings(
    session,
    statusLogs.map((l: { chargerId: string; createdAt: Date; payload: unknown }) => ({ chargerId: l.chargerId, createdAt: l.createdAt, payload: l.payload })),
  );

  // Energy billing uses session.stoppedAt — meter interpolation distributes
  // kWh accurately regardless of idle gaps. Idle is billed separately per window.
  const energyStop = session.stoppedAt;

  const siteTimeZone = site.timeZone ?? 'America/Los_Angeles';

  // ── Meter-based energy split across TOU segments ──────────────────────
  // Query MeterValues logs to interpolate the energy register at TOU window
  // boundaries, producing per-segment kWh that reflects actual power draw
  // rather than time-proportional allocation.
  // Charging windows exclude idle gaps so boundaries match actual charge periods.
  let segmentKwhOverrides: number[] | null = null;
  try {
    const meterLogs = await prisma.ocppLog.findMany({
      where: {
        chargerId,
        action: 'MeterValues',
        createdAt: {
          gte: session.startedAt,
          lte: energyStop ?? new Date(),
        },
      },
      orderBy: { createdAt: 'asc' },
      select: { payload: true, createdAt: true },
    });

    const meterReadings = extractMeterReadings(meterLogs);

    if (meterReadings.length >= 2 && energyStop) {
      // Derive charging windows (session span minus idle) then TOU-split each
      const chargingWindows = deriveChargingWindows(
        session.startedAt,
        energyStop,
        timings.idleWindows,
      );

      const chargingSegments: Array<{ startedAt: string; endedAt: string }> = [];
      for (const cw of chargingWindows) {
        const windowSegs = splitTouDuration({
          startedAt: cw.startedAt,
          stoppedAt: cw.stoppedAt,
          pricingMode: site.pricingMode,
          defaultPricePerKwhUsd: site.pricePerKwhUsd,
          defaultIdleFeePerMinUsd: site.idleFeePerMinUsd,
          touWindows: site.touWindows,
          timeZone: siteTimeZone,
        });
        chargingSegments.push(...windowSegs);
      }

      if (chargingSegments.length > 1) {
        const boundaries = [
          new Date(chargingSegments[0].startedAt),
          ...chargingSegments.map((s) => new Date(s.endedAt)),
        ];
        const boundaryWh = interpolateMeterAtBoundaries(meterReadings, boundaries);
        const totalKwh = computeDeliveredKwh(session) ?? 0;
        segmentKwhOverrides = computeSegmentKwh(boundaryWh, totalKwh);
      }
    }
  } catch (err) {
    console.warn(`[BillingSnapshot] Meter interpolation failed for session ${sessionId}, falling back to time-proportional:`, err);
  }

  const amounts = computeSessionAmounts({
    ...session,
    startedAt: session.startedAt,
    stoppedAt: energyStop,
    pricingMode: site.pricingMode,
    pricePerKwhUsd: site.pricePerKwhUsd,
    idleFeePerMinUsd: site.idleFeePerMinUsd,
    activationFeeUsd: site.activationFeeUsd,
    gracePeriodMin: site.gracePeriodMin,
    touWindows: site.touWindows,
    siteTimeZone,
    softwareVendorFeeMode: site.softwareVendorFeeMode,
    softwareVendorFeeValue: site.softwareVendorFeeValue,
    softwareFeeIncludesActivation: site.softwareFeeIncludesActivation,
    idleStartedAt: timings.idleStartedAt,
    idleStoppedAt: timings.idleStoppedAt,
    idleWindows: timings.idleWindows,
    segmentKwhOverrides,
  });

  const b = amounts.billingBreakdown;

  const snapshotData = {
    // Locked pricing inputs
    pricingMode: site.pricingMode,
    pricePerKwhUsd: site.pricePerKwhUsd,
    idleFeePerMinUsd: site.idleFeePerMinUsd,
    activationFeeUsd: site.activationFeeUsd,
    gracePeriodMin: site.gracePeriodMin,
    touWindowsJson: site.touWindows ?? undefined,
    siteTimeZone,
    // Computed outputs
    kwhDelivered: amounts.kwhDelivered ?? undefined,
    durationMinutes: amounts.durationMinutes ?? undefined,
    energyAmountUsd: b.energy.totalUsd,
    idleAmountUsd: b.idle.totalUsd,
    activationAmountUsd: b.activation.totalUsd,
    grossAmountUsd: b.grossTotalUsd,
    vendorFeeUsd: amounts.vendorFeeUsd,
    netAmountUsd: (amounts.effectiveAmountCents ?? 0) / 100,
    billingBreakdownJson: { ...amounts.billingBreakdown, idleWindows: timings.idleWindows } as object,
    // Locked timings
    chargingStartedAt: session.startedAt,
    chargingStoppedAt: energyStop ?? undefined,
    idleStartedAt: timings.idleStartedAt ? new Date(timings.idleStartedAt) : undefined,
    idleStoppedAt: timings.idleStoppedAt ? new Date(timings.idleStoppedAt) : undefined,
    plugOutAt: timings.plugOutAt ? new Date(timings.plugOutAt) : undefined,
  };

  await prisma.sessionBillingSnapshot.upsert({
    where: { sessionId },
    create: { sessionId, ...snapshotData },
    update: snapshotData,
  });

  console.log(`[BillingSnapshot] Captured session ${sessionId} (tx:${session.transactionId}) — gross: $${b.grossTotalUsd.toFixed(2)}`);
  return true;
}

/**
 * Backfill billing snapshots for all completed sessions that don't have one yet.
 * Safe to run multiple times — skips sessions that already have a snapshot.
 */
export async function backfillBillingSnapshots(opts?: { dryRun?: boolean; force?: boolean }): Promise<{ processed: number; errors: number }> {
  const dryRun = opts?.dryRun ?? true;
  const force = opts?.force ?? false;
  console.log(`[BillingSnapshot] Backfill starting (${dryRun ? 'DRY RUN' : 'WRITE'}${force ? ', FORCE recapture' : ''})...`);

  const sessions = await prisma.session.findMany({
    where: {
      status: 'COMPLETED',
      // force=true: recapture all non-final sessions; false: only sessions without a snapshot
      ...(force ? {} : { billingSnapshot: null }),
      NOT: { payment: { status: { in: ['CAPTURED', 'REFUNDED'] } } },
    },
    select: { id: true, transactionId: true },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`Found ${sessions.length} completed sessions to process.`);
  let processed = 0;
  let errors = 0;

  for (const s of sessions) {
    if (dryRun) {
      console.log(`  [dry-run] would snapshot session ${s.id} (tx:${s.transactionId})`);
      processed++;
      continue;
    }
    try {
      await captureSessionBillingSnapshot(s.id);
      processed++;
    } catch (err) {
      console.error(`  ERROR tx:${s.transactionId}:`, err);
      errors++;
    }
  }

  console.log(`\nDone. Processed: ${processed} | Errors: ${errors}`);
  return { processed, errors };
}
