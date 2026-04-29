# TASK-0208 Phase 3 — Gate 1 dark-deploy completion record

**Date:** 2026-04-29
**Operator:** astraclaw08-coder
**Outcome:** Gate 1 ✅ complete. Phase 3 schema + code live in prod, runtime gate OFF, zero behavior change.

This document records the prod release of TASK-0208 Phase 3 (Slices A–E), the verification that the dark-deploy guarantees hold, and the prepared runbooks for Gates 2–3. **Gates 2–4 are NOT yet executed** as of this writing.

---

## 1. Release artifact

| Item | Value |
|---|---|
| Release PR | [#77](https://github.com/astraclaw08-coder/ev-charger/pull/77) |
| Merge commit | `0ab3eb50e66f950477de620a1755b06e1fdd3ee3` (`0ab3eb5`) |
| Base branch | `main` |
| Source branch | `dev` (HEAD `563b4e9`) |
| Slices folded in | A (#72), B (#73), C (#74), D (#75), E evidence (#76); design doc (#71) |

## 2. Deploy steps executed

| Step | Result |
|---|---|
| `prisma migrate deploy --schema=packages/shared/prisma/schema.prisma` against prod | Applied `20260428180000_task_0208_phase3_slice_a` (1 migration). Re-run shows "Database schema is up to date!" |
| `railway up --service api --detach` from `packages/api/` on `main` HEAD | Deploy `013ca864` SUCCESS |
| `railway up --service ocpp-server-fresh --detach` from `packages/ocpp-server/` on `main` HEAD | Deploy `aeb11b4c` SUCCESS |
| `vercel --prod --yes` from `packages/portal/` | Aliased to `https://portal.lumeopower.com` |

Order followed migration-first per CLAUDE.md hard rule #15.

## 3. Dark-deploy verification (all asserts ✅)

Captured at `2026-04-29T02:15Z`, after all four deploy steps completed:

| Assertion | Expected | Observed |
|---|---|---|
| API `/health` | 200 + `db:ok` | ✅ `{"status":"ok","service":"ev-charger-api","db":"ok"}` |
| OCPP `/health` | 200 | ✅ `{"status":"ok"}` |
| Portal `/` | HTTP 200 | ✅ `200 ct=text/html; charset=utf-8` |
| 1A32 `connected[]` | yes | ✅ |
| 1A32 row status | `ONLINE` | ✅ |
| 1A32 heartbeat freshness | within ~15-min cadence | ✅ 2m37s ago (fresh natural heartbeat post-OCPP-redeploy reconnect) |
| `FLEET_GATED_SESSIONS_ENABLED` on api | unset | ✅ no `FLEET_*` vars |
| `FLEET_GATED_SESSIONS_ENABLED` on ocpp-server-fresh | unset | ✅ no `FLEET_*` vars |
| `FleetPolicy WHERE status='ENABLED'` | 0 | ✅ 0 |
| `Connector WHERE chargingMode='FLEET_AUTO'` | 0 | ✅ 0 |
| `Connector WHERE fleetPolicyId IS NOT NULL` | 0 | ✅ 0 |
| `Site WHERE fleetAutoRolloutEnabled=true` | 0 | ✅ 0 |

The two-tier rollout gate fails closed at every entry point. Phase 3 runtime code is loaded but no plug-in transition can produce a fleet auto-start.

## 4. 1A32 responsiveness

Natural heartbeat verified 2m37s post-deploy. **TriggerMessage(Heartbeat) from the operator portal was NOT executed in this gate** because the operator-token-required call would require the portal UI; the natural heartbeat was sufficient evidence. Operator can re-verify on demand from the portal's charger detail page if desired before Gate 3.

## 5. Known carry-over (not introduced by this release)

- 4 ghost rows in `_prisma_migrations` (`stripe_payment_phase0` ×3 + `add_site_preauth_amount`) from orphaned TASK-0096 branches predate this release. Slice G handles cleanup, NOT Gate 1.
- Stale `Postgres-Ow_f` and `ev-charger` services in the Railway prod project — separate cleanup task, also predates Phase 3.

## 6. What this gate did NOT do

- ❌ Flip `FLEET_GATED_SESSIONS_ENABLED` (still unset on both services)
- ❌ Author or enable any FleetPolicy
- ❌ Change any `Connector.chargingMode` / `fleetPolicyId` / rollout flag
- ❌ Touch 1A32 config beyond observing its status
- ❌ Trigger any RemoteStartTransaction
- ❌ Run any maintenance marker (none was needed — OCPP redeploy disconnect was a normal release-window blip, not a planned fleet operation)

---

# Gate 2 checklist — author + enable pilot FleetPolicy via portal

> **Status:** PREPARED, NOT EXECUTED. Awaiting explicit operator approval.

## Pre-flight (run first, must all pass)

```bash
# Confirm prod state still clean before we configure anything.
DBL='postgresql://postgres:XLHiieljDtaTNriVcPBiiXDDNSvEHruQ@ballast.proxy.rlwy.net:12701/railway'

# 1. No ENABLED FleetPolicy globally.
psql "$DBL" -A -t -c 'select count(*) from "FleetPolicy" where status='"'"'ENABLED'"'"';'
# expect: 0

# 2. No connector currently in FLEET_AUTO mode.
psql "$DBL" -A -t -c 'select count(*) from "Connector" where "chargingMode"='"'"'FLEET_AUTO'"'"';'
# expect: 0

# 3. 1A32 connector exists and is currently PUBLIC.
psql "$DBL" -A -F'|' -c 'select co.id, co."chargerId", co."connectorId", co."chargingMode", co."fleetPolicyId" from "Connector" co join "Charger" ch on ch.id=co."chargerId" where ch."ocppId"='"'"'1A32-1-2010-00008'"'"';'
# expect: 1 row, chargingMode=PUBLIC, fleetPolicyId=NULL

# 4. 1A32 has no active session.
psql "$DBL" -A -F'|' -c 'select s.id, s.status from "Session" s join "Connector" co on co.id=s."connectorId" join "Charger" ch on ch.id=co."chargerId" where ch."ocppId"='"'"'1A32-1-2010-00008'"'"' and s.status='"'"'ACTIVE'"'"';'
# expect: 0 rows
```

## Operator portal steps

The operator (Son) performs these. Claude does not have an operator session to drive the portal directly.

1. Open `https://portal.lumeopower.com`
2. Sign in as operator
3. Navigate: Sites → **Location Alpha** → Fleet Policies tab
4. Click **+ New Policy**
5. Fill the form:

   | Field | Value |
   |---|---|
   | Name | `Phase 3 Pilot — 1A32` |
   | idTag Prefix | `PILOT-1A32-` |
   | Max Amps | `16` |
   | OCPP Stack Level | `51` (form floor; runtime hardcodes 90/1, this field is unused for Phase 3) |
   | autoStartIdTag | `PILOT-1A32-001` |
   | Always on (24/7) | ✅ check |
   | Windows | leave empty (alwaysOn bypasses windows) |
   | Notes | `Phase 3 prod pilot, 1A32 only. Created at <UTC timestamp>.` |

6. Click **Save** — policy lands in DRAFT
7. From the policy list, click **Enable** on `Phase 3 Pilot — 1A32`

**Stop.** Notify Claude that the policy is ENABLED. Claude will re-verify before Gate 2 step 8.

8. Operator: navigate Sites → Location Alpha → 1A32 charger detail
9. In the **Fleet-Auto config** panel, find Connector 1
10. Set:
    - Charging mode: **Fleet auto-start**
    - Fleet policy: **Phase 3 Pilot — 1A32**
    - Rollout override: **Inherit site** (we leave this for now; Gate 3 will enable per-connector override after env flag flip)
11. Click **Save**

## DB verification (Claude runs after each operator step)

```bash
DBL='postgresql://postgres:XLHiieljDtaTNriVcPBiiXDDNSvEHruQ@ballast.proxy.rlwy.net:12701/railway'

# After step 6 (DRAFT saved):
psql "$DBL" -A -F'|' -c 'select id, status, "alwaysOn", "autoStartIdTag", "siteId" from "FleetPolicy" where name='"'"'Phase 3 Pilot — 1A32'"'"';'
# expect: 1 row, status=DRAFT, alwaysOn=t, autoStartIdTag=PILOT-1A32-001

# After step 7 (Enable):
psql "$DBL" -A -t -c 'select count(*) from "FleetPolicy" where status='"'"'ENABLED'"'"';'
# expect: 1
psql "$DBL" -A -F'|' -c 'select id, status from "FleetPolicy" where name='"'"'Phase 3 Pilot — 1A32'"'"';'
# expect: status=ENABLED

# After step 11 (connector configured):
psql "$DBL" -A -F'|' -c 'select co."chargingMode", co."fleetPolicyId", co."fleetAutoRolloutEnabled", fp.name as policy_name, fp.status as policy_status from "Connector" co left join "FleetPolicy" fp on fp.id=co."fleetPolicyId" join "Charger" ch on ch.id=co."chargerId" where ch."ocppId"='"'"'1A32-1-2010-00008'"'"';'
# expect: chargingMode=FLEET_AUTO, fleetPolicyId=<policy id>, fleetAutoRolloutEnabled=NULL (inherit), policy_name=Phase 3 Pilot — 1A32, policy_status=ENABLED
```

## Gate 2 success criteria

- 1 ENABLED FleetPolicy at Location Alpha with the proposed name + autoStartIdTag
- 1A32 connector 1 has `chargingMode=FLEET_AUTO`, `fleetPolicyId` set, `fleetAutoRolloutEnabled=NULL`
- All other connectors at Location Alpha (and globally) remain PUBLIC
- Site `fleetAutoRolloutEnabled` still `false`
- Env flag still unset → **runtime behavior STILL unchanged** (the two-tier gate is still closed at the env tier)

## Gate 2 rollback (if anything looks wrong)

```bash
# Disable policy via portal: navigate to policy → Disable.
# Or via SQL:
psql "$DBL" -c 'update "FleetPolicy" set status='"'"'DISABLED'"'"' where name='"'"'Phase 3 Pilot — 1A32'"'"';'

# Revert connector to PUBLIC and clear policy assignment:
psql "$DBL" -c 'update "Connector" set "chargingMode"='"'"'PUBLIC'"'"', "fleetPolicyId"=NULL where id='"'"'2f853894-c27d-4c25-a3ea-6b759b747585'"'"';'
```

---

# Gate 3 runbook — flip env kill switch ON for the pilot window

> **Status:** RUNBOOK ONLY, NOT EXECUTED. Awaiting explicit approval after Gate 2 lands and operator is on-site for Gate 4.

## Order of operations

1. **Maintenance marker** (per operator decision: yes — keeps SLA accounting clean during the OCPP redeploy WS-disconnect window):

   ```bash
   cd /Users/son/projects/ev-charger
   npm run deploy:mark-maintenance -- --reason "TASK-0208 Phase 3 pilot — env flag ON for 1A32 test"
   ```

   This writes a `SCHEDULED_MAINTENANCE` `UptimeEvent` for every currently-ONLINE charger. Idempotent. Verifies prod DATABASE_URL before any write.

2. **Set env flag on api**

   ```bash
   railway variable set "FLEET_GATED_SESSIONS_ENABLED=true" --service api
   ```

   Note: on this Railway project, `variable set` triggers a full rebuild (~5 min). Tracked separately as a future improvement (DB-backed feature flag, per redesign §0 #5 — out of scope for Phase 3).

3. **Set env flag on ocpp-server-fresh**

   ```bash
   railway variable set "FLEET_GATED_SESSIONS_ENABLED=true" --service ocpp-server-fresh
   ```

   Triggers OCPP rebuild. Connected chargers (including 1A32) experience a ~30–60s WS disconnect during the swap.

4. **Wait for both deploys SUCCESS**

   Poll Railway GraphQL until both services report `status=SUCCESS` on the new deploy.

5. **Health verification**

   ```bash
   curl -fsS https://api-production-26cf.up.railway.app/health
   curl -fsS https://ocpp-server-fresh-production.up.railway.app/health
   curl -fsS https://ocpp-server-fresh-production.up.railway.app/status \
     | jq '.recentChargers[] | select(.ocppId=="1A32-1-2010-00008")'
   ```

   Expect: both services 200, 1A32 in `connected[]` with a heartbeat within the next 15 min. If 1A32 doesn't reconnect within 5 min, **STOP** — abort Gate 3 and run Gate 5 rollback.

6. **Operator: portal → 1A32 → Connector 1 → Rollout override = Enabled**

   Confirmation modal will appear (Slice B harden requires explicit confirm on `false→true` rollout transitions).

7. **Verify rollout flag flip in DB**

   ```bash
   DBL='postgresql://postgres:XLHiieljDtaTNriVcPBiiXDDNSvEHruQ@ballast.proxy.rlwy.net:12701/railway'
   psql "$DBL" -A -F'|' -c 'select co."fleetAutoRolloutEnabled" from "Connector" co join "Charger" ch on ch.id=co."chargerId" where ch."ocppId"='"'"'1A32-1-2010-00008'"'"';'
   # expect: t

   # Audit log entry written:
   psql "$DBL" -A -F'|' -c 'select action, "createdAt", metadata->>'"'"'newValue'"'"' as new_value from "AdminAuditEvent" where action='"'"'fleet.rollout.connector.update'"'"' order by "createdAt" desc limit 1;'
   # expect: 1 row, action=fleet.rollout.connector.update, new_value=true
   ```

   At this point, 1A32 connector 1 is **live for Fleet-Auto auto-start** as soon as a vehicle plug-in transition arrives. Site flag still false; other chargers globally remain unaffected.

## Gate 3 rollback (if anything looks wrong)

In order of severity / cost:

1. **Cheapest** — flip rollout override back: portal → connector → Rollout override = Disabled. DB-only flip, no restart, takes effect within 30s cache TTL. Effective immediately. **This is the canonical day-to-day rollback.**
2. **Mid** — disable policy: portal → policy → Disable. Same DB-only effect.
3. **Heaviest** — flip env flag back to unset:
   ```bash
   railway variable delete FLEET_GATED_SESSIONS_ENABLED --service api
   railway variable delete FLEET_GATED_SESSIONS_ENABLED --service ocpp-server-fresh
   railway redeploy --service api -y
   railway redeploy --service ocpp-server-fresh -y
   ```
   Restart-cost rollback. Reserve for incident response only.

## Gate 4 prerequisites (must all hold before vehicle plug-in)

- Operator on-site at 1A32
- Vehicle ready to plug in
- Cable / connector physically clean and unobstructed
- Both services healthy on the new deploy
- 1A32 in `connected[]`, heartbeat fresh
- DB rollout override = `true` for connector 1
- Visual / audible monitoring set up so operator can confirm vehicle behavior

---

## Cross-references

- Design source: `tasks/task-0208-phase3-fleet-auto-redesign.md` (PR #71)
- Slice E rehearsal evidence: `tasks/task-0208-phase3-slice-e-evidence.md` (PR #76)
- Slice plan: A #72, B #73, C #74, D #75, E #76, dark-deploy release #77
