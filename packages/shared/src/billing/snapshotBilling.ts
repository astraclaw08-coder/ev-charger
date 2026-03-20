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
import { computeSessionAmounts } from './sessionBilling';

type StatusLogLike = { chargerId: string; createdAt: Date; payload: unknown };

const FINAL_STATUSES = new Set(['CAPTURED', 'REFUNDED']);

/**
 * Inline idle/plugOut resolver — mirrors the logic in API routes.
 * Scoped to the session's connector and time window.
 */
function resolveSessionTimings(
  session: { startedAt: Date; stoppedAt: Date | null; connector?: { connectorId?: number | null } | null },
  statusLogs: StatusLogLike[],
): { plugOutAt: string | null; idleStartedAt: string | null; idleStoppedAt: string | null } {
  const connectorId = session.connector?.connectorId ?? null;
  const start = session.startedAt.getTime();
  const stop = session.stoppedAt?.getTime() ?? Date.now();

  const relevant = statusLogs
    .filter(l => {
      const p = l.payload as any;
      if (connectorId != null && p?.connectorId != null && Number(p.connectorId) !== Number(connectorId)) return false;
      const t = l.createdAt.getTime();
      return t >= start - 5 * 60_000 && t <= stop + 2 * 60 * 60_000;
    })
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  let plugOutAt: string | null = null;
  let idleStartedAt: string | null = null;
  let idleStoppedAt: string | null = null;

  for (const log of relevant) {
    const p = log.payload as any;
    const status = String(p?.status ?? '').toUpperCase();
    const t = log.createdAt.toISOString();
    if ((status === 'FINISHING' || status === 'SUSPENDEDEV' || status === 'SUSPENDEDEVSE') && !idleStartedAt) {
      idleStartedAt = t;
    }
    if (status === 'AVAILABLE' && log.createdAt.getTime() > start) {
      plugOutAt = t;
      idleStoppedAt = t;
    }
  }

  return { plugOutAt, idleStartedAt, idleStoppedAt };
}

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

  const timings = resolveSessionTimings(
    session,
    statusLogs.map(l => ({ chargerId: l.chargerId, createdAt: l.createdAt, payload: l.payload })),
  );

  const billingStop = timings.idleStartedAt
    ? new Date(timings.idleStartedAt)
    : timings.plugOutAt
      ? new Date(timings.plugOutAt)
      : session.stoppedAt;

  const amounts = computeSessionAmounts({
    ...session,
    startedAt: session.startedAt,
    stoppedAt: billingStop,
    pricingMode: site.pricingMode,
    pricePerKwhUsd: site.pricePerKwhUsd,
    idleFeePerMinUsd: site.idleFeePerMinUsd,
    activationFeeUsd: site.activationFeeUsd,
    gracePeriodMin: site.gracePeriodMin,
    touWindows: site.touWindows,
    softwareVendorFeeMode: site.softwareVendorFeeMode,
    softwareVendorFeeValue: site.softwareVendorFeeValue,
    softwareFeeIncludesActivation: site.softwareFeeIncludesActivation,
    idleStartedAt: timings.idleStartedAt,
    idleStoppedAt: timings.idleStoppedAt,
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
    // Computed outputs
    kwhDelivered: amounts.kwhDelivered ?? undefined,
    durationMinutes: amounts.durationMinutes ?? undefined,
    energyAmountUsd: b.energy.totalUsd,
    idleAmountUsd: b.idle.totalUsd,
    activationAmountUsd: b.activation.totalUsd,
    grossAmountUsd: b.grossTotalUsd,
    vendorFeeUsd: amounts.vendorFeeUsd,
    netAmountUsd: (amounts.effectiveAmountCents ?? 0) / 100,
    billingBreakdownJson: amounts.billingBreakdown as object,
    // Locked timings
    chargingStartedAt: session.startedAt,
    chargingStoppedAt: billingStop ?? undefined,
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
export async function backfillBillingSnapshots(opts?: { dryRun?: boolean }): Promise<{ processed: number; errors: number }> {
  const dryRun = opts?.dryRun ?? true;
  console.log(`[BillingSnapshot] Backfill starting (${dryRun ? 'DRY RUN' : 'WRITE'})...`);

  const sessions = await prisma.session.findMany({
    where: { status: 'COMPLETED', billingSnapshot: null },
    select: { id: true, transactionId: true },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`Found ${sessions.length} completed sessions without a snapshot.`);
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
