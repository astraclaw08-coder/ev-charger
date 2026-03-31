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
- [ ] Stripe webhook: capture payment after session stops (kWh × rate)
  <!-- ⚠️ INCOMPLETE: triggerBillingHook() in packages/ocpp-server/src/handlers/stopTransaction.ts is a stub — only logs the amount, never creates a Stripe PaymentIntent. Webhook endpoint exists at POST /payments/webhook but never fires. Need to implement: look up session.payment.stripeCustomerId, create a PaymentIntent for (kwhDelivered × ratePerKwh) cents, then the webhook handles capture/failure. -->

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

## Phase 6: Deploy MVP ✅
> Deployed 2026-02-24

- [x] Deploy Postgres to Railway
- [x] Deploy OCPP server to Railway — `wss://ocpp-server-production.up.railway.app`
- [x] Deploy API to Railway — `https://api-production-26cf.up.railway.app`
- [x] Deploy portal to Vercel — `https://portal-self-delta.vercel.app`
- [ ] Build Expo app and submit to TestFlight — EAS project linked (`39b3fbf7`); run `eas build --platform ios --profile production` interactively to provision Apple signing
- [x] Connect OCPP simulator to production endpoint and run full cycle
- [x] End-to-end test passed — session COMPLETED, 1.5 kWh, transactionId verified via API

**Done when:** All backend services healthy, portal live, production E2E sim passing.

---

---

## Task 155: AI Diagnostics Agent — Proactive & Corrective Charger Maintenance
> Goal: LLM-powered diagnostics for charger network health — per-user isolated sessions, OAuth-secured, built on existing stack

### Architecture Decisions
- **Single agent, not multi-agent** — one well-prompted agent with tool access (DB queries, RAG, OCPP commands via existing API)
- **Per-user sessions** — each portal user gets isolated conversation context; no cross-user data leakage
- **OAuth via Keycloak** — LLM hook endpoints use existing Keycloak OIDC; no separate auth system
- **Existing infra only** — Postgres (pgvector extension), Fastify API, Railway; no new databases
- **Batch + trigger, not streaming** — nightly health reports + on-demand diagnostics + error-triggered analysis; avoids runaway LLM costs
- **PII redaction** — all charger logs/session data anonymized before LLM context (strip user IDs, payment info, VINs; use pseudonymized tokens)

### Subtask 155.1: Database — Knowledge & Conversation Schema
- [ ] Enable `pgvector` extension on Postgres
- [ ] Add Prisma model `DiagKnowledgeDoc` — id, title, source (manual/ocpp-spec/past-fix), content, embedding (vector 1536), createdAt
- [ ] Add Prisma model `DiagConversation` — id, userId (FK→User), title, createdAt, updatedAt
- [ ] Add Prisma model `DiagMessage` — id, conversationId (FK→DiagConversation), role (user/assistant/system), content, toolCalls (JSON), createdAt
- [ ] Add Prisma model `ChargerEvent` — id, chargerId (FK→Charger), eventType (error/anomaly/warning), ocppAction, errorCode, severity, payload (JSON), detectedAt
- [ ] Migration + seed: ingest OCPP 1.6 spec docs + common error code reference as initial knowledge base
- [ ] Add index on ChargerEvent(chargerId, detectedAt) and DiagKnowledgeDoc embedding (ivfflat)

**Done when:** `prisma migrate` succeeds, pgvector queries return nearest-neighbor results on seeded docs.

### Subtask 155.2: Event Ingestion Pipeline
- [ ] Hook into existing OCPP handlers (StatusNotification, MeterValues, StopTransaction) to emit ChargerEvents on: error codes, fault status, anomalous meter readings (configurable thresholds), session failures
- [ ] Threshold rules (no ML yet): voltage out of range, temperature spikes, repeated connector faults within window, session failure rate > X% per charger/day
- [ ] Backfill script: scan existing OcppLog for historical error patterns → populate ChargerEvent

**Done when:** Live OCPP traffic generates ChargerEvent rows; backfill populates historical events.

### Subtask 155.3: RAG Retrieval Service
- [ ] Embedding service: function to embed text chunks via Claude/OpenAI embeddings API (configurable provider)
- [ ] Ingestion CLI: `npm run ingest-docs` — reads markdown/PDF files from `docs/knowledge-base/`, chunks, embeds, upserts into DiagKnowledgeDoc
- [ ] Retrieval function: `retrieveRelevantDocs(query: string, topK: number)` — pgvector cosine similarity search
- [ ] Include recent ChargerEvents for the target charger as structured context (not embedded, just fetched)

**Done when:** Given a query like "connector fault code 3", returns relevant OCPP spec sections + past similar incidents.

### Subtask 155.4: LLM Diagnostics API (OAuth-Secured, Per-User Sessions)
- [ ] `POST /api/diagnostics/conversations` — create new conversation (auth: Keycloak Bearer token, scoped to authenticated user)
- [ ] `POST /api/diagnostics/conversations/:id/messages` — send message, get AI response (auth required, verify conversation belongs to user)
- [ ] `GET /api/diagnostics/conversations` — list user's conversations (auth required, returns only own)
- [ ] `GET /api/diagnostics/conversations/:id` — get conversation with messages (auth required, ownership check)
- [ ] `DELETE /api/diagnostics/conversations/:id` — delete conversation (auth required, ownership check)
- [ ] LLM orchestration: receives user message → builds context (conversation history + RAG docs + recent charger telemetry) → calls Claude API with system prompt → stores response → returns structured JSON
- [ ] System prompt: domain-expert role, structured output (issue_type, confidence, root_cause, recommended_action, severity), instruction to only use provided context
- [ ] Tool definitions for the agent: `queryChargerStatus(chargerId)`, `getRecentEvents(chargerId, hours)`, `searchKnowledgeBase(query)`, `getSessionHistory(chargerId, days)`
- [ ] PII redaction middleware: strip/pseudonymize user PII, payment data, VINs from all context before LLM call
- [ ] Rate limiting: per-user message rate limit (e.g., 20 messages/hour) to control costs

**Done when:** Authenticated portal user can have a multi-turn conversation about a charger's health, getting context-aware diagnostics. Different users cannot see each other's conversations.

### Subtask 155.5: Scheduled Health Reports
- [ ] Nightly cron (or scheduled Fastify task): for each active site, analyze last 24h of ChargerEvents + session metrics
- [ ] Generate structured health report per site: charger uptime %, error trends, anomalies, predicted risks, recommended actions
- [ ] Store report in DB (new `SiteHealthReport` model) + send summary to operator notification preferences
- [ ] Portal endpoint: `GET /api/sites/:id/health-reports` — paginated list of reports

**Done when:** Nightly report generates for test site with real telemetry data; viewable in portal.

### Subtask 155.6: Portal UI — Diagnostics Chat + Health Dashboard
- [ ] New portal page: `/diagnostics` — chat interface for conversational charger diagnostics
- [ ] Conversation sidebar: list past conversations, create new, delete
- [ ] Chat area: message bubbles, streaming response display, charger context cards
- [ ] Charger selector: pick which charger(s) to diagnose (pre-fills context)
- [ ] Health dashboard widget on site detail page: latest health report summary, trend sparklines, alert badges
- [ ] Health reports page: `/sites/:id/health-reports` — full report history with drill-down

**Done when:** Operator can open diagnostics, select a charger, ask "why is this charger faulting?", and get a contextual answer citing specific error events and documentation.

### Out of Scope (Future)
- Edge-deployed models / on-device inference
- Multi-agent orchestration (single agent sufficient at current scale)
- Real-time streaming telemetry analysis (batch + trigger is sufficient)
- Autonomous remediation (human-in-the-loop only for now)
- Fine-tuned domain models (RAG + good prompting first)

---

## Backlog (Post-MVP)
- OCPP 2.0.1 upgrade path
- Multi-tenant operator accounts
- Load balancing / smart charging (OCPP SetChargingProfile)
- RFID card support
- Fleet/corporate accounts
- Revenue sharing between site hosts and operators
