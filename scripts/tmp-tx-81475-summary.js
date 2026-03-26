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
      connector: { select: { connectorId: true, charger: { select: { id: true, ocppId: true } } } },
    },
  });
  if (!session) throw new Error('session not found');

  const end = new Date((session.stoppedAt ?? new Date()).getTime() + 60_000);
  const logs = await prisma.ocppLog.findMany({
    where: {
      chargerId: session.connector.charger.id,
      action: 'StatusNotification',
      createdAt: { gte: session.startedAt, lte: end },
      payload: { path: ['connectorId'], equals: session.connector.connectorId },
    },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true, payload: true },
  });

  const rows = logs.map((l) => ({ at: l.createdAt, status: l.payload?.status || 'UNKNOWN', errorCode: l.payload?.errorCode || '' }));
  const transitions = [];
  for (const r of rows) {
    if (!transitions.length || transitions[transitions.length - 1].status !== r.status || transitions[transitions.length - 1].errorCode !== r.errorCode) {
      transitions.push(r);
    }
  }

  const totals = new Map();
  for (let i = 0; i < rows.length - 1; i++) {
    const cur = rows[i];
    const next = rows[i + 1];
    const secs = Math.max(0, (next.at - cur.at) / 1000);
    totals.set(cur.status, (totals.get(cur.status) || 0) + secs);
  }

  console.log(JSON.stringify({
    transactionId: tx,
    startedAt: session.startedAt,
    stoppedAt: session.stoppedAt,
    ocppId: session.connector.charger.ocppId,
    connectorId: session.connector.connectorId,
  }, null, 2));

  console.log('\nTransitions (deduped):');
  for (const t of transitions) {
    console.log(`${t.at.toISOString()} | ${t.status} | ${t.errorCode}`);
  }

  console.log('\nStatus totals (seconds, raw by status stream):');
  for (const [status, secs] of [...totals.entries()].sort((a,b)=>b[1]-a[1])) {
    console.log(`${status}: ${secs.toFixed(1)}s`);
  }
})();
