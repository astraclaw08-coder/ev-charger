# TASK-0208 Phase 3 — BUG: `FleetPolicy.alwaysOn` not honored by gating engine

**Status:** OPEN — found 2026-04-29 during prod Gate 4 plug-in on 1A32.
**Severity:** High — every fleet pilot with `alwaysOn=true` and an empty `windowsJson` will appear ACTIVE in DB but deliver **zero power** because the engine pushes a 0 A deny profile (sL=90 limit=0).
**Surface:** OCPP runtime (`packages/ocpp-server/src/fleet/fleetScheduler.ts`) + shared window evaluator (`packages/shared/src/fleetWindow.ts`).
**Code path landed:** Phase 2 PR-d (Hybrid-B fleet scheduler). Slice A/B added the `alwaysOn` column + UI but Slice C did not touch the scheduler/window evaluator → column is unread at runtime.

> **Scope clarification (READ FIRST).** This document describes a narrow engine bug — once a fleet session is attached, the gate decision misreads `alwaysOn=true`. It is **not** the same scope as the broader product UX described in §0 below. The engine fix is necessary for any Fleet-Auto session to deliver energy with `alwaysOn=true`, but it is **not by itself sufficient** to prove the no-driver-activation product requirement. See §4.6 Tier 4 for the validation that does close the UX.

---

## 0. Desired Fleet Auto UX (product requirement)

### Product statement

When **Fleet Auto is enabled in the portal** for a site, charger, or specific connector, the driver should not need to activate charging manually. During an allowed charging window, the driver should be able to **plug in** and charging should start automatically — **no mobile app start, no RFID tap, no operator Remote Start.**

### Acceptance criterion

> Given Fleet Auto is enabled for the connector via site/charger/connector portal controls, and the current policy window is allowed, when a vehicle is plugged in, then the OCPP server issues `RemoteStartTransaction` automatically and the resulting `Session` has `fleetPolicyId` attached, `GATE_RELEASED` profile is pushed, and energy flows — without app / RFID / operator activation.

### Connector-level safety nuance

Internally, runtime control remains **connector-level**. Multi-port chargers may need mixed modes (one connector public, one fleet). The portal may expose site-level and charger-level bulk controls, but those resolve into per-connector assignments and rollout flags. The runtime never reads "site is fleet" — it reads `Connector.chargingMode`, `Connector.fleetPolicyId`, and the effective rollout flag (`Connector.fleetAutoRolloutEnabled` ?? `Site.fleetAutoRolloutEnabled`).

### Full enablement preconditions for the UX

For auto-start to fire on plug-in, ALL of the following must hold (this is the existing two-tier gate from the redesign doc §0 #5 + Slice C decision matrix):

1. `FLEET_GATED_SESSIONS_ENABLED=true` (env, emergency kill switch on)
2. Effective rollout for this connector is `true` — resolved as: `Connector.fleetAutoRolloutEnabled` if non-null wins (so a connector `false` overrides a site `true`); a connector `null` inherits `Site.fleetAutoRolloutEnabled`
3. `Connector.chargingMode === 'FLEET_AUTO'`
4. `Connector.fleetPolicyId` resolves to a `FleetPolicy` with `status='ENABLED'`
5. `policy.autoStartIdTag` is set
6. Charger online + readiness gate satisfied (boot + heartbeat per Slice C strict gate)
7. No active session already running on the connector
8. No fresh pending auto-start attempt in flight

The acceptance criterion above is observable end-to-end **only after all 8 are true**. None is optional.

### Out-of-window behavior (intended product behavior)

Per the redesign doc §7 edge-cases table:

> **Plug-in before allow window**: Auto-start creates fleet session; profile applies 0 A; scheduler releases at window open.
> **Plug-in while `alwaysOn=true`**: Auto-start creates fleet session; profile applies `maxAmps` immediately.

So when a vehicle plugs in **outside** the allowed window:

1. `RemoteStartTransaction` still fires (auto-start does not gate on window state).
2. `Session` is created with `fleetPolicyId` attached and `plugInAt` populated.
3. The fleet engine pushes a profile at `sL=90 limit=0` (GATE_ACTIVE) — vehicle holds in `SuspendedEVSE`.
4. When the window opens, the scheduler's edge timer fires and rewrites via same-id replacement (same fleet `chargingProfileId` from `fleetProfileIdFor(chargerId)`, sL=90, limit=`maxAmps`) — vehicle resumes.
5. `BillingSnapshot.preDeliveryGatedMinutes` captures the time the vehicle waited in the deny period.
6. `gatedPricingMode` reflects the policy's gating-mode contract.

This is the design intent recorded in the original redesign doc and is the behavior the next Slice C end-to-end UX test (§4.6 Tier 4) must validate alongside the in-window case.

### Bug vs UX (the distinction this document maintains)

| Concern | Scope | Status |
|---|---|---|
| **Engine bug** | `alwaysOn=true` pushes 0 A after a fleet session is attached, regardless of how the session got attached | covered by §1–§4 of this doc; fix is engine-only |
| **Product UX** | Vehicle plug-in alone (no app, no RFID, no operator click) starts charging when Fleet Auto is enabled | the engine fix is necessary but **not sufficient**; needs the full Slice C activation chain to fire |
| **Validation** | Tier 1/2/3 in §4.6 prove the engine fix in isolation. **Tier 4 (new) proves the actual UX.** Tier 4 is the gating criterion for declaring Fleet Auto pilot-ready. |

The §4.6 validation tiers are deliberately staged. **Do not** treat a green Tier 2 or Tier 3 as proof of the Fleet Auto UX — they are engine-isolation evidence only.

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

### 4.2 Full set of code touchpoints — Option B is bigger than just `evaluateFleetWindowAt`

Picking Option B means the new `alwaysOn?` parameter on `evaluateFleetWindowAt` is the *destination* — but the value has to be plumbed there from the policy row. Without the plumbing, the param goes unused and the bug stays. Concrete touchpoints in `packages/ocpp-server/src/fleet/fleetScheduler.ts`:

| Line / symbol | Change |
|---|---|
| `interface SessionForSchedule` (line ~46) | Add field `alwaysOn: boolean;` |
| `hydrateSessions()` Prisma select (line ~129) | Change `select: { id: true, maxAmps: true, windowsJson: true, site: ... }` → add `alwaysOn: true` |
| `hydrateSessions()` `out.push({...})` (line ~143) | Include `alwaysOn: pol.alwaysOn` in the synthesized session row |
| `driveCharger()` `intendedModeAt(...)` call (line ~358) | Pass `session.alwaysOn` |
| `intendedModeAt()` signature (line ~234) | Either add `alwaysOn: boolean` arg, OR change signature to take a partial policy object `{windowsJson, timeZone, alwaysOn}` |
| `packages/shared/src/fleetWindow.ts` `evaluateFleetWindowAt()` | Add `alwaysOn?: boolean` and short-circuit to `active=true` |

If we miss any of those steps, `alwaysOn` reaches `evaluateFleetWindowAt` as `undefined` and the bug is unchanged. The fix MUST land all six together or none — partial landings are observably broken.

Also worth noting: the **edge-timer scheduling** path also calls into the window evaluator to compute `nextTransitionAt`. With `alwaysOn=true` the natural result is `null` (no transitions ever). That's correct — the 5-min reconcile tick still runs as a backstop, so even if state somehow drifted (operator flips `alwaysOn=false` mid-session), the next tick would notice. No additional change needed in the edge-timer code, but it's worth a regression test to confirm.

### 4.3a Other Phase 2 selftests to extend

- `packages/shared/src/fleetWindow.selftest.ts` — alwaysOn override cases (see §4.4 below).
- `packages/ocpp-server/src/fleet/fleetScheduler.selftest.ts` — `intendedModeAt` with the new arg, plus a hydrateSessions test that asserts `SessionForSchedule.alwaysOn` is populated correctly when fetched.

### 4.3b Schema

No migration needed. `FleetPolicy.alwaysOn` already exists (Slice A migration `20260428180000_task_0208_phase3_slice_a`). The fix is code-only.

### 4.4 Test additions

| Test file | Additions |
|---|---|
| `packages/shared/src/fleetWindow.selftest.ts` | 3 new cases: alwaysOn=true → active=true regardless of `at`/`windows`/`timeZone`; alwaysOn=true with empty windows → active=true; alwaysOn=true with windowed days → still active=true |
| `packages/ocpp-server/src/fleet/fleetScheduler.selftest.ts` | (a) `intendedModeAt(..., alwaysOn=true)` → `mode='GATE_RELEASED'`, `nextTransitionAt=null`. (b) hydrateSessions assertion that `SessionForSchedule.alwaysOn` is populated from the policy row. (c) regression: `intendedModeAt(..., alwaysOn=false)` with empty windows still returns `GATE_ACTIVE` (existing behavior preserved). |
| `packages/ocpp-server/src/fleet/applyFleetPolicyProfile.selftest.ts` | (optional) verify the profile push for GATE_RELEASED carries `stackLevel=90` + `limit=maxAmps`, not the 0 A deny shape |

No new selftest file needed — extend the existing ones.

### 4.5 Sim coverage gap (worth flagging separately)

`sim-fleet-auto.ts` from Slice E acks `SetChargingProfile` without enforcing 0 A. That's why Slice E rehearsal greenlit a policy that would deliver 0 W in real life. Two options:

- **Cheap**: add a profile assertion to the sim — capture the inbound `SetChargingProfile` payload and **fail** the sim if the resulting `mode` doesn't match expectation (alwaysOn → expect sL=90 limit=maxAmps).
- **Expensive**: build a more faithful charger sim that tracks current-offered as a function of pushed profiles.

The cheap option closes this exact regression class. Add to a follow-up PR after the fix lands.

### 4.6 Validation strategy — does NOT depend on Slice C auto-RemoteStart

The `alwaysOn` bug is in the gating engine (`fleetScheduler.intendedModeAt` + `fleetWindow.evaluateFleetWindowAt`). The engine runs **after** a fleet session is attached to a Connector — regardless of HOW the attachment happened. This means the fix can be validated through any path that produces a fleet-attributed `Session`. We deliberately exclude the Slice C auto-RemoteStart path from **engine-isolation** validation because:

- Auto-start surfaced two real-world friction points in Gate 4 (post-redeploy heartbeat wait + readiness gate timing); revalidating both during the same pilot adds variables that aren't relevant to the engine fix.
- The engine fix should be provable in isolation from the activation layer.
- Slice C will be re-tested separately once the engine is known correct — see Tier 4 below and §5.

> **Important — scope of Tier 1, Tier 2, and Tier 3 (read this before reading the tiers):**
>
> Tiers 1–3 prove **the engine pushes the correct profile shape when a fleet session is attached**. They do NOT prove the desired Fleet Auto UX from §0 (no-driver-activation auto-start with `fleetPolicyId` attached, GATE_RELEASED, energy flowing). In every Tier 1–3 path, attachment is performed by something OTHER than Slice C auto-RemoteStart (unit test inputs, Hybrid-B Authorize prefix match, or operator-issued RemoteStart). Tiers 1–3 passing is a **necessary but not sufficient** condition for pilot-readiness — they validate the engine, not the UX.
>
> **Tier 4 (Slice C end-to-end UX validation) is the only tier that proves §0's acceptance criterion.** A green Tier 1–3 with a red or skipped Tier 4 means the engine bug is fixed but the product UX is unverified — do not declare the pilot done in that state.

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
6. **Assert** `csChargingProfiles.stackLevel === 90` AND `csChargingProfiles.chargingSchedule.chargingSchedulePeriod[0].limit === 16` (`alwaysOn=true` → GATE_RELEASED → maxAmps=16)
7. Sim continues with MeterValues / StopTransaction so the BillingSnapshot path runs

The Authorize prefix-match path is the legacy Hybrid-B route that Slice G is going to retire — it is still functional today and is the cleanest non-auto-RemoteStart path to attach a fleet policy to a session. The sim assertion fails before the fix (server pushes sL=90 limit=0) and passes after (sL=90 limit=16).

This addresses the "Slice E sim caveat" that hid the bug originally: the sim ack'd `SetChargingProfile` without checking the payload. Adding the assertion above closes that exact gap permanently.

#### Tier 3 — prod re-pilot on 1A32 (without auto-RemoteStart)

> **PRECONDITION caveat (added 2026-04-29 per reviewer):** the Hybrid-B fleet attachment fires only when the charger sends `Authorize` BEFORE `StartTransaction`. Whether that happens depends on the charger's `AuthorizeRemoteTxRequests` configuration value:
>
> - `AuthorizeRemoteTxRequests=true` → charger sends Authorize on RemoteStart → Hybrid-B prefix-match cache populates → StartTransaction handler `consumeFleetAuthorize()` returns the cached entry → fleet attached.
> - `AuthorizeRemoteTxRequests=false` → charger goes straight to StartTransaction → Authorize cache empty → `consumeFleetAuthorize()` returns null → handler falls through to `consumeFleetAutoStartPending()` which is also null (rollout disabled, Slice C never wrote one) → `Session.fleetPolicyId` stays NULL → engine never runs → Tier 3 doesn't actually exercise the fix.
>
> LOOP firmware default for this key on 1A32 is unknown without checking. **Step 1 of the re-pilot must verify it.**

After Tier 1+2 land in dev and the fix reaches prod (dev → main release + ocpp-server-fresh redeploy):

1. **Pre-flight precondition check.** Operator: portal → 1A32 → Get Configuration. Confirm `AuthorizeRemoteTxRequests=true`. If it's `false` (or unset, depending on firmware default), the operator must `ChangeConfiguration` to set it `true` and reboot the charger if required. Without this, Tier 3 is invalid.
2. Pre-flight state: env flag still ON, all rollout flags `false`, no ENABLED policies global except the pilot, 1A32 ONLINE.
3. Confirm pilot policy still ENABLED (currently is, from Gate 2).
4. Confirm connector still `chargingMode=FLEET_AUTO` + `fleetPolicyId` set (currently is).
5. **Do NOT enable connector rollout override.** With rollout=false, Slice C auto-start cannot fire — the fleet attachment we want comes purely from the Hybrid-B Authorize prefix match.
6. Operator: portal → 1A32 → **Remote Start** with idTag `PILOT-1A32-001` (the policy's autoStartIdTag — matches prefix `PILOT-1A32-`).
7. Vehicle plugged in (or already in).
8. **Mandatory verification before drawing any conclusions about the engine fix:** query the `Session` row created from this StartTransaction. **`Session.fleetPolicyId` MUST be non-null** (= the pilot policy id). If it's null, the Hybrid-B path didn't fire, the engine never ran, and any conclusions about "no 0 A push" are meaningless. Stop the test, investigate `AuthorizeRemoteTxRequests`, retry.
9. With fleet attachment confirmed, verify in OcppLog and on the meter:
   - **NO** profile push with `sL=90 limit=0`
   - **YES** profile push with `sL=90 limit=16`
   - `Power.Active.Import > 0` within ~30 seconds
   - Vehicle actually charges
10. Operator: RemoteStop or unplug.
11. Verify Session COMPLETED, kWh > 0, BillingSnapshot reflects real energy + correct gating-mode classification.

This path exercises the bug-fix code (the engine's gate decision) on the real charger **once step 8 confirms the fleet attachment actually happened**. Without step 8, the test silently degrades into a non-fleet session with no engine activity and no signal value. Pilot wall-clock: ~10–15 min including reconnect-after-redeploy and the precondition check.

#### Fallback if `AuthorizeRemoteTxRequests` can't be set true on this charger

Two backup options if the precondition fails and can't be remediated:

- **Use Slice C auto-RemoteStart for the re-pilot** (relaxing the "without auto-RemoteStart" constraint). Re-enable connector rollout override, plug in, let `maybeAutoStartFleet` write the pending entry, StartTransaction consumes via `consumeFleetAutoStartPending`. Adds the heartbeat-after-redeploy variable but is the only other way to definitively attach a fleet policy on this charger.
- **Skip Tier 3 entirely.** If Tier 1 and Tier 2 pass cleanly, that's strong evidence. Treat Tier 3 as nice-to-have, not gating, for this fix.

Whether Tier 3 ran or was skipped per its fallback, **Tier 4 below is the mandatory gate for declaring the pilot ready.**

#### Tier 4 — Slice C end-to-end UX validation (gates pilot-readiness)

This tier exists to prove the §0 acceptance criterion verbatim. It is the only tier that exercises the full Fleet Auto UX (server-initiated RemoteStart on plug-in, no driver action). **Tier 4 must pass before the pilot is declared ready** — Tiers 1–3 are engine-isolation only and do not substitute for it.

**Pre-flight state (rollout enabled, engine fix deployed):**
- Tier 1 + Tier 2 green.
- Engine fix deployed to prod ocpp-server-fresh.
- Tier 3 is **optional** — if it ran, it should be green; if it was skipped per the Tier 3 fallback, that does not block Tier 4.
- 1A32 ONLINE, heartbeat pre-warmed (`TriggerMessage(Heartbeat)` immediately after redeploy SUCCESS — see §5).
- Pilot policy `fleet-policy-pilot-1a32-2026-04-29` ENABLED, `alwaysOn=true`, `autoStartIdTag=PILOT-1A32-001`, `maxAmps=16`, prefix `PILOT-1A32-`.
- Connector still `chargingMode=FLEET_AUTO` + `fleetPolicyId` set.
- `FLEET_GATED_SESSIONS_ENABLED=true` on prod ocpp-server.
- `Connector.fleetAutoRolloutEnabled=true` (or `Site.fleetAutoRolloutEnabled=true`) — **this is the bit Tier 3 left off; Tier 4 turns it back on.**

**Steps:**

1. Operator: enable connector rollout override on the pilot connector (portal → 1A32 → connector 1 → toggle Fleet Auto rollout ON).
2. Operator: confirm 1A32 readiness gate is satisfied (live WS + heartbeatCount≥1 + bootReceived). If unsure, fire `TriggerMessage(Heartbeat)` from the portal.
3. **Plug in the vehicle. No app action. No RFID swipe. No operator-issued RemoteStart.** This is the UX under test.
4. Verify within ~15 seconds of `StatusNotification(Preparing)`:
   - Server log emits `[fleet.auto-start] Decision: ACCEPTED` for charger 1A32 connector 1, idTag `PILOT-1A32-001`.
   - Server log emits `RemoteStartTransaction` Accepted on attempt 1 (or attempt 2 with the LOOP retry-after-Faulted-blip fallback).
5. Verify the resulting `Session` row:
   - `fleetPolicyId = fleet-policy-pilot-1a32-2026-04-29` (NON-NULL — this is the §0 acceptance criterion).
   - `idTag = PILOT-1A32-001`.
   - `userId` = synthetic fleet user (`clerkId=synthetic-fleet-fleet-policy-pilot-1a32-2026-04-29`).
   - `plugInAt` set, `firstEnergyAt` populated within ~30 s.
6. Verify the engine pushed the correct profile shape:
   - **NO** `SetChargingProfile` with `stackLevel=90 limit=0`.
   - **YES** `SetChargingProfile` with `stackLevel=90 limit=16` (GATE_RELEASED at `maxAmps`).
   - Charger acks Accepted.
7. Verify real-world charging:
   - `Power.Active.Import > 0` from MeterValues within ~30 s.
   - Vehicle visibly charging.
8. Operator: RemoteStop or driver unplugs.
9. Verify Session COMPLETED with `kwhDelivered > 0`.
10. Verify `BillingSnapshot` written with `gatedPricingMode='gated'` and `kwhDelivered > 0`. (`preDeliveryGatedMinutes` should be small since alwaysOn means no real deny dwell.)

**Pass criteria:** every assertion above holds. Any single failure = Tier 4 not passed = pilot NOT ready.

**Why this tier is mandatory:** Tier 3 deliberately leaves rollout OFF and uses operator-issued RemoteStart, so it never exercises `maybeAutoStartFleet`, the readiness gate, the synthetic-user-creation path on plug-in, or the `consumeFleetAutoStartPending` direct-FK attachment. Those are exactly the components that make the §0 UX work. The Gate 4 incident on 2026-04-29 demonstrated that those pieces can each look correct in isolation while the end-to-end UX is broken (in that case by the alwaysOn engine bug). Tier 4 is the only test that catches that class of regression.

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

## 7. Cross-references

- Design source: `tasks/task-0208-phase3-fleet-auto-redesign.md` (PR #71)
- Slice A schema: PR #72
- Slice B operator UX: PR #73
- Slice C runtime auto-start: PR #74
- Slice C readiness patch: PR #80 / release #81
- Phase 2 PR-d (the codepath that ships the bug): pre-Phase-3 fleetScheduler / fleetWindow
- Slice E rehearsal evidence (caveat that hid this bug): `tasks/task-0208-phase3-slice-e-evidence.md`
- Gate 1/2 completion: `tasks/task-0208-phase3-gate1-completion.md`
