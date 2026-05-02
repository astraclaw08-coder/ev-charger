/**
 * chargerWindowDetectors — Self-Tests (TASK-0198 Phase 1, PR #2)
 * Run: npx ts-node packages/ocpp-server/src/diagnostics/chargerWindowDetectors.selftest.ts
 *
 * Pure-function tests; no DB. Each detector is exercised against
 * deterministic inputs that cover positive, negative, and edge cases.
 */

import {
  detectHeartbeatGaps,
  detectFaultLoops,
  detectMeterAnomalies,
  detectSessionStateMismatches,
  segmentFramesByChargingStatus,
  HEARTBEAT_GAP_WARN_MS,
  HEARTBEAT_GAP_HIGH_MS,
  FAULT_LOOP_MIN_COUNT,
  FAULT_LOOP_WINDOW_MS,
  METER_FROZEN_MIN_FRAMES,
  METER_UNDERCURRENT_MIN_FRAMES,
  SESSION_NO_METERING_AFTER_CHARGING_MS,
  type FaultEventTick,
  type MeterFrame,
  type StatusTick,
  type SessionInterval,
} from './chargerWindowDetectors';

let passed = 0;
let failed = 0;
function assert(c: boolean, name: string) {
  if (c) { passed++; console.log(`  ✅ ${name}`); }
  else   { failed++; console.error(`  ❌ ${name}`); }
}

const T0 = new Date('2026-05-02T18:00:00Z').getTime();
const at = (ms: number) => new Date(T0 + ms);
const min = (n: number) => n * 60_000;

// ─── HEARTBEAT_GAP ──────────────────────────────────────────────────
console.log('\n--- HEARTBEAT_GAP: empty / single tick → no events ---');
{
  assert(detectHeartbeatGaps([]).length === 0, 'empty list');
  assert(detectHeartbeatGaps([{ ts: at(0) }]).length === 0, 'single tick');
}

console.log('\n--- HEARTBEAT_GAP: regular cadence (1 min apart) → no events ---');
{
  const ticks = Array.from({ length: 10 }, (_, i) => ({ ts: at(i * min(1)) }));
  assert(detectHeartbeatGaps(ticks).length === 0, '10 ticks at 1-min cadence');
}

console.log('\n--- HEARTBEAT_GAP: gap just under threshold → no event ---');
{
  // 4 min gap (threshold 5 min)
  const ticks = [{ ts: at(0) }, { ts: at(min(4)) }];
  assert(detectHeartbeatGaps(ticks).length === 0, '4-min gap (under 5-min warn)');
}

console.log('\n--- HEARTBEAT_GAP: gap > 5 min → MEDIUM event ---');
{
  const ticks = [{ ts: at(0) }, { ts: at(min(7)) }];
  const events = detectHeartbeatGaps(ticks);
  assert(events.length === 1, 'exactly one event');
  assert(events[0].kind === 'HEARTBEAT_GAP', 'kind=HEARTBEAT_GAP');
  assert(events[0].severity === 'MEDIUM', `severity=MEDIUM (got ${events[0].severity})`);
  assert((events[0].payloadSummary as any).gapMinutes === 7, 'gapMinutes=7 in summary');
}

console.log('\n--- HEARTBEAT_GAP: gap > 15 min → HIGH event ---');
{
  const ticks = [{ ts: at(0) }, { ts: at(min(20)) }];
  const events = detectHeartbeatGaps(ticks);
  assert(events.length === 1, 'one event');
  assert(events[0].severity === 'HIGH', 'severity=HIGH for 20-min gap');
}

console.log('\n--- HEARTBEAT_GAP: multiple gaps → multiple events ---');
{
  const ticks = [
    { ts: at(0) }, { ts: at(min(1)) }, { ts: at(min(8)) }, // 7-min gap → MEDIUM
    { ts: at(min(9)) }, { ts: at(min(30)) },               // 21-min gap → HIGH
  ];
  const events = detectHeartbeatGaps(ticks);
  assert(events.length === 2, 'two events');
  assert(events[0].severity === 'MEDIUM' && events[1].severity === 'HIGH', 'severities ordered correctly');
}

// ─── FAULT_LOOP ────────────────────────────────────────────────────
console.log('\n--- FAULT_LOOP: < min count → no event ---');
{
  const faults: FaultEventTick[] = [
    { ts: at(0), connectorId: 1, errorCode: 'GroundFailure', vendorErrorCode: null, vendorId: null },
    { ts: at(min(1)), connectorId: 1, errorCode: 'GroundFailure', vendorErrorCode: null, vendorId: null },
  ];
  assert(detectFaultLoops(faults).length === 0, '2 faults < min 3');
}

console.log('\n--- FAULT_LOOP: 3 faults in 5 min, same connector → one HIGH event ---');
{
  const faults: FaultEventTick[] = [
    { ts: at(0), connectorId: 1, errorCode: 'GroundFailure', vendorErrorCode: null, vendorId: null },
    { ts: at(min(2)), connectorId: 1, errorCode: 'GroundFailure', vendorErrorCode: null, vendorId: null },
    { ts: at(min(4)), connectorId: 1, errorCode: 'GroundFailure', vendorErrorCode: null, vendorId: null },
  ];
  const events = detectFaultLoops(faults);
  assert(events.length === 1, 'one event');
  assert(events[0].kind === 'FAULT_LOOP', 'kind=FAULT_LOOP');
  assert(events[0].severity === 'HIGH', 'severity=HIGH');
  assert(events[0].connectorId === 1, 'connectorId=1');
  assert(events[0].errorCode === 'GroundFailure', 'errorCode collapsed when uniform');
  assert((events[0].payloadSummary as any).count === 3, 'count=3');
}

console.log('\n--- FAULT_LOOP: 3 faults spread > 5 min → no event ---');
{
  const faults: FaultEventTick[] = [
    { ts: at(0), connectorId: 1, errorCode: 'X', vendorErrorCode: null, vendorId: null },
    { ts: at(min(3)), connectorId: 1, errorCode: 'X', vendorErrorCode: null, vendorId: null },
    { ts: at(min(8)), connectorId: 1, errorCode: 'X', vendorErrorCode: null, vendorId: null },
  ];
  // Window from t=0 covers t=0,3 (2 faults < 3). Window from t=3 covers 3,8 (2 faults < 3). No burst.
  assert(detectFaultLoops(faults).length === 0, 'spread faults do not loop');
}

console.log('\n--- FAULT_LOOP: 5 faults in 5 min on connector 1 + isolated fault on connector 2 → one event for connector 1 ---');
{
  const faults: FaultEventTick[] = [
    { ts: at(0), connectorId: 1, errorCode: 'A', vendorErrorCode: null, vendorId: null },
    { ts: at(min(1)), connectorId: 1, errorCode: 'A', vendorErrorCode: null, vendorId: null },
    { ts: at(min(2)), connectorId: 1, errorCode: 'B', vendorErrorCode: null, vendorId: null },
    { ts: at(min(3)), connectorId: 1, errorCode: 'A', vendorErrorCode: null, vendorId: null },
    { ts: at(min(4)), connectorId: 1, errorCode: 'A', vendorErrorCode: null, vendorId: null },
    { ts: at(min(2)), connectorId: 2, errorCode: 'A', vendorErrorCode: null, vendorId: null },
  ];
  const events = detectFaultLoops(faults);
  assert(events.length === 1, 'one event for connector 1');
  assert(events[0].connectorId === 1, 'connector=1');
  assert((events[0].payloadSummary as any).count === 5, 'count=5');
  assert(events[0].errorCode === null, 'errorCode null when codes mixed');
  assert(Array.isArray((events[0].payloadSummary as any).errorCodes), 'errorCodes array preserved');
}

console.log('\n--- FAULT_LOOP: separate bursts → separate events (no overlap) ---');
{
  const faults: FaultEventTick[] = [];
  // Burst 1: 3 faults at t=0,1,2 min
  for (const m of [0, 1, 2]) faults.push({ ts: at(min(m)), connectorId: 1, errorCode: 'X', vendorErrorCode: null, vendorId: null });
  // Gap of 10 min
  // Burst 2: 3 faults at t=15,16,17 min
  for (const m of [15, 16, 17]) faults.push({ ts: at(min(m)), connectorId: 1, errorCode: 'Y', vendorErrorCode: null, vendorId: null });
  const events = detectFaultLoops(faults);
  assert(events.length === 2, 'two distinct bursts');
  assert((events[0].payloadSummary as any).errorCodes[0] === 'X', 'first burst errorCode=X');
  assert((events[1].payloadSummary as any).errorCodes[0] === 'Y', 'second burst errorCode=Y');
}

// ─── METER_ANOMALY: frozen register ────────────────────────────────
console.log('\n--- METER_ANOMALY: register changing → no event ---');
{
  const frames: MeterFrame[] = Array.from({ length: 6 }, (_, i) => ({
    ts: at(i * min(1)),
    registerWh: 1000 + i * 100,
    currentImportA: 16,
    currentOfferedA: 16,
    powerActiveImportW: 3840,
  }));
  assert(detectMeterAnomalies(frames).length === 0, 'rising register → no event');
}

console.log('\n--- METER_ANOMALY: register frozen for ≥ MIN frames during Charging → frozen-register event ---');
{
  const frames: MeterFrame[] = Array.from({ length: METER_FROZEN_MIN_FRAMES + 1 }, (_, i) => ({
    ts: at(i * min(1)),
    registerWh: 5000,
    currentImportA: 0.5,
    currentOfferedA: 16,
    powerActiveImportW: 0,
  }));
  const events = detectMeterAnomalies(frames);
  // We expect both frozen-register and undercurrent (since 0.5A < 50% of 16A = 8A).
  const frozen = events.filter((e) => (e.payloadSummary as any).subtype === 'frozen-register');
  assert(frozen.length === 1, `one frozen-register event (got ${frozen.length})`);
  assert(frozen[0].kind === 'METER_ANOMALY', 'kind=METER_ANOMALY');
  assert((frozen[0].payloadSummary as any).frames === METER_FROZEN_MIN_FRAMES + 1, `frames=${METER_FROZEN_MIN_FRAMES + 1}`);
  assert((frozen[0].payloadSummary as any).registerWh === 5000, 'registerWh captured');
}

console.log('\n--- METER_ANOMALY: undercurrent ≥ MIN frames → undercurrent event ---');
{
  const frames: MeterFrame[] = Array.from({ length: METER_UNDERCURRENT_MIN_FRAMES + 1 }, (_, i) => ({
    ts: at(i * min(1)),
    registerWh: 5000 + i, // changing — avoids frozen-register
    currentImportA: 5,
    currentOfferedA: 16, // 5/16 = 31% < 50%
    powerActiveImportW: 1200,
  }));
  const events = detectMeterAnomalies(frames);
  const under = events.filter((e) => (e.payloadSummary as any).subtype === 'undercurrent');
  assert(under.length === 1, 'one undercurrent event');
  assert((under[0].payloadSummary as any).lastImportA === 5, 'lastImportA captured');
  assert((under[0].payloadSummary as any).lastOfferedA === 16, 'lastOfferedA captured');
}

console.log('\n--- METER_ANOMALY: undercurrent ignored when offered=0 (deny-mode) ---');
{
  const frames: MeterFrame[] = Array.from({ length: 6 }, (_, i) => ({
    ts: at(i * min(1)),
    registerWh: 5000 + i,
    currentImportA: 0,
    currentOfferedA: 0, // engine pushed 0 A — undercurrent is the intended state
    powerActiveImportW: 0,
  }));
  const events = detectMeterAnomalies(frames);
  const under = events.filter((e) => (e.payloadSummary as any).subtype === 'undercurrent');
  assert(under.length === 0, 'offered=0 not flagged as undercurrent');
}

console.log('\n--- METER_ANOMALY: brief undercurrent (< MIN frames) → no event ---');
{
  const frames: MeterFrame[] = [
    ...Array.from({ length: 2 }, (_, i) => ({
      ts: at(i * min(1)),
      registerWh: 5000 + i,
      currentImportA: 5,
      currentOfferedA: 16,
      powerActiveImportW: 1200,
    })),
    ...Array.from({ length: 4 }, (_, i) => ({
      ts: at((i + 2) * min(1)),
      registerWh: 5002 + i,
      currentImportA: 16,
      currentOfferedA: 16,
      powerActiveImportW: 3840,
    })),
  ];
  const events = detectMeterAnomalies(frames);
  const under = events.filter((e) => (e.payloadSummary as any).subtype === 'undercurrent');
  assert(under.length === 0, '2-frame undercurrent < min 4 → not flagged');
}

// ─── SESSION_STATE_MISMATCH ───────────────────────────────────────
console.log('\n--- SESSION_STATE_MISMATCH: Charging + metering present → no event ---');
{
  const statuses: StatusTick[] = [{ ts: at(0), connectorId: 1, status: 'Charging' }];
  const meterFrames: MeterFrame[] = Array.from({ length: 5 }, (_, i) => ({
    ts: at(min(i + 1)),
    registerWh: 1000 + i * 100,
    currentImportA: 16, currentOfferedA: 16, powerActiveImportW: 3840,
  }));
  const oneOpen: SessionInterval[] = [{ startedAt: at(0), stoppedAt: null }];
  const events = detectSessionStateMismatches({ statuses, meterFrames, activeSessionIntervals: oneOpen });
  assert(events.length === 0, 'metering present → no charging-without-metering event');
}

console.log('\n--- SESSION_STATE_MISMATCH: Charging + no metering for ≥ threshold → event ---');
{
  const statuses: StatusTick[] = [{ ts: at(0), connectorId: 1, status: 'Charging' }];
  const meterFrames: MeterFrame[] = []; // none
  const oneOpen: SessionInterval[] = [{ startedAt: at(0), stoppedAt: null }];
  const events = detectSessionStateMismatches({ statuses, meterFrames, activeSessionIntervals: oneOpen });
  const mismatch = events.find((e) => (e.payloadSummary as any).subtype === 'charging-without-metering');
  assert(!!mismatch, 'charging-without-metering event emitted');
  assert(mismatch?.connectorId === 1, 'connectorId carried');
  assert((mismatch?.payloadSummary as any).observedForMs >= SESSION_NO_METERING_AFTER_CHARGING_MS, 'observedForMs ≥ threshold');
}

console.log('\n--- SESSION_STATE_MISMATCH: Charging followed by Suspended within < threshold → no event ---');
{
  const statuses: StatusTick[] = [
    { ts: at(0), connectorId: 1, status: 'Charging' },
    { ts: at(min(1)), connectorId: 1, status: 'SuspendedEVSE' }, // status changed before threshold
  ];
  const events = detectSessionStateMismatches({
    statuses, meterFrames: [], activeSessionIntervals: [{ startedAt: at(0), stoppedAt: null }],
  });
  assert(events.length === 0, 'short Charging window → no mismatch event');
}

console.log('\n--- SESSION_STATE_MISMATCH: Available WITHIN active session interval → event ---');
{
  const statuses: StatusTick[] = [{ ts: at(min(5)), connectorId: 1, status: 'Available' }];
  const intervals: SessionInterval[] = [{ startedAt: at(0), stoppedAt: at(min(10)) }];
  const events = detectSessionStateMismatches({ statuses, meterFrames: [], activeSessionIntervals: intervals });
  const mismatch = events.find((e) => (e.payloadSummary as any).subtype === 'available-while-session-active');
  assert(!!mismatch, 'available-while-session-active event when ts inside interval');
  assert((mismatch?.payloadSummary as any).sessionStartedAt === at(0).toISOString(), 'sessionStartedAt carried');
}

console.log('\n--- SESSION_STATE_MISMATCH: Available BEFORE the active interval → no event ---');
{
  const statuses: StatusTick[] = [{ ts: at(0), connectorId: 1, status: 'Available' }];
  const intervals: SessionInterval[] = [{ startedAt: at(min(5)), stoppedAt: at(min(10)) }];
  const events = detectSessionStateMismatches({ statuses, meterFrames: [], activeSessionIntervals: intervals });
  assert(events.length === 0, 'Available preceding the active interval → no false positive');
}

console.log('\n--- SESSION_STATE_MISMATCH: Available AFTER the active interval ended → no event ---');
{
  const statuses: StatusTick[] = [{ ts: at(min(15)), connectorId: 1, status: 'Available' }];
  const intervals: SessionInterval[] = [{ startedAt: at(0), stoppedAt: at(min(10)) }];
  const events = detectSessionStateMismatches({ statuses, meterFrames: [], activeSessionIntervals: intervals });
  assert(events.length === 0, 'Available after stoppedAt → no false positive');
}

console.log('\n--- SESSION_STATE_MISMATCH: Available exactly AT stoppedAt is treated as outside (half-open) → no event ---');
{
  const statuses: StatusTick[] = [{ ts: at(min(10)), connectorId: 1, status: 'Available' }];
  const intervals: SessionInterval[] = [{ startedAt: at(0), stoppedAt: at(min(10)) }];
  const events = detectSessionStateMismatches({ statuses, meterFrames: [], activeSessionIntervals: intervals });
  assert(events.length === 0, 'half-open: ts === stoppedAt is OUTSIDE the interval');
}

console.log('\n--- SESSION_STATE_MISMATCH: Available with NO active intervals → no event ---');
{
  const statuses: StatusTick[] = [{ ts: at(0), connectorId: 1, status: 'Available' }];
  const events = detectSessionStateMismatches({ statuses, meterFrames: [], activeSessionIntervals: [] });
  assert(events.length === 0, 'no event when no intervals provided');
}

console.log('\n--- SESSION_STATE_MISMATCH: multiple Available statuses, only the one inside an interval emits ---');
{
  const statuses: StatusTick[] = [
    { ts: at(0), connectorId: 1, status: 'Available' },          // before interval
    { ts: at(min(7)), connectorId: 1, status: 'Available' },     // inside interval [5, 10)
    { ts: at(min(20)), connectorId: 1, status: 'Available' },    // after interval
  ];
  const intervals: SessionInterval[] = [{ startedAt: at(min(5)), stoppedAt: at(min(10)) }];
  const events = detectSessionStateMismatches({ statuses, meterFrames: [], activeSessionIntervals: intervals });
  const mismatches = events.filter((e) => (e.payloadSummary as any).subtype === 'available-while-session-active');
  assert(mismatches.length === 1, `exactly one Available-during-active emitted (got ${mismatches.length})`);
  assert((mismatches[0].payloadSummary as any).availableAt === at(min(7)).toISOString(), 'the one inside the interval');
}

// ─── segmentFramesByChargingStatus ─────────────────────────────────
console.log('\n--- segmentFramesByChargingStatus: no Charging in statuses → no segments ---');
{
  const statuses: StatusTick[] = [
    { ts: at(0), connectorId: 1, status: 'Available' },
    { ts: at(min(5)), connectorId: 1, status: 'Preparing' },
  ];
  const frames: MeterFrame[] = Array.from({ length: 3 }, (_, i) => ({
    ts: at(min(i)), registerWh: 1000, currentImportA: 0, currentOfferedA: 0, powerActiveImportW: 0,
  }));
  const segs = segmentFramesByChargingStatus(statuses, frames);
  assert(segs.length === 0, 'no Charging status → empty segmentation');
}

console.log('\n--- segmentFramesByChargingStatus: a single Charging window with frames inside ---');
{
  const statuses: StatusTick[] = [
    { ts: at(0), connectorId: 1, status: 'Available' },
    { ts: at(min(2)), connectorId: 1, status: 'Charging' },
    { ts: at(min(8)), connectorId: 1, status: 'Finishing' },
  ];
  const frames: MeterFrame[] = [
    { ts: at(min(1)), registerWh: 1000, currentImportA: 0, currentOfferedA: 0, powerActiveImportW: 0 },   // before window
    { ts: at(min(3)), registerWh: 1100, currentImportA: 16, currentOfferedA: 16, powerActiveImportW: 3840 },
    { ts: at(min(5)), registerWh: 1200, currentImportA: 16, currentOfferedA: 16, powerActiveImportW: 3840 },
    { ts: at(min(7)), registerWh: 1300, currentImportA: 16, currentOfferedA: 16, powerActiveImportW: 3840 },
    { ts: at(min(9)), registerWh: 1300, currentImportA: 0, currentOfferedA: 0, powerActiveImportW: 0 },    // after window
  ];
  const segs = segmentFramesByChargingStatus(statuses, frames);
  assert(segs.length === 1, 'one segment');
  assert(segs[0].length === 3, 'three frames inside [2, 8) min');
  assert(segs[0][0].registerWh === 1100, 'first inside-frame is t=3min');
  assert(segs[0][2].registerWh === 1300, 'last inside-frame is t=7min');
}

console.log('\n--- segmentFramesByChargingStatus: Charging until end-of-window stays open ---');
{
  const statuses: StatusTick[] = [
    { ts: at(0), connectorId: 1, status: 'Charging' },
  ];
  const frames: MeterFrame[] = Array.from({ length: 4 }, (_, i) => ({
    ts: at(min(i)), registerWh: 1000 + i, currentImportA: 16, currentOfferedA: 16, powerActiveImportW: 3840,
  }));
  const segs = segmentFramesByChargingStatus(statuses, frames);
  assert(segs.length === 1, 'one segment');
  assert(segs[0].length === 4, 'all 4 frames captured (no closing transition)');
}

console.log('\n--- segmentFramesByChargingStatus: multiple Charging windows produce separate segments ---');
{
  const statuses: StatusTick[] = [
    { ts: at(0), connectorId: 1, status: 'Charging' },
    { ts: at(min(3)), connectorId: 1, status: 'Available' },
    { ts: at(min(10)), connectorId: 1, status: 'Charging' },
    { ts: at(min(15)), connectorId: 1, status: 'Finishing' },
  ];
  const frames: MeterFrame[] = [
    { ts: at(min(1)), registerWh: 1, currentImportA: 16, currentOfferedA: 16, powerActiveImportW: 3840 },
    { ts: at(min(2)), registerWh: 2, currentImportA: 16, currentOfferedA: 16, powerActiveImportW: 3840 },
    { ts: at(min(11)), registerWh: 100, currentImportA: 16, currentOfferedA: 16, powerActiveImportW: 3840 },
    { ts: at(min(13)), registerWh: 102, currentImportA: 16, currentOfferedA: 16, powerActiveImportW: 3840 },
  ];
  const segs = segmentFramesByChargingStatus(statuses, frames);
  assert(segs.length === 2, 'two segments');
  assert(segs[0].length === 2 && segs[1].length === 2, 'two frames per segment');
}

console.log('\n--- segmentFramesByChargingStatus: idle-only meter frames are NEVER seen by the anomaly detector ---');
{
  // This is the exact false-positive class the reviewer flagged: a flat
  // register during Available was being passed to detectMeterAnomalies
  // and emitted a frozen-register event. With the segmenter in place the
  // detector simply never sees those frames.
  const statuses: StatusTick[] = [
    { ts: at(0), connectorId: 1, status: 'Available' },
  ];
  const idleFlatFrames: MeterFrame[] = Array.from({ length: METER_FROZEN_MIN_FRAMES + 2 }, (_, i) => ({
    ts: at(min(i)), registerWh: 5000, currentImportA: 0, currentOfferedA: 0, powerActiveImportW: 0,
  }));
  const segs = segmentFramesByChargingStatus(statuses, idleFlatFrames);
  // No Charging window → no segments → detector never invoked.
  assert(segs.length === 0, 'idle frames produce zero segments');
  // Sanity: if we DID call the detector on these frames directly, it
  // would falsely flag — confirming the segmenter is what protects us.
  const wouldFalselyFlag = detectMeterAnomalies(idleFlatFrames);
  assert(wouldFalselyFlag.some((e) => (e.payloadSummary as any).subtype === 'frozen-register'),
    'detector alone would false-positive (proves segmenter is necessary)');
}

// ─── Threshold export sanity ──────────────────────────────────────
console.log('\n--- thresholds are sensible ---');
{
  assert(HEARTBEAT_GAP_WARN_MS < HEARTBEAT_GAP_HIGH_MS, 'WARN < HIGH');
  assert(FAULT_LOOP_MIN_COUNT >= 3, 'FAULT_LOOP_MIN_COUNT ≥ 3');
  assert(FAULT_LOOP_WINDOW_MS >= 60_000, 'FAULT_LOOP_WINDOW_MS ≥ 1 min');
  assert(METER_FROZEN_MIN_FRAMES >= 3, 'METER_FROZEN_MIN_FRAMES ≥ 3');
  assert(METER_UNDERCURRENT_MIN_FRAMES >= 3, 'METER_UNDERCURRENT_MIN_FRAMES ≥ 3');
  assert(SESSION_NO_METERING_AFTER_CHARGING_MS >= 60_000, 'SESSION_NO_METERING_AFTER_CHARGING_MS ≥ 1 min');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
