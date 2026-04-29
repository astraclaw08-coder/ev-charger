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

### 4.6 Re-pilot plan

After the patch lands and reaches prod via dev → main release + ocpp-server-fresh redeploy:

1. Pre-flight identical to Gate 1 final state — env still ON (don't roll), connector rollout disabled, pilot policy can stay `alwaysOn=true` (its definition is correct; only the runtime was misreading)
2. Operator: re-enable rollout override on 1A32 connector 1
3. Operator: plug in
4. Verify sL=90 limit=0 push **does NOT happen**; sL=1 limit=16 push **does** happen
5. Verify `Power.Active.Import > 0` within ~30 seconds of session start
6. Stop, restore, write Gate 4 evidence

Total wall-clock estimated: ~30 minutes including operator coordination, assuming readiness gate (heartbeat post-redeploy) is met before plug-in.

---

## 5. Cleanup status (this pilot)

To be filled in by the cleanup pass currently in operator's hands at time of writing:

- [ ] Connector 1 rollout override disabled via portal
- [ ] Active session `991396a8-…` RemoteStop fired
- [ ] Session COMPLETED in DB
- [ ] BillingSnapshot row written (will reflect 0 kWh delivered — expected given the bug)
- [ ] Vehicle unplugged
- [ ] Connector returned to AVAILABLE
- [ ] No further auto-start firing (rollout disabled prevents)

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
