/**
 * TASK-0198 Phase 1 — cross-message window detectors.
 *
 * The per-message extractor in chargerEventExtractor.ts only reasons about
 * a single OCPP message in isolation. Some maintenance signals require
 * looking across a *window* of messages on a charger:
 *
 *   HEARTBEAT_GAP            — gaps between consecutive Heartbeat messages
 *                              that exceed expected heartbeat interval +
 *                              tolerance, while no OFFLINE transition was
 *                              recorded
 *   FAULT_LOOP               — ≥ N STATUS_FAULT events on the same
 *                              connector within a time window (default
 *                              3 in 5 min)
 *   METER_ANOMALY            — energy register frozen across N consecutive
 *                              Sample.Periodic frames during Charging,
 *                              OR Current.Import persistently below
 *                              Current.Offered during Charging
 *   SESSION_STATE_MISMATCH   — Charging status was reported but no
 *                              MeterValues arrived for N seconds, OR an
 *                              Available status arrived while a Session
 *                              row remained ACTIVE (caller passes session
 *                              activity in)
 *
 * All detectors are pure functions — input is a typed window of normalised
 * facts (NOT raw OcppLog rows; the backfill script projects rows into the
 * input shapes). Output is the same `ExtractedChargerEvent` shape used by
 * the per-message extractor, so the writer (chargerEventLogger.ts) handles
 * persistence uniformly.
 *
 * Thresholds are exported as constants for selftest visibility and for an
 * env-tunable upgrade path later.
 */

import type {
  ChargerEventKind,
  ChargerEventSeverity,
  ExtractedChargerEvent,
} from './chargerEventExtractor';

// ─── Thresholds (v1 hardcoded; env-tunable in a later PR) ──────────────

/** Maximum tolerated gap between consecutive Heartbeats before we emit. */
export const HEARTBEAT_GAP_WARN_MS = 5 * 60_000;   // 5 min → MEDIUM
export const HEARTBEAT_GAP_HIGH_MS = 15 * 60_000;  // 15 min → HIGH

/** A burst of ≥ this many STATUS_FAULT events on the same connector inside the window emits one FAULT_LOOP. */
export const FAULT_LOOP_MIN_COUNT = 3;
export const FAULT_LOOP_WINDOW_MS = 5 * 60_000;

/** Consecutive Sample.Periodic frames with identical Energy.Active.Import.Register during Charging → frozen-register anomaly. */
export const METER_FROZEN_MIN_FRAMES = 4;
/** Consecutive Sample.Periodic frames where Current.Import < this fraction of Current.Offered (and Offered > 0) → undercurrent anomaly. */
export const METER_UNDERCURRENT_FRACTION = 0.5;
export const METER_UNDERCURRENT_MIN_FRAMES = 4;

/** Charging status with no MeterValues in this window → session-state-mismatch. */
export const SESSION_NO_METERING_AFTER_CHARGING_MS = 3 * 60_000;

// ─── Public input/output types ─────────────────────────────────────────

export interface HeartbeatTick {
  ts: Date;
}

export interface FaultEventTick {
  ts: Date;
  connectorId: number | null;
  errorCode: string | null;
  vendorErrorCode: string | null;
  vendorId: string | null;
}

export interface MeterFrame {
  ts: Date;
  /** Energy.Active.Import.Register in Wh, when present. */
  registerWh: number | null;
  /** Current.Import in Amps, when present. */
  currentImportA: number | null;
  /** Current.Offered in Amps, when present. */
  currentOfferedA: number | null;
  /** Power.Active.Import in Watts, when present. */
  powerActiveImportW: number | null;
}

export interface StatusTick {
  ts: Date;
  connectorId: number | null;
  status: string;
}

export interface SessionWindow {
  /** Connector status transitions in time order. */
  statuses: StatusTick[];
  /** MeterValues frames in time order. Caller filters to `Sample.Periodic` only. */
  meterFrames: MeterFrame[];
  /**
   * Half-open intervals during which a Session row was ACTIVE on this
   * connector. `stoppedAt: null` means the session is still active at
   * scan time (treat as +∞). Available-while-session-active is detected
   * by checking whether each Available status timestamp falls inside any
   * of these intervals — NOT by a coarse "any active session in window"
   * boolean.
   */
  activeSessionIntervals: SessionInterval[];
}

export interface SessionInterval {
  startedAt: Date;
  stoppedAt: Date | null;
}

// ─── HEARTBEAT_GAP ─────────────────────────────────────────────────────

/**
 * Emit one event per gap between consecutive Heartbeats that exceeds the
 * warn threshold. Severity scales with gap size.
 *
 * Caller is responsible for filtering out heartbeats that fall during a
 * known OFFLINE window (UptimeEvent says the charger was deliberately
 * offline) — this detector is intentionally narrow: it only sees the
 * heartbeat timestamps it's given.
 */
export function detectHeartbeatGaps(ticks: HeartbeatTick[]): ExtractedChargerEvent[] {
  if (ticks.length < 2) return [];
  const sorted = [...ticks].sort((a, b) => a.ts.getTime() - b.ts.getTime());
  const out: ExtractedChargerEvent[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const gapMs = sorted[i].ts.getTime() - sorted[i - 1].ts.getTime();
    if (gapMs <= HEARTBEAT_GAP_WARN_MS) continue;
    const severity: ChargerEventSeverity = gapMs >= HEARTBEAT_GAP_HIGH_MS ? 'HIGH' : 'MEDIUM';
    out.push({
      kind: 'HEARTBEAT_GAP',
      severity,
      connectorId: null, // charger-wide
      errorCode: null,
      vendorErrorCode: null,
      vendorId: null,
      payloadSummary: {
        gapMs,
        gapMinutes: Math.round((gapMs / 60_000) * 10) / 10,
        prevHeartbeatAt: sorted[i - 1].ts.toISOString(),
        nextHeartbeatAt: sorted[i].ts.toISOString(),
      },
    });
  }
  return out;
}

// ─── FAULT_LOOP ────────────────────────────────────────────────────────

/**
 * Emit one FAULT_LOOP event per burst of ≥ FAULT_LOOP_MIN_COUNT
 * STATUS_FAULT events on the same connector within FAULT_LOOP_WINDOW_MS.
 * Bursts are detected with a sliding window — overlapping bursts collapse
 * into a single event keyed at the burst's first fault ts.
 */
export function detectFaultLoops(faults: FaultEventTick[]): ExtractedChargerEvent[] {
  if (faults.length < FAULT_LOOP_MIN_COUNT) return [];

  // Group by connectorId (null is its own group — charge-point-wide faults).
  const byConnector = new Map<string, FaultEventTick[]>();
  for (const f of faults) {
    const key = f.connectorId === null ? 'null' : String(f.connectorId);
    const bucket = byConnector.get(key);
    if (bucket) bucket.push(f);
    else byConnector.set(key, [f]);
  }

  const out: ExtractedChargerEvent[] = [];

  for (const bucket of byConnector.values()) {
    bucket.sort((a, b) => a.ts.getTime() - b.ts.getTime());
    let i = 0;
    while (i <= bucket.length - FAULT_LOOP_MIN_COUNT) {
      const start = bucket[i].ts.getTime();
      // Find the largest j such that bucket[j].ts - start ≤ FAULT_LOOP_WINDOW_MS.
      let j = i;
      while (j + 1 < bucket.length && bucket[j + 1].ts.getTime() - start <= FAULT_LOOP_WINDOW_MS) {
        j++;
      }
      const count = j - i + 1;
      if (count >= FAULT_LOOP_MIN_COUNT) {
        const errorCodes = Array.from(
          new Set(bucket.slice(i, j + 1).map((f) => f.errorCode).filter((c): c is string => !!c)),
        );
        const vendorErrorCodes = Array.from(
          new Set(
            bucket.slice(i, j + 1).map((f) => f.vendorErrorCode).filter((c): c is string => !!c),
          ),
        );
        out.push({
          kind: 'FAULT_LOOP',
          severity: 'HIGH',
          connectorId: bucket[i].connectorId,
          errorCode: errorCodes.length === 1 ? errorCodes[0] : null,
          vendorErrorCode: vendorErrorCodes.length === 1 ? vendorErrorCodes[0] : null,
          vendorId: null,
          payloadSummary: {
            count,
            windowMs: bucket[j].ts.getTime() - start,
            firstAt: bucket[i].ts.toISOString(),
            lastAt: bucket[j].ts.toISOString(),
            errorCodes,
            vendorErrorCodes,
          },
        });
        // Skip past this burst to avoid emitting overlapping events.
        i = j + 1;
      } else {
        i++;
      }
    }
  }

  return out;
}

// ─── METER_ANOMALY ─────────────────────────────────────────────────────

/**
 * Detect frozen-register and undercurrent anomalies during Charging.
 *
 * Caller is responsible for narrowing `frames` to the Charging window only
 * (we don't know "is this charger Charging right now" without status
 * context). Pre-Charging deny windows or post-Charging tail frames must be
 * filtered out before invoking this detector.
 */
export function detectMeterAnomalies(frames: MeterFrame[]): ExtractedChargerEvent[] {
  if (frames.length < METER_FROZEN_MIN_FRAMES) return [];
  const out: ExtractedChargerEvent[] = [];

  // Frozen register: longest run of consecutive frames where registerWh is
  // identical (and non-null). Emit when the run length ≥ MIN_FRAMES.
  const sorted = [...frames].sort((a, b) => a.ts.getTime() - b.ts.getTime());
  let runStart = 0;
  while (runStart < sorted.length) {
    const startVal = sorted[runStart].registerWh;
    if (startVal === null) { runStart++; continue; }
    let runEnd = runStart;
    while (runEnd + 1 < sorted.length && sorted[runEnd + 1].registerWh === startVal) {
      runEnd++;
    }
    const runLen = runEnd - runStart + 1;
    if (runLen >= METER_FROZEN_MIN_FRAMES) {
      out.push({
        kind: 'METER_ANOMALY',
        severity: 'MEDIUM',
        connectorId: null,
        errorCode: null,
        vendorErrorCode: null,
        vendorId: null,
        payloadSummary: {
          subtype: 'frozen-register',
          frames: runLen,
          registerWh: startVal,
          firstAt: sorted[runStart].ts.toISOString(),
          lastAt: sorted[runEnd].ts.toISOString(),
        },
      });
      runStart = runEnd + 1;
    } else {
      runStart = runEnd + 1;
    }
  }

  // Undercurrent: longest run of consecutive frames where currentImportA <
  // METER_UNDERCURRENT_FRACTION * currentOfferedA AND currentOfferedA > 0.
  let i = 0;
  while (i < sorted.length) {
    const inUndercurrent = (f: MeterFrame): boolean => {
      if (f.currentOfferedA === null || f.currentImportA === null) return false;
      if (f.currentOfferedA <= 0) return false;
      return f.currentImportA < f.currentOfferedA * METER_UNDERCURRENT_FRACTION;
    };
    if (!inUndercurrent(sorted[i])) { i++; continue; }
    let j = i;
    while (j + 1 < sorted.length && inUndercurrent(sorted[j + 1])) j++;
    const runLen = j - i + 1;
    if (runLen >= METER_UNDERCURRENT_MIN_FRAMES) {
      out.push({
        kind: 'METER_ANOMALY',
        severity: 'MEDIUM',
        connectorId: null,
        errorCode: null,
        vendorErrorCode: null,
        vendorId: null,
        payloadSummary: {
          subtype: 'undercurrent',
          frames: runLen,
          firstAt: sorted[i].ts.toISOString(),
          lastAt: sorted[j].ts.toISOString(),
          // Sample-level snapshot (last frame of the run) for triage.
          lastImportA: sorted[j].currentImportA,
          lastOfferedA: sorted[j].currentOfferedA,
          fractionThreshold: METER_UNDERCURRENT_FRACTION,
        },
      });
    }
    i = j + 1;
  }

  return out;
}

// ─── SESSION_STATE_MISMATCH ────────────────────────────────────────────

/**
 * Detect mismatches between connector status, session liveness, and meter
 * activity within a single charging-relevant window.
 *
 * Two checks in v1:
 *   (a) Connector reported `Charging` but no MeterValues frames arrived
 *       within SESSION_NO_METERING_AFTER_CHARGING_MS afterward.
 *   (b) Connector reported `Available` while a Session row was still
 *       marked ACTIVE (caller passes that fact in via hasActiveSession).
 *
 * All status timestamps must be inside the same window passed to the
 * detector — caller scopes by chargerId+connectorId+window.
 */
export function detectSessionStateMismatches(window: SessionWindow): ExtractedChargerEvent[] {
  const out: ExtractedChargerEvent[] = [];
  const statuses = [...window.statuses].sort((a, b) => a.ts.getTime() - b.ts.getTime());
  const frames = [...window.meterFrames].sort((a, b) => a.ts.getTime() - b.ts.getTime());

  // (a) Charging without metering within N min.
  for (let i = 0; i < statuses.length; i++) {
    if (statuses[i].status !== 'Charging') continue;
    const chargingAt = statuses[i].ts.getTime();
    // Find the next status transition AFTER this Charging (if any) — defines
    // the window upper bound; if none, use chargingAt + threshold.
    const nextStatusTs = i + 1 < statuses.length ? statuses[i + 1].ts.getTime() : Number.POSITIVE_INFINITY;
    const cutoff = Math.min(nextStatusTs, chargingAt + SESSION_NO_METERING_AFTER_CHARGING_MS);
    const sawMetering = frames.some(
      (f) => f.ts.getTime() > chargingAt && f.ts.getTime() <= cutoff,
    );
    const elapsedMs = cutoff - chargingAt;
    if (!sawMetering && elapsedMs >= SESSION_NO_METERING_AFTER_CHARGING_MS) {
      out.push({
        kind: 'SESSION_STATE_MISMATCH',
        severity: 'MEDIUM',
        connectorId: statuses[i].connectorId,
        errorCode: null,
        vendorErrorCode: null,
        vendorId: null,
        payloadSummary: {
          subtype: 'charging-without-metering',
          chargingAt: statuses[i].ts.toISOString(),
          observedForMs: elapsedMs,
        },
      });
    }
  }

  // (b) Available with a Session ACTIVE *at that exact timestamp*.
  // Coarse boolean checking would falsely flag every Available in a
  // window that contained any active session anywhere — this iterates
  // intervals and checks containment per Available tick.
  if (window.activeSessionIntervals.length > 0) {
    for (const s of statuses) {
      if (s.status !== 'Available') continue;
      const ts = s.ts.getTime();
      const overlapping = window.activeSessionIntervals.find((iv) =>
        iv.startedAt.getTime() <= ts &&
        (iv.stoppedAt === null || ts < iv.stoppedAt.getTime()),
      );
      if (!overlapping) continue;
      out.push({
        kind: 'SESSION_STATE_MISMATCH',
        severity: 'MEDIUM',
        connectorId: s.connectorId,
        errorCode: null,
        vendorErrorCode: null,
        vendorId: null,
        payloadSummary: {
          subtype: 'available-while-session-active',
          availableAt: s.ts.toISOString(),
          sessionStartedAt: overlapping.startedAt.toISOString(),
          sessionStoppedAt: overlapping.stoppedAt?.toISOString() ?? null,
        },
      });
    }
  }

  return out;
}

// ─── Charging-window segmentation helper ──────────────────────────────

/**
 * Slice a flat list of MeterValues frames into the time windows during
 * which the connector status was 'Charging'. A `Charging` status opens a
 * window; the NEXT status transition closes it. If a charging status is
 * never followed by another transition, the window stays open through the
 * latest frame.
 *
 * Intent: callers (the backfill script) buffer ALL Sample.Periodic frames
 * for a connector, then call this helper to produce the "only Charging"
 * subset(s) that detectMeterAnomalies expects. Without this, idle frames
 * with a flat register get falsely flagged as frozen-register anomalies.
 *
 * Returns one array of frames per Charging window. Empty array if no
 * Charging status was observed in `statuses` or no frames fall inside
 * any Charging window.
 */
export function segmentFramesByChargingStatus(
  statuses: StatusTick[],
  frames: MeterFrame[],
): MeterFrame[][] {
  if (statuses.length === 0 || frames.length === 0) return [];
  const sortedStatuses = [...statuses].sort((a, b) => a.ts.getTime() - b.ts.getTime());
  const sortedFrames = [...frames].sort((a, b) => a.ts.getTime() - b.ts.getTime());

  const windows: Array<{ from: number; to: number }> = [];
  for (let i = 0; i < sortedStatuses.length; i++) {
    if (sortedStatuses[i].status !== 'Charging') continue;
    const from = sortedStatuses[i].ts.getTime();
    const next = sortedStatuses.slice(i + 1).find((s) => s.status !== 'Charging');
    const to = next ? next.ts.getTime() : Number.POSITIVE_INFINITY;
    windows.push({ from, to });
  }
  if (windows.length === 0) return [];

  return windows
    .map(({ from, to }) =>
      sortedFrames.filter((f) => {
        const t = f.ts.getTime();
        return t >= from && t < to;
      }),
    )
    .filter((arr) => arr.length > 0);
}

// Re-export the shared types so downstream backfill code can import a
// single module.
export type { ChargerEventKind, ChargerEventSeverity, ExtractedChargerEvent };
