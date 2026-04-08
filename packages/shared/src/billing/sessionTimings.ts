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

export type IdleWindow = {
  startedAt: string;
  stoppedAt: string;
};

export type SessionTimings = {
  idleStartedAt?: string;
  idleStoppedAt?: string;
  idleWindows: IdleWindow[];
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
  if (!chargerId || !connectorId || !session.startedAt) return { idleWindows: [] };

  const sessionStart = new Date(session.startedAt);
  if (!Number.isFinite(sessionStart.getTime())) return { idleWindows: [] };

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
    return { idleWindows: [], plugInAt: sessionStart.toISOString() };
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

  // ── Multi-window idle detection ──────────────────────────────────────────
  // Collect all idle windows: a window starts at CHARGING → SUSPENDED/FINISHING
  // and ends at the next genuine CHARGING (≥60s) or AVAILABLE/session end.
  // Brief charging bursts (<60s between SUSPENDED states) are absorbed as noise.
  const MIN_CHARGE_MS = 60_000;

  const rawIdleWindows: Array<{ startAt: Date; endAt: Date }> = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.at.getTime() < sessionStart.getTime()) continue;
    if (e.prevStatus !== 'CHARGING') continue;
    if (e.status !== 'SUSPENDED_EV' && e.status !== 'SUSPENDED_EVSE' && e.status !== 'FINISHING') continue;

    const startAt = e.at;
    let endAt: Date | null = null;

    for (let j = i + 1; j < events.length; j++) {
      if (events[j].status === 'CHARGING') {
        endAt = events[j].at;
        break;
      }
      if (events[j].status === 'AVAILABLE'
        && !!events[j].prevStatus
        && new Set(['FINISHING', 'SUSPENDED_EV', 'SUSPENDED_EVSE']).has(events[j].prevStatus!)) {
        endAt = events[j].at;
        break;
      }
    }
    if (!endAt) endAt = plugOut?.at ?? sessionStop ?? null;
    if (endAt && endAt.getTime() > startAt.getTime()) {
      rawIdleWindows.push({ startAt, endAt });
    }
  }

  // Merge windows separated by charging bursts shorter than MIN_CHARGE_MS (noise)
  const mergedWindows: Array<{ startAt: Date; endAt: Date }> = [];
  for (const w of rawIdleWindows) {
    const prev = mergedWindows[mergedWindows.length - 1];
    if (prev && (w.startAt.getTime() - prev.endAt.getTime()) < MIN_CHARGE_MS) {
      prev.endAt = w.endAt; // absorb noise burst
    } else {
      mergedWindows.push({ startAt: new Date(w.startAt), endAt: new Date(w.endAt) });
    }
  }

  const idleWindows: IdleWindow[] = mergedWindows.map((w) => ({
    startedAt: w.startAt.toISOString(),
    stoppedAt: w.endAt.toISOString(),
  }));

  return {
    idleStartedAt: idleWindows.length > 0 ? idleWindows[0].startedAt : undefined,
    idleStoppedAt: idleWindows.length > 0 ? idleWindows[idleWindows.length - 1].stoppedAt : undefined,
    idleWindows,
    plugInAt: plugIn?.at?.toISOString() ?? sessionStart.toISOString(),
    plugOutAt: plugOut?.at?.toISOString(),
  };
}
