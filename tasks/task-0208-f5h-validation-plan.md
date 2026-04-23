# TASK-0208 — F5h Validation Plan

**Status:** NOT YET RUN
**Gate:** Phase 2 of TASK-0208 (Hybrid-B) is blocked until F5h PASSES.
**Owner:** field session on 1A32 + test vehicle
**Source doc:** `tasks/task-0208-f5-server-gate-firmware-check.md` § F5h gating experiment (line 579)

---

## Purpose

Prove that the 1A32 LOOP firmware + the real test vehicle tolerate **prolonged 0 A TxProfile modulation** without entering `Faulted` or going `SuspendedEV` (car-side giveup). Hybrid-B's entire premise — always-Accept at Authorize, then modulate current via `SetChargingProfile` stackLevel=90 — depends on this behavior. If the firmware or the car refuses to dwell at 0 A indefinitely, Hybrid-B is dead and we pivot to Plan B (deferred authorization, source doc line 564).

---

## Pre-flight (before touching the charger)

1. `FLEET_GATED_SESSIONS_ENABLED=false` on the server (flag stays OFF for F5h; we drive profiles manually, not through policy-attached sessions).
2. Confirm Phase 1 scaffold is deployed (commit `6f24a15` on dev → dev OCPP server).
3. Confirm 1A32 reaches `connectionReadyForSmartCharging = true` (BootNotification + ≥1 Heartbeat, hard rule #1).
4. Confirm no existing active smart-charging profile on 1A32 (`ClearChargingProfile` sweep first).
5. Baseline: one clean session (plug in, RFID auth, charge 2 min, stop, unplug) with no profiles pushed — records a "healthy" trace to diff against.

---

## Test sequence

Each step uses `SetChargingProfile` with `stackLevel=90`, `chargingProfilePurpose=TxProfile`, `chargingRateUnit=A`, single period `startPeriod=0, limit=<A>`.

| # | Action | Expected charger state | Expected car state |
|---|--------|------------------------|---------------------|
| 1 | Plug in. Vehicle authorizes (any valid idTag). | `Charging` after StartTransaction Accepted | charging begins |
| 2 | Push profile `limit=0 A`. | transitions to `SuspendedEVSE` within a few seconds | stays connected, no fault |
| 3 | Hold 0 A for **5 minutes**. | remains `SuspendedEVSE` continuously | stays connected; MeterValues report ~0 W |
| 4 | Push profile `limit=32 A` (or charger max). | returns to `Charging` | resumes drawing current |
| 5 | Hold at max for 2 minutes. | `Charging` stable | drawing rated current |
| 6 | Push profile `limit=0 A` again. | `SuspendedEVSE` | stays connected |
| 7 | Hold 0 A for **another 5 minutes**. | `SuspendedEVSE` continuous | stays connected |
| 8 | Push profile `limit=16 A`. | `Charging` | resumes at 16 A |
| 9 | Hold 1 min, then RemoteStop. | `Finishing` → `Available` | session ends cleanly |
| 10 | Unplug. | `Available` | — |

**Total duration:** ~15 min wall clock.

---

## Pass criteria (ALL must hold)

1. **No `Faulted` status** at any point — especially no `PowerSwitchFailure` during the 0 A → limit → 0 A transitions. (1A32 has a documented `PowerSwitchFailure` history; this is the primary risk.)
2. **Car stays charge-ready** through **at least one full 0 → max → 0 cycle** (steps 2–6). "Charge-ready" = resumes current within 30 s of the step-4 profile push without driver intervention.
3. **No car-side timeout** during either 5-min 0 A dwell. If the car flips to `SuspendedEV` (EV-initiated stop) during 0 A hold, the dwell ceiling is shorter than 5 min and Hybrid-B is not viable as specified.
4. **Energy delivered strictly within non-zero windows** (allowing profile-push latency, ≤ 10 s). No phantom delivery during 0 A dwell.
5. **Clean StopTransaction** at step 9 with `meterStop > meterStart` and `reason=Remote`.
6. **No orphan cleanup interference** — the session must not be auto-killed by `sessionSafety.ts` during 0 A dwell. (Phase 1 carve-out is flag-gated and therefore OFF in this test; the session has no `fleetPolicyId`, so confirm no other cleanup path fires. If one does, that is a Phase-1 regression to fix, not an F5h failure.)

---

## Fail modes and disposition

| Observed | Interpretation | Disposition |
|----------|----------------|-------------|
| `Faulted / PowerSwitchFailure` during 0 A push | Firmware cannot tolerate sustained 0 A TxProfile. | **FAIL.** Pivot to Plan B. |
| Car goes `SuspendedEV` during 5-min 0 A hold | Car-side 0 A tolerance shorter than our window. | **FAIL.** Pivot to Plan B. |
| Charging does not resume on step 4 within 30 s | Profile re-apply not taking effect post-dwell. | **FAIL.** Investigate before re-testing. |
| Energy > 0 during 0 A dwell | Profile not enforced. | **FAIL.** 1A32 TxProfile support incomplete; Hybrid-B unviable on this firmware. |
| All 6 pass criteria hold | Hybrid-B viable on 1A32. | **PASS.** Unblock Phase 2. |

---

## Evidence to capture

- OCPP log (`OcppLog` table rows for the session) — full StartTransaction / SetChargingProfile / MeterValues / StopTransaction trace
- StatusNotification timeline — transitions between `Charging`, `SuspendedEVSE`, any unexpected states
- Wall-clock timestamps for each profile push and the observed charger-state transition latency
- Photo or note of car dashboard state during each 0 A dwell (to catch `SuspendedEV` that the charger may not report)
- Any Faulted event → capture exact `errorCode` and `vendorErrorCode`

All of the above go into a new section of `task-0208-f5-server-gate-firmware-check.md` once F5h runs.

---

## Post-test

- If **PASS**: proceed to Phase 2 per design note (`task-0208-phase2-design-note.md`).
- If **FAIL**: open design doc for Plan B (deferred authorization); Phase 1 schema is still useful (`FleetPolicy` + window math) since Plan B also needs policy + windows.
- Either way: revert 1A32 config to pre-F5 baseline when done (`MaxEnergyOnInvalidId` back to its pre-F5g value; clear any residual profiles).
