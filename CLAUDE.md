# CLAUDE.md — ev-charger

## What It Is
A full-stack EV charging platform using OCPP 1.6J (JSON over WebSocket).
- **Drivers**: Mobile app to find chargers, start/stop sessions, pay
- **Operators**: Web portal to register chargers, manage billing, view analytics
- **Chargers**: Communicate with the backend via OCPP 1.6 WebSocket protocol

## Monorepo Structure

```
ev-charger/
  packages/
    shared/        # Shared TypeScript types, OCPP message schemas, utils
    ocpp-server/   # Node.js OCPP 1.6 Central System (WebSocket server)
    api/           # REST API — used by mobile app and portal
    portal/        # React + Vite management dashboard (operators)
    mobile/        # React Native + Expo driver app
  docs/            # Architecture decisions, OCPP message flow diagrams
  tasks/
    todo.md        # Current sprint tasks
    lessons.md     # Mistake log
  docker-compose.yml
```

## Tech Stack

| Layer | Tech | Why |
|-------|------|-----|
| OCPP Server | Node.js + TypeScript + `ocpp-rpc` | Battle-tested OCPP-J implementation |
| REST API | Fastify + TypeScript | Fast, schema-first, great TS support |
| Database | PostgreSQL + Prisma | Relational data, excellent ORM |
| Auth | Clerk | Handles mobile + web auth, webhooks |
| Portal | React + Vite + TailwindCSS + shadcn/ui | Fast build, great component library |
| Mobile | React Native + Expo | Cross-platform, easy OTA updates |
| Maps | Mapbox | Free tier, React Native SDK |
| Payments | Stripe | Industry standard, supports auth-hold billing |
| Hosting | Railway (backend + DB) | Simple deploys, managed Postgres |
| Mobile deploys | Expo EAS | OTA updates, easy builds |

## OCPP 1.6 — Key Messages (MVP Scope)

**Charger → Server:**
- `BootNotification` — charger comes online, server accepts it
- `Heartbeat` — keep-alive every 5min, server returns current time
- `StatusNotification` — charger state changes (Available, Preparing, Charging, etc.)
- `Authorize` — validate an idTag (driver token)
- `StartTransaction` — charger confirms session started, gets a transactionId
- `StopTransaction` — charger reports session ended with meter values
- `MeterValues` — periodic energy readings during session

**Server → Charger:**
- `RemoteStartTransaction` — driver taps "Start" in app → server tells charger to start
- `RemoteStopTransaction` — driver taps "Stop" → server tells charger to stop
- `ChangeAvailability` — operator takes charger offline/online from portal
- `Reset` — soft or hard reboot a charger

## Data Models (Core)

```
Site → has many Chargers
Charger → has many Connectors (1-4 ports)
Connector → has many Sessions
Session → has one Payment
User (Driver) → has many Sessions
Operator → manages Sites
```

## API Endpoints (MVP)

**Public (driver app):**
- `GET /chargers` — list chargers with status + location (with bbox filter)
- `GET /chargers/:id` — charger detail
- `POST /sessions/start` — remote start a session
- `POST /sessions/:id/stop` — remote stop
- `GET /sessions` — driver's session history
- `POST /payments/setup-intent` — Stripe setup for saved card

**Operator (portal):**
- `POST /sites` — create a site
- `POST /chargers` — register a charger to a site
- `GET /sites/:id/analytics` — usage, revenue, uptime stats
- `GET /chargers/:id/status` — real-time charger state
- `POST /chargers/:id/reset` — reboot a charger

## Quick Start

```bash
# From project root
npm install          # Install all workspace deps
npm run dev          # Start all services (docker-compose + api + portal)
npm run dev:ocpp     # Start OCPP server only
npm run dev:portal   # Start portal only

# Database
npx prisma migrate dev     # Run migrations
npx prisma studio          # Visual DB browser

# Tests
npm test             # Run all tests across packages
```

## Environment Variables

```bash
# packages/ocpp-server/.env
OCPP_PORT=9000
DATABASE_URL=postgresql://...

# packages/api/.env
PORT=3001
DATABASE_URL=postgresql://...
CLERK_SECRET_KEY=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=

# packages/portal/.env
VITE_API_URL=http://localhost:3001
VITE_CLERK_PUBLISHABLE_KEY=
VITE_MAPBOX_TOKEN=

# packages/mobile/.env
EXPO_PUBLIC_API_URL=http://localhost:3001
EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY=
EXPO_PUBLIC_MAPBOX_TOKEN=
```

## Key Constraints

- OCPP server and API are separate processes — communicate via DB + events (not in-process calls)
- Never store raw card details — Stripe handles all PCI scope
- Charger state is source of truth from OCPP messages — don't infer state from API calls
- All OCPP message handling must be idempotent (chargers retry on no-ack)
- Session billing: authorize a hold at start, capture at stop based on kWh metered

## Testing

```bash
npm test                    # Unit tests
npm run test:ocpp-sim       # Runs a simulated charger against local OCPP server
npm run test:e2e            # End-to-end API tests
```

Always run `npm run test:ocpp-sim` after any OCPP server changes to validate message handling.
