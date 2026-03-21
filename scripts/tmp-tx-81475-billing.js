const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const s = await prisma.session.findFirst({ where: { transactionId: 81475 }, select: { id: true, billingBreakdown: true, stoppedAt: true, startedAt: true } });
  if (!s) return console.log('NO_SESSION');
  console.log(JSON.stringify({
    id: s.id,
    startedAt: s.startedAt,
    stoppedAt: s.stoppedAt,
    pricingMode: s.billingBreakdown?.pricingMode,
    gracePeriodMin: s.billingBreakdown?.gracePeriodMin,
    idleMinutes: s.billingBreakdown?.idle?.minutes,
    idleTotalUsd: s.billingBreakdown?.idle?.totalUsd,
    idleSegments: s.billingBreakdown?.idle?.segments,
  }, null, 2));
})();