const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const tx = 81475;
  const session = await prisma.session.findFirst({
    where: { transactionId: tx },
    select: {
      id: true,
      transactionId: true,
      startedAt: true,
      stoppedAt: true,
      connectorId: true,
      connector: {
        select: {
          connectorId: true,
          charger: { select: { id: true, ocppId: true, site: { select: { name: true } } } },
        },
      },
    },
  });

  if (!session) {
    console.log('NO_SESSION');
    return;
  }

  console.log(JSON.stringify({
    sessionId: session.id,
    transactionId: session.transactionId,
    startedAt: session.startedAt,
    stoppedAt: session.stoppedAt,
    chargerId: session.connector.charger.id,
    ocppId: session.connector.charger.ocppId,
    site: session.connector.charger.site.name,
    connectorId: session.connector.connectorId,
  }, null, 2));

  const t0 = new Date(new Date(session.startedAt).getTime() - 30 * 60 * 1000);
  const t1 = new Date((session.stoppedAt ? new Date(session.stoppedAt) : new Date()).getTime() + 60 * 60 * 1000);

  const logs = await prisma.ocppLog.findMany({
    where: {
      chargerId: session.connector.charger.id,
      createdAt: { gte: t0, lte: t1 },
      OR: [
        {
          action: 'StatusNotification',
          payload: { path: ['connectorId'], equals: session.connector.connectorId },
        },
        { action: 'StartTransaction' },
        { action: 'StopTransaction' },
      ],
    },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true, action: true, payload: true },
  });

  console.log(`LOG_COUNT ${logs.length}`);
  for (const l of logs) {
    const p = l.payload || {};
    if (l.action === 'StatusNotification') {
      console.log(`${l.createdAt.toISOString()} | StatusNotification | connectorId=${p.connectorId ?? ''} | status=${p.status ?? ''} | errorCode=${p.errorCode ?? ''}`);
      continue;
    }
    if (l.action === 'StartTransaction' || l.action === 'StopTransaction') {
      console.log(`${l.createdAt.toISOString()} | ${l.action} | tx=${p.transactionId ?? ''} | meter=${p.meterStart ?? p.meterStop ?? ''} | reason=${p.reason ?? ''}`);
    }
  }
})()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
