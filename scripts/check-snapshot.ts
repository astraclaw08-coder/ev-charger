import { prisma } from '../packages/shared/src/db';
(async () => {
  const snap = await prisma.sessionBillingSnapshot.findFirst({ where: { session: { transactionId: 74426 } }, select: { idleStartedAt: true, idleStoppedAt: true, chargingStoppedAt: true, plugOutAt: true, chargingStartedAt: true, kwhDelivered: true, energyAmountUsd: true, idleAmountUsd: true, grossAmountUsd: true } });
  console.log(JSON.stringify(snap, null, 2));
  await prisma.$disconnect();
})();
