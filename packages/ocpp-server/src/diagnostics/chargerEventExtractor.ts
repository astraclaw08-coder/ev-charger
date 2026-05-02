/**
 * TASK-0198 Phase 1 — pure ChargerEvent extractor.
 *
 * Given a single OCPP message (action + direction + payload), emit zero or
 * more structured `ChargerEvent` rows. Pure function: no DB, no I/O, no
 * timer state. Persistence + ingestion-flow control live in
 * chargerEventLogger.ts.
 *
 * v1 (PR #1) extracts the three highest-signal event kinds from per-message
 * data alone — anything that needs cross-message reasoning (heartbeat-gap,
 * fault-loop, meter-anomaly) is deferred to the PR #2 backfill / window
 * analyzer where we can reason over a time range.
 *
 *   STATUS_FAULT          — StatusNotification with errorCode != 'NoError'
 *                           OR status='Faulted'
 *   REMOTE_START_FAILED   — RemoteStartTransaction response (server received
 *                           charger reply) with status != 'Accepted'
 *   REMOTE_STOP_FAILED    — RemoteStopTransaction response with status != 'Accepted'
 *
 * Severity policy (deliberately conservative; can be bumped in operator
 * config later without schema change):
 *   STATUS_FAULT  → HIGH if status='Faulted', else MEDIUM
 *   REMOTE_*_FAILED → MEDIUM (operator-initiated failure; not a charger fault)
 *
 * The extractor is intentionally narrow: false positives are worse than
 * false negatives because every event row drives downstream attention.
 */

export type ChargerEventKind =
  // Per-message extractor (this file)
  | 'STATUS_FAULT'
  | 'REMOTE_START_FAILED'
  | 'REMOTE_STOP_FAILED'
  // Cross-message window detectors (chargerWindowDetectors.ts)
  | 'HEARTBEAT_GAP'
  | 'FAULT_LOOP'
  | 'METER_ANOMALY'
  | 'SESSION_STATE_MISMATCH';

export type ChargerEventSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface ExtractedChargerEvent {
  kind: ChargerEventKind;
  severity: ChargerEventSeverity;
  connectorId: number | null;
  errorCode: string | null;
  vendorErrorCode: string | null;
  vendorId: string | null;
  payloadSummary: Record<string, unknown>;
}

export interface OcppMessageInput {
  /** OCPP action name (e.g. "StatusNotification", "RemoteStartTransaction"). */
  action: string;
  /** INBOUND = charger → server; OUTBOUND = server → charger. */
  direction: 'INBOUND' | 'OUTBOUND';
  /** Raw message payload — JSON shape depends on action. */
  payload: unknown;
}

/**
 * Extract zero or more ChargerEvents from a single OCPP message.
 * Returns an empty array for messages that don't match any extractor.
 */
export function extractChargerEvents(input: OcppMessageInput): ExtractedChargerEvent[] {
  const { action, direction, payload } = input;
  if (!payload || typeof payload !== 'object') return [];
  const p = payload as Record<string, unknown>;

  switch (action) {
    case 'StatusNotification':
      return direction === 'INBOUND' ? extractStatusFault(p) : [];

    case 'RemoteStartTransactionResponse':
    case 'RemoteStartTransaction':
      // Server emits the request OUTBOUND; charger reply lands as
      // RemoteStartTransactionResponse INBOUND in some logger setups, or
      // is captured under the request action when message-correlation
      // collapses request+response. We handle both shapes — the response
      // shape always has a top-level `status` field; the request shape
      // does not.
      return direction === 'INBOUND' && hasStatusField(p)
        ? extractRemoteCommandFailure(p, 'REMOTE_START_FAILED')
        : [];

    case 'RemoteStopTransactionResponse':
    case 'RemoteStopTransaction':
      return direction === 'INBOUND' && hasStatusField(p)
        ? extractRemoteCommandFailure(p, 'REMOTE_STOP_FAILED')
        : [];

    default:
      return [];
  }
}

// ─── Per-action helpers ────────────────────────────────────────────────

function extractStatusFault(p: Record<string, unknown>): ExtractedChargerEvent[] {
  const status = typeof p.status === 'string' ? p.status : null;
  const errorCode = typeof p.errorCode === 'string' ? p.errorCode : null;
  const isExplicitFaulted = status === 'Faulted';
  const hasErrorCode = errorCode !== null && errorCode !== 'NoError';

  if (!isExplicitFaulted && !hasErrorCode) return [];

  const connectorId = parseConnectorId(p.connectorId);
  const vendorErrorCode = typeof p.vendorErrorCode === 'string' ? p.vendorErrorCode : null;
  const vendorId = typeof p.vendorId === 'string' ? p.vendorId : null;
  const info = typeof p.info === 'string' ? p.info : null;
  const timestamp = typeof p.timestamp === 'string' ? p.timestamp : null;

  return [
    {
      kind: 'STATUS_FAULT',
      severity: isExplicitFaulted ? 'HIGH' : 'MEDIUM',
      connectorId,
      errorCode,
      vendorErrorCode,
      vendorId,
      payloadSummary: {
        status,
        errorCode,
        vendorErrorCode,
        vendorId,
        info,
        timestamp,
      },
    },
  ];
}

function extractRemoteCommandFailure(
  p: Record<string, unknown>,
  kind: 'REMOTE_START_FAILED' | 'REMOTE_STOP_FAILED',
): ExtractedChargerEvent[] {
  const status = typeof p.status === 'string' ? p.status : null;
  if (status === 'Accepted' || status === null) return [];

  return [
    {
      kind,
      severity: 'MEDIUM',
      connectorId: parseConnectorId(p.connectorId),
      errorCode: null,
      vendorErrorCode: null,
      vendorId: null,
      payloadSummary: { status },
    },
  ];
}

// ─── Internal utilities ─────────────────────────────────────────────────

function parseConnectorId(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  // OCPP connectorId 0 means "charge-point-wide" — we represent that as null
  // in ChargerEvent for clearer downstream filtering. A connector-specific
  // event carries the actual connectorId (1..N).
  if (raw === 0) return null;
  if (raw < 1 || raw > 32) return null;
  return Math.floor(raw);
}

function hasStatusField(p: Record<string, unknown>): boolean {
  return typeof p.status === 'string';
}
