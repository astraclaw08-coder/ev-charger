# CLAUDE.md — ev-charger

## What It Is
Full-stack EV charging platform — OCPP 1.6J, mobile app (Expo/React Native), management portal (React/Vite), REST API (Fastify).

## Monorepo Structure
```
ev-charger/
  packages/
    shared/        # Shared TS types, OCPP schemas, TOU/billing/smart-charging utils
    ocpp-server/   # OCPP 1.6 Central System (WebSocket server, port 9000)
    api/           # Fastify REST API (port 3001)
    portal/        # React + Vite operator dashboard
    mobile/        # React Native + Expo driver app
```

## Tech Stack
| Layer | Tech |
|-------|------|
| OCPP Server | Node.js + TypeScript + `ocpp-rpc` |
| REST API | Fastify + TypeScript |
| Database | PostgreSQL + Prisma |
| Auth | **Keycloak** (migrated from Clerk — no Clerk code remains) |
| Portal | React + Vite + TailwindCSS + shadcn/ui |
| Mobile | React Native + Expo |
| Maps | Google Maps (iOS/Android/Web) + Mapbox (fallback) |
| Payments | Stripe |
| Backend hosting | Railway (auto-deploy on push) |
| Portal hosting | Vercel (manual `vercel --prod` required) |
| Mobile builds | Expo EAS |

## Environments

### Dev
- API: `http://localhost:3001` | OCPP: `ws://localhost:9000/<ocppId>` | Portal: `http://localhost:5173`
- DB: Local Postgres (docker-compose) | Auth: Keycloak realm `ev-charger`
- Branch: `dev` | `prisma db push` OK here

### Prod
- API: `https://api-production-26cf.up.railway.app`
- OCPP: `wss://ocpp-server-fresh-production.up.railway.app/<ocppId>`
- Portal: `https://portal.lumeopower.com`
- DB: Railway managed Postgres | Auth: Keycloak realm `ev-charger-prod`
- Branch: `main` | **Must use `prisma migrate deploy` — never `db push`**

## Quick Start
```bash
npm install && npm run dev        # All services
npm run dev:ocpp                  # OCPP server only
npm run dev:portal                # Portal only
npx prisma migrate dev            # Run migrations
npx prisma studio                 # Visual DB browser
```

## Data Models (Core)
```
Site → has many Chargers → has many Connectors → has many Sessions
Session → has BillingSnapshot (TOU-aware receipt data)
SmartChargingGroup → has many Chargers + SmartChargingProfiles
User (Driver) → has many Sessions, Favorites
```

---

## ⚠️ Hard Rules — Lessons from Production Incidents

### OCPP Server
1. **Boot gate:** Never send server commands until BootNotification + ≥1 Heartbeat confirmed. Real firmware disconnects on early commands.
2. **Profiles are volatile:** `SetChargingProfile` lives in charger RAM. Always re-apply after boot (reset `smartChargingState.status` to `PENDING_OFFLINE` on BootNotification).
3. **Scope defaults = "do nothing":** If no profile resolves for a charger, skip Clear/Set entirely. Never apply fallback to all chargers.
4. **Orphan session cleanup:** When connector → Available/Preparing with an ACTIVE session → auto-close it. Charger disconnect doesn't guarantee StopTransaction.
5. **Two smart-charging paths:** `ocpp-server/smartCharging.ts` (boot) and `api/lib/smartCharging.ts` (HTTP). Fix both or you fix neither.
6. **Single process per port:** After restart, verify only one process on port 9000. Stale `dist/` processes serve old code.
7. **WSS URL = `wss://host/<ocppId>`:** Exactly one path segment. No double-identity.

### Smart Charging (Firmware)
8. **Never assume native stacking works.** LOOP EX-1762 (and likely other budget firmware) accepts multiple `ChargePointMaxProfile` at the same stackLevel but applies the HIGHER limit, not the lower. OCPP 1.6 spec says replace, firmware says keep both. The server must merge all active profiles into a **single Absolute profile** with `min(effectiveLimits)` and push that one profile. See `ocpp-server/smartCharging.ts` merged-profile model.
9. **Recurring Weekly profiles are unreliable.** LOOP EX-1762 accepts them (`Accepted`) but miscomputes schedule period offsets — `GetCompositeSchedule` returns wrong limits. Use Absolute profiles with heartbeat-driven re-push for window transitions instead.
10. **Profile-set changes must force re-push.** When a contributing profile is disabled/deleted, the stale clear removes the merged OCPP profile from the charger. The remaining profiles' individual fingerprints haven't changed, so equivalence checks can falsely skip the re-push. Always re-push when the active profile set changes (stale count > 0).
11. **`resolveCurrentLimitKw` uses UTC.** Schedule window matching in `ocpp-server/smartCharging.ts` checks `getUTCHours()`/`getUTCDay()`, not site timezone. Known issue — same class of bug as rule 13 below.

### Timezone / Billing
12. **TOU must use site timezone:** `resolveTouRateAt()` needs `timeZone` param. Without it, PDT sessions evaluate at wrong UTC offset.
13. **`isWindowActive()` in `shared/src/smartCharging.ts` uses UTC:** Needs timezone-aware fix (like `touPricing.ts` `localDayMinute` pattern).
14. **Midnight = `"00:00"` not `"23:59"`:** Legacy values cause 1-min billing gaps.

### Mobile / Expo
15. **Xcode ignores `.env`:** Build vars must be in `project.pbxproj` build settings. Empty Google Maps key → SIGABRT.
16. **Dev key ≠ Prod key:** RC builds must use prod Google Maps API key.
17. **React singleton:** Root `node_modules/react` must symlink → mobile's React. Duplicate = hook crashes.
18. **Safe area ≠ visual height:** Don't use `tabBarHeight` for control positioning — use measured visual constants.

### Database
19. **Never `db push` in prod.** Generate migration in dev → commit → `prisma migrate deploy` in prod.
20. **Schema drift check in CI.** Prevents deploying code referencing missing tables.

### Deploy
21. **Vercel does NOT auto-deploy.** After `main` merge: `cd packages/portal && vercel --prod --yes`.
22. **Check endpoints post-deploy:** API `/health`, OCPP `/health`, OCPP `/status`.
23. **OCPP prod deploys must use the wrapper:** run `npm run deploy:ocpp`, not raw `railway up --service ocpp-server-fresh`.
    - Wrapper inserts a `SCHEDULED_MAINTENANCE` `UptimeEvent` for every currently-ONLINE charger, so the WebSocket disconnect window is excluded from uptime calculations as scheduled maintenance under current platform policy.
    - **Scope of use:** short planned OCPP server restarts only. Do not use for rollbacks of unknown scope or any operation where reconnect within minutes is not expected.
    - **Prod DB prerequisite:** requires `DATABASE_URL` pointing at prod Railway Postgres. The script fail-fasts (exit 1) if the var is missing or the connection fails — `&&` chain prevents `railway up` from starting. Shell deploys often don't have prod creds loaded; configure via `~/.env` or a sourced `.envrc` first.
    - **Post-deploy verification:** verify each marked charger reconnects within ~5 minutes (check `/status` or query `UptimeEvent` for the closing `ONLINE` row from BootNotification). If any charger has not reconnected, investigate immediately because the still-open maintenance segment may over-exclude downtime beyond the intended deploy window.
    - Idempotency: re-runs on a charger already in `SCHEDULED_MAINTENANCE` are skipped deterministically — no time-threshold.
24. **Prod portal changes require PR.** No direct deploys from dev branch.

### Auth (Keycloak)
24. **Dev realm `ev-charger` / Prod realm `ev-charger-prod`.** Same env var names, different values.
25. **`assertKeycloakConfig()` validates on startup.** No legacy Clerk aliases.

### Fleet Policies (TASK-0208)
24. **Fleet policies must be DISABLED before editing.** API returns 409 `POLICY_ENABLED_IMMUTABLE`. See `docs/fleet-policies.md`.
25. **Per-site idTag-prefix collisions are rejected.** Substring overlap between ENABLED/DRAFT siblings (e.g. `FLEET-` vs `FLEET-ACME-`) is ambiguous at runtime and fails validation with `PREFIX_COLLISION`. DISABLED rows are ignored.
26. **Prod flag `FLEET_GATED_SESSIONS_ENABLED` stays OFF until explicit flip.** CRUD API + UI ship independent of the flag.

### General
26. **Verify full chain with curl before telling user to retry.**
27. **QC gate mandatory:** build check, runtime UI verify, API/data verify, acceptance criteria, regression spot-check.
