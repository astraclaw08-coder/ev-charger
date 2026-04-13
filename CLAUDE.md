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

### Timezone / Billing
8. **TOU must use site timezone:** `resolveTouRateAt()` needs `timeZone` param. Without it, PDT sessions evaluate at wrong UTC offset.
9. **`isWindowActive()` in `shared/src/smartCharging.ts` uses UTC:** Needs timezone-aware fix (like `touPricing.ts` `localDayMinute` pattern).
10. **Midnight = `"00:00"` not `"23:59"`:** Legacy values cause 1-min billing gaps.

### Mobile / Expo
11. **Xcode ignores `.env`:** Build vars must be in `project.pbxproj` build settings. Empty Google Maps key → SIGABRT.
12. **Dev key ≠ Prod key:** RC builds must use prod Google Maps API key.
13. **React singleton:** Root `node_modules/react` must symlink → mobile's React. Duplicate = hook crashes.
14. **Safe area ≠ visual height:** Don't use `tabBarHeight` for control positioning — use measured visual constants.

### Database
15. **Never `db push` in prod.** Generate migration in dev → commit → `prisma migrate deploy` in prod.
16. **Schema drift check in CI.** Prevents deploying code referencing missing tables.

### Deploy
17. **Vercel does NOT auto-deploy.** After `main` merge: `cd packages/portal && vercel --prod --yes`.
18. **Check endpoints post-deploy:** API `/health`, OCPP `/health`, OCPP `/status`.
19. **Prod portal changes require PR.** No direct deploys from dev branch.

### Auth (Keycloak)
20. **Dev realm `ev-charger` / Prod realm `ev-charger-prod`.** Same env var names, different values.
21. **`assertKeycloakConfig()` validates on startup.** No legacy Clerk aliases.

### Payments (Stripe)
22. **Stripe `paymentIntents.create` with `confirm: true` requires `payment_method_types: ['card']`.** Without it, Stripe defaults to dashboard-enabled methods which may include redirect-based types, causing `return_url` errors. Discovered during sandbox QC — production code must always include this.
23. **Charging = preauth + capture.** Two distinct Stripe operations. Preauth before session start, capture after StopTransaction. Never a single charge.
24. **Reservation = final sale.** Different `PaymentPurpose` — uses immediate capture, NOT preauth flow.
25. **Guest skips preauth.** No `stripeCustomerId` → no payment gate. Session creation has no payment dependency.
26. **Overflow → partial capture + deficit.** If billing exceeds authorized hold: capture up to authorized amount, persist `deficitCents` as `PARTIAL_CAPTURED`. No automatic second charge in v1.
27. **Session completion never depends on payment.** Physical charging happened. StopTransaction always succeeds; capture failure is non-fatal and retryable.
28. **CAS race protection on capture.** `FOR UPDATE SKIP LOCKED` prevents duplicate charges when StopTransaction and orphan cleanup converge.

### General
29. **Verify full chain with curl before telling user to retry.**
30. **QC gate mandatory:** build check, runtime UI verify, API/data verify, acceptance criteria, regression spot-check.
