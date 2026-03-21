const { prisma } = require('../packages/shared/dist');

function normalizeStatus(v) {
  if (typeof v !== 'string') return null;
  const n = v.trim().replace(/[-\s]/g, '_').toUpperCase();
  const map = {
    AVAILABLE: 'AVAILABLE',
    PREPARING: 'PREPARING',
    CHARGING: 'CHARGING',
    FINISHING: 'FINISHING',
    SUSPENDEDEV: 'SUSPENDED_EV',
    SUSPENDED_EV: 'SUSPENDED_EV',
    SUSPENDEDEVSE: 'SUSPENDED_EVSE',
    SUSPENDED_EVSE: 'SUSPENDED_EVSE',
    RESERVED: 'RESERVED',
    UNAVAILABLE: 'UNAVAILABLE',
    FAULTED: 'FAULTED',
  };
  return map[n] ?? null;
}

function transitionType(fromStatus, toStatus) {
  if (fromStatus === 'AVAILABLE' && toStatus === 'PREPARING') return 'PLUG_IN';
  if ((fromStatus === 'FINISHING' || fromStatus === 'SUSPENDED_EV' || fromStatus === 'SUSPENDED_EVSE') && toStatus === 'AVAILABLE') return 'PLUG_OUT';
  if (fromStatus === 'CHARGING' && (toStatus === 'SUSPENDED_EV' || toStatus === 'SUSPENDED_EVSE' || toStatus === 'FINISHING')) return 'IDLE_START';
  if ((fromStatus === 'FINISHING' || fromStatus === 'SUSPENDED_EV' || fromStatus === 'SUSPENDED_EVSE') && toStatus === 'AVAILABLE') return 'IDLE_END';
  return 'STATUS_CHANGE';
}

(async () => {
  const charger = await prisma.charger.findFirst({ where: { ocppId: '1A32-1-2010-00008' }, include: { connectors: true } });
  if (!charger) throw new Error('charger not found');
  const connectorRef = new Map(charger.connectors.map((c) => [c.connectorId, c.id]));
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const logs = await prisma.ocppLog.findMany({
    where: { chargerId: charger.id, action: 'StatusNotification', createdAt: { gte: since } },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true, payload: true },
  });

  const byConnector = new Map();
  for (const row of logs) {
    const p = row.payload || {};
    if (typeof p !== 'object') continue;
    const connectorId = Number(p.connectorId);
    const status = normalizeStatus(p.status);
    if (!Number.isInteger(connectorId) || connectorId <= 0 || !status) continue;
    const at = p.timestamp ? new Date(p.timestamp) : row.createdAt;
    if (!Number.isFinite(at.getTime())) continue;
    const arr = byConnector.get(connectorId) || [];
    arr.push({ at, status, payloadTs: p.timestamp ? new Date(p.timestamp) : null });
    byConnector.set(connectorId, arr);
  }

  let created = 0;
  for (const [connectorId, events] of byConnector.entries()) {
    let prev = null;
    for (const e of events) {
      if (!prev) {
        prev = e;
        continue;
      }
      if (prev.status === e.status) {
        prev = e;
        continue;
      }

      const fromStatus = prev.status;
      const toStatus = e.status;
      const occurredAt = e.at;

      const existing = await prisma.connectorStateTransition.findFirst({
        where: {
          chargerId: charger.id,
          connectorId,
          fromStatus,
          toStatus,
          occurredAt: {
            gte: new Date(occurredAt.getTime() - 1000),
            lte: new Date(occurredAt.getTime() + 1000),
          },
        },
        select: { id: true },
      });

      if (!existing) {
        await prisma.connectorStateTransition.create({
          data: {
            chargerId: charger.id,
            connectorRefId: connectorRef.get(connectorId),
            connectorId,
            fromStatus,
            toStatus,
            transitionType: transitionType(fromStatus, toStatus),
            occurredAt,
            payloadTs: e.payloadTs,
          },
        });
        created += 1;
      }

      prev = e;
    }
  }

  console.log(JSON.stringify({ chargerId: charger.id, created }, null, 2));
  await prisma.$disconnect();
})();