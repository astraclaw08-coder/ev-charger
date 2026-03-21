# OCPP Network Data Flow — QC Specification

> **Purpose:** Prevent regressions in critical IoT connectivity and OCPP protocol behavior.
> Any change touching `ocpp-server/`, `smartCharging`, OCPP handlers, or the `clientRegistry`
> must pass all applicable checks in this document before merging.

---

## 1. Critical Data Flows (must never break)

### 1A. Charger Connect → Boot → Heartbeat → Ready
```
WS connect
  → Auth (identity lookup, optional password check)
  → BootNotification received → status=ONLINE, outbox enqueued, smartChargingState reset to PENDING_OFFLINE
  → Heartbeat[1] received → connectionReadyForSmartCharging gate satisfied
  → applySmartChargingForCharger runs (first time after boot)
  → If profile assigned: PENDING_OFFLINE → Clear+Set → APPLIED
  → If no profile: skip entirely, no commands sent
  → Heartbeat[2+]: idempotency check → skip if APPLIED+same profile+same limit
```

**Regression tripwires:**
- Server MUST NOT send any server-initiated call (SetChargingProfile, ClearChargingProfile, TriggerMessage, etc.) between WS connect and first Heartbeat.
- BootNotification MUST reset `smartChargingState.status` to `PENDING_OFFLINE`.
- Chargers with no assigned profile MUST receive zero profile commands, ever.

---

### 1B. Charger Reconnect After Reboot
```
Charger reboots → volatile profile memory wiped
  → WS connect (new session)
  → BootNotification → PENDING_OFFLINE reset
  → First Heartbeat → gate satisfied → profile re-applied
  → DB: lastAppliedAt updated, status=APPLIED
```

**Regression tripwires:**
- After BootNotification, `smartChargingState.status` in DB must be `PENDING_OFFLINE`, not `APPLIED`.
- First heartbeat after boot MUST trigger Clear+Set for chargers with an active profile.

---

### 1C. Idempotent Heartbeat (stable connection, profile unchanged)
```
Heartbeat[N] (N > 1, no profile change, no reboot)
  → applySmartChargingForCharger runs
  → existingState.status=APPLIED + same sourceProfileId + |effectiveLimitKw delta| < 0.001
  → SKIP: no Clear, no Set, no OCPP commands sent
```

**Regression tripwires:**
- Stable charger with applied profile MUST NOT receive repeated Clear/Set on every heartbeat.
- `lastAttemptAt` updates; `lastAppliedAt` does NOT change on a skip.

---

### 1D. Profile Change Propagation
```
Operator updates/creates/deletes a SmartChargingProfile
  → API calls reconcileSmartChargingForCharger
  → New effectiveLimitKw or sourceProfileId differs from existingState
  → Clear + Set sent
  → DB: status=APPLIED, lastAppliedAt updated
```

---

### 1E. Active Session (StartTransaction → MeterValues → StopTransaction)
```
RemoteStart / local Start
  → StartTransaction → session record created, status=CHARGING
  → MeterValues (periodic) → session.kwhDelivered updated, monotonic guard enforced
  → StopTransaction → session closed, final kWh + cost computed
```

**Regression tripwires:**
- MeterValues MUST update session even during active charging (not only on stop).
- StopTransaction MUST NOT throw if session is already closed (idempotent).
- RemoteStart MUST work from AVAILABLE, PREPARING, and SUSPENDED_EV connector states.

---

## 2. QC Checklist — Run Before Any OCPP Change Merges

### Tier 1: Automated (run in CI on every PR touching ocpp-server/)

```bash
# Build checks
npm run build --workspace=packages/shared
npm run build --workspace=packages/ocpp-server   # or tsc --noEmit --skipLibCheck

# Smart charging gate test (simulator-based)
cd packages/ocpp-server
CHARGER_ID=TEST-ASTRA-001 OCPP_SIM_SERVER=ws://localhost:9000 \
  npx ts-node src/scripts/test-smart-charging-gate.ts

# Expected output:
#   ✅ No profile commands before first HB
#   ✅ PASS: idempotency — no redundant Clear/Set on subsequent HBs
#   ✅ ALL TESTS PASSED
```

### Tier 2: Local Integration (run manually before merging any OCPP handler change)

```bash
# 1. Start local stack
node scripts/dev-supervisor.js start

# 2. Confirm only ONE ocpp-server process on port 9000
fuser 9000/tcp     # should show exactly one PID
ps aux | grep "dist/index\|ts-node.*ocpp" | grep -v grep

# 3. Confirm local OCPP health
curl http://localhost:9000/health        # {"status":"ok"}
curl http://localhost:9000/status        # shows connected chargers

# 4. Run sim-persistent to simulate a full charger lifecycle
cd packages/ocpp-server
OCPP_SIM_SERVER=ws://localhost:9000 npx ts-node src/scripts/sim-persistent.ts &
SIM_PID=$!
sleep 30
kill $SIM_PID

# 5. Verify DB state after sim run
node -e "
const { PrismaClient } = require('./node_modules/.prisma/client');
const p = new PrismaClient();
p.smartChargingState.findMany({ select: { status:true, effectiveLimitKw:true, lastAppliedAt:true } })
  .then(r => r.forEach(x => console.log(JSON.stringify(x))))
  .finally(() => p.\$disconnect());
"
```

### Tier 3: Real Charger Smoke (run when modifying BootNotification/Heartbeat/SmartCharging handlers)

```
1. Confirm charger in connected[] via /status
2. Watch logs for 2 full heartbeat cycles (900s each):
     - First HB after boot: EXACTLY one Clear + one Set (if charger has profile)
     - Second HB+: ZERO Clear/Set commands (idempotency)
3. Check DB: lastAppliedAt is stable (not updating on every heartbeat)
4. Confirm charger stays in connected[] throughout (no reconnect loop)
5. For chargers WITHOUT profile (e.g. W1): ZERO profile commands ever
```

---

## 3. OCPP Change Safety Rules

### 3.1 Server-initiated commands
**Never send** `SetChargingProfile`, `ClearChargingProfile`, `RemoteStart`, `RemoteStop`, `Reset`, `TriggerMessage`, or any `[CALL]` frame to a charger:
- During the WS handshake/auth phase
- After `WS connect` but before `BootNotification` response is sent
- After `BootNotification` but before the first `Heartbeat` is received
- When the charger is not in `connected[]` (clientRegistry)

### 3.2 New OCPP handler checklist
When adding or modifying any inbound handler (`BootNotification`, `Heartbeat`, `StatusNotification`, etc.):
- [ ] Does the handler update charger `status` in DB?
- [ ] Does it enqueue an `OcppEventOutbox` event (for gate tracking)?
- [ ] Does it reset any state that the charger may have wiped (e.g., profiles on boot)?
- [ ] Does it trigger any server-initiated OCPP calls? If yes — are they gated by `connectionReadyForSmartCharging` or equivalent?
- [ ] Does it handle the case where the charger is OFFLINE/DEGRADED gracefully?
- [ ] Does the catch-all handler return `{}` instead of throwing (prevents `CALLERROR` disconnects)?

### 3.3 Smart charging changes specifically
When modifying `smartCharging.ts` or `reconcileSmartChargingForCharger`:
- [ ] Is idempotency preserved? (skip if `status=APPLIED` + same profile + same limit)
- [ ] Is the boot-reset path preserved? (BootNotification resets to `PENDING_OFFLINE`)
- [ ] Does a charger with no assigned profile receive zero commands?
- [ ] Does the gate (`connectionReadyForSmartCharging`) still require BootNotification + min heartbeats?
- [ ] Does a profile change (different `sourceProfileId` or limit) still trigger Clear + Set?

---

## 4. Known Real-World Firmware Behaviors (do not regress against these)

| Charger | Firmware quirk | Mitigation |
|---|---|---|
| W1 (IC3-23LOG) | Rejects `ClearChargingProfile` / `SetChargingProfile` with `onCallReceived error`; disconnects ~30s after | Never send profile commands if no profile assigned |
| 1A32 (LOOP) | Profiles are volatile — wiped on reboot | Boot-reset + re-apply on first heartbeat |
| Most field chargers | `ChargePointMaxProfile` does NOT persist across reboot despite OCPP §3.12 | Always re-apply on boot |
| Various | Sending server calls during boot stabilization causes firmware to disconnect | Enforce boot+heartbeat gate before any server-initiated call |

---

## 5. Incident Record

### 2026-03-17 — W1 connect/disconnect loop (smart charging boot storm)
- **Symptom:** W1 reconnecting every ~30s, logs showed `onCallReceived error` for Clear/SetChargingProfile
- **Root cause:** `applySmartChargingForCharger` fired on BootNotification for all chargers including those with no profile; stale OCPP process running old code
- **Fixes:** `b8b3038` (skip no-profile), `d0fdd67` (boot reset to PENDING_OFFLINE), `01e7eb4` (heartbeat gate)
- **Detection gap:** No automated test verified zero commands for no-profile chargers, no test for idempotency across reconnects
- **Prevention:** This QC spec + `test-smart-charging-gate.ts` added to CI
