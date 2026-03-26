const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const s = await prisma.session.findFirst({
    where: { transactionId: 81475 },
    select: {
      id: true,
      startedAt: true,
      stoppedAt: true,
      sessionFact: {
        select: {
          totalKwh: true,
          grossRevenueUsd: true,
          idleMinutes: true,
          idleFeeUsd: true,
          amountState: true,
          estimatedAmountCents: true,
          effectiveAmountCents: true,
          sourceVersion: true,
        },
      },
    },
  });
  console.log(JSON.stringify(s, null, 2));
})();