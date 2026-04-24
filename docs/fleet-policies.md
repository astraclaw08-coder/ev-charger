# Fleet Policies — Operator Runbook

**Scope:** TASK-0208 Phase 2 (scheduler) + Phase 2.5 (CRUD + portal UI).
**Audience:** operators managing a site; on-call debugging a gated session.
**Status:** behaviorally complete behind the `FLEET_GATED_SESSIONS_ENABLED`
feature flag. Prod flag remains **OFF** until a separate flip PR lands.

---

## What a Fleet Policy does

A `FleetPolicy` declares an allowed delivery window + max current for a
group of drivers at a site, matched by `idTag` prefix.

Runtime behavior when the flag is ON:

- **Inside the window:** server allows the driver to charge, capped at the
  policy's `maxAmps`.
- **Outside the window:** server pushes a `ChargePointMaxProfile` at **0 A**,
  effectively pausing the charger until the window opens. The OCPP session
  stays open; the meter freezes.

Transitions are driven by two mechanisms in the scheduler:

1. **Edge timer** per charger, armed at the next window boundary (the
   `nextTransitionAt` value returned by `evaluateFleetWindowAt`).
2. **Periodic reconcile tick** (default 5 minutes, tunable via
   `FLEET_SCHEDULER_RECONCILE_MS`) which re-reads policies fresh and
   corrects any drift — handles clock skew, missed edge fires after a
   restart, and policy edits landed while a session is active.

Policies never cancel a transaction — the driver's session persists, only
the modulation changes.

---

## Creating and editing policies

All CRUD happens under SiteDetail → **Fleet Policies** tab (requires
`fleet.policy.write` permission, i.e. site:write scope).

- New policies land in **DRAFT**. They are visible but inert.
- **Enable** runs full validation (requires ≥1 valid window) and flips the
  row to **ENABLED**. The scheduler picks up the policy on its next tick
  and at every event (boot, session start/end).
- **Disable** flips back to **DISABLED**. The scheduler stops enforcing
  and, for any currently-gated session on that charger, the next reconcile
  tick will demote the gate profile via same-id replacement.
- **Delete** is blocked if any past `Session` row references this policy
  (receipt context is preserved). Disable instead.

Status pills in the table:

| Pill | Meaning |
|---|---|
| 🟡 DRAFT | saved but not enforced |
| 🟢 ENABLED | actively gating matching sessions |
| ⚪ DISABLED | paused; no enforcement |

---

## Operator decision guide

### When to use a Fleet Policy vs a Smart Charging Profile

| Scenario | Use |
|---|---|
| Restrict a specific **group of drivers** (by idTag) to charge only during off-peak hours | **Fleet Policy** |
| Cap the **entire site** (or charger group) to a kW ceiling regardless of who's plugged in | **Smart Charging Profile** (scope SITE/GROUP) |
| Override a single charger's limit temporarily | **Smart Charging Profile** (scope CHARGER) |
| Give depot-vehicles priority overnight but let anyone else charge any time | **Fleet Policy** (matches on idTag prefix only) |
| Stop _everyone_ on the site outside business hours | **Smart Charging Profile** with a 0 kW window |

Rule of thumb: if the gate depends on **who** (via `idTag` prefix), it's a
fleet policy. If it depends on **when** or **where** alone, it's a smart
charging profile. The two systems stack at different OCPP stack levels
(smart charging defaults to level ~60; fleet policies default to 90) and
the higher level wins while active.

### Why policies must be DISABLED before editing

Fleet policies are enforced with fresh reads on every scheduling event
(boot, session start/end, reconcile tick). An operator editing an ENABLED
policy mid-session could silently change the current cap or window
boundaries while a driver is charging — which would then only take effect
at the next tick, creating a confusing gap between "what the UI says" and
"what the charger is doing." Requiring an explicit **Disable → edit →
Enable** sequence makes the state transition visible and gives the
operator an obvious checkpoint to confirm the new configuration before
pushing it back to live enforcement.

### Why overlapping idTag prefixes are rejected

Runtime matching is `idTag.startsWith(prefix)`. If two ENABLED or DRAFT
policies at the same site have prefixes where one is a prefix of the
other (e.g. `FLEET-` and `FLEET-ACME-`), an incoming idTag like
`FLEET-ACME-001` would match both — there is no deterministic way to
pick a winner. Rather than silently first-wins (which is brittle and
depends on insert order), the API rejects the collision at write time
with `PREFIX_COLLISION`. DISABLED siblings are ignored because they
carry no runtime semantics.

If you need nested tenancy, pick non-overlapping roots (e.g. `ACME-`
and `FLEET-`) or use a single broader policy with a single `maxAmps`.

### Why multi-connector chargers currently warn+skip

The Phase 2 scheduler's enforcement unit is the **charger**, not the
connector — `SetChargingProfile` at `ChargePointMaxProfile` scope
applies to the whole charger. If two ACTIVE fleet sessions land on
different connectors of the same charger and resolve to different
intended modes (one ALLOW, one GATE), the scheduler cannot satisfy
both without per-connector profiles, which adds significant firmware
compatibility risk and a much bigger state machine.

Today the scheduler logs a warning and **skips enforcement for that
charger for that cycle** — neither session's policy is applied. The
next tick re-evaluates. This is an intentionally conservative default
to avoid flapping or enforcing the wrong gate; per-connector gating is
explicitly deferred (see "Deferred work" below).

Operational impact: in practice, today's deployments have one ACTIVE
fleet session per charger at a time. If your site regularly runs two
fleet drivers on the same charger simultaneously, open an issue before
enabling the flag.

---

## Preview endpoint

`POST /fleet-policies/:id/preview` with optional `{ at: ISO }` (defaults
to now) returns a non-mutating advisory:

```json
{
  "advisory": true,
  "policyId": "…",
  "policyStatus": "DRAFT",
  "at": "2026-04-24T17:00:00.000Z",
  "timeZone": "America/Los_Angeles",
  "active": true,
  "intendedMode": "ALLOW",
  "matchedWindow": { "day": 5, "start": "09:00", "end": "17:00" },
  "nextTransitionAt": "2026-04-25T00:00:00.000Z"
}
```

The portal exposes this as a "Preview now" button in the edit modal.
It never writes to the DB and never calls the scheduler — pure function
over `windowsJson` + the site's timezone.

---

## Rollout checklist — flipping the prod flag

1. **Land PR-A / PR-B / PR-C to `dev`.** (Current state.)
2. **Author policies in dev realm.** Smoke-test a full cycle: create DRAFT
   → enable → session starts in-window → session starts out-of-window →
   disable → confirm gate lifts.
3. **Run one week of dev-realm operation with
   `FLEET_GATED_SESSIONS_ENABLED=true`.** Watch logs for
   `[FleetScheduler]` warnings and any `enforcement error` lines.
4. **Author prod policies in DRAFT.** (Safe — nothing enforced yet.)
5. **Coordinate with affected fleet operators.** Warn them of the
   effective-start time.
6. **Flip the Railway env var** `FLEET_GATED_SESSIONS_ENABLED=true` on
   the OCPP server service. No code change required.
7. **Enable policies in prod.** The scheduler picks them up within one
   reconcile tick (≤5 minutes) and re-asserts on boot.
8. **Monitor for 24h.** `[FleetScheduler] enforcement error` lines carry
   full context: `sessionId`, `chargerId`, `fleetPolicyId`, `intendedMode`.

To roll back: flip the env var to `false` and restart the OCPP service.
Any in-flight 0 A gates will persist in charger RAM until the next
session end or reboot — the scheduler's teardown via same-id replacement
requires the flag to be on. Operators can force-clear by issuing a
manual `ClearChargingProfile` call for the fleet stack level, or by
restarting the affected chargers.

---

## Troubleshooting

### A fleet driver says they can't charge but the policy window is open

1. Check the policy row — `ENABLED`?
2. Does the driver's `idTag` actually start with the policy's
   `idTagPrefix`? (Case-sensitive.)
3. Open the edit modal, click **Preview now** with the current time → is
   `intendedMode: "ALLOW"`?
4. Check site timezone — policy windows are evaluated in the site's IANA
   tz, which is set via SiteDetail → Settings. A policy authored under
   the assumption of `America/Los_Angeles` on a site configured as
   `UTC` will evaluate in UTC.
5. OCPP server logs: grep `[FleetScheduler]` for the charger ID. Look
   for `enforcement error` lines — they include `intendedMode` and
   `reason`.

### The scheduler logged "multiple ACTIVE fleet sessions" and skipped

Expected behavior when two ACTIVE fleet sessions land on the same
charger. Either wait for one to end (normal) or manually stop one via
the operator portal. The next reconcile tick will enforce on the
remaining session.

### Enable button fails with validation errors

The modal auto-opens with field errors surfaced and a top-level banner
describing why. Fix the highlighted fields, save, and retry Enable from
the list view.

### Edit button is disabled

Policy is `ENABLED`. Click **Disable**, edit, then **Enable** again. The
tooltip on the disabled button ("Disable policy before editing.")
describes exactly this.

---

## Deferred work — NOT in Phase 2.5

- **Energy-triggered early release.** Today release is strictly
  time-based — a window closes when the clock hits the end time, not
  when the vehicle finishes charging.
- **Multi-connector gating.** See "warn+skip" section above.
- **RemoteStart retry fallback.** If the first auto-RemoteStart after
  Authorize drops (observed on LOOP firmware during Faulted state),
  there is no inline retry. Operator must re-plug or re-authorize.
- **Policy audit log.** Only `createdByOperatorId` and
  `updatedByOperatorId` stamps; no history of field changes.
- **Live gated-session observability in the portal.** Phase 2.6.
- **FleetPolicy clustering / multi-site policies.** Policies are
  strictly per-site.
- **Final `gatedPricingMode` vocabulary.** Today the
  `SessionBillingSnapshot.gatedPricingMode` column is written as the
  literal string `'gated'` when a session carried a fleet policy; the
  final multi-value vocabulary (e.g. `'gated-free' | 'gated-flat'`) is
  design-note Q2 and open.
