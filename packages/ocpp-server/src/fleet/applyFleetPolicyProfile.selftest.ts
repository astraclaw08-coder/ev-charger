/**
 * applyFleetPolicyProfile + fleetProfileId — Self-Tests (TASK-0208 Phase 2, PR-a)
 * Run: npx ts-node packages/ocpp-server/src/fleet/applyFleetPolicyProfile.selftest.ts
 *
 * No external mocking framework. Dependency seams on the helper accept
 * injected `sendProfile`, `readiness`, and `flagEnabled` for isolation.
 */

import {
  applyFleetPolicyProfile,
  getFleetRamState,
  __resetFleetRamStateForTests,
  type FleetPolicyLike,
  type FleetGateMode,
} from './applyFleetPolicyProfile';
import { fleetProfileIdFor, FLEET_PROFILE_ID_BOUNDS } from './fleetProfileId';

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else            { failed++; console.error(`  ❌ ${name}`); }
}

function deepEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ─── Stubs for dependency injection ──────────────────────────────────────

interface SentCall {
  ocppId: string;
  payload: Record<string, unknown>;
}

function makeSendStub(response: 'Accepted' | 'Rejected' | 'NotSupported' | 'throw') {
  const calls: SentCall[] = [];
  const fn = async (ocppId: string, payload: Record<string, unknown>) => {
    calls.push({ ocppId, payload });
    if (response === 'throw') throw new Error('simulated network error');
    return response;
  };
  return { fn, calls };
}

function readyStub(ready: boolean, reason = ready ? 'ok' : 'not ready') {
  return async (_c: string, _o: string) => ({ ready, reason });
}

const ON = () => true;
const OFF = () => false;

const POLICY: FleetPolicyLike = { id: 'policy-alpha', maxAmps: 32 };
const CHARGER = 'charger-1A32-1-2010-00008';
const OCPP = '1A32-1-2010-00008';

async function main() {

// ───────────── fleetProfileId ─────────────────────────────────────────

console.log('\n--- fleetProfileId ---');

{
  const id = fleetProfileIdFor(CHARGER);
  assert(Number.isInteger(id), 'id is integer');
  assert(id >= FLEET_PROFILE_ID_BOUNDS.min && id <= FLEET_PROFILE_ID_BOUNDS.max, 'id in fleet namespace range');
  assert(fleetProfileIdFor(CHARGER) === id, 'id stable for same chargerId');
  assert(fleetProfileIdFor('different-charger') !== id, 'id differs for different charger');
}

{
  let threw = false;
  try { fleetProfileIdFor(''); } catch { threw = true; }
  assert(threw, 'empty chargerId throws');
}

// ───────────── flag gate ───────────────────────────────────────────────

console.log('\n--- flag-off short-circuits ---');

{
  __resetFleetRamStateForTests();
  const send = makeSendStub('Accepted');
  const res = await applyFleetPolicyProfile({
    chargerId: CHARGER, ocppId: OCPP, policy: POLICY, mode: 'GATE_ACTIVE',
    sendProfile: send.fn, readiness: readyStub(true), flagEnabled: OFF,
  });
  assert(res.ok === false && 'skipped' in res && res.skipped === 'flag-off', 'returns flag-off');
  assert(send.calls.length === 0, 'no profile sent when flag off');
  assert(getFleetRamState(CHARGER) === null, 'no RAM state written when flag off');
}

// ───────────── offline / not-ready ────────────────────────────────────

console.log('\n--- offline → PENDING (no push, no state mutation) ---');

{
  __resetFleetRamStateForTests();
  const send = makeSendStub('Accepted');
  const res = await applyFleetPolicyProfile({
    chargerId: CHARGER, ocppId: OCPP, policy: POLICY, mode: 'GATE_ACTIVE',
    sendProfile: send.fn, readiness: readyStub(false, 'boot gate unmet'), flagEnabled: ON,
  });
  assert(res.ok === false && 'skipped' in res && res.skipped === 'offline', 'returns offline');
  assert(res.ok === false && res.reason === 'boot gate unmet', 'carries reason from readiness check');
  assert(send.calls.length === 0, 'no profile sent when not ready');
  assert(getFleetRamState(CHARGER) === null, 'no RAM state mutation when not ready');
}

// ───────────── GATE_ACTIVE push shape ─────────────────────────────────

console.log('\n--- GATE_ACTIVE pushes sL=90 limit=0 CPMaxProfile ---');

{
  __resetFleetRamStateForTests();
  const send = makeSendStub('Accepted');
  const res = await applyFleetPolicyProfile({
    chargerId: CHARGER, ocppId: OCPP, policy: POLICY, mode: 'GATE_ACTIVE',
    sendProfile: send.fn, readiness: readyStub(true), flagEnabled: ON,
  });
  assert(res.ok === true, 'ok=true');
  assert(res.ok === true && res.action === 'pushed', 'action=pushed');
  assert(send.calls.length === 1, 'exactly one CALL emitted');
  const p = send.calls[0].payload as any;
  assert(p.connectorId === 0, 'connectorId=0 (charger-scoped)');
  assert(p.csChargingProfiles.chargingProfileId === fleetProfileIdFor(CHARGER), 'profileId matches derivation');
  assert(p.csChargingProfiles.stackLevel === 90, 'stackLevel=90');
  assert(p.csChargingProfiles.chargingProfilePurpose === 'ChargePointMaxProfile', 'purpose=ChargePointMaxProfile (not TxProfile)');
  assert(p.csChargingProfiles.chargingProfileKind === 'Absolute', 'kind=Absolute');
  assert(p.csChargingProfiles.chargingSchedule.chargingRateUnit === 'A', 'unit=A');
  assert(deepEq(p.csChargingProfiles.chargingSchedule.chargingSchedulePeriod, [{ startPeriod: 0, limit: 0 }]), 'schedule = single 0 A period');
  const state = getFleetRamState(CHARGER);
  assert(state !== null && state.mode === 'GATE_ACTIVE', 'RAM state records mode');
  assert(state !== null && state.lastAppliedAt !== null, 'lastAppliedAt set on Accepted');
  assert(state !== null && state.lastError === null, 'lastError cleared on Accepted');
}

// ───────────── GATE_RELEASED push shape ───────────────────────────────

console.log('\n--- GATE_RELEASED pushes same-id sL=90 limit=maxAmps ---');

{
  __resetFleetRamStateForTests();
  const send = makeSendStub('Accepted');
  const res = await applyFleetPolicyProfile({
    chargerId: CHARGER, ocppId: OCPP, policy: POLICY, mode: 'GATE_RELEASED',
    sendProfile: send.fn, readiness: readyStub(true), flagEnabled: ON,
  });
  assert(res.ok === true, 'ok=true');
  const p = send.calls[0].payload as any;
  assert(p.csChargingProfiles.chargingProfileId === fleetProfileIdFor(CHARGER), 'SAME profileId as GATE_ACTIVE (same-id replace)');
  assert(p.csChargingProfiles.stackLevel === 90, 'stackLevel=90 (dominates charger CPMax baseline at sL=60)');
  assert(p.csChargingProfiles.chargingProfilePurpose === 'ChargePointMaxProfile', 'purpose=ChargePointMaxProfile (same as deny)');
  assert(p.csChargingProfiles.chargingProfileKind === 'Absolute', 'kind=Absolute');
  assert(deepEq(p.csChargingProfiles.chargingSchedule.chargingSchedulePeriod, [{ startPeriod: 0, limit: 32 }]), 'schedule = maxAmps (32)');
  const state = getFleetRamState(CHARGER);
  assert(state !== null && state.mode === 'GATE_RELEASED', 'RAM state records GATE_RELEASED');
  assert(state !== null && state.stackLevel === 90, 'RAM state stackLevel=90');
  assert(state !== null && state.limitAmps === 32, 'RAM state limitAmps=maxAmps');
}

// ───────────── stackLevel symmetry between modes (regression guard for
// 2026-04-29 baseline-loses bug) ──────────────────────────────────────

console.log('\n--- deny + release push at the SAME stackLevel (sL=90) ---');

{
  __resetFleetRamStateForTests();
  const sendDeny = makeSendStub('Accepted');
  await applyFleetPolicyProfile({
    chargerId: CHARGER, ocppId: OCPP, policy: POLICY, mode: 'GATE_ACTIVE',
    sendProfile: sendDeny.fn, readiness: readyStub(true), flagEnabled: ON,
  });
  const denyPayload = sendDeny.calls[0].payload as any;

  __resetFleetRamStateForTests();
  const sendRelease = makeSendStub('Accepted');
  await applyFleetPolicyProfile({
    chargerId: CHARGER, ocppId: OCPP, policy: POLICY, mode: 'GATE_RELEASED',
    sendProfile: sendRelease.fn, readiness: readyStub(true), flagEnabled: ON,
  });
  const releasePayload = sendRelease.calls[0].payload as any;

  assert(
    denyPayload.csChargingProfiles.stackLevel === releasePayload.csChargingProfiles.stackLevel,
    `deny stackLevel === release stackLevel (deny=${denyPayload.csChargingProfiles.stackLevel}, release=${releasePayload.csChargingProfiles.stackLevel})`,
  );
  assert(denyPayload.csChargingProfiles.stackLevel === 90, 'both modes use sL=90');
  assert(
    denyPayload.csChargingProfiles.chargingProfileId === releasePayload.csChargingProfiles.chargingProfileId,
    'deny + release share the same chargingProfileId',
  );
  // The whole point of the fix: same sL, different limit.
  const denyLimit = denyPayload.csChargingProfiles.chargingSchedule.chargingSchedulePeriod[0].limit;
  const releaseLimit = releasePayload.csChargingProfiles.chargingSchedule.chargingSchedulePeriod[0].limit;
  assert(denyLimit === 0, 'deny limit=0');
  assert(releaseLimit === 32, 'release limit=maxAmps (32)');
}

// ───────────── idempotency — skip re-push of identical state ──────────

console.log('\n--- idempotent: second identical apply skips the CALL ---');

{
  __resetFleetRamStateForTests();
  const send = makeSendStub('Accepted');
  const common = {
    chargerId: CHARGER, ocppId: OCPP, policy: POLICY, mode: 'GATE_ACTIVE' as FleetGateMode,
    sendProfile: send.fn, readiness: readyStub(true), flagEnabled: ON,
  };
  await applyFleetPolicyProfile(common);
  const res2 = await applyFleetPolicyProfile(common);
  assert(res2.ok === true && res2.action === 'skipped-idempotent', 'second call marks skipped-idempotent');
  assert(send.calls.length === 1, 'still only one CALL emitted');
  const s = getFleetRamState(CHARGER)!;
  assert(s.lastAttemptAt.getTime() >= s.lastAppliedAt!.getTime(), 'lastAttemptAt bumped on idempotent skip');
}

// ───────────── mode change → fresh push ───────────────────────────────

console.log('\n--- mode flip GATE_ACTIVE → GATE_RELEASED re-pushes ---');

{
  __resetFleetRamStateForTests();
  const send = makeSendStub('Accepted');
  await applyFleetPolicyProfile({
    chargerId: CHARGER, ocppId: OCPP, policy: POLICY, mode: 'GATE_ACTIVE',
    sendProfile: send.fn, readiness: readyStub(true), flagEnabled: ON,
  });
  const res2 = await applyFleetPolicyProfile({
    chargerId: CHARGER, ocppId: OCPP, policy: POLICY, mode: 'GATE_RELEASED',
    sendProfile: send.fn, readiness: readyStub(true), flagEnabled: ON,
  });
  assert(res2.ok === true && res2.action === 'pushed', 'second apply pushes on mode change');
  assert(send.calls.length === 2, 'two CALLs emitted total');
}

// ───────────── policy switch triggers re-push ──────────────────────────

console.log('\n--- policy id change on same charger triggers re-push ---');

{
  __resetFleetRamStateForTests();
  const send = makeSendStub('Accepted');
  await applyFleetPolicyProfile({
    chargerId: CHARGER, ocppId: OCPP, policy: POLICY, mode: 'GATE_ACTIVE',
    sendProfile: send.fn, readiness: readyStub(true), flagEnabled: ON,
  });
  await applyFleetPolicyProfile({
    chargerId: CHARGER, ocppId: OCPP, policy: { id: 'policy-beta', maxAmps: 32 }, mode: 'GATE_ACTIVE',
    sendProfile: send.fn, readiness: readyStub(true), flagEnabled: ON,
  });
  assert(send.calls.length === 2, 'policy swap re-pushes');
}

// ───────────── maxAmps clamping ────────────────────────────────────────

console.log('\n--- maxAmps clamping ---');

{
  __resetFleetRamStateForTests();
  const send = makeSendStub('Accepted');
  await applyFleetPolicyProfile({
    chargerId: CHARGER, ocppId: OCPP, policy: { id: 'p', maxAmps: 999 }, mode: 'GATE_RELEASED',
    sendProfile: send.fn, readiness: readyStub(true), flagEnabled: ON,
  });
  const p1 = send.calls[0].payload as any;
  assert(p1.csChargingProfiles.chargingSchedule.chargingSchedulePeriod[0].limit === 80, 'clamped to upper bound 80');
}

{
  __resetFleetRamStateForTests();
  const send = makeSendStub('Accepted');
  await applyFleetPolicyProfile({
    chargerId: CHARGER, ocppId: OCPP, policy: { id: 'p', maxAmps: 2 }, mode: 'GATE_RELEASED',
    sendProfile: send.fn, readiness: readyStub(true), flagEnabled: ON,
  });
  const p1 = send.calls[0].payload as any;
  assert(p1.csChargingProfiles.chargingSchedule.chargingSchedulePeriod[0].limit === 6, 'clamped to lower bound 6');
}

// ───────────── rejection path ─────────────────────────────────────────

console.log('\n--- firmware rejection records lastError, no lastAppliedAt bump ---');

{
  __resetFleetRamStateForTests();
  const send = makeSendStub('Rejected');
  const res = await applyFleetPolicyProfile({
    chargerId: CHARGER, ocppId: OCPP, policy: POLICY, mode: 'GATE_ACTIVE',
    sendProfile: send.fn, readiness: readyStub(true), flagEnabled: ON,
  });
  assert(res.ok === false && (res as any).error === 'rejected', 'returns error=rejected');
  const s = getFleetRamState(CHARGER)!;
  assert(s.lastError !== null && s.lastError.includes('Rejected'), 'lastError captures status');
  assert(s.lastAppliedAt === null, 'lastAppliedAt not bumped on rejection');
}

// ───────────── exception path ─────────────────────────────────────────

console.log('\n--- exception is captured, RAM state updated with error ---');

{
  __resetFleetRamStateForTests();
  const send = makeSendStub('throw');
  const res = await applyFleetPolicyProfile({
    chargerId: CHARGER, ocppId: OCPP, policy: POLICY, mode: 'GATE_ACTIVE',
    sendProfile: send.fn, readiness: readyStub(true), flagEnabled: ON,
  });
  assert(res.ok === false && (res as any).error === 'exception', 'returns error=exception');
  const s = getFleetRamState(CHARGER)!;
  assert(s.lastError !== null && s.lastError.includes('simulated'), 'lastError holds exception msg');
}

// ───────────── preserve prior lastAppliedAt on later failure ──────────

console.log('\n--- prior successful lastAppliedAt preserved across later failure ---');

{
  __resetFleetRamStateForTests();
  const sendOk = makeSendStub('Accepted');
  await applyFleetPolicyProfile({
    chargerId: CHARGER, ocppId: OCPP, policy: POLICY, mode: 'GATE_ACTIVE',
    sendProfile: sendOk.fn, readiness: readyStub(true), flagEnabled: ON,
  });
  const firstApplied = getFleetRamState(CHARGER)!.lastAppliedAt!;

  const sendFail = makeSendStub('Rejected');
  await applyFleetPolicyProfile({
    chargerId: CHARGER, ocppId: OCPP, policy: POLICY, mode: 'GATE_RELEASED',
    sendProfile: sendFail.fn, readiness: readyStub(true), flagEnabled: ON,
  });
  const s = getFleetRamState(CHARGER)!;
  assert(s.lastAppliedAt !== null && s.lastAppliedAt.getTime() === firstApplied.getTime(), 'lastAppliedAt unchanged after later rejection');
  assert(s.mode === 'GATE_RELEASED', 'mode reflects attempted mode even on rejection');
}

// ───────────── summary ────────────────────────────────────────────────

console.log(`\n${'='.repeat(50)}`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) process.exit(1);

}

main().catch((err) => {
  console.error('Selftest crashed:', err);
  process.exit(1);
});
