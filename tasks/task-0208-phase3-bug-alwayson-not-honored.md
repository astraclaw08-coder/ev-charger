# TASK-0208 Phase 3 — BUG: `FleetPolicy.alwaysOn` not honored by gating engine

**Status:** OPEN — found 2026-04-29 during prod Gate 4 plug-in on 1A32.
**Severity:** High — every fleet pilot with `alwaysOn=true` and an empty `windowsJson` will appear ACTIVE in DB but deliver **zero power** because the engine pushes a 0 A deny profile (sL=90 limit=0).
**Surface:** OCPP runtime (`packages/ocpp-server/src/fleet/fleetScheduler.ts`) + shared window evaluator (`packages/shared/src/fleetWindow.ts`).
**Code path landed:** Phase 2 PR-d (Hybrid-B fleet scheduler). Slice A/B added the `alwaysOn` column + UI but Slice C did not touch the scheduler/window evaluator → column is unread at runtime.

---

## 1. Reproduction (live evidence from 1A32 prod pilot)

| Item | Value |
|---|---|
| Charger | `1A32-1-2010-00008` (LOOP firmware, Location Alpha) |
| Policy | `fleet-policy-pilot-1a32-2026-04-29` — status=ENABLED, **alwaysOn=true**, autoStartIdTag=`PILOT-1A32-001`, maxAmps=16, windowsJson=`{"windows":[]}` |
| Connector 1 | chargingMode=FLEET_AUTO, fleetPolicyId set, rollout override=true |
| Env flag | `FLEET_GATED_SESSIONS_ENABLED=true` |
| Session | `991396a8-4270-4312-b78d-dd8e01507ee8` ACTIVE, fleetPolicyId attached, synthetic user `62e2f53a-…` |
| Vehicle | plugged in 05:42:48Z, RemoteStart fired 05:49:09Z (after natural heartbeat landed in patched OCPP process) |

### What the OCPP server pushed

| Time (UTC) | Profile id | stackLevel | limit | Source |
|---|---|---|---|---|
| 05:49:11 | `1` | 60 | 32 A | smartCharging baseline (unrelated) |
| **05:49:17** | **`1741013210`** | **90** | **0 A** | **fleet engine — `mode='GATE_ACTIVE'` (deny push)** |

OCPP rule: higher `stackLevel` wins. Fleet sL=90 limit=0 beat smartCharging sL=60 limit=32 → charger offered **0 A** to the vehicle.

### What the meter reported (3+ minutes after session start)

| Measurand | Value |
|---|---|
| `Power.Active.Import` | **0.00 W** |
| `Current.Import` | 0.00 A |
| `Current.Offered` | 0.00 A |
| `Energy.Active.Import.Register` | unchanged 10,640,706.3 Wh across consecutive samples |
| Connector status | `SuspendedEVSE` (with PowerSwitchFailure flap — known F5h-benign firmware quirk during 0 A dwell) |

Vehicle plugged in, session ACTIVE, billing gated, but **no energy flowed**.

### Why the gate said GATE_ACTIVE

`evaluateFleetWindowAt({at, windows: [], timeZone})` returns `{active: false}` because no window matches the current time (there are no windows). `intendedModeAt` then maps `active=false` → `GATE_ACTIVE` → push limit=0.

The policy's `alwaysOn=true` is **never read** at any point in the gating decision.

---

## 2. Root cause — code locations

### 2.1 `packages/ocpp-server/src/fleet/fleetScheduler.ts:234-244`

```ts
/** Intended gate mode for a given policy at a given instant. */
export function intendedModeAt(
  windowsJson: unknown,
  timeZone: string | null,
  at: Date,
): { mode: FleetGateMode; nextTransitionAt: Date | null } {
  const evalResult = evaluateFleetWindowAt({ at, windows: windowsJson, timeZone });
  return {
    mode: evalResult.active ? 'GATE_RELEASED' : 'GATE_ACTIVE',
    nextTransitionAt: evalResult.nextTransitionAt,
  };
}
```

`intendedModeAt` takes only `(windowsJson, timeZone, at)`. It has **no access to `policy.alwaysOn`**. The bug is that this signature was chosen in Phase 2 before the field existed; Phase 3 added the field but did not refactor the helper.

### 2.2 `packages/shared/src/fleetWindow.ts` — `evaluateFleetWindowAt`

The window evaluator is a pure-function: given `(at, windows, timeZone)`, returns `{active, matchedWindow, nextTransitionAt}`. No `alwaysOn` parameter; empty `windows` evaluates to `active=false` for all `at`.

### 2.3 Confirmed by grep

```
$ grep -rnE 'alwaysOn' packages/ocpp-server/src --include='*.ts'
(no output — column is never read in the runtime)
```

`alwaysOn` is referenced **only** in the schema, the FleetPolicy validator, the operator portal form, and the validator selftest. **Zero references** in the OCPP runtime.

### 2.4 Why the existing test suites didn't catch it

| Suite | Why it missed the bug |
|---|---|
| `shared/fleetPolicy.selftest` (Phase 3 Slice A/B) | Validates the input shape only — does not exercise the runtime gate decision |
| `ocpp-server/fleet/fleetScheduler.selftest` (Phase 2 PR-d) | Predates `alwaysOn`; tests window-only scenarios |
| `ocpp-server/fleet/fleetAutoStart.selftest` (Phase 3 Slice C) | Tests the auto-start decision matrix and readiness gate; does not call into `intendedModeAt` or `applyFleetPolicyProfile` |
| Slice E local rehearsal | Used `alwaysOn=true` AND saw the engine push a profile, but the simulator acks `SetChargingProfile` without enforcing 0 A. The `gatedPricingMode='gated'` BillingSnapshot value masked the fact that gating-mode was wrong — the snapshot fields were being populated, just with the wrong intent. **The Slice E "sim-only caveat" we documented (sim doesn't enforce 0 A) hid this exact bug.** |

The bug is only observable on a real charger that obeys the profile.

---

## 3. Operational impact

- **Any policy with `alwaysOn=true` and an empty `windowsJson` is broken end-to-end at runtime.** It will pass operator validation (Slice B accepts the input), pass auto-start activation (Slice C fires correctly), attach to a Session, populate billing snapshot fields, but deliver **0 W** for the entire session.
- **Workaround for operators today**: use `alwaysOn=false` + a wide `windowsJson` covering the desired allow period (e.g. one window per day Sun-Sat 00:00–23:59). This forces the engine through the existing window-evaluation path that Phase 2 PR-d ships and is known-correct.
- **No data corruption**: the bug is in profile-push intent, not data persistence. Existing sessions, billing snapshots, and audit rows are correct.
- **Pilot recovery cost**: low. The 1A32 pilot session can be restored to a working state by either flipping the policy to `alwaysOn=false` + windowed, or shipping the patch below.

---

## 4. Fix plan

### 4.1 Code change shape

Two clean places to honor `alwaysOn`. Recommendation: **Option B** (push the rule into `evaluateFleetWindowAt`) so a single source of truth answers "is the gate active right now?"

#### Option A — short-circuit in `intendedModeAt`

```ts
// fleetScheduler.ts
export function intendedModeAt(
  windowsJson: unknown,
  timeZone: string | null,
  at: Date,
  alwaysOn: boolean,           // NEW
): { mode: FleetGateMode; nextTransitionAt: Date | null } {
  if (alwaysOn) {
    return { mode: 'GATE_RELEASED', nextTransitionAt: null };
  }
  const evalResult = evaluateFleetWindowAt({ at, windows: windowsJson, timeZone });
  return {
    mode: evalResult.active ? 'GATE_RELEASED' : 'GATE_ACTIVE',
    nextTransitionAt: evalResult.nextTransitionAt,
  };
}
```

Caller sites in fleetScheduler must thread `policy.alwaysOn` through. Edge timers also need to know "no transitions ever" when `alwaysOn=true`.

#### Option B — fold into `evaluateFleetWindowAt` (preferred)

```ts
// shared/fleetWindow.ts
export function evaluateFleetWindowAt(args: {
  at: Date;
  windows: unknown;
  timeZone?: string | null;
  alwaysOn?: boolean;         // NEW (defaults false)
}): FleetWindowEval {
  if (args.alwaysOn) {
    return { active: true, matchedWindow: null, nextTransitionAt: null };
  }
  // ... existing logic
}
```

Caller in fleetScheduler:

```ts
const evalResult = evaluateFleetWindowAt({
  at, windows: windowsJson, timeZone, alwaysOn: policy.alwaysOn,
});
```

Option B keeps `intendedModeAt`'s signature clean (single source of truth lives in shared) and means the existing fleetScheduler.selftest framework that exercises window evaluation also exercises the alwaysOn override.

### 4.2 Other call sites that need `alwaysOn`

Any place that passes `windowsJson` into `evaluateFleetWindowAt` or computes a "next transition" needs the `alwaysOn` value. From a quick grep:

- `fleetScheduler.ts` `intendedModeAt` — direct caller
- `fleetScheduler.ts` edge-timer scheduling — uses `nextTransitionAt`. With `alwaysOn=true` the result is `null` → no edge timer needed. The reconcile-tick fallback still runs every 5 min as a backstop.
- `packages/shared/src/fleetWindow.selftest.ts` — extend with alwaysOn cases.
- Anywhere else in `fleetScheduler.ts` that loads policies needs to also `select: { alwaysOn: true }` from Prisma.

### 4.3 Schema

No migration needed. `FleetPolicy.alwaysOn` already exists (Slice A migration `20260428180000_task_0208_phase3_slice_a`). The fix is code-only.

### 4.4 Test additions

| Test file | Additions |
|---|---|
| `packages/shared/src/fleetWindow.selftest.ts` | 3 new cases: alwaysOn=true → active=true regardless of `at`/`windows`/`timeZone`; alwaysOn=true with empty windows → active=true; alwaysOn=true with windowed days → still active=true |
| `packages/ocpp-server/src/fleet/fleetScheduler.selftest.ts` | 1 new case for `intendedModeAt`: policy.alwaysOn=true with empty windowsJson at any time → `mode='GATE_RELEASED'`, `nextTransitionAt=null` |
| `packages/ocpp-server/src/fleet/applyFleetPolicyProfile.selftest.ts` | (optional) verify the profile push for GATE_RELEASED carries `stackLevel=1` + `limit=maxAmps`, not the 0 A deny shape |

No new selftest file needed — extend the existing ones.

### 4.5 Sim coverage gap (worth flagging separately)

`sim-fleet-auto.ts` from Slice E acks `SetChargingProfile` without enforcing 0 A. That's why Slice E rehearsal greenlit a policy that would deliver 0 W in real life. Two options:

- **Cheap**: add a profile assertion to the sim — capture the inbound `SetChargingProfile` payload and **fail** the sim if the resulting `mode` doesn't match expectation (alwaysOn → expect sL=1 limit=maxAmps).
- **Expensive**: build a more faithful charger sim that tracks current-offered as a function of pushed profiles.

The cheap option closes this exact regression class. Add to a follow-up PR after the fix lands.

### 4.6 Validation strategy — does NOT depend on Slice C auto-RemoteStart

The `alwaysOn` bug is in the gating engine (`fleetScheduler.intendedModeAt` + `fleetWindow.evaluateFleetWindowAt`). The engine runs **after** a fleet session is attached to a Connector — regardless of HOW the attachment happened. This means the fix can be validated through any path that produces a fleet-attributed `Session`. We deliberately exclude the Slice C auto-RemoteStart path from validation because:

- Auto-start surfaced two real-world friction points in Gate 4 (post-redeploy heartbeat wait + readiness gate timing); revalidating both during the same pilot adds variables that aren't relevant to the engine fix.
- The engine fix should be provable in isolation from the activation layer.
- Slice C will be re-tested separately once the engine is known correct — see §5 below.

#### Tier 1 — unit tests (deterministic, fastest)

Add to `packages/shared/src/fleetWindow.selftest.ts`:
- `alwaysOn=true + windows=[]` at any `at`/`timeZone` → `{active: true, matchedWindow: null, nextTransitionAt: null}`
- `alwaysOn=true + windows=[some-day-mon-9-17]` at Sunday midnight → still `active: true` (alwaysOn overrides windows)
- `alwaysOn=false + windows=[]` at any `at` → `{active: false}` (existing behavior preserved)

Add to `packages/ocpp-server/src/fleet/fleetScheduler.selftest.ts`:
- `intendedModeAt(windows=[], timeZone, at, alwaysOn=true)` → `mode='GATE_RELEASED'`, `nextTransitionAt=null`
- `intendedModeAt(windows=[mon-9-17], timeZone, sundayMidnight, alwaysOn=true)` → `mode='GATE_RELEASED'`
- `intendedModeAt(windows=[], timeZone, at, alwaysOn=false)` → `mode='GATE_ACTIVE'` (regression guard)

These tests fail before the fix and pass after. They do not require any prod resource.

#### Tier 2 — local OCPP sim with profile-shape assertion (no auto-start)

Modify `packages/ocpp-server/src/scripts/sim-fleet-auto.ts` (or write a sibling `sim-hybrid-b.ts`) to drive a session via the **Hybrid-B Authorize prefix path** instead of waiting for a server-initiated RemoteStart:

1. Connect, BootNotification, Heartbeat
2. `StatusNotification(Available) → (Preparing)` (just like before)
3. **Sim sends `Authorize` with idTag `PILOT-1A32-001`** (matches policy prefix `PILOT-1A32-`)
4. Sim sends `StartTransaction` with that idTag
5. Sim **captures** the inbound `SetChargingProfile` payload from the server
6. **Assert** `csChargingProfiles.stackLevel === 1` AND `csChargingProfiles.chargingSchedule.chargingSchedulePeriod[0].limit === 16` (`alwaysOn=true` → GATE_RELEASED → maxAmps=16)
7. Sim continues with MeterValues / StopTransaction so the BillingSnapshot path runs

The Authorize prefix-match path is the legacy Hybrid-B route that Slice G is going to retire — it is still functional today and is the cleanest non-auto-RemoteStart path to attach a fleet policy to a session. The sim assertion fails before the fix (server pushes sL=90 limit=0) and passes after (sL=1 limit=16).

This addresses the "Slice E sim caveat" that hid the bug originally: the sim ack'd `SetChargingProfile` without checking the payload. Adding the assertion above closes that exact gap permanently.

#### Tier 3 — prod re-pilot on 1A32 (without auto-RemoteStart)

After Tier 1+2 land in dev and the fix reaches prod (dev → main release + ocpp-server-fresh redeploy):

1. Pre-flight: env flag still ON, all rollout flags `false`, no ENABLED policies global except the pilot, 1A32 ONLINE
2. **Re-enable** the pilot policy if it was disabled during teardown (it's currently `ENABLED` from Gate 2 — confirm)
3. **Re-enable** connector chargingMode=FLEET_AUTO + fleetPolicyId assignment if those were cleared during teardown (currently still set from Gate 2 — confirm)
4. **Do NOT enable connector rollout override.** With rollout=false, Slice C auto-start cannot fire.
5. Operator: portal → 1A32 → **Remote Start** with idTag `PILOT-1A32-001` (manually invokes the `POST /chargers/:id/remote-start` operator endpoint with the policy's autoStartIdTag — Authorize will fire Hybrid-B prefix match and attach the policy to the session)
6. Vehicle plugged in (or already in)
7. Verify in OcppLog and on the meter:
   - **NO** profile push with `sL=90 limit=0`
   - **YES** profile push with `sL=1 limit=16`
   - `Power.Active.Import > 0` within ~30 seconds
   - Vehicle actually charges
8. Operator: RemoteStop or unplug
9. Verify Session COMPLETED, kWh > 0, BillingSnapshot reflects real energy

This path exercises the bug-fix code (the engine's gate decision) on the real charger without depending on Slice C auto-start working post-redeploy. Pilot wall-clock: ~10 min including reconnect-after-redeploy.

After Tier 3 succeeds, **then** separately re-test Slice C auto-RemoteStart end-to-end with the heartbeat-pre-warm precaution noted in §5.

---

## 5. Operational notes for the next prod pilot

- **Pre-warm heartbeat after any OCPP redeploy.** The patched OCPP process starts with an empty `clientRegistry`. 1A32's natural heartbeat cadence (~15 min) caused a 7-min wait between operator plug-in and the first auto-start eligible moment. Operator can fire `TriggerMessage(Heartbeat)` from the portal immediately after the deploy SUCCESS to set `heartbeatCount=1` and unblock the readiness gate without waiting for nature.
- **Tier 2 sim assertion catches this regression class.** If the alwaysOn fix lands without the sim assertion upgrade, future similar bugs (engine pushes wrong profile shape) will not be caught in CI. Worth the small extra effort.
- **`Session.kwhDelivered=0` is a useful red-flag signal.** Any fleet session that completes with zero energy AND non-zero `preDeliveryGatedMinutes` is a strong candidate for "engine pushed deny when it shouldn't have." Could be a future ops-dashboard alert.

---

## 6. Cleanup status (this pilot) — completed 2026-04-29

| Step | Status | Evidence |
|---|---|---|
| Connector 1 rollout override disabled via portal | ✅ | AdminAuditEvent `d7debf0e-…` `fleet.rollout.connector.update` old=`true` new=`false` at 05:56:49Z |
| Vehicle unplugged | ✅ | StopTransaction received from charger 15:12:42Z |
| Session COMPLETED | ✅ | `991396a8-…` status `COMPLETED` at 15:12:34.58Z |
| BillingSnapshot row written | ✅ | kwhDelivered=`0`, grossAmountUsd=`0`, preDeliveryGatedMinutes=`0.323`, gatedPricingMode=`gated` (zero energy as predicted by the bug) |
| Connector returned to AVAILABLE | ✅ |
| No further auto-start firing | ✅ rollout disabled |
| Env flag (`FLEET_GATED_SESSIONS_ENABLED`) | retained ON in prod (deliberate per Gate 3 decision — emergency-only kill switch) |
| Pilot policy `fleet-policy-pilot-1a32-2026-04-29` | retained ENABLED (no harm — runtime gate still closed via rollout flag) |
| Connector chargingMode | retained FLEET_AUTO + fleetPolicyId assignment (no harm — runtime gate still closed) |

Final prod state: identical-effect to Gate 1 dark deploy. Two-tier rollout gate is closed at the rollout-flag tier; engine code can still be deployed/replaced without affecting runtime behavior.

---

## 6. Cross-references

- Design source: `tasks/task-0208-phase3-fleet-auto-redesign.md` (PR #71)
- Slice A schema: PR #72
- Slice B operator UX: PR #73
- Slice C runtime auto-start: PR #74
- Slice C readiness patch: PR #80 / release #81
- Phase 2 PR-d (the codepath that ships the bug): pre-Phase-3 fleetScheduler / fleetWindow
- Slice E rehearsal evidence (caveat that hid this bug): `tasks/task-0208-phase3-slice-e-evidence.md`
- Gate 1/2 completion: `tasks/task-0208-phase3-gate1-completion.md`
