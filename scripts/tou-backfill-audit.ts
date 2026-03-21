/**
 * TOU Backfill Audit
 * Understand what's persisted vs computed for TOU sessions before any backfill.
 */
import { prisma } from '../packages/shared/src/db';

async function main() {
  // TOU sites
  const sites = await prisma.site.findMany({
    where: { pricingMode: 'tou' },
    select: { id: true, name: true, touWindows: true, pricePerKwhUsd: true, idleFeePerMinUsd: true, gracePeriodMin: true, activationFeeUsd: true },
  });
  console.log(`TOU sites: ${sites.length}`);
  sites.forEach(s => console.log(`  - ${s.name} (${s.id})`));

  const siteIds = sites.map(s => s.id);

  // Session counts
  const total = await prisma.session.count({ where: { connector: { charger: { siteId: { in: siteIds } } }, status: 'COMPLETED' } });
  const withPayment = await prisma.session.count({ where: { connector: { charger: { siteId: { in: siteIds } } }, status: 'COMPLETED', payment: { isNot: null } } });
  const withFinalPayment = await prisma.session.count({ where: { connector: { charger: { siteId: { in: siteIds } } }, status: 'COMPLETED', payment: { status: { in: ['CAPTURED', 'REFUNDED'] } } } });
  console.log(`\nCOMPLETED TOU sessions: ${total}`);
  console.log(`  with any payment:   ${withPayment}`);
  console.log(`  with FINAL payment: ${withFinalPayment} (amountCents already locked — skip these)`);

  // SessionFact — check if revenueUsd is stored
  const facts = await prisma.sessionFact.findMany({
    where: { siteId: { in: siteIds } },
    select: { id: true, sessionId: true, revenueUsd: true, energyKwh: true, status: true },
    take: 5,
  });
  console.log(`\nSample SessionFacts (${facts.length}):`);
  facts.forEach(f => console.log(`  sessionId: ${f.sessionId} | revenueUsd: ${f.revenueUsd} | energyKwh: ${f.energyKwh} | status: ${f.status}`));

  // Sample sessions
  const sample = await prisma.session.findMany({
    where: { connector: { charger: { siteId: { in: siteIds } } }, status: 'COMPLETED' },
    select: {
      id: true, transactionId: true, startedAt: true, stoppedAt: true,
      kwhDelivered: true, meterStart: true, meterStop: true,
      payment: { select: { status: true, amountCents: true } },
      connector: { include: { charger: { select: { siteId: true } } } },
    },
    orderBy: { startedAt: 'desc' },
    take: 10,
  });
  console.log('\nSample sessions:');
  sample.forEach(s => console.log(
    `  tx:${s.transactionId} | kwh:${s.kwhDelivered} | pay:${s.payment?.status ?? 'none'} | amt:${s.payment?.amountCents ?? 'none'}`
  ));

  await prisma.$disconnect();
}

main().catch(console.error);
