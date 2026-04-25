# TASK-0208 — Phase 2 Design Note

**Status:** DESIGN ONLY. **Do not begin implementation until F5h PASSES.**
**Depends on:** Phase 1 scaffold (`6f24a15` on dev), F5h validation (`task-0208-f5h-validation-plan.md`)
**Binding rules:** Design rules 1–5 in `task-0208-f5-server-gate-firmware-check.md` § "Design rules (binding for Phase 2+)"

---

## Scope

Phase 2 wires Phase 1's schema scaffold into the live OCPP flow so that a fleet driver's plug-in actually triggers window-gated current modulation. Behavior remains flag-gated: no production change unless `FLEET_GATED_SESSIONS_ENABLED=true` AND a matching `FleetPolicy` row exists.

### In scope
1. Authorize handler — attach `fleetPolicyId` to the forthcoming session
2. `applyFleetPolicyProfile()` — gated wrapper over `SetChargingProfile`, stackLevel=90
3. MeterValues handler — populate `plugInAt`, `firstEnergyAt`, `lastEnergyAt`
4. Snapshot capture — compute `preDeliveryGatedMinutes` and `gatedPricingMode` at StopTransaction
5. Edge-triggered window scheduler with 5-min reconciliation backup
6. BootNotification re-apply (hard rule #2)
7. FleetPolicy CRUD (API + portal) — minimal, operator-only
8. Unit tests; no UX polish (Phase 4)

### Out of scope (deferred)
- Driver app "scheduled at HH:MM" UI (Phase 4)
- Portal fleet-session window-state display (Phase 4)
- Receipt template split time (Phase 4)
- Multi-organization rollout controls (Phase 5)

---

## Architecture (by layer)

### 1. Authorize handler — `packages/ocpp-server/src/handlers/authorize.ts`

On Authorize, resolve `FleetPolicy` by `idTag.startsWith(policy.idTagPrefix)` across all policies for the charger's site/charger scope (Design Rule 3). If matched:

- Return `Accepted` regardless of window state (Hybrid-B premise: always-Accept, modulate current).
- Stash `{ fleetPolicyId, matchedAt }` in a short-lived in-memory map keyed by `{ ocppId, idTag }` so the subsequent StartTransaction can attach `fleetPolicyId` to the created `Session` row. TTL ~5 min (Authorize → StartTransaction is typically <30 s).

Non-fleet idTags: unchanged path.

**Key invariant:** this is the ONLY place `fleetPolicyId` gets assigned to a session. Receipts and sessionSafety key off `Session.fleetPolicyId`; it must be set before the first MeterValues lands.

### 2. `applyFleetPolicyProfile()` — `packages/ocpp-server/src/smartCharging.ts`

New exported wrapper. Signature:

```ts
applyFleetPolicyProfile(chargerId: string, opts: {
  amps: number;           // 0 or policy maxAmps
  sessionId: string;      // for logging / traceability
  reason: 'window-open' | 'window-close' | 'boot-reapply';
}): Promise<{ ok: boolean; why?: string }>
```

Rules (Design Rule 1):
- Goes through `connectionReadyForSmartCharging()` gate. If not ready → mark `smartChargingState.status = PENDING_OFFLINE` and return `{ ok: false, why: 'not-ready' }`.
- stackLevel=**90** (Design Rule 2).
- `chargingProfilePurpose=TxProfile`, `chargingRateUnit=A`, single period `{startPeriod:0, limit: amps}`.
- On BootNotification: existing re-reconcile mechanism picks up `PENDING_OFFLINE` and re-applies. No Phase 2 change needed beyond ensuring the fleet profile is in the reconcile set.
- **Never** call `remoteSetChargingProfile` or hit `/set-charging-profile` directly for fleet modulation — those bypass the gate.

**Parallel path audit:** `api/lib/smartCharging.ts` also exists (hard rule #5). Fleet modulation is server-driven (window edges), so it lives only in `ocpp-server/src/smartCharging.ts`. The HTTP path is not touched for fleet purposes. Document this explicitly in the wrapper's doc-comment to prevent future drift.

### 3. MeterValues handler — `packages/ocpp-server/src/handlers/meterValues.ts`

On each MeterValues with `measurand=Energy.Active.Import.Register`:

- If `session.plugInAt` is null: set to StatusNotification "Preparing" transition time, or fall back to StartTransaction time. (Preferred: capture at `statusNotification.ts` Preparing edge; MeterValues is the fallback when that transition was missed.)
- If this MeterValues shows `energyKwh > previousEnergyKwh`: set `session.firstEnergyAt` (once, if null) and update `session.lastEnergyAt`.
- If `energyKwh == previousEnergyKwh`: update nothing (0 A dwell ticks do not move `lastEnergyAt`).

All three fields are nullable on current dev — safe to write conditionally.

### 4. Snapshot capture — `packages/api/src/routes/sessions.ts` (receipt / billing-snapshot path)

At the moment `SessionBillingSnapshot` is created (StopTransaction → receipt generation):

- If `session.fleetPolicyId != null`:
  - `preDeliveryGatedMinutes` = floor minutes between `plugInAt` and `firstEnergyAt` (0 if `firstEnergyAt` is null — i.e., session ended without ever delivering energy).
  - `gatedPricingMode` = snapshot of `FleetPolicy.pricingMode` at capture time (e.g., `'gated-free'`, `'gated-standard-tou'`). Design Rule 4: never rewrite past snapshots.
- Else: both fields stay null. Non-fleet snapshots unchanged.

### 5. Window scheduler

Location: new `packages/ocpp-server/src/fleetScheduler.ts`.

- For each ACTIVE session with `fleetPolicyId != null`:
  - On session create (and on server boot for existing ACTIVE fleet sessions): call `evaluateFleetWindowAt(now, policy)` (already shipped in Phase 1), schedule a `setTimeout` for `nextTransitionAt`.
  - On timer fire: re-evaluate, push the new amps limit via `applyFleetPolicyProfile()`, schedule the next edge.
- Backup: 5-min interval loop scans all ACTIVE fleet sessions and reconciles: if current profile amps ≠ expected amps per `evaluateFleetWindowAt(now)`, push correct amps.
- Cleanup: on StopTransaction, cancel any pending timer for that session.

**Why edge-triggered + periodic:** per astra review (source doc line 626) — edge timers give crisp UX at window open/close; periodic reconciliation catches missed edges (server restart, clock skew, network blip).

### 6. BootNotification re-apply — hard rule #2

No new code: the existing `smartChargingState.status = PENDING_OFFLINE` + boot-time reconcile handles this, provided fleet profiles use the same reconciliation mechanism. Phase 2 work: ensure `applyFleetPolicyProfile()` writes the same state fields the existing reconciler reads.

### 7. FleetPolicy CRUD

API routes under `packages/api/src/routes/fleetPolicies.ts`:
- `GET /fleet-policies` — list, operator-scoped
- `POST /fleet-policies` — create
- `PATCH /fleet-policies/:id` — update
- `DELETE /fleet-policies/:id` — soft-delete (status=`DISABLED`), never hard-delete (Design Rule 3: past sessions FK-lessly reference the id)

Portal: minimal form under operator settings — idTagPrefix, site/charger scope, allowedWindows JSON editor, maxAmps, pricingMode, status toggle.

---

## Feature flag surface

| Flag | Default | Effect |
|------|---------|--------|
| `FLEET_GATED_SESSIONS_ENABLED` | `false` | When false: Authorize handler skips fleet match entirely; `applyFleetPolicyProfile()` returns `{ ok: false, why: 'flag-off' }`; scheduler does not start; snapshot capture writes null fields. |

Flag is read once at server boot + re-read by scheduler loop each cycle. No per-charger flag in Phase 2.

---

## Tests

- Unit: `applyFleetPolicyProfile()` readiness gate, stackLevel, amps clamping
- Unit: scheduler next-edge computation across DST, timezone boundaries (reuse `fleetWindow.selftest.ts` fixtures)
- Integration (OCPP simulator): full flow — Authorize → StartTransaction → window-closed 0 A → window-open maxA → MeterValues with energy flow → window-close 0 A → StopTransaction → snapshot has correct `preDeliveryGatedMinutes`
- Regression: non-fleet idTag follows unchanged path; guest (no `stripeCustomerId`) unaffected
- Regression: flag OFF → no behavior change vs current dev

---

## Migration

None. Phase 1's additive migration already covers all fields Phase 2 writes. Design Rule 5 (additive, never destructive) holds.

---

## Open questions for implementation

1. **Authorize/StartTransaction linking cache:** in-memory map is simplest, but survives server restart poorly. Is a 5-min window acceptable, or should we write a short-lived `PendingFleetMatch` row? In-memory is the default; reconsider if field tests show Authorize→StartTransaction gaps > 1 min.
2. **pricingMode vocabulary:** finalize the enum for `gatedPricingMode` (`'gated-free'`, `'gated-standard-tou'`, `'gated-flat'`?). Needs operator/product input before Phase 2 PR opens.
3. **Scheduler and clustering:** if the OCPP server runs >1 replica, edge timers duplicate. Current prod is single-process (hard rule #6). Document this as a constraint; if clustering ever happens, move scheduler to a leader-elected worker.

---

## Go/no-go

Phase 2 implementation starts **only** when F5h has PASSED per `task-0208-f5h-validation-plan.md`. If F5h FAILS, this document is obsolete and the successor is a Plan-B design note (deferred authorization).
