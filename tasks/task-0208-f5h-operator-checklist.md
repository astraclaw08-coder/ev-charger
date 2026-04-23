# F5h Operator Checklist — one page

Print this. Take it to the field. Mark it up live.

**Unit under test:** 1A32 (LOOP firmware) + test vehicle
**Target:** prove 0 A TxProfile tolerance for Hybrid-B
**Full plan:** `tasks/task-0208-f5h-validation-plan.md`
**Go/no-go:** PASS = unblock TASK-0208 Phase 2. FAIL = pivot to Plan B.

---

## Before you leave

- [ ] Test vehicle has ≥ 30 % SOC (need headroom both above and below fill window)
- [ ] `FLEET_GATED_SESSIONS_ENABLED=false` on the OCPP server — confirmed
- [ ] Dev OCPP server reachable (`/health` green); dev DB reachable
- [ ] Phase 1 scaffold commit `6f24a15` present on the server you'll hit
- [ ] No stale profiles on 1A32 — run the pre-sweep (see "Profile commands" below)
- [ ] Stopwatch or phone timer (you'll be counting 5-min dwells)
- [ ] Camera/phone for car-dashboard photos at each 0 A dwell
- [ ] Terminal with ability to run `curl` or `psql` (evidence capture)
- [ ] A copy of this checklist + the full validation plan

---

## Baseline (do this first)

One clean session with **no profiles pushed**, just to confirm healthy behavior and get a reference trace.

- [ ] Plug in
- [ ] Vehicle authorizes; StartTransaction Accepted
- [ ] Charge 2 min at max current
- [ ] RemoteStop
- [ ] Unplug; charger returns to Available

**Note baseline session id here:** ________________________________

---

## Test sequence (10 steps — fill in as you go)

Time-stamp each event. Charger state = StatusNotification value at that moment. Car state = dashboard observation.

| # | Action | Target state (charger / car) | Time | Charger state observed | Car state observed | OK? |
|---|--------|------------------------------|------|------------------------|--------------------|-----|
| 1 | Plug in + authorize | Charging / charging | | | | ☐ |
| 2 | Push profile **0 A** | SuspendedEVSE / connected | | | | ☐ |
| 3 | Hold 0 A for **5 min** | SuspendedEVSE / connected | | | | ☐ |
| 4 | Push profile **max A** | Charging / drawing | | | | ☐ |
| 5 | Hold max for 2 min | Charging / drawing | | | | ☐ |
| 6 | Push profile **0 A** | SuspendedEVSE / connected | | | | ☐ |
| 7 | Hold 0 A for **5 min** | SuspendedEVSE / connected | | | | ☐ |
| 8 | Push profile **16 A** | Charging / drawing | | | | ☐ |
| 9 | RemoteStop | Finishing→Available / done | | | | ☐ |
| 10 | Unplug | Available / disconnected | | | | ☐ |

**Session id:** ________________________________
**Start:** ____:____  **End:** ____:____

---

## Pass criteria — ALL six must hold

- [ ] **P1** No `Faulted` / `PowerSwitchFailure` at any point
- [ ] **P2** Car stays charge-ready through at least one full 0 → max → 0 cycle (steps 2–6 without driver intervention)
- [ ] **P3** No car-side `SuspendedEV` during either 5-min 0 A dwell
- [ ] **P4** Energy strictly within non-zero windows (allow ≤ 10 s profile-push latency)
- [ ] **P5** Clean StopTransaction: `meterStop > meterStart`, `reason=Remote`
- [ ] **P6** No unexpected orphan-cleanup firing during 0 A dwell

**Verdict:** ☐ PASS → unblock Phase 2   ☐ FAIL → Plan B

---

## Fail-mode quick reference

| Observed | Meaning | Action |
|----------|---------|--------|
| Faulted / PowerSwitchFailure on 0 A push | firmware can't tolerate 0 A | FAIL → Plan B |
| Car flips to SuspendedEV during 5-min 0 A | car dwell tolerance < 5 min | FAIL → Plan B |
| Charging doesn't resume within 30 s of step-4 push | profile re-apply broken | FAIL → investigate |
| Energy > 0 during 0 A dwell | profile not enforced | FAIL → Hybrid-B unviable on 1A32 |

---

## Profile commands (copy-paste; fill in `OCPP_ID` and `AMPS`)

Pre-sweep (run before step 1):

There is no `/clear-charging-profile` HTTP endpoint today. Profiles are volatile (hard rule #2) and are wiped on charger reboot. Simplest pre-sweep:

```bash
# Reboot the charger — profiles in RAM are cleared
curl -X POST "$OCPP_INTERNAL/reset" \
  -H 'content-type: application/json' \
  -d '{"ocppId":"1A32","type":"Soft"}'

# Wait for BootNotification + first Heartbeat (watch logs or poll /status)
./scripts/f5h/wait-ready.sh 1A32
```

Push profile (steps 2/4/6/8):

```bash
./scripts/f5h/push-profile.sh 1A32 0     # step 2
./scripts/f5h/push-profile.sh 1A32 32    # step 4  (use the charger max)
./scripts/f5h/push-profile.sh 1A32 0     # step 6
./scripts/f5h/push-profile.sh 1A32 16    # step 8
```

RemoteStop (step 9):

```bash
./scripts/f5h/remote-stop.sh 1A32 <connectorId>
```

---

## Post-test (before you leave the site)

- [ ] Capture session id and note it above
- [ ] Run evidence capture: `./scripts/f5h/capture-evidence.sh 1A32 <sessionId>`
- [ ] Revert 1A32 config to pre-F5 baseline:
  - [ ] `MaxEnergyOnInvalidId` → pre-F5g value
  - [ ] ClearChargingProfile sweep (no residual fleet profiles)
- [ ] File evidence dir under `tasks/evidence/f5h-<date>/`
- [ ] Write up result in `tasks/task-0208-f5-server-gate-firmware-check.md` under a new "F5h — result" section

---

## Abort conditions — stop immediately if

- Car shows any warning/error message during a profile push
- Charger relay audibly chatters on a profile transition
- SOC drops unexpectedly during a dwell (indicates backfeed, should be impossible — stop, don't diagnose in field)

Safety beats data. If anything feels wrong, unplug, clear profiles, and debrief.
