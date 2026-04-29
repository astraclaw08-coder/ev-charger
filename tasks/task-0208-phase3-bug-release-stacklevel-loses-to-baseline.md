# TASK-0208 Phase 3 — Bug: fleet release-profile stackLevel loses to charger CPMax baseline

**Status:** Filed 2026-04-29 from Tier 4-Windowed E2E results on 1A32.
**Severity:** Medium — `FleetPolicy.maxAmps` is silently a no-op for amperage cap on chargers that ship with a non-fleet `ChargePointMaxProfile` baseline at any `stackLevel > 1`. Deny/release toggle still works.
**Sibling of:** `task-0208-phase3-bug-alwayson-not-honored.md` (PR #84). Same engine bug class — runtime delivers something other than what the policy says — different root cause.

---

## 1. Reproduction (Tier 4-Windowed run, 2026-04-29)

Pilot: `fleet-policy-pilot-1a32-2026-04-29`, `maxAmps=16`, single window 13:32–13:37 PT (Wed). Operator plugged in at ~13:29:50 PT.

Engine pushed three profiles (one per phase transition):

| Phase | UTC | `stackLevel` | `limit` | charger ack |
|---|---|---|---|---|
| A. pre-window deny | 20:29:22 | 90 | 0 | Accepted |
| B. window-open release | 20:32:02 | **1** | **16** | Accepted |
| C. window-close deny | 20:37:02 | 90 | 0 | Accepted |

Phase B meter readings (every ~20 s for 5 min):

| Time UTC | Current.Import (A) | Current.Offered (A) | Power.Active.Import (W) |
|---|---|---|---|
| 20:32:22 | 14.79 | 25.00 | 3,600 |
| 20:32:41 | **24.69** | **25.00** | 5,956 |
| 20:33:00 | **24.73** | **25.00** | 5,960 |
| 20:33:22 | **24.73** | **25.00** | 5,954 |
| 20:33:41 | **24.76** | **25.00** | 5,951 |
| 20:34:00 | **24.74** | **25.00** | 5,959 |
| 20:34:22 | **24.75** | **25.00** | 5,954 |
| 20:34:41 | **24.74** | **25.00** | 5,958 |
| 20:35:00 | **24.75** | **25.00** | 5,951 |
| 20:35:22 | **24.75** | **25.00** | 5,962 |
| 20:35:41 | **24.77** | **25.00** | 5,969 |
| 20:36:01 | **24.77** | **25.00** | 5,967 |
| 20:36:22 | **24.74** | **25.00** | 5,962 |
| 20:36:41 | **24.77** | **25.00** | 5,971 |
| 20:37:01 | **24.76** | **25.00** | 5,972 |

The vehicle drew ~25 A throughout phase B despite the engine pushing `limit=16`. The 16 A cap was never honored.

The earlier alwaysOn Tier 4 run on the same charger had identical numbers (`Current.Import≈24.7 A` under a `sL=1, limit=16` push). It was missed because that test's pass criterion was `Power.Active.Import > 0`, not `Current.Import ≤ maxAmps`.

## 2. Root cause

**File:** `packages/ocpp-server/src/fleet/applyFleetPolicyProfile.ts`

```ts
// lines 64–65
const STACK_LEVEL_ACTIVE = 90;
const STACK_LEVEL_RELEASED = 1;       // ← bug
// line 155
const stackLevel: 1 | 90 = mode === 'GATE_ACTIVE' ? STACK_LEVEL_ACTIVE : STACK_LEVEL_RELEASED;
```

OCPP 1.6 ChargePointMaxProfile resolution: when multiple CPMax profiles are installed on the charger, **highest stackLevel wins**.

LOOP firmware on 1A32 ships with a built-in `ChargePointMaxProfile` at `stackLevel=60, limit=25 A` (documented in F5h field notes 2026-04-24: "underlying daytime profile id=1 sL=60 limit=25 A CPMaxProfile became effective cap").

Effective stack at runtime, phase B:

| Source | `stackLevel` | `limit` (A) | Effective? |
|---|---|---|---|
| Fleet release push (`fleetProfileIdFor(chargerId)`) | 1 | 16 | ❌ loses |
| Charger built-in CPMax baseline | **60** | **25** | ✅ wins |
| (smart-charging when active, env `SMART_CHARGING_STACK_LEVEL`) | 50 default | varies | — |

Phase A deny at `sL=90` works because `90 > 60`. Phase B release at `sL=1` is below the baseline at 60, so the baseline 25 A wins.

The original design comment ("demote by pushing same profileId at stackLevel=1 limit=maxAmps") assumed there were no other CPMax profiles at higher sL on the charger. F5h showed there are.

## 3. Operational impact

- Every fleet release session on 1A32 (and any charger with a non-fleet CPMax baseline at sL > 1) silently delivers up to whatever the charger's baseline cap is, regardless of `FleetPolicy.maxAmps`.
- **Deny still works** (sL=90 wins): 0 A pre-window / post-window dwell is correctly enforced. Today's Tier 4-windowed run validates this.
- Billing kWh is correct (it reflects whatever was actually delivered).
- Operator UX gap: setting `maxAmps=8` for a fleet site that prefers slower charging is silently ignored; vehicle pulls baseline cap.

## 4. Fix plan

### 4.1 Code change shape — Option A

Switch from "demote to low sL" to **"rewrite at same high sL"**. The fleet profile owns `stackLevel=90` for the charger; deny and release both push at sL=90, varying only `limit`.

| Mode | `chargingProfileId` | `stackLevel` | `limit` |
|---|---|---|---|
| GATE_ACTIVE (deny) | `fleetProfileIdFor(chargerId)` | **90** | 0 |
| GATE_RELEASED | `fleetProfileIdFor(chargerId)` | **90** | `policy.maxAmps` |

OCPP semantics: `SetChargingProfile` with same `chargingProfileId` REPLACES the prior one. Same-id same-sL with different `limit` is the cleanest mental model — the fleet profile "owns" stackLevel 90 for that charger.

### 4.2 Code touchpoints (full set)

**`packages/ocpp-server/src/fleet/applyFleetPolicyProfile.ts`:**
- Replace the two `STACK_LEVEL_*` constants with a single `STACK_LEVEL_FLEET = 90`.
- Replace the conditional `mode === 'GATE_ACTIVE' ? 90 : 1` with `STACK_LEVEL_FLEET`.
- Drop `stackLevel: 1 | 90` literal types from `FleetProfileRamState`, `buildProfilePayload(...)` arg, and `ramStateMatches(...)` desired arg — switch to `number` (or keep a single literal `90` if the type-narrowing is useful).
- Update the file's banner comment block (lines 8–10): remove the "demote by pushing same profileId at stackLevel=1 limit=maxAmps" wording; new wording is "rewrite at same stackLevel=90, limit=maxAmps".

**`packages/ocpp-server/src/fleet/fleetProfileId.ts`:**
- The doc comment ends with "lets us demote the fleet profile (stackLevel 90 → 1) to release the gate without ever issuing ClearChargingProfile." Update to reflect same-sL rewrite.

**`tasks/task-0208-phase3-bug-alwayson-not-honored.md`:**
- §0 out-of-window step 4 mentions "(same fleet `chargingProfileId` from `fleetProfileIdFor(chargerId)`, sL=1, limit=`maxAmps`)" — update to `sL=90`.
- §4.6 Tier 1/2/3/4 references to "sL=1 limit=16" must become "sL=90 limit=16".
- Operational notes / red-flag signals — rephrase any "0 A vs 16 A at sL=1" wording.

### 4.3 Tests

**`packages/ocpp-server/src/fleet/applyFleetPolicyProfile.selftest.ts`:**
- Existing assertions expecting `stackLevel=1` for GATE_RELEASED must flip to `stackLevel=90`.
- Add explicit assertion that GATE_ACTIVE and GATE_RELEASED both push at stackLevel=90, varying only `limit`.
- Add explicit assertion that both modes use the same `chargingProfileId = fleetProfileIdFor(chargerId)`.
- Idempotency tests using `ramStateMatches` should be unaffected once the type change lands.

**`packages/ocpp-server/src/fleet/fleetScheduler.selftest.ts`:**
- No change required — tests assert mode plumbing, not stackLevel.

### 4.4 Sim assertion (closes the deferred Tier 2 gap from PR #84)

`packages/ocpp-server/src/scripts/sim-fleet-auto.ts` (or sibling): capture inbound `SetChargingProfile`, assert phase-B push has `stackLevel=90, limit=<maxAmps>`. Phases A/C: `stackLevel=90, limit=0`. Same idTag `PILOT-1A32-001` flow.

If this scope balloons (sim refactor wider than ~80 LOC), file as a follow-up and ship the engine fix without it. Unit/selftest + prod re-pilot are the must-haves.

### 4.5 Validation strategy

#### Tier 1 — unit/selftest (deterministic)

Per 4.3. Tests fail before the fix (existing tests assume sL=1 for release), pass after.

#### Tier 2 — local sim with profile-shape assertion

Per 4.4. Catches the bug class permanently in CI.

#### Tier 3 — prod re-pilot on 1A32 (Tier 4-Windowed re-run with cap assertion)

Repeat the safe arming sequence + plug-in flow that PASSED today. **NEW pass criterion for phase B (the only addition):**

- `Current.Import ≤ 16.5 A` peak (the hard signal — what the meter actually reports the vehicle drew)
- `Power.Active.Import ≤ ~4,000 W` peak (consistent with 16 A × ~240 V)
- `Current.Offered` is informational only — firmware can report it weirdly under stacked profiles. The hard pass signal is **`Current.Import`**.

Wall-clock unchanged (~10 min).

#### Tier 4 (optional) — quick alwaysOn re-run

After Tier 3 passes, optionally re-run a 2-min alwaysOn plug-in on 1A32 and confirm `Current.Import ≈ 16 A` (vs today's 24.7 A). Same fix, same expected outcome. Nice-to-have; not gating.

## 5. Multi-port / multi-connector caveat (out of scope here, document only)

Both today's deny and the proposed release push use `connectorId: 0`, which is **charge-point-wide** (applies to every connector on the charger). This is fine for 1A32 (single connector in the pilot) and any charger where every connector is in fleet mode. It is NOT correct for mixed-mode multi-port chargers where one connector is `FLEET_AUTO` and another is `PUBLIC` — the fleet `limit=0` would cap the public connector too.

This is a pre-existing design limitation, not a regression introduced by this fix. Solution when we get there: connector-specific profiles using the actual `connectorId`, with separate `chargingProfileId` per connector (e.g., `fleetProfileIdFor(chargerId, connectorId)`). File when we have the first multi-port mixed-mode deployment.

## 6. Cross-references

- F5h field findings: `MEMORY.md` "F5h firmware learnings" + "F5h critical finding"
- Sibling alwaysOn engine bug doc: `tasks/task-0208-phase3-bug-alwayson-not-honored.md`
- Code: `packages/ocpp-server/src/fleet/applyFleetPolicyProfile.ts:64-65, 155`
- Tier 4-Windowed evidence: OcppLog `MeterValues` + `SetChargingProfile` rows for `chargerId=charger-1A32-1-2010-00008` between 20:29:00–20:38:30Z on 2026-04-29
