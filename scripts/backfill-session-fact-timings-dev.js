const { prisma } = require('../packages/shared/dist');

function parseConnectorStatus(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/[-\s]/g, '_').toUpperCase();
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
  return map[normalized] ?? null;
}

function extractStatusEvent(log) {
  if (!log.payload || typeof log.payload !== 'object') return null;
  const payload = log.payload;
  const connectorId = Number(payload.connectorId);
  const status = parseConnectorStatus(payload.status);
  if (!Number.isInteger(connectorId) || connectorId <= 0 || !status) return null;

  const timestamp = payload.timestamp ? new Date(payload.timestamp) : null;
  const at = timestamp && Number.isFinite(timestamp.getTime()) ? timestamp : log.createdAt;
  return { connectorId, status, at };
}

function resolveSessionStatusTimings({ startedAt, stoppedAt, connectorId, statusLogs }) {
  if (!startedAt || !connectorId) return {};
  const sessionStart = new Date(startedAt);
  if (!Number.isFinite(sessionStart.getTime())) return {};

  const sessionStop = stoppedAt ? new Date(stoppedAt) : null;
  const lookbackMs = 24 * 60 * 60 * 1000;
  const hardStartMs = sessionStart.getTime() - lookbackMs;
  const hardEndMs = sessionStop && Number.isFinite(sessionStop.getTime())
    ? sessionStop.getTime() + (2 * 60 * 60 * 1000)
    : Date.now() + (2 * 60 * 60 * 1000);

  const baseEvents = statusLogs
    .map(extractStatusEvent)
    .filter(Boolean)
    .filter((e) => e.connectorId === connectorId)
    .filter((e) => {
      const atMs = e.at.getTime();
      return atMs >= hardStartMs && atMs <= hardEndMs;
    })
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  if (baseEvents.length === 0) {
    return { plugInAt: sessionStart.toISOString() };
  }

  const events = baseEvents.map((e, idx) => ({ ...e, prevStatus: idx > 0 ? baseEvents[idx - 1].status : null }));

  const plugInCandidates = events.filter((e) =>
    e.prevStatus === 'AVAILABLE' && e.status === 'PREPARING' && e.at.getTime() <= sessionStart.getTime(),
  );
  const preparingCandidates = events.filter((e) => e.status === 'PREPARING' && e.at.getTime() <= sessionStart.getTime());
  const plugIn = plugInCandidates.length > 0
    ? plugInCandidates[plugInCandidates.length - 1]
    : (preparingCandidates.length > 0 ? preparingCandidates[preparingCandidates.length - 1] : null);

  const plugOutCandidates = events.filter((e) =>
    e.status === 'AVAILABLE'
    && !!e.prevStatus
    && ['FINISHING', 'SUSPENDED_EV', 'SUSPENDED_EVSE'].includes(e.prevStatus)
    && (!sessionStop || e.at.getTime() >= sessionStop.getTime()),
  );
  const plugOut = plugOutCandidates.length > 0
    ? plugOutCandidates[0]
    : events.find((e) => e.status === 'AVAILABLE' && !!e.prevStatus && ['FINISHING', 'SUSPENDED_EV', 'SUSPENDED_EVSE'].includes(e.prevStatus));

  return {
    plugInAt: (plugIn?.at ?? sessionStart).toISOString(),
    plugOutAt: plugOut?.at?.toISOString(),
  };
}

(async () => {
  const rows = await prisma.sessionFact.findMany({
    include: {
      session: { select: { connector: { select: { connectorId: true } } } },
      charger: { select: { id: true } },
    },
  });

  const chargerIds = Array.from(new Set(rows.map((r) => r.chargerId)));
  const statusLogs = await prisma.ocppLog.findMany({
    where: { chargerId: { in: chargerIds }, action: 'StatusNotification' },
    orderBy: { createdAt: 'asc' },
  });

  const logsByCharger = new Map();
  for (const log of statusLogs) {
    const arr = logsByCharger.get(log.chargerId) || [];
    arr.push({ createdAt: log.createdAt, payload: log.payload });
    logsByCharger.set(log.chargerId, arr);
  }

  let updated = 0;
  for (const row of rows) {
    const timings = resolveSessionStatusTimings({
      startedAt: row.startedAt,
      stoppedAt: row.stoppedAt,
      connectorId: row.session?.connector?.connectorId,
      statusLogs: logsByCharger.get(row.chargerId) || [],
    });

    const nextStart = timings.plugInAt ? new Date(timings.plugInAt) : row.startedAt;
    const nextStop = timings.plugOutAt ? new Date(timings.plugOutAt) : row.stoppedAt;
    const nextDuration = nextStop ? Math.max(0, Math.round((nextStop.getTime() - nextStart.getTime()) / 60000)) : row.durationMinutes;

    const changed = Math.abs(nextStart.getTime() - row.startedAt.getTime()) > 1000
      || ((nextStop && row.stoppedAt) ? Math.abs(nextStop.getTime() - row.stoppedAt.getTime()) > 1000 : nextStop !== row.stoppedAt)
      || nextDuration !== row.durationMinutes;

    if (!changed) continue;

    await prisma.sessionFact.update({
      where: { id: row.id },
      data: {
        startedAt: nextStart,
        stoppedAt: nextStop,
        durationMinutes: nextDuration,
        sourceVersion: 'v1+timingfix-20260320',
      },
    });
    updated += 1;
  }

  console.log(JSON.stringify({ total: rows.length, updated }, null, 2));
  await prisma.$disconnect();
})();