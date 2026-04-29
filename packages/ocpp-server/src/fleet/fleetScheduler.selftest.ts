/**
 * fleetScheduler — Self-Tests (TASK-0208 Phase 2, PR-d)
 * Run: npx ts-node packages/ocpp-server/src/fleet/fleetScheduler.selftest.ts
 *
 * Covers: start/stop idempotency, flag gating, single-session enforcement,
 * window-active vs inactive mode mapping, >1 sessions same charger skip,
 * edge-timer fires at next transition, onSessionEnd clears timer, onBoot
 * drives a reconcile, error-path logging contains full context, applyProfile
 * non-fatal failures do not retry inline.
 */

import {
  startFleetScheduler,
  stopFleetScheduler,
  reconcileCharger,
  reconcileAll,
  onSessionStart,
  onSessionEnd,
  onBoot,
  intendedModeAt,
  __getFleetSchedulerStateForTests,
  __resetFleetSchedulerForTests,
  type SessionForSchedule,
  type TimerFns,
} from './fleetScheduler';
import type { ApplyResult, FleetGateMode } from './applyFleetPolicyProfile';

let passed = 0;
let failed = 0;
function assert(c: boolean, name: string) {
  if (c) { passed++; console.log(`  ✅ ${name}`); }
  else   { failed++; console.error(`  ❌ ${name}`); }
}

// ─── Fake timers ──────────────────────────────────────────────────────
interface FakeTimerFns extends TimerFns {
  runAll: () => Promise<void>;
  counts: { timeout: number; interval: number };
  pending: Map<number, { cb: () => void; ms: number; kind: 'timeout' | 'interval' }>;
}
function makeFakeTimers(): FakeTimerFns {
  let nextId = 1;
  const pending = new Map<number, { cb: () => void; ms: number; kind: 'timeout' | 'interval' }>();
  const counts = { timeout: 0, interval: 0 };
  return {
    setTimeout: (cb, ms) => {
      const id = nextId++;
      pending.set(id, { cb, ms, kind: 'timeout' });
      counts.timeout++;
      return id;
    },
    clearTimeout: (h) => { pending.delete(h as number); },
    setInterval: (cb, ms) => {
      const id = nextId++;
      pending.set(id, { cb, ms, kind: 'interval' });
      counts.interval++;
      return id;
    },
    clearInterval: (h) => { pending.delete(h as number); },
    runAll: async () => {
      const entries = [...pending.entries()];
      for (const [id, e] of entries) {
        if (e.kind === 'timeout') pending.delete(id);
        e.cb();
      }
      await new Promise((r) => setImmediate(r));
    },
    counts,
    pending,
  };
}

// ─── Fake applyProfile factory ────────────────────────────────────────
function makeApplyProfileRecorder(result: ApplyResult = { ok: true, action: 'pushed', state: {} as any }) {
  const calls: Array<{ chargerId: string; ocppId: string; policyId: string; mode: FleetGateMode }> = [];
  const fn = async (opts: any): Promise<ApplyResult> => {
    calls.push({ chargerId: opts.chargerId, ocppId: opts.ocppId, policyId: opts.policy.id, mode: opts.mode });
    return result;
  };
  return { calls, fn };
}

// Sample fleet window: Mon–Fri 22:00 → 06:00 is NOT supported (overnight forbidden),
// so use 10:00–12:00 Mon for deterministic eval.
const MON_10_TO_12: unknown = { windows: [{ day: 1, start: '10:00', end: '12:00' }] };

function sess(
  id: string,
  chargerId: string,
  policyId = 'p1',
  opts: { alwaysOn?: boolean; windowsJson?: unknown } = {},
): SessionForSchedule {
  return {
    sessionId: id,
    chargerId,
    ocppId: `ocpp-${chargerId}`,
    fleetPolicyId: policyId,
    maxAmps: 32,
    windowsJson: opts.windowsJson ?? MON_10_TO_12,
    siteTimeZone: 'America/Los_Angeles',
    alwaysOn: opts.alwaysOn ?? false,
  };
}

// Log capture helper — captures console.warn only for assertion.
function captureWarn<T>(fn: () => Promise<T>): Promise<{ value: T; warnings: string[] }> {
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  return fn().finally(() => { console.warn = origWarn; }).then((value) => ({ value, warnings }));
}

async function main() {

// ─── intendedModeAt mapping ───────────────────────────────────────────
console.log('\n--- intendedModeAt: active=window open ⇒ GATE_RELEASED ---');
{
  // Monday 2026-04-27, 10:30 PT = 17:30 UTC
  const at = new Date('2026-04-27T17:30:00.000Z');
  const r = intendedModeAt(MON_10_TO_12, 'America/Los_Angeles', at);
  assert(r.mode === 'GATE_RELEASED', `mode=GATE_RELEASED (got ${r.mode})`);
  assert(r.nextTransitionAt != null, 'nextTransitionAt set');
}
{
  // Monday 2026-04-27, 09:30 PT — before window
  const at = new Date('2026-04-27T16:30:00.000Z');
  const r = intendedModeAt(MON_10_TO_12, 'America/Los_Angeles', at);
  assert(r.mode === 'GATE_ACTIVE', `mode=GATE_ACTIVE (got ${r.mode})`);
}
{
  // No windows ⇒ permanently inactive ⇒ always GATE_ACTIVE
  const at = new Date('2026-04-27T17:30:00.000Z');
  const r = intendedModeAt({ windows: [] }, 'America/Los_Angeles', at);
  assert(r.mode === 'GATE_ACTIVE', 'empty windows ⇒ GATE_ACTIVE');
}
// ─── intendedModeAt + alwaysOn (TASK-0208 Phase 3 fix) ────────────────
console.log('\n--- intendedModeAt: alwaysOn=true ⇒ GATE_RELEASED, nextTransitionAt=null ---');
{
  // Empty windows + alwaysOn=true → GATE_RELEASED (this is the bug fix path)
  const at = new Date('2026-04-27T17:30:00.000Z');
  const r = intendedModeAt({ windows: [] }, 'America/Los_Angeles', at, /* alwaysOn */ true);
  assert(r.mode === 'GATE_RELEASED', `alwaysOn=true + empty windows ⇒ GATE_RELEASED (got ${r.mode})`);
  assert(r.nextTransitionAt === null, `alwaysOn=true ⇒ no transition (got ${r.nextTransitionAt})`);
}
{
  // Windowed config OUTSIDE window + alwaysOn=true → still GATE_RELEASED
  const at = new Date('2026-04-27T16:30:00.000Z'); // 09:30 PT, before 10:00 window
  const r = intendedModeAt(MON_10_TO_12, 'America/Los_Angeles', at, /* alwaysOn */ true);
  assert(r.mode === 'GATE_RELEASED', 'alwaysOn overrides windows even when outside');
  assert(r.nextTransitionAt === null, 'alwaysOn ⇒ no transition');
}
{
  // Regression guard: alwaysOn=false (or omitted) preserves existing behavior.
  const at = new Date('2026-04-27T17:30:00.000Z');
  const r = intendedModeAt({ windows: [] }, 'America/Los_Angeles', at, /* alwaysOn */ false);
  assert(r.mode === 'GATE_ACTIVE', 'alwaysOn=false + empty windows ⇒ GATE_ACTIVE (regression guard)');
}

// ─── start/stop idempotency ──────────────────────────────────────────
console.log('\n--- start/stop idempotent ---');
{
  __resetFleetSchedulerForTests();
  const timers = makeFakeTimers();
  startFleetScheduler({ timers, flagEnabled: () => true, reconcileMs: 60_000 });
  const s1 = __getFleetSchedulerStateForTests();
  assert(s1.started === true, 'started');
  assert(timers.counts.interval === 1, 'one reconcile interval created');
  startFleetScheduler({ timers, flagEnabled: () => true, reconcileMs: 60_000 });
  assert(timers.counts.interval === 1, 'second start is no-op');
  stopFleetScheduler();
  assert(__getFleetSchedulerStateForTests().started === false, 'stopped');
  stopFleetScheduler(); // second stop no-op (no throw)
  assert(true, 'second stop no-op');
}

// ─── flag-off no-op ───────────────────────────────────────────────────
console.log('\n--- flag off: reconcile is no-op ---');
{
  __resetFleetSchedulerForTests();
  const timers = makeFakeTimers();
  const ap = makeApplyProfileRecorder();
  startFleetScheduler({
    timers, flagEnabled: () => false, reconcileMs: 60_000,
    applyProfile: ap.fn,
    fetchAll: async () => [sess('s1', 'C1')],
    fetchForCharger: async () => [sess('s1', 'C1')],
  });
  await reconcileAll();
  await reconcileCharger('C1');
  assert(ap.calls.length === 0, 'applyProfile not called when flag off');
  stopFleetScheduler();
}

// ─── single-session reconcile calls applyProfile with correct mode ────
console.log('\n--- single session reconcile ---');
{
  __resetFleetSchedulerForTests();
  const timers = makeFakeTimers();
  const ap = makeApplyProfileRecorder();
  const now = () => new Date('2026-04-27T17:30:00.000Z'); // Monday 10:30 PT
  startFleetScheduler({
    timers, now, flagEnabled: () => true, reconcileMs: 60_000,
    applyProfile: ap.fn,
    fetchAll: async () => [sess('s1', 'C1', 'pol-A')],
    fetchForCharger: async (c) => (c === 'C1' ? [sess('s1', 'C1', 'pol-A')] : []),
  });
  await reconcileCharger('C1');
  assert(ap.calls.length === 1, 'one apply call');
  assert(ap.calls[0].mode === 'GATE_RELEASED', 'inside window ⇒ GATE_RELEASED');
  assert(ap.calls[0].policyId === 'pol-A', 'policyId plumbed');
  assert(ap.calls[0].ocppId === 'ocpp-C1', 'ocppId plumbed');
  stopFleetScheduler();
}

// ─── outside window → GATE_ACTIVE ─────────────────────────────────────
console.log('\n--- outside window ⇒ GATE_ACTIVE ---');
{
  __resetFleetSchedulerForTests();
  const timers = makeFakeTimers();
  const ap = makeApplyProfileRecorder();
  const now = () => new Date('2026-04-27T16:30:00.000Z'); // Monday 09:30 PT
  startFleetScheduler({
    timers, now, flagEnabled: () => true,
    applyProfile: ap.fn,
    fetchAll: async () => [sess('s1', 'C1')],
    fetchForCharger: async () => [sess('s1', 'C1')],
  });
  await reconcileCharger('C1');
  assert(ap.calls[0].mode === 'GATE_ACTIVE', 'before window ⇒ GATE_ACTIVE');
  stopFleetScheduler();
}

// ─── alwaysOn=true session ⇒ GATE_RELEASED even outside windows ────────
console.log('\n--- alwaysOn=true session ⇒ GATE_RELEASED through driveCharger ---');
{
  __resetFleetSchedulerForTests();
  const timers = makeFakeTimers();
  const ap = makeApplyProfileRecorder();
  // Outside window: 09:30 PT, MON_10_TO_12 not yet open. Without alwaysOn this
  // would yield GATE_ACTIVE (see test above). With alwaysOn=true the engine
  // must still push GATE_RELEASED — this is the fix the bug doc tracks.
  const now = () => new Date('2026-04-27T16:30:00.000Z');
  const session = sess('s-always', 'C-always', 'p-always', { alwaysOn: true });
  startFleetScheduler({
    timers, now, flagEnabled: () => true,
    applyProfile: ap.fn,
    fetchAll: async () => [session],
    fetchForCharger: async () => [session],
  });
  await reconcileCharger('C-always');
  assert(ap.calls.length === 1, 'applyProfile called once');
  assert(ap.calls[0].mode === 'GATE_RELEASED', `alwaysOn=true outside window ⇒ GATE_RELEASED (got ${ap.calls[0].mode})`);
  // No edge transition expected when alwaysOn (next reconcile tick is the only
  // cadence). Verify no edge timer was set.
  const st = __getFleetSchedulerStateForTests();
  assert(st.edgeTimerKeys.length === 0, 'no edge timer when alwaysOn (nextTransitionAt=null)');
  stopFleetScheduler();
}

// ─── >1 session same charger → warn + skip ────────────────────────────
console.log('\n--- >1 ACTIVE fleet session same charger ---');
{
  __resetFleetSchedulerForTests();
  const timers = makeFakeTimers();
  const ap = makeApplyProfileRecorder();
  const now = () => new Date('2026-04-27T17:30:00.000Z');
  startFleetScheduler({
    timers, now, flagEnabled: () => true,
    applyProfile: ap.fn,
    fetchAll: async () => [sess('s1', 'C1', 'polA'), sess('s2', 'C1', 'polB')],
    fetchForCharger: async () => [sess('s1', 'C1', 'polA'), sess('s2', 'C1', 'polB')],
  });
  const { warnings } = await captureWarn(async () => { await reconcileCharger('C1'); });
  assert(ap.calls.length === 0, 'enforcement skipped');
  assert(warnings.some((w) => w.includes('>1 ACTIVE fleet session')), 'warning logged');
  assert(warnings.some((w) => w.includes('s1') && w.includes('s2')), 'both sessionIds in warning');
  assert(warnings.some((w) => w.includes('C1')), 'chargerId in warning');
  stopFleetScheduler();
}

// ─── edge-timer scheduled, fires reconcile on trigger ─────────────────
console.log('\n--- edge timer scheduled + fires ---');
{
  __resetFleetSchedulerForTests();
  const timers = makeFakeTimers();
  const ap = makeApplyProfileRecorder();
  const now = () => new Date('2026-04-27T17:30:00.000Z');
  startFleetScheduler({
    timers, now, flagEnabled: () => true,
    applyProfile: ap.fn,
    fetchAll: async () => [sess('s1', 'C1')],
    fetchForCharger: async () => [sess('s1', 'C1')],
  });
  await reconcileCharger('C1');
  const st = __getFleetSchedulerStateForTests();
  assert(st.edgeTimerKeys.includes('C1'), 'edge timer registered for C1');
  // Fire pending timers (both reconcile-interval and the edge-timeout)
  const apCallsBefore = ap.calls.length;
  await timers.runAll();
  // The edge timer fires reconcileCharger which makes another apply call.
  // The interval timer also ticks → fetchAll returns [s1] → another apply call.
  // Accept >= 1 additional call.
  assert(ap.calls.length > apCallsBefore, 'edge/interval triggered another apply');
  stopFleetScheduler();
}

// ─── onSessionEnd clears edge timer ───────────────────────────────────
console.log('\n--- onSessionEnd clears edge timer ---');
{
  __resetFleetSchedulerForTests();
  const timers = makeFakeTimers();
  const ap = makeApplyProfileRecorder();
  startFleetScheduler({
    timers, flagEnabled: () => true,
    applyProfile: ap.fn,
    fetchAll: async () => [],
    fetchForCharger: async () => [sess('s1', 'C1')],
  });
  await reconcileCharger('C1');
  assert(__getFleetSchedulerStateForTests().edgeTimerKeys.includes('C1'), 'timer present');
  onSessionEnd('C1');
  assert(!__getFleetSchedulerStateForTests().edgeTimerKeys.includes('C1'), 'timer cleared on end');
  stopFleetScheduler();
}

// ─── onSessionStart drives reconcileCharger ───────────────────────────
console.log('\n--- onSessionStart drives reconcile ---');
{
  __resetFleetSchedulerForTests();
  const timers = makeFakeTimers();
  const ap = makeApplyProfileRecorder();
  startFleetScheduler({
    timers, flagEnabled: () => true,
    applyProfile: ap.fn,
    fetchAll: async () => [],
    fetchForCharger: async (c) => (c === 'C1' ? [sess('s1', 'C1')] : []),
  });
  await onSessionStart('C1');
  assert(ap.calls.length === 1, 'onSessionStart applied once');
  assert(ap.calls[0].chargerId === 'C1', 'for C1');
  stopFleetScheduler();
}

// ─── onBoot re-applies for all ACTIVE fleet sessions on charger ───────
console.log('\n--- onBoot drives reconcile on the charger ---');
{
  __resetFleetSchedulerForTests();
  const timers = makeFakeTimers();
  const ap = makeApplyProfileRecorder();
  startFleetScheduler({
    timers, flagEnabled: () => true,
    applyProfile: ap.fn,
    fetchAll: async () => [],
    fetchForCharger: async (c) => (c === 'C1' ? [sess('s1', 'C1')] : []),
  });
  await onBoot('C1');
  assert(ap.calls.length === 1, 'onBoot applied once (single session)');
  stopFleetScheduler();
}

// ─── enforcement failure logs full context, no inline retry ───────────
console.log('\n--- apply failure logs full context (no retry) ---');
{
  __resetFleetSchedulerForTests();
  const timers = makeFakeTimers();
  const ap = {
    calls: 0,
    fn: async (_opts: any): Promise<ApplyResult> => {
      ap.calls++;
      return { ok: false, error: 'rejected', reason: 'SetChargingProfile Rejected', state: {} as any };
    },
  };
  const now = () => new Date('2026-04-27T17:30:00.000Z');
  startFleetScheduler({
    timers, now, flagEnabled: () => true,
    applyProfile: ap.fn,
    fetchAll: async () => [],
    fetchForCharger: async () => [sess('s-ERR', 'C1', 'pol-ERR')],
  });
  const { warnings } = await captureWarn(async () => { await reconcileCharger('C1'); });
  assert(ap.calls === 1, 'exactly one apply attempt (no inline retry)');
  const errWarn = warnings.find((w) => w.includes('enforcement error'));
  assert(errWarn != null, 'enforcement error logged');
  assert(errWarn!.includes('sessionId=s-ERR'), 'sessionId in log');
  assert(errWarn!.includes('chargerId=C1'), 'chargerId in log');
  assert(errWarn!.includes('fleetPolicyId=pol-ERR'), 'fleetPolicyId in log');
  assert(errWarn!.includes('intendedMode=GATE_RELEASED'), 'intendedMode in log');
  assert(errWarn!.includes('reason=SetChargingProfile Rejected'), 'reason in log');
  stopFleetScheduler();
}

// ─── reconcileAll groups by charger, applies dup-skip per charger ────
console.log('\n--- reconcileAll groups and applies dup-skip per charger ---');
{
  __resetFleetSchedulerForTests();
  const timers = makeFakeTimers();
  const ap = makeApplyProfileRecorder();
  const now = () => new Date('2026-04-27T17:30:00.000Z');
  startFleetScheduler({
    timers, now, flagEnabled: () => true,
    applyProfile: ap.fn,
    fetchAll: async () => [
      sess('sA', 'C1'),
      sess('sB', 'C2', 'p2'),
      sess('sC', 'C2', 'p3'), // dup on C2 → skip
    ],
    fetchForCharger: async () => [],
  });
  const { warnings } = await captureWarn(async () => { await reconcileAll(); });
  assert(ap.calls.length === 1, 'only C1 enforced');
  assert(ap.calls[0].chargerId === 'C1', 'C1 applied');
  assert(warnings.some((w) => w.includes('C2') && w.includes('>1 ACTIVE')), 'C2 skipped with warning');
  stopFleetScheduler();
}

// ─── zero sessions on charger → clears timer, no apply ────────────────
console.log('\n--- zero sessions on charger ---');
{
  __resetFleetSchedulerForTests();
  const timers = makeFakeTimers();
  const ap = makeApplyProfileRecorder();
  startFleetScheduler({
    timers, flagEnabled: () => true,
    applyProfile: ap.fn,
    fetchAll: async () => [],
    fetchForCharger: async () => [],
  });
  await reconcileCharger('C1');
  assert(ap.calls.length === 0, 'no apply when no sessions');
  assert(!__getFleetSchedulerStateForTests().edgeTimerKeys.includes('C1'), 'no edge timer');
  stopFleetScheduler();
}

console.log(`\n${'='.repeat(50)}`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) process.exit(1);

}

main().catch((err) => {
  console.error('Selftest crashed:', err);
  process.exit(1);
});
