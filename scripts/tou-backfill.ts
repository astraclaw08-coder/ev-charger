/**
 * TOU Billing Backfill
 *
 * For all COMPLETED sessions on TOU sites with no FINAL payment:
 *  1. Recompute billingBreakdown using the current (fixed) TOU engine
 *  2. Print a dry-run summary
 *  3. If --write flag passed, update SessionFact.revenueUsd with the corrected gross amount
 *
 * Sessions with CAPTURED/REFUNDED payments are skipped (amounts already locked).
 *
 * Usage:
 *   npx ts-node scripts/tou-backfill.ts           # dry run (default)
 *   npx ts-node scripts/tou-backfill.ts --write   # apply updates
 */

import { prisma } from '../packages/shared/src/db';
import { computeSessionAmounts } from '../packages/api/src/lib/sessionBilling';

// Inline idle-window resolver — finds plugOut/idleStart from StatusNotification logs
type StatusLogLike = { chargerId: string; createdAt: Date; payload: unknown };
function resolveSessionStatusTimings(
  session: { startedAt: Date; stoppedAt: Date | null; connector?: { connectorId?: number } | null },
  statusLogs: StatusLogLike[],
): { plugInAt: string | null; plugOutAt: string | null; idleStartedAt: string | null; idleStoppedAt: string | null } {
  // Filter logs scoped to this session's time range + connector
  const connectorId = (session.connector as any)?.connectorId ?? null;
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
    if (status === 'FINISHING' || status === 'SUSPENDEDEV' || status === 'SUSPENDEDEVSE') {
      if (!idleStartedAt) idleStartedAt = t;
    }
    if (status === 'AVAILABLE' && log.createdAt.getTime() > start) {
      plugOutAt = t;
      idleStoppedAt = t;
    }
  }

  return { plugInAt: null, plugOutAt, idleStartedAt, idleStoppedAt };
}

const WRITE = process.argv.includes('--write');
const FINAL_STATUSES = new Set(['CAPTURED', 'REFUNDED']);

async function main() {
  console.log(`Mode: ${WRITE ? 'WRITE' : 'DRY RUN'}`);

  const sites = await prisma.site.findMany({
    where: { pricingMode: 'tou' },
    select: {
      id: true, name: true, pricingMode: true,
      pricePerKwhUsd: true, idleFeePerMinUsd: true,
      activationFeeUsd: true, gracePeriodMin: true,
      touWindows: true,
      softwareVendorFeeMode: true, softwareVendorFeeValue: true,
      softwareFeeIncludesActivation: true,
    },
  });

  const siteById = new Map(sites.map(s => [s.id, s]));
  const siteIds = sites.map(s => s.id);

  const sessions = await prisma.session.findMany({
    where: {
      connector: { charger: { siteId: { in: siteIds } } },
      status: 'COMPLETED',
      // Skip FINAL payments — amount already locked
      NOT: { payment: { status: { in: ['CAPTURED', 'REFUNDED'] } } },
    },
    include: {
      payment: { select: { status: true, amountCents: true } },
      connector: { include: { charger: { select: { id: true, siteId: true } } } },
    },
    orderBy: { startedAt: 'asc' },
  });

  console.log(`\nProcessing ${sessions.length} sessions across ${sites.length} TOU sites...\n`);

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const session of sessions) {
    const siteId = session.connector?.charger?.siteId;
    const site = siteId ? siteById.get(siteId) : null;
    if (!site) { skipped++; continue; }

    // Skip final payments (double-check)
    if (session.payment && FINAL_STATUSES.has(session.payment.status)) { skipped++; continue; }

    try {
      // Fetch status logs for idle window detection
      const chargerId = session.connector.charger.id;
      const statusLogs = await prisma.ocppLog.findMany({
        where: {
          chargerId,
          action: 'StatusNotification',
          createdAt: {
            gte: new Date(session.startedAt.getTime() - 24 * 60 * 60 * 1000),
            lte: new Date((session.stoppedAt?.getTime() ?? Date.now()) + 2 * 60 * 60 * 1000),
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 10000,
      });

      const timings = resolveSessionStatusTimings(
        session,
        statusLogs.map(l => ({ chargerId: l.chargerId, createdAt: l.createdAt, payload: l.payload })),
      );

      const billingStop = timings.idleStartedAt
        ? new Date(timings.idleStartedAt)
        : (timings.plugOutAt ? new Date(timings.plugOutAt) : session.stoppedAt);

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
      const energySegs = b.energy.segments.map(s => `$${s.pricePerKwhUsd}×${s.minutes.toFixed(0)}min`).join(', ');
      const idleSegs = b.idle.segments.map(s => `$${s.idleFeePerMinUsd}/min×${s.minutes.toFixed(0)}min`).join(', ');

      console.log(
        `tx:${session.transactionId?.toString().padEnd(8)} | kwh:${(amounts.kwhDelivered ?? 0).toFixed(3).padEnd(8)} ` +
        `| gross:$${b.grossTotalUsd.toFixed(2).padEnd(7)} | energy:[${energySegs}] | idle:[${idleSegs || 'none'}]`
      );

      // Update SessionFact.revenueUsd if it exists and differs
      const fact = await prisma.sessionFact.findUnique({ where: { sessionId: session.id }, select: { id: true, revenueUsd: true } });
      if (fact) {
        const newRevenue = b.grossTotalUsd;
        const oldRevenue = fact.revenueUsd ? Number(fact.revenueUsd) : null;
        const changed = oldRevenue === null || Math.abs(oldRevenue - newRevenue) > 0.001;
        if (changed && WRITE) {
          await prisma.sessionFact.update({
            where: { sessionId: session.id },
            data: { revenueUsd: newRevenue },
          });
          console.log(`  → updated SessionFact revenueUsd: ${oldRevenue} → ${newRevenue}`);
        } else if (changed) {
          console.log(`  → [dry-run] would update SessionFact revenueUsd: ${oldRevenue} → ${newRevenue}`);
        }
      }

      updated++;
    } catch (err) {
      console.error(`  ERROR tx:${session.transactionId}:`, err);
      errors++;
    }
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Processed: ${updated} | Skipped: ${skipped} | Errors: ${errors}`);
  if (!WRITE) console.log('\nRun with --write to apply SessionFact revenueUsd updates.');

  await prisma.$disconnect();
}

main().catch(console.error);
