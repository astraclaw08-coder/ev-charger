/**
 * chargerEventExtractor — Self-Tests (TASK-0198 Phase 1, PR #1)
 * Run: npx ts-node packages/ocpp-server/src/diagnostics/chargerEventExtractor.selftest.ts
 *
 * Pure-function tests; no DB, no mocks beyond the message payload itself.
 */

import {
  extractChargerEvents,
  type OcppMessageInput,
} from './chargerEventExtractor';

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else            { failed++; console.error(`  ❌ ${name}`); }
}

function inbound(action: string, payload: unknown): OcppMessageInput {
  return { action, direction: 'INBOUND', payload };
}
function outbound(action: string, payload: unknown): OcppMessageInput {
  return { action, direction: 'OUTBOUND', payload };
}

// ─── StatusNotification: NoError → no events ──────────────────────────
console.log('\n--- StatusNotification with no fault ---');
{
  const events = extractChargerEvents(inbound('StatusNotification', {
    connectorId: 1,
    status: 'Charging',
    errorCode: 'NoError',
    timestamp: '2026-05-02T12:00:00Z',
  }));
  assert(events.length === 0, 'no events for status=Charging errorCode=NoError');
}

// ─── StatusNotification: Available → no events ────────────────────────
console.log('\n--- StatusNotification: Available is not a fault ---');
{
  const events = extractChargerEvents(inbound('StatusNotification', {
    connectorId: 1, status: 'Available', errorCode: 'NoError',
  }));
  assert(events.length === 0, 'Available with NoError emits no event');
}

// ─── StatusNotification: errorCode set → STATUS_FAULT (severity MEDIUM) ──
console.log('\n--- StatusNotification with vendor errorCode (status=SuspendedEVSE) ---');
{
  const events = extractChargerEvents(inbound('StatusNotification', {
    connectorId: 1,
    status: 'SuspendedEVSE',
    errorCode: 'PowerSwitchFailure',
    vendorErrorCode: '0x000000000003',
    timestamp: '2026-04-29T20:29:41.373Z',
  }));
  assert(events.length === 1, 'one event emitted');
  const e = events[0];
  assert(e.kind === 'STATUS_FAULT', `kind=STATUS_FAULT (got ${e.kind})`);
  assert(e.severity === 'MEDIUM', `severity=MEDIUM when status != Faulted (got ${e.severity})`);
  assert(e.connectorId === 1, 'connectorId carried');
  assert(e.errorCode === 'PowerSwitchFailure', 'errorCode carried');
  assert(e.vendorErrorCode === '0x000000000003', 'vendorErrorCode carried');
  assert((e.payloadSummary as any).status === 'SuspendedEVSE', 'payloadSummary.status set');
  assert((e.payloadSummary as any).timestamp === '2026-04-29T20:29:41.373Z', 'payloadSummary.timestamp preserved');
}

// ─── StatusNotification: status=Faulted → STATUS_FAULT severity HIGH ──
console.log('\n--- StatusNotification status=Faulted promotes severity ---');
{
  const events = extractChargerEvents(inbound('StatusNotification', {
    connectorId: 1, status: 'Faulted', errorCode: 'NoError',
  }));
  assert(events.length === 1, 'one event when status=Faulted (even with NoError)');
  assert(events[0].severity === 'HIGH', `severity=HIGH for status=Faulted (got ${events[0].severity})`);
}

// ─── StatusNotification: Faulted + non-NoError → still HIGH (not double-emit) ──
console.log('\n--- Faulted + errorCode → one HIGH event ---');
{
  const events = extractChargerEvents(inbound('StatusNotification', {
    connectorId: 1, status: 'Faulted', errorCode: 'GroundFailure',
  }));
  assert(events.length === 1, 'still one event');
  assert(events[0].severity === 'HIGH', 'severity=HIGH wins over MEDIUM-from-errorCode');
  assert(events[0].errorCode === 'GroundFailure', 'errorCode carried');
}

// ─── StatusNotification connectorId=0 → null (charge-point-wide) ─────
console.log('\n--- StatusNotification connectorId=0 normalises to null ---');
{
  const events = extractChargerEvents(inbound('StatusNotification', {
    connectorId: 0, status: 'Faulted', errorCode: 'NoError',
  }));
  assert(events.length === 1, 'event emitted for charge-point-wide fault');
  assert(events[0].connectorId === null, 'connectorId=0 → null in event row');
}

// ─── StatusNotification connectorId out-of-range → null ───────────────
console.log('\n--- StatusNotification connectorId out-of-range normalises to null ---');
{
  const events = extractChargerEvents(inbound('StatusNotification', {
    connectorId: 999, status: 'Faulted', errorCode: 'NoError',
  }));
  assert(events.length === 1, 'event emitted');
  assert(events[0].connectorId === null, 'out-of-range connectorId → null');
}

// ─── StatusNotification OUTBOUND ack → no event (we only watch INBOUND) ──
console.log('\n--- StatusNotification OUTBOUND ack ignored ---');
{
  const events = extractChargerEvents(outbound('StatusNotification', {}));
  assert(events.length === 0, 'OUTBOUND StatusNotification ignored');
}

// ─── RemoteStartTransaction Accepted → no event ──────────────────────
console.log('\n--- RemoteStartTransaction Accepted is not a failure ---');
{
  const events = extractChargerEvents(inbound('RemoteStartTransactionResponse', {
    status: 'Accepted',
  }));
  assert(events.length === 0, 'no event when Accepted');
}

// ─── RemoteStartTransaction Rejected → REMOTE_START_FAILED ──────────
console.log('\n--- RemoteStartTransaction Rejected → REMOTE_START_FAILED ---');
{
  const events = extractChargerEvents(inbound('RemoteStartTransactionResponse', {
    status: 'Rejected',
  }));
  assert(events.length === 1, 'one event');
  assert(events[0].kind === 'REMOTE_START_FAILED', 'kind=REMOTE_START_FAILED');
  assert(events[0].severity === 'MEDIUM', 'severity=MEDIUM');
  assert((events[0].payloadSummary as any).status === 'Rejected', 'payloadSummary.status carried');
}

// ─── RemoteStartTransaction (collapsed action name) Rejected → also caught ──
console.log('\n--- collapsed RemoteStartTransaction action name handled ---');
{
  const events = extractChargerEvents(inbound('RemoteStartTransaction', {
    status: 'Rejected',
  }));
  assert(events.length === 1, 'one event under collapsed action name');
  assert(events[0].kind === 'REMOTE_START_FAILED', 'kind=REMOTE_START_FAILED');
}

// ─── RemoteStopTransaction Rejected → REMOTE_STOP_FAILED ───────────
console.log('\n--- RemoteStopTransaction Rejected → REMOTE_STOP_FAILED ---');
{
  const events = extractChargerEvents(inbound('RemoteStopTransactionResponse', {
    status: 'Rejected',
  }));
  assert(events.length === 1, 'one event');
  assert(events[0].kind === 'REMOTE_STOP_FAILED', 'kind=REMOTE_STOP_FAILED');
}

// ─── OUTBOUND request shape (no top-level status) → no event ─────────
console.log('\n--- OUTBOUND RemoteStartTransaction request ignored ---');
{
  const events = extractChargerEvents(outbound('RemoteStartTransaction', {
    connectorId: 1, idTag: 'PILOT-1A32-001',
  }));
  assert(events.length === 0, 'OUTBOUND request (no status field) ignored');
}

// ─── INBOUND with request shape (no status) — defensive: don't emit ──
console.log('\n--- INBOUND RemoteStartTransaction without status field ignored ---');
{
  const events = extractChargerEvents(inbound('RemoteStartTransaction', {
    connectorId: 1, idTag: 'PILOT-1A32-001',
  }));
  assert(events.length === 0, 'request-shape INBOUND without status ignored');
}

// ─── Non-target action (e.g. Heartbeat) → never emits ───────────────
console.log('\n--- Heartbeat / BootNotification / MeterValues never emit (v1) ---');
{
  const heartbeat = extractChargerEvents(inbound('Heartbeat', {}));
  const boot = extractChargerEvents(inbound('BootNotification', {
    chargePointVendor: 'X', chargePointModel: 'Y',
  }));
  const meter = extractChargerEvents(inbound('MeterValues', {
    connectorId: 1, transactionId: 1, meterValue: [],
  }));
  assert(heartbeat.length === 0, 'Heartbeat → no events');
  assert(boot.length === 0, 'BootNotification → no events');
  assert(meter.length === 0, 'MeterValues → no events (deferred to PR #2 backfill)');
}

// ─── Defensive: null/undefined/non-object payloads don't crash ──────
console.log('\n--- malformed payloads do not throw ---');
{
  const e1 = extractChargerEvents(inbound('StatusNotification', null));
  const e2 = extractChargerEvents(inbound('StatusNotification', undefined));
  const e3 = extractChargerEvents(inbound('StatusNotification', 'string-payload' as any));
  const e4 = extractChargerEvents(inbound('StatusNotification', 42 as any));
  assert(e1.length === 0 && e2.length === 0 && e3.length === 0 && e4.length === 0,
    'malformed payloads silently emit no events');
}

// ─── Severity is conservative (no CRITICAL emitted by v1) ──────────
console.log('\n--- v1 never emits CRITICAL ---');
{
  // Even the worst real-world StatusNotification still maps to HIGH at most.
  const events = extractChargerEvents(inbound('StatusNotification', {
    connectorId: 1, status: 'Faulted', errorCode: 'InternalError',
    vendorErrorCode: '0xDEADBEEF', vendorId: 'AcmeCo',
  }));
  assert(events[0].severity === 'HIGH', 'caps at HIGH; CRITICAL reserved for cross-message rules');
}

// ─── Summary ────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
