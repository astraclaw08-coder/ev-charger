# TASK-0208 Phase 3 — Slice E rehearsal evidence

**Status:** PASSED (local sim, 2026-04-28).
**Scope:** dev/staging rehearsal of Slices A → D, exercised end-to-end against a local OCPP server with `FLEET_GATED_SESSIONS_ENABLED=true`. **No prod or Railway env was touched.**
**Mode:** sim-only (Option 1 from the rehearsal pre-flight).

---

## 1. Environment

| Layer | Where | Notes |
|---|---|---|
| Postgres | local Docker `ev-charger-postgres` | port 5432, schema migrated through `20260428180000_task_0208_phase3_slice_a` |
| OCPP server | `node packages/ocpp-server/dist/index.js` (process-local) | port 9000, internal HTTP 9001 |
| Env flag | `FLEET_GATED_SESSIONS_ENABLED=true` (local shell only) | unset on prod Railway services throughout rehearsal |
| Sim | `npx ts-node packages/ocpp-server/src/scripts/sim-fleet-auto.ts` (new for Slice E) | drives a real OCPP-1.6 RPCClient |
| Charger identity | `CP002` (seeded by `prisma/seed.ts`) | Hawthorne site |
| Mobile | not exercised in this rehearsal — Slice D tests cover the mobile filter via static typecheck; physical-device validation is deferred to F |

LaunchAgent `com.evcharger.ocpp-server.plist` was unloaded for the rehearsal and restored at teardown. Process-local server runs replaced it for the duration of the test.

---

## 2. Test data

### FleetPolicy

| Field | Value |
|---|---|
| `id` | `fleet-sim-policy-e` |
| `siteId` | `site-hawthorne-001` |
| `name` | `Slice E Always-On` |
| `status` | `ENABLED` (test); restored to `DISABLED` at teardown |
| `idTagPrefix` | `FLEETSIM-` (legacy column, unused by Phase 3 runtime) |
| `maxAmps` | `16` |
| `ocppStackLevel` | `90` (column unused by Phase 3 runtime; engine hardcodes 90/1) |
| `alwaysOn` | `true` for baseline, `false` for windowed test |
| `autoStartIdTag` | `FLEETSIM01` (9 chars, fits OCPP CiString20Type) |
| `windowsJson` | `{"windows":[]}` baseline; `{"windows":[{"day":2,"start":"16:36","end":"16:41"}]}` windowed |

### Connector config

| Field | Value |
|---|---|
| `chargerId` | `charger-002` (CP002) |
| `connectorId` | `1` |
| `chargingMode` | `FLEET_AUTO` (test); restored to `PUBLIC` at teardown |
| `fleetPolicyId` | `fleet-sim-policy-e`; cleared at teardown |
| `fleetAutoRolloutEnabled` | `true` per-connector override; cleared at teardown |
| `Site.fleetAutoRolloutEnabled` | left `false` to verify connector-override path |

### Final state (at teardown)

```
ENABLED FleetPolicy count globally: 0
CP002 connector 1: chargingMode=PUBLIC, fleetPolicyId=NULL, fleetAutoRolloutEnabled=NULL
Site Hawthorne: fleetAutoRolloutEnabled=false
LaunchAgent ocpp-server: reloaded (pid 62318)
```

---

## 3. Scenarios run

### 3.1 Positive baseline — always-on policy

**Setup:** policy `alwaysOn=true`, connector FLEET_AUTO, rollout flag ON, env flag ON.

**Sim transcript (key lines):**

```
✅ Connected
Boot: Accepted interval=900s
Heartbeat: 2026-04-28T23:28:15.380Z
Sent Preparing at 2026-04-28T23:28:15.979Z, waiting up to 15000ms for RemoteStartTransaction…
[Sim] ◀── RemoteStartTransaction received: connectorId=1 idTag=FLEETSIM01
✅ Got auto-start idTag: FLEETSIM01
Authorize: Accepted
StartTransaction: txn=57445 status=Accepted
  meter 1: 100500 Wh
  meter 2: 101000 Wh
  meter 3: 101500 Wh
Stop: idTagInfo=Accepted kWh=1.500
✅ SIMULATION COMPLETE
```

**Server log (decision trail):**

```
[fleet.auto-start] Decision: ACCEPTED chargerId=charger-002 ocppId=CP002 connectorId=1 policyId=fleet-sim-policy-e idTag=FLEETSIM01
[fleet.auto-start] RemoteStart Accepted on attempt 1: ocppId=CP002 connectorId=1 idTag=FLEETSIM01
[Authorize] chargerId=charger-002 idTag=FLEETSIM01
[StartTransaction] chargerId=charger-002 connector=1 idTag=FLEETSIM01 meterStart=100000 reservationId=none
[StartTransaction] fleet-auto direct attachment (verified pending): chargerId=charger-002 connectorId=1 policyId=fleet-sim-policy-e idTag=FLEETSIM01
[RemoteSetChargingProfile] Charger CP002 responded: Accepted
[MeterValues] fleet: first energy flow sessionId=92bede65-d7bf-4949-8b82-b97f89c95393 policy=fleet-sim-policy-e at=2026-04-28T23:28:17.051Z deltaWh=500.0 deltaW=2100350
[StopTransaction] fleet observation written sessionId=92bede65-d7bf-4949-8b82-b97f89c95393 policy=fleet-sim-policy-e preDeliveryGatedMinutes=0.01 gatedPricingMode=gated
```

**DB row evidence (immediately post-stop):**

```
Synthetic User row:
  id      : 35fcabe3-a1ff-4b54-95be-8c2c0dc05b01
  idTag   : FLEETSIM01
  email   : fleet-policy-fleet-sim-policy-e@fleet.local
  clerkId : synthetic-fleet-fleet-sim-policy-e
  name    : Fleet Policy Slice E Always-On

Session row:
  id            : 92bede65-d7bf-4949-8b82-b97f89c95393
  status        : COMPLETED
  transactionId : 57445
  idTag         : FLEETSIM01
  fleetPolicyId : fleet-sim-policy-e
  userId        : 35fcabe3-... (synthetic, ✓)
  plugInAt      : 2026-04-28 23:28:16.22 (set ✓)
  firstEnergyAt : populated (✓)
  lastEnergyAt  : populated (✓)

BillingSnapshot:
  grossAmountUsd            : 0.52
  netAmountUsd              : 0.52
  kwhDelivered              : 1.5
  preDeliveryGatedMinutes   : 0.01385
  gatedPricingMode          : gated
```

**Verdict:** ✅ All Slice C/D wires lit:
- StatusNotification(Preparing) → `maybeAutoStartFleet` decision matrix passed
- RemoteStartTransaction Accepted on attempt 1 (no retry needed)
- Authorize succeeded against the synthetic user (Slice C synthetic-user upsert path)
- StartTransaction direct-FK attachment via `consumeFleetAutoStartPending` (verified pending)
- Fleet engine pushed a charging profile, charger acked
- MeterValues populated `firstEnergyAt`; StopTransaction wrote BillingSnapshot with `gatedPricingMode='gated'` and a `preDeliveryGatedMinutes` value

> **Sim-only caveat:** the sim acks `SetChargingProfile` but does not actually obey 0 A — it continues to send MeterValues regardless. So `preDeliveryGatedMinutes=0.01` reflects the time between `plugInAt` and the very next MeterValues frame the sim sent (~600 ms), not a real deny-window dwell. A real charger obeying the 0 A profile would produce a much larger value, but that's a property of the firmware behavior, not of the server code path. The control path was fully exercised.

### 3.2 Negative — connector rollout flag OFF

**Setup:** flipped `Connector.fleetAutoRolloutEnabled=false`. Site flag remained `false`. OCPP server restarted to clear the 30-s rollout cache.

**Result:** `SIM_NEGATIVE=true` simulator timed out waiting for `RemoteStartTransaction` ✅. Server log:

```
[fleet.auto-start] Skipped: chargerId=charger-002 connectorId=1 reason=rollout-disabled {}
```

### 3.3 Negative — chargingMode = PUBLIC

**Setup:** flipped `Connector.chargingMode='PUBLIC'`, `fleetAutoRolloutEnabled=true`. OCPP server restarted.

**Result:** simulator timed out waiting ✅. No server log line — `mode-public` is silent by design (high-volume, expected case for every public charger plug-in).

### 3.4 Negative — env flag OFF

**Setup:** restored `chargingMode=FLEET_AUTO`. Started OCPP server with `FLEET_GATED_SESSIONS_ENABLED` **unset**.

**Result:** simulator timed out waiting ✅. No log line — `flag-off` is silent by design.

### 3.5 Windowed policy — fleet attachment + gating-mode capture

**Setup:** `alwaysOn=false`, single allow window 5 min in the future (16:36–16:41 PDT). Sim runs at 16:31 PDT — outside the allow window → policy says "deny" → fleet engine should push a 0 A profile.

**Result:** session COMPLETED with `fleetPolicyId` attached, `gatedPricingMode='gated'`. Server log:

```
[fleet.auto-start] Decision: ACCEPTED ...
[RemoteSetChargingProfile] Charger CP002 responded: Accepted
[StopTransaction] fleet observation written ... preDeliveryGatedMinutes=0.01 gatedPricingMode=gated
```

**Caveat (same as 3.1):** the sim doesn't obey 0 A so `preDeliveryGatedMinutes` doesn't reflect a real deny dwell. Behavior is a sim limitation; control-path correctness is what this rehearsal validates.

---

## 4. Cross-check: side-effects we intentionally avoided

| Concern | Outcome |
|---|---|
| Prod Railway env vars touched | ❌ no |
| Prod rollout flags touched | ❌ no |
| Prod DB rows touched | ❌ no |
| Hijack of real-driver `idTag` | ❌ no — `FLEETSIM01` had no existing User; synthetic created cleanly |
| Stale `dist/` process running old code | ❌ no — LaunchAgent unloaded, fresh `dist/` rebuilt before each run |
| Local DB state diverged from teardown plan | ❌ no — `count(ENABLED policies)=0` and connector restored to PUBLIC at end |

---

## 5. Code defects found

**None.**

The decision matrix, retry/idempotency, synthetic-user path, direct-FK attachment via `consumeFleetAutoStartPending`, profile push, and billing-snapshot capture all behaved as designed across all five scenarios.

---

## 6. Recommendations before Slice F (prod pilot)

1. **Stand up a Railway `staging` environment** (still option 2 from the pre-flight) before the first prod flag flip. Local rehearsal proves the code path; staging would validate the deploy mechanics + Keycloak prod-realm interaction + the env-var read path on Railway.
2. **Real-charger sim caveat on `preDeliveryGatedMinutes`**: validate against a real charger (1A32 or similar) during F so we have a baseline for what a non-zero value actually looks like.
3. **Optional: charger-side simulator that obeys SetChargingProfile.** Out of Slice E scope, but would make windowed-policy regressions catchable in CI.

---

## 7. Reproducibility

The `sim-fleet-auto.ts` script (committed in this PR) is parameterized:

```bash
# Positive run
SIM_CHARGER_ID=CP002 SIM_CHARGER_PASS=cp002-secret \
  npx ts-node packages/ocpp-server/src/scripts/sim-fleet-auto.ts

# Negative run (expects timeout)
SIM_CHARGER_ID=CP002 SIM_CHARGER_PASS=cp002-secret \
  SIM_NEGATIVE=true SIM_REMOTE_START_TIMEOUT_MS=8000 \
  npx ts-node packages/ocpp-server/src/scripts/sim-fleet-auto.ts
```

Logs from this rehearsal are at `/tmp/slice-e-evidence/` on the dev workstation:

```
ocpp.log               positive baseline server log
ocpp-negative.log      rollout-disabled run
ocpp-public.log        chargingMode=PUBLIC run
ocpp-flag-off.log      env flag unset run
ocpp-windowed.log      windowed policy run
sim-positive.log       positive sim transcript
sim-negative-rollout.log
sim-negative-public.log
sim-negative-flag-off.log
sim-windowed.log
```

These are workstation artifacts, not committed.

---

## 8. Cross-references

- Design: `tasks/task-0208-phase3-fleet-auto-redesign.md`
- Schema: PR #72 (Slice A)
- Operator UX: PR #73 (Slice B)
- Runtime: PR #74 (Slice C)
- Mobile filter: PR #75 (Slice D)
