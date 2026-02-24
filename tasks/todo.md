# EV Charger MVP — Build Tasks

## Phase 1: Foundation ← START HERE
> Goal: Monorepo, database schema, shared types, local dev environment running

- [ ] Initialize npm workspaces monorepo with TypeScript root config
- [ ] Create `packages/shared` — export OCPP 1.6 message types and Zod schemas for all MVP messages
- [ ] Set up `docker-compose.yml` with PostgreSQL + pgAdmin
- [ ] Create Prisma schema: Site, Charger, Connector, Session, User, Payment, OcppLog tables
- [ ] Run initial migration, verify tables in pgAdmin
- [ ] Write seed script with 2 test sites, 4 chargers, 1 test driver user

**Done when:** `docker-compose up` starts Postgres, `npx prisma studio` shows all tables with seed data.

---

## Phase 2: OCPP Server
> Goal: A working Central System that chargers can connect to and exchange real OCPP 1.6 messages

- [ ] Set up `packages/ocpp-server` with `ocpp-rpc` library
- [ ] Handle `BootNotification` — accept charger, update DB status to `Accepted`
- [ ] Handle `Heartbeat` — respond with `currentTime`, update `lastHeartbeat` in DB
- [ ] Handle `StatusNotification` — update Connector status in DB (Available/Preparing/Charging/Faulted/Unavailable)
- [ ] Handle `Authorize` — look up idTag in DB, return `Accepted` or `Invalid`
- [ ] Handle `StartTransaction` — create Session record, return `transactionId`
- [ ] Handle `StopTransaction` — close Session with kWh and duration, trigger billing hook
- [ ] Handle `MeterValues` — store periodic readings on Session
- [ ] Implement `RemoteStartTransaction` — expose internal fn for API to call
- [ ] Implement `RemoteStopTransaction` — expose internal fn for API to call
- [ ] Write OCPP simulator (`npm run test:ocpp-sim`) that connects, boots, and runs a full start→meter→stop cycle

**Done when:** Simulator completes a full charging session end-to-end with all DB records created correctly.

---

## Phase 3: REST API
> Goal: Fastify API serving both portal and mobile app

- [ ] Set up `packages/api` with Fastify + Clerk auth middleware
- [ ] `GET /chargers` with bbox query param — return chargers with real-time connector status
- [ ] `GET /chargers/:id` — full detail including connector states
- [ ] `POST /sessions/start` — validate driver auth, call OCPP RemoteStart, return sessionId
- [ ] `POST /sessions/:id/stop` — call OCPP RemoteStop
- [ ] `GET /sessions` — driver's session history (auth required)
- [ ] `GET /sessions/:id` — live session detail with current kWh + cost estimate
- [ ] `POST /sites` — operator creates a site (operator auth required)
- [ ] `POST /chargers` — register charger to site, return OCPP endpoint URL + charger password
- [ ] `GET /sites/:id/analytics` — sessions count, kWh delivered, revenue, uptime % (last 30 days)
- [ ] `POST /chargers/:id/reset` — operator sends Reset command via OCPP
- [ ] Stripe: `POST /payments/setup-intent` — create SetupIntent for saving a card
- [ ] Stripe webhook: capture payment after session stops (kWh × rate)

**Done when:** All endpoints tested with Bruno/Postman collection, Stripe test payment captured after a simulated session.

---

## Phase 4: Management Portal
> Goal: Operators can register chargers, see live status, and view analytics

- [ ] Set up `packages/portal` with React + Vite + TailwindCSS + shadcn/ui
- [ ] Clerk auth (operator login)
- [ ] Dashboard: list of sites with charger count and status summary
- [ ] Site detail: map of charger locations + live connector status grid
- [ ] Add charger flow: form → API call → display OCPP endpoint URL + password to configure on charger
- [ ] Analytics page: sessions chart (daily), kWh chart, revenue chart (Recharts)
- [ ] Charger detail: connector states, last heartbeat, session log, Reset button

**Done when:** An operator can log in, add a charger, see it come online in the status grid, and view a session in analytics.

---

## Phase 5: Mobile App
> Goal: Drivers can find chargers, start/stop a session, and pay

- [ ] Set up `packages/mobile` with Expo + React Native + Expo Router
- [ ] Clerk auth (driver sign up/login)
- [ ] Map screen: Mapbox with charger pins, color-coded by status (green=available, red=in use, grey=offline)
- [ ] Charger detail sheet: connector list with status, price per kWh, Start button
- [ ] Payment setup: Stripe card entry (saved card for future sessions)
- [ ] Start session flow: tap Start → loading → "Session started" with live kWh counter
- [ ] Stop session: tap Stop → session summary (kWh, duration, cost) → charge card
- [ ] Session history screen

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
