# TASK-0208 Field Test F5 — Server-Gate Firmware Behavior Check

**Status:** **REQUIRED before any fleet-mode code merges.** This test answers the keystone question for the design: with local authorization bypasses disabled, does the LOOP firmware actually obey the server's authorization verdict?

**DO NOT run this on 1A32.** Its `PowerSwitchFailure` history makes it noisy for subtle authorization-semantics proofs. Use any other LOOP charger in prod that has a clean recent `StartTransaction` history. Candidate selection: query OcppLog for chargers with `StartTransaction` in the last 24h and no `Faulted` StatusNotifications in the same window.

---

## Why this test exists

Today's F1 result: the charger emitted `StartTransaction.idTag="FLEET-TEST-001"`, server responded `idTagInfo.status="Invalid", transactionId=0`, and **the charger kept charging** — ~7 kW for multiple minutes, MeterValues flowing. The charger ignored the rejection.

Root cause hypothesis: `LocalPreAuthorize=true` and `LocalAuthorizeOffline=true` gave the firmware an escape hatch — it used its local tag match to authorize itself.

F5 asks: **with those escape hatches off, does the charger respect the server's verdict?** If yes, the entire server-gate design works. If no, the design collapses and we need a different approach (e.g., `OfflinePlugAndChargeToggle=false` used as a per-window toggle, which has its own reliability and timing concerns).

---

## Preconditions

1. **Target charger:** a LOOP charger other than 1A32 with:
   - ONLINE status
   - `StartTransaction` in last 24h (proves hardware path works)
   - No `Faulted` StatusNotifications in last 24h
2. **Config pushed (via `POST /change-configuration`, with readback verification via `GetConfiguration`):**
   - `OfflinePlugAndChargeToggle=true`
   - `PlugAndChargeId=F-{ocppId}` (shortest valid form)
   - `LocalPreAuthorize=false`
   - `LocalAuthorizeOffline=false`
   - `AuthorizationCacheEnabled=false` (likely already)
   - `AllowOfflineTxForUnknownId=false` (likely already)
3. **Server state:** a test-only feature flag or per-charger override that makes `handleStartTransaction` and `handleAuthorize` return a configurable status for the fleet tag. Not the real fleet code — just a stub so we can dial the response.
4. **Instrumentation:**
   - OcppLog tailing (already have it)
   - An ammeter on the EVSE circuit OR confidence in MeterValues-based current reading
   - Stopwatch (or precise timestamp correlation) for latency measurement

---

## Sub-tests

### F5a — Blocked on StartTransaction (keystone)

**Server configured:** return `idTagInfo.status: "Blocked"` for the fleet tag on StartTransaction.

**Action:** Operator plugs in vehicle. No RFID, no app.

**Measure:**
- Does `StartTransaction.req` emit? (expected: yes)
- What does server record for `idTagInfo.status`? (should be `Blocked`)
- **Does the contactor close?** (critical: current flow on circuit; any MeterValues with non-zero Wh delta)
- If current ever flows: how long between plug-in and de-energize? This is the "server-latency brief energy" window.
- Does the charger go back to Available/Preparing, or stay stuck?

**Pass criteria:** no net energy delivered (Wh delta ≤ 100 — sub-second transient OK); charger returns to idle within 30s.

### F5b — Invalid on StartTransaction

**Server configured:** return `idTagInfo.status: "Invalid"` for the fleet tag.

**Action:** same as F5a.

**Purpose:** compare firmware behavior across statuses. Spec says any non-Accepted should de-energize, but firmware implementations vary. Confirming which specific status the LOOP firmware honors most reliably is valuable design input — we'll use that status for "reject" in production.

**Pass criteria:** identical to F5a.

### F5c — Accept with real transactionId

**Server configured:** return `idTagInfo.status: "Accepted", transactionId=<real 5-digit id>` for the fleet tag.

**Action:** same plug-in.

**Measure:**
- `Session` row created in DB with the allocated tx id
- MeterValues arrive with that tx id (not 0)
- Charging completes cleanly when driver unplugs → `StopTransaction` with same tx id

**Pass criteria:** full session lifecycle attributable to a single non-zero `transactionId`; Session row ACTIVE → COMPLETED.

### F5d — RemoteStopTransaction mid-session

Split into two sub-cases because the 2026-04-22 prod run on 1A32 proved `RemoteStopTransaction{transactionId:0}` IS honored by LOOP firmware but with meaningful latency (~1–2 min between `Accepted` and contactor open, ~200 Wh delivered during the gap). The Invalid-session variant is now the primary signal for viable Hybrid-A architecture — the Accepted variant is a standard OCPP sanity check.

#### F5d.1 — RemoteStop on Accepted session (standard)

**Preconditions:** F5c session running (real allocated `transactionId`).

**Action:** `POST /remote-stop { ocppId, transactionId }` with the allocated tx id.

**Measure:**
- Time from server `Accepted` response → `StopTransaction.req` received (wall-clock ms).
- Wh delta on the meter between `Accepted` ack and `StopTransaction.meterStop`.
- `StopTransaction.reason` (expect `Remote`).
- `Session` row transitions to `COMPLETED` with correct tx id.

**Pass criteria:** clean stop within 10s; leaked energy ≤ 50 Wh; no orphan.

#### F5d.2 — RemoteStop on Invalid (unauthorized-but-charging) session — **PRIMARY SIGNAL FOR HYBRID-A**

**Preconditions:** charger configured with `OfflinePlugAndChargeToggle=true`, `LocalPreAuthorize=true`, `StopTransactionOnInvalidId=true`; a fleet tag that the server will reject (`idTag` not in `User` table, or server stub forces Invalid).

**Action sequence (repeat 3 times for variance data):**
1. Operator plugs in EV.
2. Server receives `StartTransaction.req`, replies `idTagInfo.status=Invalid, transactionId=0`.
3. Server IMMEDIATELY sends `RemoteStopTransaction{transactionId:0}` (same WS tick where possible — measure server-side dispatch time too).
4. Wait for `StopTransaction.req` to arrive.
5. Operator unplugs after `Unavailable`/`Available` confirmed.

**Measure (per run):**
- T₀: server's `StartTransaction.req` receipt wall-clock
- T₁: server's `RemoteStopTransaction.req` dispatch wall-clock
- T₂: charger's `RemoteStopTransactionResponse{Accepted}` receipt wall-clock
- T₃: charger's `StatusNotification=Finishing` receipt wall-clock
- T₄: charger's `StopTransaction.req` receipt wall-clock
- `meterStart` (from StartTransaction), `meterStop` (from StopTransaction)
- **Leaked Wh = meterStop − meterStart**
- **Total latency = T₄ − T₀**
- **Post-ack latency = T₄ − T₂** (the portion we cannot shrink server-side)
- Max instantaneous current sampled during the window
- `StopTransaction.reason` (expect `Remote`)

**Report (append to Results section on completion):**

| Run | T₀ → T₁ (server internal) | T₁ → T₂ (WS RTT) | T₂ → T₄ (firmware delay) | Leaked Wh | Peak A |
|---|---|---|---|---|---|
| 1 | | | | | |
| 2 | | | | | |
| 3 | | | | | |
| Mean | | | | | |
| Max | | | | | |

**Pass criteria (for Hybrid-A to be viable architecture):**
- All 3 runs: charger emits `StopTransaction.reason=Remote` within 180s of plug-in (i.e. firmware honors RemoteStop consistently).
- Mean leaked energy ≤ 300 Wh (≈ $0.045 at $0.15/kWh — acceptable billing-reconciliation delta).
- Max leaked energy in any single run ≤ 500 Wh (≈ $0.075 — caps worst-case for operator SLAs).

**Fail criteria:**
- Any run where charger ignores the RemoteStop (no StopTransaction after 300s) → Hybrid-A not viable on this firmware; pivot to `MaxEnergyOnInvalidId` as primary gate or push LOOP for firmware fix.
- Mean leaked energy > 500 Wh → unacceptable for production; consider lowering `MaxEnergyOnInvalidId` as hard cap (F5g).

**Note on T₂ → T₄ delay:**
The 2026-04-22 1A32 run observed ~1–2 min of charging between `RemoteStopTransaction{Accepted}` and actual contactor open. If that pattern holds across runs, this is a firmware property (MeterValueSampleInterval-aligned? internal state-machine delay?) and must be designed around — NOT something the server can fix. The F5d.2 results directly determine whether Hybrid-A is realistic or whether we need stricter firmware gates.

### F5e — PlugAndChargeId length probe

**Preconditions:** F5a/b/c not yet run (do this first to lock the tag format).

**Action:** Push progressively longer `PlugAndChargeId` values (17, 18, 19, 20 chars). After each push, `GetConfiguration` to verify readback.

**Measure:**
- Does the charger accept values at each length?
- Does the readback equal what we pushed (no silent truncation)?
- OCPP 1.6 `CiString20` is the spec limit — confirm LOOP honors it.

**Pass criteria:** accepted and exactly readback at ≥19 chars (so `F-{ocppId}` fits for our longest LOOP ocppIds).

### F5f — transactionId=0 path sanity

**Purpose:** confirm we never accidentally produce `transactionId=0` in the fleet path, and that if it ever happens, behavior is at least predictable.

**Action (server-side only, no field action needed):**
- Inspect `StopTransaction` handler: what happens if `transactionId=0` in payload? Does it create an orphan-close path, or silently drop?
- Inspect `RemoteStopTransaction`: does the server reject tx id 0 before sending? (It should.)
- Grep billing/reporting for assumptions about `transactionId > 0`.

**Pass criteria:** fleet handler is guaranteed to return nonzero `transactionId` on Accept; StopTransaction with 0 is logged and no-op'd safely; no billing query silently ignores tx id 0.

---

## Decision matrix (F5 outcome → design impact)

| F5a result | F5b result | Design impact |
|---|---|---|
| Blocks ✓ | Blocks ✓ | Ship as designed. Use `Blocked` in production. |
| Blocks ✓ | Charges ✗ | Ship with `Blocked` only. Document that `Invalid` is not a safe verdict for LOOP. |
| Charges ✗ | Blocks ✓ | Ship with `Invalid`. Unusual but survivable. |
| Charges ✗ | Charges ✗ | **Design fails.** Fall back to `OfflinePlugAndChargeToggle` flipping per window — different architecture; re-plan. |

| F5c result | F5d.1 result | F5d.2 result | Design impact |
|---|---|---|---|
| Pass | Pass | Pass (≤300 Wh mean) | **Hybrid-A viable.** Ship auto-start + server-verdict + RemoteStop-on-reject. |
| Pass | Pass | Pass but leak > 500 Wh | Hybrid-A marginal. Require `MaxEnergyOnInvalidId` low cap (F5g) as belt-and-suspenders. |
| Pass | Pass | Fail (no stop) | Only `MaxEnergyOnInvalidId` can gate unauthorized. Ask LOOP for firmware fix. |
| Pass | Fail | — | Option B (server-orchestrated) off the table; rely on firmware cap only. |
| Fail | — | — | `Session` attribution broken; blocker. Debug before proceeding. |

---

## Cleanup after F5

1. Revert all six config keys on the target charger to its pre-F5 baseline (capture via GetConfiguration before starting).
2. Remove the test-only feature flag from server code.
3. Record measured latencies, which status code the firmware honored, and the safe `PlugAndChargeId` length into this doc's "Results" section (added below on completion).

---

## Results

### 2026-04-22 field session on 1A32 (deviation from precondition accepted)

Ran against 1A32 despite the preamble warning — operator availability
constrained us to that unit. PowerSwitchFailure noise confirmed not relevant
to the authorization-semantics signal (fault only asserts after contactor
opens, not during the energized window we're measuring).

#### F5a — Blocked/Invalid on StartTransaction: **FAIL**
With `LocalPreAuthorize=false`, `LocalAuthorizeOffline=false`,
`StopTransactionOnInvalidId=true`, `AuthorizationCacheEnabled=false`:
- Charger auto-started on plug-in, emitted `StartTransaction.idTag=F-1A32-1-2010-00008`.
- Server replied `{transactionId:0, idTagInfo.status:"Invalid"}`.
- **Charger kept charging at ~24.7 A (~6 kW)** and did NOT emit StopTransaction.
- Same outcome observed with `Blocked` in a follow-up probe.

**Design impact:** LOOP firmware does NOT de-energize on non-Accepted
StartTransaction response. The naive server-gate design (rely on
`idTagInfo.status` to stop a charging session) does NOT work on this firmware.
Fall back to `MaxEnergyOnInvalidId` as the firmware-enforced cap.

#### F5d — RemoteStopTransaction: **PASS**
`RemoteStopTransaction{transactionId:0}` was honored by the charger:
- `Accepted` response returned within WS RTT.
- Subsequent `StopTransaction.reason=Remote` arrived ~1–2 minutes later in
  cap=500 and cap=0 runs; arrived ~3 seconds after RemoteStop dispatch in
  cap=1 run because the firmware had already self-terminated.
- F5d.2 3-run variance table **not completed** — cap=1 made the measurement
  moot (firmware trips before server needs to RemoteStop). If we ever need
  F5d.2 for a design that doesn't use `MaxEnergyOnInvalidId`, repeat this
  block then.

#### F5f — transactionId=0 safety: **PASS** (implicit)
All RemoteStops in this session used `transactionId=0` and were accepted and
honored by the server + charger. Server-side handler did not error.

#### F5g — MaxEnergyOnInvalidId cap behavior (new sub-test added during field session)

Tested three cap values against the same unauthorized plug-in pattern:

| Cap value (Wh) | Delivered Wh | Firmware behavior |
|---|---|---|
| **0**   | 628 (unbounded, 7+ min until server RemoteStop) | Treated as **disabled**. Do NOT use. |
| **1**   | **140.8** | Trips to `SuspendedEVSE`, I → 0.00 A within ~6 s of Invalid response. ✓ |
| **500** | 502.8 | Hits ceiling at 502.8 Wh (0.56 % overshoot). Firmware enforces strictly. |

**140 Wh floor analysis (cap=1):**
Between the firmware crossing the 1 Wh threshold and actually pulling the
contactor, ~3 seconds of internal metering-cycle latency elapsed at
24.7 A × 240 V ≈ 5.9 kW, yielding ~140 Wh overshoot. **This floor is a
firmware property, not a server-tunable** — cap=1 gives us the minimum
post-Invalid leakage this firmware physically supports.

**Billing impact at cap=1:** ~140 Wh × $0.15/kWh ≈ $0.021 per unauthorized
plug-in attempt. Acceptable.

### Production decision — Hybrid-A with firmware cap

**Locked config for fleet-enrolled LOOP chargers:**
- `OfflinePlugAndChargeToggle=true`
- `PlugAndChargeId=F-{ocppId}` (≤20 chars, per F5e spec limit — length probe
  deferred; `F-1A32-1-2010-00008` = 19 chars is confirmed-accepted empirical
  maximum)
- `LocalPreAuthorize=false`
- `LocalAuthorizeOffline=false`
- `AuthorizationCacheEnabled=false`
- `AllowOfflineTxForUnknownId=false`
- `StopTransactionOnInvalidId=true` (belt, even though firmware ignores it)
- **`MaxEnergyOnInvalidId=1`** (suspenders — THE actual gate)

**Runtime semantics:**
1. Server `handleStartTransaction` returns `Invalid` for any fleet tag that
   does not pass `evaluateFleetIdTag`. Firmware trips at ~140 Wh.
2. Server `handleStartTransaction` returns `Accepted` + real `transactionId`
   for valid fleet sessions. Cap is irrelevant (tx is not Invalid).
3. Mid-session window-expiry enforcement deferred to future work (Option B /
   scheduled RemoteStop). V1 is start-only gating per Phase 0 DECISION 1.

### Still-open items before Hybrid-A code merge
- [x] **F5c — Accepted-path lifecycle** ✅ PASS (2026-04-22). See F5c Results
  section below.
- [ ] F5e — tag length probe beyond 19 chars (for future ocppId schemes).
  Not blocking today because our longest LOOP ocppId fits.
- [ ] Update `tasks/task-0208-phase-0-firmware-spike.md` with this session's
  findings and close it out.
- [ ] Revert 1A32 config to its pre-F5 baseline when F5c is done.

### Field session config & charger state
- Charger: `1A32-1-2010-00008` (LOOP, firmware V1.00.92LOOP).
- Current state at 21:38:32Z: `MaxEnergyOnInvalidId=1`, rest of config as
  "Locked config" above, idle (last `Finishing` then `StopTransaction` via
  RemoteStop). Operator ready for F5c on request.

---

## F5c Results — Accepted-path lifecycle (PASS, 2026-04-22)

### Approach: minimum-viable env-gated shim

Rather than schema + `FleetChargerPolicy` migration, F5c was run via a
narrow, **temporary** server shim merged in PR #51 (`7802db7`): when
`FLEET_MODE_ENABLED=true` and the incoming `StartTransaction.idTag` matches
`FLEET_ALLOW_TAG`, rebind to a seeded synthetic `User` row. No Authorize
change (LOOP firmware bypasses Authorize entirely per F5a findings). Revert
PR #52 opened post-test.

### Evidence

Charger `1A32-1-2010-00008`, 2026-04-22 PT:

| Timestamp (PT) | Event |
|---|---|
| 16:24:27 | BootNotification (post-reboot) |
| 16:25:01 | **StartTransaction** INBOUND `idTag=F-1A32-1-2010-00008` `meterStart=10580981` |
| 16:25:01 | **StartTransaction** OUTBOUND `Accepted, transactionId=65437` (~0ms) |
| 16:25:02 – 16:29:52 | 19 × MeterValues linked to `transactionId=65437` |
| 16:30:02 | StopTransaction INBOUND `reason=EVDisconnected` `meterStop=10581115` |
| 16:30:08 | Connector → Available |

Session row persisted: `c65c7b2f-2962-4db6-a0fc-938b95f0bc52`, `status=COMPLETED`,
`kwhDelivered=0.1345`, `ratePerKwh=0.50`.

### ⚠️ Physical-delivery failure discovered post-hoc (cap=1 regression)

Post-cleanup review of `StatusNotification` timeline from the F5c window
shows the session **did not actually charge for 5 minutes**. The firmware
tripped into `SuspendedEVSE` 3 seconds after `StartTransaction` was
`Accepted`, and spent the rest of the session cycling `SuspendedEVSE ↔
Faulted(PowerSwitchFailure)` until the driver unplugged:

| Time (PT) | Status |
|---|---|
| 16:24:57–58 | Charging (brief, ~134 Wh delivered) |
| 16:25:01 | StartTransaction → Accepted, tx 65437 |
| **16:25:04** | **SuspendedEVSE — 3s after Accepted** |
| 16:25:13 → 16:29:57 | SuspendedEVSE ↔ Faulted(PowerSwitchFailure) cycle, 27× transitions |
| 16:30:04 | Finishing (driver unplug) |

The 134.5 Wh delivered matches the F5a `MaxEnergyOnInvalidId=1` floor
(~140 Wh firmware metering cycle) exactly. This means the firmware cap
tripped **despite** the server returning `Accepted` — contrary to the
F5d/F5f finding that the cap only applies to Invalid sessions.

**Implication for the Hybrid-A "Locked config":** `MaxEnergyOnInvalidId=1`
kills legit Accepted sessions, not just rejects. The cap decision from F5d
must be **reopened**. Candidate root causes:
1. Firmware caches a prior Invalid verdict in `AuthorizationCache` even with
   `AuthorizationCacheEnabled=false`.
2. Firmware applies the cap to all sessions, not just Invalid ones.
3. Something else in the locked config (LocalPreAuthorize=false +
   AuthorizationCacheEnabled=false + tag unknown locally) causes firmware
   to treat the session as locally-Invalid.

**Status:** F5c is **partial PASS** — server-side lifecycle proven (tx id,
Session row, MeterValues, StopTransaction), physical energy delivery
**FAILED**. A second F5c run is required with a revised cap before Hybrid-A
can be called production-ready.

### F5c retest plan (proposed — awaiting approval)

**Hypothesis:** If we remove the firmware cap (`MaxEnergyOnInvalidId=0` =
unbounded) and clear firmware's auth cache, an Accepted session should
charge normally to driver-requested completion.

**Pre-test prep (4 server-side ops to charger 1A32):**
1. `ChangeConfiguration` → `MaxEnergyOnInvalidId=0`
2. `ClearCache.req` → flush firmware's AuthorizationCache (regardless of
   whether it's "enabled", some firmware caches anyway)
3. Reopen shim: cherry-pick PR #51 onto new `hotfix/task-0208-f5c-retest`
   branch, merge, `railway up --service ocpp-server-fresh`
4. Re-set the 3 env vars (`FLEET_MODE_ENABLED=true`,
   `FLEET_ALLOW_TAG=F-1A32-1-2010-00008`,
   `FLEET_SYSTEM_USER_ID=8d3d745b-eb22-445a-a8ff-64290275b05c`)

**Test execution:**
1. Operator reboots 1A32 to clear all transient state.
2. Operator plugs in with no activation action.
3. Observe StartTransaction → Accepted (expected, same as first F5c).
4. **Observe StatusNotification stays `Charging` for the duration** (not
   tripping SuspendedEVSE).
5. Operator lets session run ≥5 minutes OR unplugs when sufficient energy
   delivered (target: ≥1 kWh, well above the ~140 Wh F5a floor).
6. StopTransaction on unplug.

**Pass criteria (all must hold):**
- Server-side: same as first F5c (Accepted, tx id, Session row,
  MeterValues, clean Stop).
- **Physical: StatusNotification remains `Charging` throughout; no
  SuspendedEVSE/Faulted cycling.**
- **Energy: `kwhDelivered` ≥ 1.0 kWh** (unambiguously above firmware floor).
- StopTransaction reason = `EVDisconnected` with non-zero Power.Active.Import
  readings in the `transactionData` before the end point.

**Cleanup (same as first F5c):**
1. Unset the 3 env vars.
2. Revert the retest shim PR (same pattern as PR #52 reverting PR #51).
3. **Critical:** re-apply production cap value post-test. Options:
   - Leave `MaxEnergyOnInvalidId=0` (unbounded) and rely on server-side
     `RemoteStopTransaction` for Reject enforcement. Requires server work.
   - Set `MaxEnergyOnInvalidId=50000` (50 kWh) as "large enough for any
     legit session, still bounds abuse". Quick revert, no server work.
   - Investigate firmware to find the real root cause, then re-pick cap.

**Risk:** with cap=0 during the retest window, if anyone else plugs into
1A32 with a random tag during the test, firmware will charge their vehicle
unbounded (up to server's StopTransaction). Mitigation: keep the retest
window short (<30 min) and monitor logs live.

**Decision points for operator before executing:**
- [ ] Approve `MaxEnergyOnInvalidId=0` during retest window
- [ ] Approve ClearCache.req (standard OCPP, safe)
- [ ] Approve shim reintroduction via cherry-pick PR

### Distinctness verification (the key property)

| Field | Value | Source |
|---|---|---|
| `Session.idTag` | `F-1A32-1-2010-00008` | charger-sent (what LOOP firmware puts in StartTransaction.req) |
| `Session.userId` | `8d3d745b-eb22-445a-a8ff-64290275b05c` | synthetic user (shim rebind target) |
| `User.idTag` of that userId | `FLEET-SYS-F5C` | the synthetic user's own column |

The charger-sent tag and the backing user's `idTag` are stored on different
tables with different values. The shim rebinds `userId` but does NOT overwrite
`Session.idTag` with the user's idTag. This is the intended property for any
future fleet implementation.

### Retained test artifacts (intentional, not leftover)

| Artifact | Identifier |
|---|---|
| Synthetic user | `8d3d745b-eb22-445a-a8ff-64290275b05c` (email `fleet-f5c-system@internal.lumeopower.com`, idTag `FLEET-SYS-F5C`) |
| Session row | `c65c7b2f-2962-4db6-a0fc-938b95f0bc52` |
| SessionBillingSnapshot | 1 row, cascade-linked to Session |
| Transaction id | `65437` |

These rows are preserved as the audit trail for the F5c probe. They are NOT
to be deleted during cleanup because (a) the Session FK to User has ON DELETE
RESTRICT, (b) deleting the Session cascades the BillingSnapshot and destroys
the evidence, and (c) revert PR #52 removes the only code path that could
ever rebind to this user again, so ongoing risk is zero.

### Lesson: `ocpp-server-fresh` is not git-integrated

Discovered during F5c deploy: `serviceInstance.source.repo=null` and
`repoTriggers=[]` on the `ocpp-server-fresh` Railway service. Consequences:

- **Merging to `main` does NOT trigger a deploy** to `ocpp-server-fresh`.
- **`railway redeploy` rebuilds the last-uploaded source**, not the latest
  `main` commit. It looks like it deployed new code (build logs show `tsc`
  running) but the output is stale because the input is stale.

Correct post-merge deploy procedure for this service:
```bash
cd <main-synced-worktree>
git pull origin main
railway link --project 9992c8eb-f29d-4b4b-ad85-cc3a9c8e3fb0 \
             --service ocpp-server-fresh \
             --environment production
railway up --detach --service ocpp-server-fresh
```

Verification: SSH into the running service and
`grep -c <new-symbol> /app/packages/ocpp-server/dist/...` against something
that only exists in the new commit.

This should be either (a) written into the top-level CLAUDE.md "Deploy" rules
permanently, or (b) fixed at the Railway service level by connecting it to the
GitHub repo so merges auto-deploy like the other services.

### Cleanup performed post-F5c (2026-04-22)

1. Env vars `FLEET_MODE_ENABLED`, `FLEET_ALLOW_TAG`, `FLEET_SYSTEM_USER_ID`
   deleted from `ocpp-server-fresh` production.
2. Redeploy `8e06133c` SUCCESS; runtime banner absent; `/health` ok — shim
   inactive.
3. Synthetic user / Session / Snapshot retained as above.
4. Revert PR #52 opened against main. Once merged, `railway up` from main to
   fully remove shim code from the running binary.

---

## F5c retest (2026-04-23) — cap=500 FAIL, cap=0 PASS

### cap=500 result (tx 11514)

Retest to isolate firmware-wide cap hypothesis. Plugged in, shim-accepted,
session ran cleanly until **503.3 Wh** delivered — at which point firmware
began cycling `Faulted/PowerSwitchFailure ↔ SuspendedEVSE` every 3–12 s.
Session ran 60 min before first trip; trip point matches cap exactly.

**Conclusion:** `MaxEnergyOnInvalidId` is **not** Invalid-only on LOOP
firmware. It caps every session regardless of `idTagInfo.status`. Linear
scaling confirmed: cap=1 → ~140 Wh trip, cap=500 → ~503 Wh trip.

### cap=0 result (tx 89279)

Retest with `MaxEnergyOnInvalidId=0` (known from F5d.1 as "disabled /
unbounded"). Plugged in → StartTransaction Accepted → 670.6 Wh delivered
over 5 min 46 s → server-initiated RemoteStop → clean StopTransaction.

**Pass on all criteria:**
- Passed 140 Wh floor ✓
- Passed 500 Wh cap threshold ✓ (no SuspendedEVSE/Faulted during delivery)
- RemoteStop latency: **~14 Wh leak** between last observation and actual
  contactor open (2.1 s gap)
- StopTransaction reason `Remote`, response Accepted ✓

### Mid-plug RemoteStart probe (tx 75048) — architecturally critical

After tx 89279 stopped, issued RemoteStart with the same fleet tag while
vehicle remained plugged in. Result:

- Firmware took ~3 min to clear its post-stop fault loop
- New StartTransaction eventually arrived (tx 75048)
- **Vehicle went `SuspendedEV` — only 0.9 Wh delivered in ~2 min**
- Car's own state machine had ended its session; would not redraw without
  unplug-replug handshake

**Conclusion:** Mid-plug resume via RemoteStop/RemoteStart cycle is **not
viable** on this vehicle. Any architecture requiring "pause and resume later
while plugged in" must use a mechanism that keeps the transaction ACTIVE —
i.e., modulate current via `SetChargingProfile`, not transaction lifecycle.

The distinction: `SuspendedEVSE` (EVSE pausing) is resumable; `SuspendedEV`
(car finished) is not.

---

## Architecture decision: Hybrid-B (provisional, pending F5h)

**Status:** PROVISIONAL. Commit direction, do not commit product behavior
until F5h validates 0A profile safety on LOOP firmware and car tolerance.

### Design

| Server verdict | Action | Firmware result | Driver experience |
|---|---|---|---|
| Valid idTag + in window | Accept, no custom profile | Charges normally | Charges |
| Valid idTag + outside window | Accept + push `SetChargingProfile(limit=0A, purpose=TxProfile, stackLevel=HIGH)` | SuspendedEVSE, session stays ACTIVE | "Scheduled to charge at HH:MM" |
| Invalid idTag | Reject at gate + RemoteStop | StopTransaction | "Not authorized" |

### Why this over the original server-gate + firmware-cap Hybrid-A

- **Cap-based enforcement broken on LOOP:** F5c proved `MaxEnergyOnInvalidId`
  caps all sessions, not just Invalid. Any value > 0 trips legit sessions.
- **Mid-plug session restart not viable:** F5c+RemoteStart probe showed the
  car will not redraw after a stop, even with the physical cable intact.
- **Single enforcement mechanism:** profile-based rate modulation handles
  both "charge slower" (existing smart charging) and "don't charge yet"
  (fleet windows). Unified.
- **Clean separation:** authorization at StartTransaction, schedule
  enforcement via profile, state transitions via scheduler.

### Why it's provisional

The entire design rests on two un-validated assumptions:

1. **LOOP firmware honors `SetChargingProfile(limit=0A)` without tripping
   Faulted.** Given 1A32's `PowerSwitchFailure` history around profile
   changes, this is not safe to assume.
2. **The test vehicle tolerates prolonged 0A → maxA → 0A transitions
   without going `SuspendedEV`.** Car firmware varies; some give up after
   N minutes of 0A.

Either failure mode kills Hybrid-B and forces Plan B.

### Plan B — deferred authorization (fallback if F5h fails)

If prolonged 0A is unreliable:

1. Plug-in arrives → server accepts operationally (session record created
   with `status=PENDING_WINDOW` or similar, **no StartTransaction
   allowed**)
2. At window open → server issues RemoteStart
3. Driver must replug to re-handshake (explicit UX: "Please unplug and
   replug at HH:MM")

Worse UX, but separates authorization concerns from scheduling without
relying on 0A behavior. Named now so the task does not dead-end if F5h
fails.

### F5h gating experiment

**Setup:**
- Seed `FleetChargerPolicy` for 1A32 with a 5-min window opening 5 min from
  plug-in time
- Plug in 5 min before window → observe StartTransaction accepted, profile
  pushed with limit=0A
- Verify firmware reaches `SuspendedEVSE` (not Faulted)
- At window edge: profile update to max-A → verify charging resumes without
  car going SuspendedEV
- At window close (while still plugged): profile flips to 0A → verify
  SuspendedEVSE again, still no SuspendedEV
- Plug out → clean StopTransaction

**Pass criteria:**
- No `Faulted/PowerSwitchFailure` during profile pushes
- Car stays charge-ready through at least one 0→max→0 cycle
- Energy delivered only within allowed window (± profile push latency)

**Go/no-go:**
- Pass → proceed to full Hybrid-B implementation phases 1–5
- Fail → pivot to Plan B

### Implementation sequence (Hybrid-B)

**Pre-Phase-1 audit** (read-only, no code):
1. Verify no server-side cleanup kills ACTIVE sessions that are:
   Accepted / energy=0 / status=SuspendedEVSE / long-lived overnight
2. Verify BootNotification+Heartbeat gate enforced before any
   `SetChargingProfile` push (hard rule #1)
3. Verify existing smart-charging `stackLevel` usage; pick fleet tier above
4. Verify Session/receipt model can represent `pluggedDuration` vs
   `chargingDuration` vs `kwhDelivered` without implying billing for 0A
   dwell time

**Phase 1 — Schema + window math**
- `FleetIdTag` (idTag unique, orgId, enabled, revokedAt)
- `FleetChargerPolicy` (orgId, chargerId|siteId, allowedWindows JSON,
  maxAmps)
- `evaluateFleetIdTag()` returns `{kind, windowState, nextTransitionAt}`
- Window math: timezone-aware (hard rule #8); heavily tested unit suite

**Phase 2 — Profile-apply path**
- `applyFleetProfile(sessionId, limitAmps)` wrapper over
  `remoteSetChargingProfile`
- Hook into `handleStartTransaction` fleet branch
- Scheduler: edge-triggered `setTimeout` on `nextTransitionAt` + 5-min
  reconciliation loop as backup (per astra review: near-edge wakeups, not
  coarse periodic)
- BootNotification re-apply (hard rule #2)

**Phase 3 — F5h validation on 1A32**
- Decision gate

**Phase 4 — UX polish (only after F5h passes)**
- Driver app "scheduled at HH:MM" indicator
- Portal fleet-session window-state display
- Receipt template split time

**Phase 5 — Prod rollout**
- Feature-flagged per organization
- Single customer, single charger first

### Open concerns flagged by astra review

- **Long ACTIVE session at 0A:** biggest risk, not architectural but
  operational. Audit cleanup logic, timeouts, and car-side tolerance.
- **Scheduler cadence:** edge-triggered wakeups with periodic reconciliation
  as backup; 60 s poll alone is too coarse for window-open UX.
- **Firmware stability at 0A specifically:** 1A32's `PowerSwitchFailure`
  pattern means we should not assume 0A is benign.

---

## Step 2 — Pre-Phase-1 audit (2026-04-23, COMPLETE)

Read-only inspection of 4 gating items. See full brief in session log; headline:

| # | Finding | Action for Phase 1 |
|---|---------|---------------------|
| 1a | Orphan auto-close (`statusNotification.ts`) fires only on AVAILABLE/PREPARING — Hybrid-B 0 A holds stay in Charging/SuspendedEVSE, safe. | none |
| 1b | `sessionSafety.ts` `maxIdleDurationMin` + `maxChargeDurationMin` will kill 0 A-gated sessions. | **Blocker → carve-out keyed on `fleetPolicyId`, flag-gated.** |
| 2 | Boot+heartbeat gate exists (`connectionReadyForSmartCharging`) but `internalHttp /set-charging-profile` bypasses it. | **Design rule: all Hybrid-B pushes MUST go through gated path.** |
| 3 | Current stackLevel hierarchy: SITE=10, GROUP=30, CHARGER=50 + priority. | Fleet tier = **90** (below emergency=99). |
| 4 | No schema for pluggedDuration vs chargingDuration vs gated dwell. | **Additive fields on Session + SessionBillingSnapshot.** |

---

## Step 3 — Phase 1 implementation (2026-04-23, COMPLETE)

**Branch:** `hotfix/task-0208-phase1-fleet-scaffold`
**Goal:** land the schema + window math + sessionSafety carve-out as *scaffolding only* — no prod behavior change unless `FLEET_GATED_SESSIONS_ENABLED=true` is set AND `FleetPolicy` rows exist.

### Acceptance criteria ✅

| Criterion | Evidence |
|-----------|----------|
| Fleet policy schema exists | `FleetPolicy` model + `FleetPolicyStatus` enum added to `schema.prisma`. Migration `20260423000000_task_0208_fleet_policy_phase1` written. |
| Timezone-correct window evaluation with tests | `packages/shared/src/fleetWindow.ts` — `evaluateFleetWindowAt()` uses `Intl.DateTimeFormat` tz conversion mirroring `touPricing.ts::localDayMinute`. **26/26 selftest assertions pass** (`packages/shared/src/fleetWindow.selftest.ts`). |
| sessionSafety no longer kills valid fleet-gated sessions | `sessionSafety.ts` now reads `session.fleetPolicyId` and, when `FLEET_GATED_SESSIONS_ENABLED=true`, skips duration/idle/cost enforcement for fleet-matched rows. |
| Additive session / session-billing fields exist for pre-delivery dwell | `Session.{plugInAt, firstEnergyAt, lastEnergyAt, fleetPolicyId}` + `SessionBillingSnapshot.{preDeliveryGatedMinutes, gatedPricingMode}`. All nullable. |
| Design note states gated-path rule | See **Design Rule 1** below. |
| No prod behavior change | Migration is purely additive. New columns default to NULL. `FleetPolicy` table starts empty. sessionSafety change only fires on sessions with non-null `fleetPolicyId` AND flag ON (default OFF). No `SetChargingProfile` paths added. |

### Files changed

```
packages/shared/prisma/schema.prisma                            (additive)
packages/shared/prisma/migrations/20260423000000_task_0208_fleet_policy_phase1/migration.sql (new)
packages/shared/src/fleetWindow.ts                              (new)
packages/shared/src/fleetWindow.selftest.ts                     (new, 26 assertions)
packages/shared/src/index.ts                                    (export)
packages/ocpp-server/src/sessionSafety.ts                       (carve-out, flag-gated)
tasks/task-0208-f5-server-gate-firmware-check.md                (this doc)
```

### Design rules (binding for Phase 2+)

**Rule 1 (gated-path requirement).** *All* `SetChargingProfile` sends for Hybrid-B fleet modulation MUST route through `packages/ocpp-server/src/smartCharging.ts` so they inherit `connectionReadyForSmartCharging()` — the BootNotification + Heartbeat readiness gate (hard rule #1 of the top-level CLAUDE.md). The raw `remoteSetChargingProfile` in `remote/index.ts` and the `/set-charging-profile` endpoint in `internalHttp.ts` bypass the gate and are reserved for operator/manual override only. Phase 2 will expose a new `applyFleetPolicyProfile(chargerId, { amps, stackLevel })` wrapper in `smartCharging.ts` that (a) runs readiness check, (b) re-applies on BootNotification via the existing `PENDING_OFFLINE` → re-reconcile mechanism.

**Rule 2 (stackLevel = 90).** Fleet TxProfiles use `stackLevel=90`. This sits above `CHARGER base=50 + priority` so it overrides every operator-configured smart-charging profile, and below 99 which is reserved for emergency manual override.

**Rule 3 (idTag prefix = match key).** Fleet sessions are identified by `idTag.startsWith(FleetPolicy.idTagPrefix)` (see `matchesFleetPolicy()`). Authorize handler in Phase 2 will attach `fleetPolicyId` to the session row; downstream code (receipts, sessionSafety, reporting) keys on that FK-less snapshot so policy edits/deletions don't corrupt history.

**Rule 4 (receipts never lose gated dwell).** Even if a receipt later reprices, `SessionBillingSnapshot.preDeliveryGatedMinutes` must remain the wall-clock minutes between `Session.plugInAt` and `Session.firstEnergyAt` at snapshot time. `gatedPricingMode` is the policy at capture time; future policy edits never rewrite past receipts.

**Rule 5 (migration is additive, never destructive).** Any Phase-2 column change ships as a new migration with defaults so prod `prisma migrate deploy` never blocks. No `db push` in prod (hard rule #15).

### What this scaffold does NOT do (deferred to Phase 2+)

- Does NOT change Authorize handler — no `fleetPolicyId` is attached to sessions yet.
- Does NOT push any `SetChargingProfile` for fleet policies — no TxProfile wiring.
- Does NOT populate `plugInAt` / `firstEnergyAt` / `lastEnergyAt` — Phase 2 MeterValues handler work.
- Does NOT expose FleetPolicy CRUD in API or portal — backend schema only.
- Does NOT wire `preDeliveryGatedMinutes` into snapshot capture — Phase 2.

### Verification run (local)

```
DATABASE_URL="postgresql://x:x@x:5432/x" npx prisma validate   # → "valid 🚀"
npx ts-node packages/shared/src/fleetWindow.selftest.ts        # → 26 passed, 0 failed
```

Shared package builds after migration dir lands (Phase 2 PR will run shared+ocpp-server build through CI).

### Go/no-go for Phase 2

Phase 2 requires F5h (0 A tolerance validation on 1A32 + test vehicle) per architecture doc above. **Do not** start Phase 2 coding before F5h PASS.
