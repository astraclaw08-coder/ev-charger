#!/usr/bin/env npx tsx
/**
 * Backfill UptimeDaily for all chargers from their creation date to today.
 *
 * Usage: cd packages/api && npx tsx scripts/backfill-uptime.ts
 */
import 'dotenv/config';
import { prisma } from '@ev-charger/shared';
import { backfillUptimeDaily } from '../src/workers/uptimeMaterializer';

async function main() {
  const chargers = await prisma.charger.findMany({
    select: { id: true, ocppId: true, createdAt: true },
  });

  console.log(`[Backfill] Found ${chargers.length} charger(s)`);
  const now = new Date();

  for (const charger of chargers) {
    const from = charger.createdAt;
    console.log(`[Backfill] ${charger.ocppId} (${charger.id}): ${from.toISOString().slice(0, 10)} → ${now.toISOString().slice(0, 10)}`);
    try {
      await backfillUptimeDaily(charger.id, from, now);
      console.log(`[Backfill] ${charger.ocppId}: done`);
    } catch (err) {
      console.error(`[Backfill] ${charger.ocppId}: FAILED`, err);
    }
  }

  // Verify results
  const count = await prisma.uptimeDaily.count();
  console.log(`\n[Backfill] Total UptimeDaily rows: ${count}`);

  // Show summary for charger 1A32
  const summary = await prisma.uptimeDaily.findMany({
    where: { chargerId: 'charger-1A32-1-2010-00008' },
    orderBy: { date: 'desc' },
    take: 5,
  });
  if (summary.length) {
    console.log('\n[Backfill] Recent UptimeDaily for 1A32:');
    for (const row of summary) {
      console.log(`  ${row.date.toISOString().slice(0, 10)}: ${row.uptimePercent}% (avail=${row.availableSeconds}s, outage=${row.outageSeconds}s, total=${row.totalSeconds}s)`);
    }
  }

  // 30d aggregate
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);
  const rows30d = await prisma.uptimeDaily.findMany({
    where: {
      chargerId: 'charger-1A32-1-2010-00008',
      date: { gte: thirtyDaysAgo },
    },
  });
  if (rows30d.length) {
    const total = rows30d.reduce((s, r) => s + r.totalSeconds, 0);
    const avail = rows30d.reduce((s, r) => s + r.availableSeconds, 0);
    const outage = rows30d.reduce((s, r) => s + r.outageSeconds, 0);
    const excluded = rows30d.reduce((s, r) => s + r.excludedOutageSeconds, 0);
    const pct = total > 0 ? ((total - Math.max(0, outage - excluded)) / total) * 100 : 0;
    console.log(`\n[Backfill] 1A32 30-day aggregate: ${pct.toFixed(2)}% uptime`);
    console.log(`  available=${avail}s (${(avail / 3600).toFixed(1)}h), outage=${outage}s (${(outage / 3600).toFixed(1)}h), total=${total}s (${(total / 86400).toFixed(1)}d)`);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('[Backfill] Fatal error:', err);
  process.exit(1);
});
