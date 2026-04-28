# TASK-0208 — Phase 3 Fleet-Auto Redesign

**Status:** DESIGN — revised 2026-04-28. No implementation yet.  
**Author trigger:** 2026-04-28 prod E2E halt: Phase E showed the shipped Hybrid-B/RFID-prefix activation model does not deliver the desired dedicated-fleet “plug in and charge” UX.  
**Depends on:** Phase 1 scaffold, Phase 2 gating engine, Phase 2.5 CRUD/portal.  
**Replaces:** Hybrid-B/RFID-prefix activation. Hybrid-B is deprecated because it does not satisfy plug-and-charge auto-start UX; retain only as temporary migration compatibility.

---

## 0. Revision decisions

This revision makes the following calls so the next step can be ticket slicing, not another open-ended design pass:

1. **Granularity:** store fleet-auto mode on `Connector`, not `Charger`.
   - Current schema already models `Connector` separately.
   - A multi-port charger may need one fleet connector and one public connector.
   - Portal can still expose charger-level bulk controls for single-connector or all-connectors-same-mode devices.
2. **Activation identity:** use a policy-owned `autoStartIdTag`, but create/resolve a real synthetic fleet user for that idTag.
   - `Session.userId` is required today; anonymous/system sessions would require a larger billing/auth rewrite.
   - `autoStartIdTag` should be **site-unique among ENABLED/DRAFT policies** to avoid operator confusion, even though runtime matching is via connector FK.
3. **Mobile visibility:** expose fleet-only connectors as unavailable/informational, not hidden.
   - Drivers understand why a visible physical charger cannot be started from the app.
4. **Always-on:** model as a first-class policy boolean that bypasses windows but still uses the existing fleet scheduler/profile pathway.
5. **Kill switch:** keep `FLEET_GATED_SESSIONS_ENABLED` as the global runtime gate. With the flag OFF, Fleet-Auto never sends `RemoteStartTransaction` and never changes live behavior.
6. **Hybrid-B deprecation:** mark prefix/RFID fleet activation as deprecated now. It does not match the required plug-and-charge auto-start UX. Slice G (§8) removes the Authorize-handler prefix branch, rewrites `docs/fleet-policies.md` to describe Fleet-Auto only, and runs a row-classification migration that either ports legacy `idTagPrefix` rows to Fleet-Auto or archives them. Until Slice G ships, prefix matching survives **only** as data-compatibility — no new UX, docs, or deployments built on it.

---

## 1. Problem statement

### Desired UX

Operator flow:
1. Operator with site edit privilege enables fleet-auto on selected connector(s).
2. Operator assigns a FleetPolicy: windows + max amps + pricing mode, or `alwaysOn=true`.
3. Operator confirms that any plug-in on those connector(s) may auto-start a fleet session.

Driver flow:
1. Driver plugs into a fleet-auto connector.
2. Server auto-authorizes with the policy’s fleet idTag and sends `RemoteStartTransaction`.
3. Existing fleet gating holds at 0 A outside the allowed window and releases to `maxAmps` inside it.
4. Session ends on unplug / charger StopTransaction.

Public flow:
- Public connectors remain unchanged: driver app / RFID / operator RemoteStart only.

### What shipped in Hybrid-B

Hybrid-B only attaches fleet policy after an idTag prefix match during Authorize/StartTransaction. That requires RFID cards or manual RemoteStart and fails the actual dedicated-fleet requirement: “set policy once; driver just plugs in.”

---

## 2. What stays unchanged

| Area | Decision |
|---|---|
| `applyFleetPolicyProfile()` | Reuse unchanged; still the only fleet path that sends charging profiles. |
| `fleetScheduler` | Reuse; add `alwaysOn` handling, but preserve edge/reconcile model. |
| Boot + heartbeat gate | Mandatory. No server-initiated OCPP command before readiness. |
| `Session.fleetPolicyId`, `plugInAt`, `firstEnergyAt`, `lastEnergyAt` | Keep. Fleet-auto sessions populate the same fields. |
| Billing snapshot fields | Keep. No historical rewrite. |
| `FLEET_GATED_SESSIONS_ENABLED` | Keep as global OFF switch. |
| FleetPolicy immutable-while-enabled rule | Keep. Policy value edits still require DISABLED state. Connector assignment changes are separate audited config changes. |
| Hybrid-B prefix path | **Deprecated as of this revision.** Section 8 Slice G removes the Authorize-handler prefix branch and archives existing rows. Until that slice lands, prefix matching survives only as data-compatibility — no new UX, docs, or deployments built on it. |

---

## 3. Desired-state schema

Prefer connector-level configuration with charger-level UI convenience.

```prisma
enum ChargingMode {
  PUBLIC
  FLEET_AUTO
}

model Connector {
  // existing fields...
  chargingMode  ChargingMode @default(PUBLIC)
  fleetPolicyId String?
  fleetPolicy   FleetPolicy? @relation(fields: [fleetPolicyId], references: [id], onDelete: SetNull)

  @@index([chargingMode])
  @@index([fleetPolicyId])
}

model FleetPolicy {
  // existing fields...
  alwaysOn       Boolean @default(false)
  autoStartIdTag String

  // deprecated Hybrid-B compatibility only; not used for new fleet setup
  idTagPrefix    String?

  connectors     Connector[]
}
```

### Migration notes

1. Add `ChargingMode` enum.
2. Add nullable/defaulted connector fields: `Connector.chargingMode`, `Connector.fleetPolicyId`.
3. Add `FleetPolicy.alwaysOn` default false.
4. Add nullable `FleetPolicy.autoStartIdTag`, backfill from existing `idTagPrefix` or deterministic `FLEET-AUTO-<shortPolicyId>`, then make non-null.
5. Make `FleetPolicy.idTagPrefix` nullable only if current validation/API paths are updated in the same PR.
6. Add validation for active/draft `autoStartIdTag` uniqueness within a site.
7. Generate and commit a Prisma migration. **No prod `db push`.**

Open implementation detail: Prisma cannot express partial unique indexes portably; enforce site-scoped `autoStartIdTag` uniqueness in API validation and add a DB unique/index only if it does not block legacy/disabled rows.

---

## 4. Runtime design

### Trigger

New module: `packages/ocpp-server/src/fleet/fleetAutoStart.ts`

`maybeAutoStartFleet()` runs after connector status persistence when a StatusNotification indicates plug-in:

- Primary trigger: connector transitions into `Preparing`.
- Also accept `SuspendedEVSE`/`SuspendedEV` as a defensive secondary trigger only when charger firmware skips `Preparing`.
- Never trigger repeatedly for the same connector while an ACTIVE or PENDING_START fleet-auto attempt exists.

### Decision matrix

Auto-start is allowed only when all are true:

1. `FLEET_GATED_SESSIONS_ENABLED === true`
2. charger connection is ready for server-initiated commands: BootNotification + at least one Heartbeat
3. connector `chargingMode === FLEET_AUTO`
4. connector has a non-null `fleetPolicyId`
5. policy exists and `status === ENABLED`
6. policy has valid `autoStartIdTag`
7. no ACTIVE session exists for that connector
8. no recent pending auto-start attempt exists for that connector/idTag

If any condition fails, log a structured skip reason. Misconfiguration skips should surface in portal diagnostics; normal PUBLIC skips should be silent/debug only.

### OCPP flow

1. Vehicle plug-in status arrives.
2. `maybeAutoStartFleet()` resolves connector policy.
3. Server sends `RemoteStartTransaction({ connectorId, idTag: policy.autoStartIdTag })` through the same readiness-safe send path used by smart charging.
4. Charger returns Accepted/Rejected.
5. If Accepted, charger sends StartTransaction.
6. StartTransaction handler attaches:
   - `Session.fleetPolicyId = connector.fleetPolicyId`
   - `Session.userId = synthetic fleet user for policy.autoStartIdTag`
   - `Session.plugInAt` from connector transition if available, else `startedAt`
7. Existing `applyFleetPolicyProfile()` applies current gate: 0 A outside window, `maxAmps` inside window, or `maxAmps` when `alwaysOn=true`.

### Idempotency / retry

- Use a short-lived in-memory pending key: `{ chargerId, connectorId, fleetPolicyId, autoStartIdTag }`.
- If RemoteStart is rejected or times out, retry once after ~6 seconds for F5h/firmware flake.
- If still failed, emit `FleetAutoStartFailed` audit/event row and clear pending state.
- Do not keep retrying indefinitely; avoid command storms.
- On OCPP server restart, pending state may be lost, but ACTIVE session DB check prevents duplicates after StartTransaction has landed.

### Authorize / StartTransaction changes

- For Fleet-Auto connectors, accept `policy.autoStartIdTag` when it matches the connector’s assigned policy.
- Do not require `User.idTag` lookup before accepting the OCPP authorize; create/resolve synthetic fleet user for session persistence.
- Public connectors continue through existing auth behavior.
- **Hybrid-B prefix matching is deprecated.** It survives in code only until Slice G ships, at which point the Authorize-handler prefix branch is removed. Do not extend, instrument, or document this path. Any operator setup that would have used it must use Fleet-Auto instead.

### Always-on semantics

`alwaysOn=true` means:
- scheduler/window evaluation returns “allowed now” 24/7
- profile still applies `maxAmps`
- billing still records fleet/gated pricing mode
- no special bypass around `applyFleetPolicyProfile()`; keep one fleet current-control path

---

## 5. Portal/API UX

### Connector / charger configuration

- Charger detail shows connector rows with `Public` / `Fleet auto-start` mode.
- For single-connector chargers, UI may look charger-level but writes connector-level config.
- Multi-connector chargers show per-connector controls plus a bulk “apply to all connectors” action.
- Fleet mode requires selecting an ENABLED FleetPolicy for the same site.
- Switching to Fleet-Auto requires confirmation:
  > Any vehicle plugged into this connector may auto-start a fleet session using the selected policy.
- Every mode/policy assignment change writes an audit event.

### FleetPolicy form

- Add `Always on (24/7)` checkbox; hides/disables windows editor while checked.
- Add `autoStartIdTag` field with generated default: `FLEET-AUTO-<siteSlug>-<shortId>`.
- Hide `idTagPrefix` from new-policy creation. If legacy rows must be edited, show it only in a clearly labeled deprecated/compatibility section.
- Enforce existing rule: enabled policies are immutable. To edit windows/max amps/idTags, disable policy first.

### API

- Expose connector `chargingMode` and `fleetPolicyId` in charger/site responses.
- Add endpoint or extend existing charger update route for connector fleet config.
- Validate same-site policy assignment.
- Validate operator has site edit privilege.
- Validate `autoStartIdTag` is safe length/charset for OCPP idTag compatibility.

### Mobile app

- Driver-facing charger/connector views show Fleet-Auto connectors as `Fleet only — not available in app` with no Start button.
- Public connectors remain unchanged.

---

## 6. Safety invariants

1. PUBLIC connector never auto-starts.
2. Flag OFF means zero auto-start behavior, even if connector config exists.
3. Fleet-Auto without assigned ENABLED policy refuses to auto-start and surfaces operator-visible misconfiguration.
4. Server-initiated RemoteStart must respect boot+heartbeat readiness.
5. No command storms: one retry max, no unbounded loops.
6. Public mobile/RFID sessions cannot accidentally inherit a connector fleet policy unless idTag is the policy `autoStartIdTag`. The deprecated Hybrid-B prefix-matching branch in Authorize is removed in Slice G; until then it must not be used for any new fleet setup.
7. Policy edits remain blocked while ENABLED.
8. All prod rollout starts with code + schema deployed while flag OFF.
9. Every prod test ends by restoring baseline: flag OFF, no ENABLED FleetPolicy unless intentionally continuing pilot, connector mode reset if test-only.

---

## 7. Edge cases

| Scenario | Expected behavior |
|---|---|
| Plug-in before allow window | Auto-start creates fleet session; profile applies 0 A; scheduler releases at window open. |
| Plug-in while `alwaysOn=true` | Auto-start creates fleet session; profile applies `maxAmps` immediately. |
| RemoteStart rejected | Retry once after ~6s; if still failed, audit + portal diagnostic; no further retries. |
| Charger skips `Preparing` and reports `SuspendedEVSE` | Defensive trigger may auto-start if no active/pending session. |
| Charger reboots mid-session | Existing boot-time reconcile re-applies fleet profile after readiness. |
| OCPP server restarts after RemoteStart accepted but before StartTransaction | StartTransaction direct connector-policy attachment still works; no reliance on in-memory authorize cache. |
| Two connectors on same charger, one public and one fleet | Only fleet connector auto-starts. Public connector stays unchanged. |
| Flag off during fleet plug-in | No auto-start; connector remains waiting. This is intentional kill-switch behavior. |
| Policy disabled while connector still assigned | Auto-start refuses; portal shows misconfiguration. |
| Duplicate `autoStartIdTag` in same site | API rejects or warns before ENABLED; prefer reject for DRAFT/ENABLED. |

---

## 8. Execution plan — vertical slices

### Slice A — Schema + validation foundation

**Outcome:** Connector-level config and policy fields exist with no runtime behavior change.  
**Files likely touched:** Prisma schema/migration, shared types, API validators/tests.  
**Acceptance:**
- migration generated and committed
- existing data backfilled to `PUBLIC`
- `autoStartIdTag` validation added
- no OCPP auto-start code active

**Verification:**
- `prisma migrate dev` or test DB migration
- API/unit validation tests
- schema drift check

### Slice B — API + portal config UX

**Outcome:** Operators can assign Fleet-Auto mode per connector and configure policy `alwaysOn`/`autoStartIdTag`; still no runtime auto-start.  
**Files likely touched:** API charger/fleet routes, portal charger detail, FleetPolicy form, audit log path.  
**Acceptance:**
- operator can switch connector Public ↔ Fleet-Auto
- confirmation dialog exists
- audit event written
- enabled-policy immutability preserved
- mobile/app APIs expose mode safely

**Verification:**
- API tests for role/same-site validation
- portal build/typecheck
- Storybook or screenshot/manual portal verification

### Slice C — Fleet-Auto runtime behind flag

**Outcome:** OCPP server can auto-start a fleet session on fleet connector plug-in, but only with flag ON.  
**Files likely touched:** `fleetAutoStart.ts`, status handler, authorize/start transaction handlers, synthetic fleet user helper, tests.  
**Acceptance:**
- PUBLIC connector ignored
- FLEET_AUTO connector auto-starts only when flag ON and policy ENABLED
- StartTransaction attaches `fleetPolicyId`
- synthetic fleet user/session persistence works
- readiness gate enforced
- retry/idempotency covered

**Verification:**
- unit decision matrix
- simulator integration: PUBLIC ignored, FLEET_AUTO starts
- compatibility regression: deprecated Hybrid-B rows do not break during migration

### Slice D — Mobile visibility + API response polish

**Outcome:** Driver app communicates fleet-only connectors correctly.  
**Acceptance:**
- fleet-only connector has no Start button
- public connector behavior unchanged

**Verification:**
- mobile typecheck/build gate
- simulator/manual screen check if practical

### Slice E — Staging/dev rehearsal

**Outcome:** End-to-end dry run before prod.  
**Acceptance:**
- flag ON only in dev/staging
- simulator plug-in auto-starts
- outside-window and always-on paths verified
- StopTransaction/billing snapshot verified

**Verification:**
- API `/health`, OCPP `/health`
- DB session row with `fleetPolicyId`, correct `idTag`, synthetic user
- logs show one RemoteStart, no duplicate loop

### Slice F — Prod pilot runbook

**Outcome:** Single-connector pilot on 1A32 or equivalent, with explicit restore path.  
**Acceptance:**
- code/schema deployed with flag OFF first
- one connector configured Fleet-Auto
- flag flipped only for planned test window
- real plug-in auto-starts
- gating/billing verified
- baseline restored unless Son approves continuing pilot

**Verification:**
- prod health endpoints
- OCPP `/status` confirms charger connected
- DB row evidence
- manual/charger evidence of energy flow
- post-test baseline: flag OFF, policy/connector mode final state recorded

### Slice G — Hybrid-B retirement

**Outcome:** Prefix/RFID activation is fully removed as a maintained code path. `idTagPrefix` survives only as a nullable historical column until a follow-up drop migration.  
**Trigger:** runs after Slice F pilot succeeds and any operator who previously relied on Hybrid-B has been moved to Fleet-Auto or accepted archival.  
**Files likely touched:** Authorize handler (remove prefix-match branch), FleetPolicy validators, `docs/fleet-policies.md`, portal (remove deprecated UI surfaces), admin script for row migration/archival, follow-up Prisma migration to drop `idTagPrefix`.

**Pre-flight (read-only):**
- enumerate all `FleetPolicy` rows where `idTagPrefix IS NOT NULL`
- for each, classify: (a) already migrated to Fleet-Auto (has `autoStartIdTag` + at least one connector with `chargingMode=FLEET_AUTO` referencing it), (b) ENABLED but unmigrated, (c) DRAFT/DISABLED unmigrated
- block this slice from merging until category (b) is empty

**Acceptance:**
- Authorize handler no longer reads `idTagPrefix` for any decision
- runtime tests confirm: a session started with an idTag matching a stale prefix is treated as PUBLIC (no fleet attachment)
- portal no longer offers prefix as a configuration field for new or edited policies
- `docs/fleet-policies.md` rewritten to describe Fleet-Auto only; Hybrid-B section moved to a "Historical / removed" appendix
- admin script idempotently sets `idTagPrefix = NULL` on all archived rows (or sets `status=DISABLED` + a `notes` archive marker if the row also lacks `autoStartIdTag`)
- follow-up migration drops `FleetPolicy.idTagPrefix` once the column is empty across all environments
- audit log captures every row touched by the migration

**Verification:**
- `select count(*) from "FleetPolicy" where "idTagPrefix" is not null` returns 0 in dev/staging/prod before column drop
- Authorize handler unit tests: prefix match no longer triggers fleet attachment
- regression: existing Fleet-Auto sessions unaffected
- `prisma migrate status` clean; no drift introduced

---

## 9. Rollout strategy

1. Land slices A–D on `dev` with runtime flag OFF.
2. Run Slice E in local/dev/staging.
3. Promote through normal `dev → main` PR process.
4. Deploy prod schema/code while flag OFF.
5. Configure one pilot connector.
6. Flip flag for planned window only.
7. Run pilot and restore baseline.
8. If pilot passes, keep one connector active for monitored soak only with Son approval.
9. Expand connector-by-connector; do not site-wide flip until at least one soak passes.
10. **Hybrid-B retirement (Slice G):** once Fleet-Auto is in soak and any prior Hybrid-B operator setup is migrated or archived, land Slice G to remove the Authorize-handler prefix branch and rewrite `docs/fleet-policies.md`. Run the row-migration/archival script in dev/staging first, then prod. Final cleanup migration drops `FleetPolicy.idTagPrefix` after the column is empty in all environments.

---

## 10. Design acceptance checklist

- [x] Granularity decision made: connector-level storage, charger-level bulk UI allowed.
- [x] `autoStartIdTag` semantics decided: policy-owned, site-unique for DRAFT/ENABLED, backed by synthetic fleet user for required `Session.userId`.
- [x] Mobile behavior decided: show fleet-only unavailable, no Start button.
- [x] Hybrid-B fate decided: deprecated now; Slice G removes the Authorize prefix branch and archives existing rows. No new UX, docs, or deployments built on Hybrid-B.
- [ ] Migration reviewed by second agent/human before implementation.
- [ ] Fleet customer/operator UX reviewed if available.
- [ ] Slice A ticket created with exact files/tests.
- [ ] Slice G ticket drafted with the row-classification query, archival script, doc rewrite, and follow-up `idTagPrefix` drop migration.

---

## 11. Cross-references

- `docs/fleet-policies.md` — current Hybrid-B operator/runtime docs. Slice G rewrites this file to describe Fleet-Auto only; Hybrid-B content moves to a historical/removed appendix.
- `tasks/task-0208-phase2-design-note.md` — shipped Phase 2 design.
- `tasks/task-0208-f5-server-gate-firmware-check.md` — readiness + smart charging guardrails.
- `tasks/task-0208-f5h-validation-plan.md` — field validation methodology.
- `CLAUDE.md` Fleet Policies hard rules #24–26.
- `memory/ev-charger-lessons.md` OCPP/Prisma/deploy rules.
