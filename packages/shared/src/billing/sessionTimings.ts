/**
 * Shared session status/timing resolver.
 * Used by both the API routes and snapshot capture to derive idle/plugOut timings
 * from OCPP StatusNotification logs.
 */

export type StatusLogLike = {
  chargerId: string;
  createdAt: Date;
  payload: unknown;
};

export type SessionLikeForIdle = {
  startedAt?: Date | string | null;
  stoppedAt?: Date | string | null;
  connector?: { connectorId?: number | null; charger?: { id?: string | null } } | null;
};

export type SessionTimings = {
  idleStartedAt?: string;
  idleStoppedAt?: string;
  plugInAt?: string;
  plugOutAt?: string;
};

function parseConnectorStatus(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/[-\s]/g, '_').toUpperCase();
  const map: Record<string, string> = {
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

function extractStatusEvent(log: StatusLogLike): { connectorId: number; status: string; at: Date } | null {
  if (!log.payload || typeof log.payload !== 'object') return null;
  const payload = log.payload as { connectorId?: number | string; status?: string; timestamp?: string };
  const connectorId = Number(payload.connectorId);
  const status = parseConnectorStatus(payload.status);
  if (!Number.isInteger(connectorId) || connectorId <= 0 || !status) return null;

  const timestamp = payload.timestamp ? new Date(payload.timestamp) : null;
  const at = timestamp && Number.isFinite(timestamp.getTime()) ? timestamp : log.createdAt;
  return { connectorId, status, at };
}

export function resolveSessionStatusTimings(
  session: SessionLikeForIdle,
  statusLogsForCharger: StatusLogLike[],
): SessionTimings {
  const chargerId = session.connector?.charger?.id;
  const connectorId = session.connector?.connectorId;
  if (!chargerId || !connectorId || !session.startedAt) return {};

  const sessionStart = new Date(session.startedAt);
  if (!Number.isFinite(sessionStart.getTime())) return {};

  const sessionStop = session.stoppedAt ? new Date(session.stoppedAt) : null;
  const lookbackMs = 24 * 60 * 60 * 1000;
  const hardStartMs = sessionStart.getTime() - lookbackMs;
  const hardEndMs = sessionStop && Number.isFinite(sessionStop.getTime())
    ? sessionStop.getTime() + (2 * 60 * 60 * 1000)
    : Date.now() + (2 * 60 * 60 * 1000);

  const baseEvents = statusLogsForCharger
    .map(extractStatusEvent)
    .filter((e): e is { connectorId: number; status: string; at: Date } => Boolean(e))
    .filter((e) => e.connectorId === connectorId)
    .filter((e) => {
      const atMs = e.at.getTime();
      return atMs >= hardStartMs && atMs <= hardEndMs;
    })
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  if (baseEvents.length === 0) {
    return { plugInAt: sessionStart.toISOString() };
  }

  const events = baseEvents.map((e, idx) => ({
    ...e,
    prevStatus: idx > 0 ? baseEvents[idx - 1].status : null as string | null,
  }));

  // plugIn: last PREPARING event before session start, preceded by AVAILABLE
  const plugInCandidates = events.filter((e) =>
    e.prevStatus === 'AVAILABLE'
    && e.status === 'PREPARING'
    && e.at.getTime() <= sessionStart.getTime(),
  );
  const preparingCandidates = events.filter((e) =>
    e.status === 'PREPARING'
    && e.at.getTime() <= sessionStart.getTime(),
  );
  const plugIn = plugInCandidates.length > 0
    ? plugInCandidates[plugInCandidates.length - 1]
    : (preparingCandidates.length > 0 ? preparingCandidates[preparingCandidates.length - 1] : null);

  // plugOut: first AVAILABLE after a FINISHING/SUSPENDED state, at or after session stop
  const plugOutCandidates = events.filter((e) =>
    e.status === 'AVAILABLE'
    && !!e.prevStatus
    && new Set(['FINISHING', 'SUSPENDED_EV', 'SUSPENDED_EVSE']).has(e.prevStatus)
    && (!sessionStop || e.at.getTime() >= sessionStop.getTime()),
  );
  const plugOut = plugOutCandidates.length > 0
    ? plugOutCandidates[0]
    : events.find((e) =>
      e.status === 'AVAILABLE'
      && !!e.prevStatus
      && new Set(['FINISHING', 'SUSPENDED_EV', 'SUSPENDED_EVSE']).has(e.prevStatus),
    );

  // idleStart: LAST CHARGING → SUSPENDED_EV/EVSE (primary) or CHARGING → FINISHING (fallback)
  // Uses the last transition (not first) so brief charging resumptions after
  // an initial suspend are included in the charging window, not the idle window.
  const idleStart = events.filter((e) =>
    e.at.getTime() >= sessionStart.getTime()
    && e.prevStatus === 'CHARGING'
    && (e.status === 'SUSPENDED_EV' || e.status === 'SUSPENDED_EVSE'),
  ).pop() ?? events.filter((e) =>
    e.at.getTime() >= sessionStart.getTime()
    && e.prevStatus === 'CHARGING'
    && e.status === 'FINISHING',
  ).pop() ?? null;

  const idleEnd = idleStart
    ? events.find((e) =>
      e.at.getTime() > idleStart.at.getTime()
      && e.status === 'AVAILABLE'
      && (
        e.prevStatus === 'FINISHING'
        || e.prevStatus === 'SUSPENDED_EV'
        || e.prevStatus === 'SUSPENDED_EVSE'
      ),
    )
    : null;

  const resolvedIdleEnd = idleEnd?.at ?? plugOut?.at ?? sessionStop ?? null;

  return {
    idleStartedAt: idleStart?.at && resolvedIdleEnd && resolvedIdleEnd.getTime() > idleStart.at.getTime()
      ? idleStart.at.toISOString()
      : undefined,
    idleStoppedAt: idleStart?.at && resolvedIdleEnd && resolvedIdleEnd.getTime() > idleStart.at.getTime()
      ? resolvedIdleEnd.toISOString()
      : undefined,
    plugInAt: plugIn?.at?.toISOString() ?? sessionStart.toISOString(),
    plugOutAt: plugOut?.at?.toISOString(),
  };
}
