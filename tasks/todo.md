# EV Charger MVP — Build Tasks

## Phase 1: Foundation ← START HERE
> Goal: Monorepo, database schema, shared types, local dev environment running

- [x] Initialize npm workspaces monorepo with TypeScript root config
- [x] Create `packages/shared` — export OCPP 1.6 message types and Zod schemas for all MVP messages
- [x] Set up `docker-compose.yml` with PostgreSQL + pgAdmin
- [x] Create Prisma schema: Site, Charger, Connector, Session, User, Payment, OcppLog tables
- [x] Run initial migration, verify tables in pgAdmin
- [x] Write seed script with 2 test sites, 4 chargers, 1 test driver user

**Done when:** `docker-compose up` starts Postgres, `npx prisma studio` shows all tables with seed data.

---

## Phase 2: OCPP Server
> Goal: A working Central System that chargers can connect to and exchange real OCPP 1.6 messages

- [x] Set up `packages/ocpp-server` with `ocpp-rpc` library
- [x] Handle `BootNotification` — accept charger, update DB status to `Accepted`
- [x] Handle `Heartbeat` — respond with `currentTime`, update `lastHeartbeat` in DB
- [x] Handle `StatusNotification` — update Connector status in DB (Available/Preparing/Charging/Faulted/Unavailable)
- [x] Handle `Authorize` — look up idTag in DB, return `Accepted` or `Invalid`
- [x] Handle `StartTransaction` — create Session record, return `transactionId`
- [x] Handle `StopTransaction` — close Session with kWh and duration, trigger billing hook
- [x] Handle `MeterValues` — store periodic readings on Session
- [x] Implement `RemoteStartTransaction` — expose internal fn for API to call
- [x] Implement `RemoteStopTransaction` — expose internal fn for API to call
- [x] Write OCPP simulator (`npm run test:ocpp-sim`) that connects, boots, and runs a full start→meter→stop cycle

**Done when:** Simulator completes a full charging session end-to-end with all DB records created correctly.

---

## Phase 3: REST API
> Goal: Fastify API serving both portal and mobile app

- [x] Set up `packages/api` with Fastify + Clerk auth middleware
- [x] `GET /chargers` with bbox query param — return chargers with real-time connector status
- [x] `GET /chargers/:id` — full detail including connector states
- [x] `POST /sessions/start` — validate driver auth, call OCPP RemoteStart, return sessionId
- [x] `POST /sessions/:id/stop` — call OCPP RemoteStop
- [x] `GET /sessions` — driver's session history (auth required)
- [x] `GET /sessions/:id` — live session detail with current kWh + cost estimate
- [x] `POST /sites` — operator creates a site (operator auth required)
- [x] `POST /chargers` — register charger to site, return OCPP endpoint URL + charger password
- [x] `GET /sites/:id/analytics` — sessions count, kWh delivered, revenue, uptime % (last 30 days)
- [x] `POST /chargers/:id/reset` — operator sends Reset command via OCPP
- [x] Stripe: `POST /payments/setup-intent` — create SetupIntent for saving a card
- [x] Stripe webhook: capture payment after session stops (kWh × rate)

**Done when:** All endpoints tested with Bruno/Postman collection, Stripe test payment captured after a simulated session.

---

## Phase 4: Management Portal
> Goal: Operators can register chargers, see live status, and view analytics

- [x] Set up `packages/portal` with React + Vite + TailwindCSS + shadcn/ui
- [x] Clerk auth (operator login)
- [x] Dashboard: list of sites with charger count and status summary
- [x] Site detail: map of charger locations + live connector status grid
- [x] Add charger flow: form → API call → display OCPP endpoint URL + password to configure on charger
- [x] Analytics page: sessions chart (daily), kWh chart, revenue chart (Recharts)
- [x] Charger detail: connector states, last heartbeat, session log, Reset button

**Done when:** An operator can log in, add a charger, see it come online in the status grid, and view a session in analytics.

---

## Phase 5: Mobile App
> Goal: Drivers can find chargers, start/stop a session, and pay

- [x] Set up `packages/mobile` with Expo + React Native + Expo Router
- [x] Clerk auth (driver sign up/login)
- [x] Map screen: Mapbox with charger pins, color-coded by status (green=available, red=in use, grey=offline)
- [x] Charger detail sheet: connector list with status, price per kWh, Start button
- [x] Payment setup: Stripe card entry (saved card for future sessions)
- [x] Start session flow: tap Start → loading → "Session started" with live kWh counter
- [x] Stop session: tap Stop → session summary (kWh, duration, cost) → charge card
- [x] Session history screen

**Done when:** Full session flow works on iOS simulator — map → find charger → start → stop → payment charged.

---

## Phase 6: Deploy MVP
- [ ] Deploy Postgres to Railway
- [ ] Deploy OCPP server to Railway (port 9000, public WebSocket endpoint)
- [ ] Deploy API to Railway
- [ ] Deploy portal to Vercel
- [ ] Build Expo app and submit to TestFlight
- [ ] Connect a real OCPP 1.6 charger (or use a hardware simulator) to production OCPP endpoint
- [ ] End-to-end test on real hardware

---

## Backlog (Post-MVP)
- OCPP 2.0.1 upgrade path
- Multi-tenant operator accounts
- Load balancing / smart charging (OCPP SetChargingProfile)
- RFID card support
- Fleet/corporate accounts
- Revenue sharing between site hosts and operators
