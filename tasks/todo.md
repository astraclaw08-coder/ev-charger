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

## Pending Verification

### Live-session TOU billing fix (commit `0a5c23f`, deployed 2026-04-20)
- [x] API `GET /sessions/:id` — ACTIVE sessions pass `stoppedAt = now` into `computeSessionAmounts` → TOU segmentation works live
- [x] Mobile `LiveSessionView` — Cost bound to `billingBreakdown.totals.grossUsd`, no more client-side `kwh × ratePerKwh`
- [x] `AppState` + `useFocusEffect` refetch wired in `app/session/[id].tsx`
- [x] Direct-function verification: session 43a2b830 real data → old path $33.25 flat, new path $16.87 TOU-correct, completed path unchanged
- [ ] **Not yet proven live**: foreground/focus refetch behavior on RC app during a real active session. The code path is in place and compiles clean, but requires a live ACTIVE session on a TOU site to confirm:
  - Backgrounding the app for 5+ min then foregrounding → kWh snaps to current within 1-2 s (AppState listener)
  - Tab-switching away and back → same (useFocusEffect)
  - Cost updates match TOU window rollover when session crosses a boundary
  - Final receipt `grossAmountUsd` == live-card cost at t=stop (within $0.01 rounding)
- Next verification opportunity: next active session on 1A32 or any TOU-priced site

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

#### 155.6a: Tabbed AI Diagnostic Chat in Operations ✅ COMPLETE (2026-04-09)
> Narrowed scope: leverage existing Lumeo AI chat + 25 agent tools (no new backend)

- [x] `AgentChatContext` — shared React context for chat open/tab state, replaces self-contained isOpen
- [x] Tab bar in `AgentChatPanel` — General tab (always) + up to 3 closeable Diagnostic tabs
- [x] Independent message history per tab (separate localStorage keys, `lumeo.agent-chat.diag.${chargerId}`)
- [x] Tab metadata persistence (`lumeo.agent-chat.tabs`) survives page refresh
- [x] `TabSession` remount pattern (`key={activeTab.id}`) — clean lifecycle, no cross-tab async leaks
- [x] `seedState`/`seedVersion` state machine for idempotent auto-send of diagnostic prompts
- [x] `diagnostic-seed` message meta — renders as system event row, not user bubble
- [x] "✦ AI Diagnose" button on every charger card in NetworkOps health grid
- [x] One active stream globally — tab switch aborts previous, partial response preserved
- [x] Close preserves transcript, clear resets seedState to idle
- [x] Deployed to production: `portal.lumeopower.com` (Vercel, commit `e2b0f28`)

**Files:** `AgentChatContext.tsx` (new), `AgentChatPanel.tsx`, `useAgentChat.ts`, `types.ts`, `Layout.tsx`, `NetworkOps.tsx`

#### 155.6b: Remaining (not yet started)
- [ ] New portal page: `/diagnostics` — dedicated chat interface for conversational charger diagnostics
- [ ] Conversation sidebar: list past conversations, create new, delete
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

## Task 156: Privacy & Terms of Service — Mobile App + Portal

> Goal: Provide legally required privacy policy, terms of service, and consent flows for end-users (mobile app) and operators (portal).

### Subtask 156.1: Privacy Policy & Terms of Service Pages
- [ ] Draft Privacy Policy covering: data collected (account info, payment, location, charging history, device info), data usage, third-party sharing (Stripe, Mapbox, analytics), data retention, user rights (access, deletion, correction), contact info
- [ ] Draft Terms of Service covering: acceptable use, payment terms, liability limitations, dispute resolution, account termination, service availability
- [ ] Host both as static pages accessible via URL (e.g., `/privacy`, `/terms` on portal domain)
- [ ] Ensure pages are publicly accessible (no auth required)

### Subtask 156.2: Mobile App Consent Flow
- [ ] Add "I agree to the Privacy Policy and Terms of Service" checkbox on sign-up screen with links to both documents
- [ ] Block registration until consent is given
- [ ] Record consent timestamp + version in user record (new fields: `tosAcceptedAt`, `tosVersion`, `privacyAcceptedAt`, `privacyVersion`)
- [ ] Add Privacy Policy and Terms links in app Settings/About screen
- [ ] Handle re-consent: if policy version changes, prompt user to accept updated terms on next app open

### Subtask 156.3: Portal Consent Flow
- [ ] Add consent checkbox on portal sign-up / first-login flow with links to Privacy Policy and Terms
- [ ] Record consent timestamp + version in operator user record
- [ ] Add Privacy Policy and Terms links in portal footer and Settings page
- [ ] Handle re-consent on policy version updates

### Subtask 156.4: Data Rights & Account Deletion
- [ ] `DELETE /api/users/me` — account deletion endpoint (anonymize PII, retain anonymized charging records for billing/compliance)
- [ ] Add "Delete My Account" option in mobile app Settings
- [ ] Add "Delete My Account" option in portal Settings
- [ ] Confirmation flow with grace period notice (e.g., 30 days before permanent deletion)
- [ ] Email confirmation on deletion request

### Subtask 156.5: Prisma Schema Updates
- [ ] Add to User model: `tosAcceptedAt DateTime?`, `tosVersion String?`, `privacyAcceptedAt DateTime?`, `privacyVersion String?`, `deletionRequestedAt DateTime?`
- [ ] Migration

**Done when:** Both apps require consent before use, link to hosted policy pages, support re-consent on updates, and users can request account deletion.

---

## Task 157: Astra Handshake Protocol — Claude Code ↔ Astra Task Contract System

> Goal: Formalize the Claude Code ↔ Astra/OpenClaw task agreement workflow so that every non-trivial task has a structured, machine-readable contract with explicit plan approval and final signoff gates. No task is treated as complete without Astra signoff.

### Problem Statement
Currently plan state lives in chat context (which compacts), plan files (which get overwritten per-task), and agent memory (which resets per session). There is no durable, machine-readable record that both Claude Code and Astra can inspect independently. Review feedback is scattered across chat rounds with no structured trail.

### Architecture Decisions
- **File-on-disk, not a service** — JSON contracts in git, no custom CLI tools, no web UI, no database
- **Two gates only** — plan review + final signoff. More gates create friction without proportional value.
- **JSON contract is source of truth** — machine-parseable (Astra can programmatically read), diff-friendly in git, forces structured thinking
- **Minimal v1** — prove it on 2-3 real tasks before iterating. Resist over-engineering the workflow system.

### Subtask 157.1: Template + Protocol Documentation
- [ ] Create `state/task-handshake/templates/task-contract.json` — canonical template with fields:
  - `taskId`, `title`, `status` (enum: `draft`, `plan_review_required`, `plan_approved`, `changes_requested`, `in_progress`, `final_review_required`, `approved`, `closed`)
  - `goal` — what and why
  - `acceptanceCriteria` — concrete, testable conditions
  - `scope` — in-scope and out-of-scope
  - `implementationPlan` — sequenced steps
  - `filesExpectedToChange` — declared at plan time, not just completion
  - `risks` — known risks and mitigations
  - `openQuestions` — unresolved items needing input
  - `blockers` — explicit field, not buried in openQuestions
  - `proofOfWork` — initial evidence (test results, build output, etc.)
  - `reviewHistory` — array of `{ reviewer, decision, notes, timestamp }` to preserve review trail across sessions
  - `changedFiles` — filled at completion
  - `verification` — filled at completion
  - `completionEvidence` — filled at completion
  - `createdAt`, `updatedAt`
- [ ] Create `state/task-handshake/README.md` — protocol documentation covering:
  - purpose and motivation
  - contract lifecycle (draft → plan_review → approved/changes_requested → in_progress → final_review → approved → closed)
  - field definitions and examples
  - ground rules (no freeform chat as only record, no silent scope expansion, no done without QC evidence)

### Subtask 157.2: Claude Code Integration Prompt
- [ ] Create `state/task-handshake/prompts/claude-code-task-intro.md` — injected at session start, instructs Claude Code to:
  - read the contract on task start
  - refuse to implement if `status !== 'plan_approved'`
  - create/update per-task contract files at `state/task-handshake/tasks/<task-id>.json`
  - set status to `plan_review_required` before implementation
  - set status to `final_review_required` before closing
  - notify Astra via OpenClaw gateway message as active notification
- [ ] Add the prompt path to `.claude/` project config or CLAUDE.md so it loads automatically

### Subtask 157.3: Astra/OpenClaw Integration
- [ ] Astra notification mechanism: OpenClaw gateway message (`openclaw agent --to main --message "Plan ready for review: TASK-XXXX"`) as active notification, JSON status as durable record
- [ ] Astra review workflow: read contract JSON, validate plan, write `reviewHistory` entry, set status to `plan_approved` or `changes_requested`
- [ ] Astra final signoff: read contract, verify completion evidence, write signoff entry, set status to `approved`
- [ ] Optional: OpenClaw cron or hook to detect `plan_review_required` / `final_review_required` status changes and auto-notify

### Subtask 157.4: Validate on First Real Task
- [ ] Use the protocol on the next non-trivial task end-to-end
- [ ] Retrospective: did it add value? what was friction? what needs adjustment?

### Design Notes from Assessment

**Concern: Who actually blocks?**
Claude Code has no built-in "wait" between sessions. The enforcement is: Claude Code reads the contract on task start and refuses to implement if `status !== 'plan_approved'`. This works only if the prompt is injected reliably. Astra needs a way to detect status changes — either via OpenClaw cron polling or active notification via gateway message. If the user is the sole relay between agents, this is just structured chat with extra steps. The value comes when Astra can autonomously review and write back decisions.

**Concern: Duplication with existing systems**
Claude Code already has plan mode (`~/.claude/plans/*.md`) and there's `tasks/todo.md` as the project tracker. Three places tracking overlapping state is a recipe for drift. Recommendation: the task contract should **replace** the Claude Code plan file for handshake-governed tasks, or reference it by path. `tasks/todo.md` stays as the high-level project tracker; the contract is the per-task detail.

**Concern: Scope creep on the protocol itself**
This is meta-tooling. Implementation must stay minimal: one JSON template, one README, one prompt file. No custom CLI, no web UI. File-on-disk is the right primitive. Prove it works on 2-3 tasks before adding sophistication.

**Concern: Notification reliability**
Recommend belt-and-suspenders: OpenClaw gateway message as active push + JSON status as durable pull. Astra can check either.

**Concern: Review trail persistence**
The `reviewHistory` array is critical — it solves the exact problem of review feedback being lost to chat compaction. Each entry should capture reviewer identity, decision, notes, and timestamp so either agent can reconstruct what happened across sessions.

### Files to Create/Modify
| File | Change |
|------|--------|
| `state/task-handshake/templates/task-contract.json` | **NEW** — canonical contract template |
| `state/task-handshake/README.md` | **NEW** — protocol documentation |
| `state/task-handshake/prompts/claude-code-task-intro.md` | **NEW** — Claude Code session prompt |
| `state/task-handshake/tasks/` | **NEW** — directory for per-task contracts |
| `.claude/` or `CLAUDE.md` | Reference handshake prompt for auto-loading |

**Done when:** Claude Code can create a task contract, set it to `plan_review_required`, Astra can read and approve it, Claude Code respects the gate and only implements after approval, and the full cycle completes on one real task.

---

## Backlog (Post-MVP)
- OCPP 2.0.1 upgrade path
- Multi-tenant operator accounts
- Load balancing / smart charging (OCPP SetChargingProfile)
- RFID card support
- Fleet/corporate accounts
- Revenue sharing between site hosts and operators

---

## Enterprise Gap Assessment (2026-04-10)

### What the platform already has in some form
- OCPP 1.6J core CSMS, remote commands, diagnostics hooks, firmware/trigger/config command paths
- Driver mobile app + operator portal + white-label-friendly theming baseline
- Smart charging/load management at site/group/charger scope
- TOU pricing, activation/idle fees, software fee overlays
- Keycloak auth, RBAC, audit log paths, consent/re-consent flows, privacy/terms pages
- Organization/portfolio scoping foundations, analytics dashboards, CSV export, webhooks/settings surfaces
- AI diagnostic chat foundation and charger health assessment primitives

### What is still missing for true top-tier / enterprise parity
- OCPP 2.0.1 and advanced security/device model
- OCPI roaming, partner settlement, external network visibility
- Enterprise billing engine (invoicing, taxes, subscriptions, split settlements, reconciliation)
- Reservations/waitlists/route-planning stack
- Deeper EMS/utility/DER integrations (meters, solar, storage, OpenADR)
- Fleet orchestration (vehicle/SOC/departure-aware charging)
- ISO 15118 Plug & Charge certificate lifecycle
- HA/multi-region/DR architecture and compliance evidence tooling
- Internationalization/localization and true multi-currency
- Predictive maintenance/anomaly automation beyond current diagnostics

---

## Task 160: OCPP 2.0.1 Foundation + Security Profiles
> Goal: add an enterprise-grade protocol roadmap beyond OCPP 1.6J, starting with dual-stack architecture and the highest-value 2.0.1 capabilities.

### Subtask 160.1: Protocol architecture
- [ ] Define dual-stack CSMS architecture for OCPP 1.6J + 2.0.1 coexistence
- [ ] Add protocol capability registry per charger model/firmware
- [ ] Design message normalization layer mapping 1.6J and 2.0.1 events into shared internal domain models

### Subtask 160.2: OCPP 2.0.1 implementation slice
- [ ] Implement 2.0.1 connection/bootstrap flow for a simulator-backed pilot charger
- [ ] Support device model/component-variable inventory reads
- [ ] Support transaction/event model mapping (`TransactionEvent`, availability, notify reports)
- [ ] Add 2.0.1 security profile plan (mTLS/cert lifecycle requirements, signed firmware readiness)

### Subtask 160.3: Portal/API support
- [ ] Show per-charger protocol version/capabilities in portal
- [ ] Add API surface for component-level monitoring and config management
- [ ] Create simulator/QC harness for mixed 1.6J + 2.0.1 regression coverage

**Done when:** one pilot charger/simulator can run on OCPP 2.0.1 with normalized telemetry and visible protocol capabilities.

---

## Task 161: OCPI Roaming + Partner Settlement Engine
> Goal: make the platform interoperable with roaming hubs and partner CPO/eMSP networks.

### Subtask 161.1: OCPI core
- [ ] Design OCPI module architecture (`locations`, `tariffs`, `tokens`, `sessions`, `cdrs`, `commands`)
- [ ] Implement credential exchange, role negotiation, version discovery, and partner config storage
- [ ] Publish local locations/tariffs/session data through OCPI endpoints

### Subtask 161.2: Remote access + partner sessions
- [ ] Ingest partner locations/tariffs/tokens for out-of-network visibility
- [ ] Support remote start/stop token-based roaming auth flows
- [ ] Build CDR generation/export pipeline for roaming sessions

### Subtask 161.3: Clearing/settlement
- [ ] Add partner settlement ledger, payable/receivable tracking, and dispute statuses
- [ ] Reconcile OCPI session/CDR totals against internal billing records
- [ ] Add portal views for roaming revenue, partner balances, and exceptions

**Done when:** a configured roaming partner can exchange locations/tokens/sessions/CDRs and settlement deltas are visible.

---

## Task 162: Enterprise Billing, Tax, Invoicing, and Settlement
> Goal: upgrade billing from session charging into a configurable finance engine.

### Subtask 162.1: Tariff and product engine
- [ ] Add versioned tariff catalogs with effective dates, currencies, taxes, subscriptions, and promos
- [ ] Support business models: public ad hoc, membership, fleet contract, host-owned, roaming, employee/workplace
- [ ] Add guest pay, RFID balance/prepaid, invoice billing, and postpaid account modes

### Subtask 162.2: Financial records
- [ ] Add invoice, invoice line, tax jurisdiction, credit memo, payout, and reconciliation models
- [ ] Implement tax calculation abstraction for US sales tax/VAT-ready treatment
- [ ] Generate session-rated financial documents and settlement statements

### Subtask 162.3: Revenue share + reconciliation
- [ ] Automate split billing between CPO, site host, landlord, and software platform
- [ ] Add payout run workflow with exception handling and audit trail
- [ ] Build reconciliation jobs against Stripe payouts, refunds, disputes, and session records

**Done when:** the platform can produce invoices/settlements with taxes, revenue-share, and reconciliation evidence.

---

## Task 163: Reservations, Waitlists, and Route Planning
> Goal: close a major driver-experience gap for public-network scale.

### Subtask 163.1: Reservation domain
- [ ] Add reservation inventory, hold windows, expiry, penalties, and connector allocation rules
- [ ] Implement OCPP reservation flows where supported and graceful fallback where unsupported
- [ ] Add anti-hoarding, no-show, and overbooking policy controls

### Subtask 163.2: Driver UX
- [ ] Mobile/web flows for reserve, join waitlist, ETA updates, and cancellation
- [ ] Push notifications for slot ready, expiry warning, charger unavailable, reroute suggestion
- [ ] Surface reservation state in charger/site availability APIs

### Subtask 163.3: Route planning
- [ ] Add route-planning service integrating charger availability, connector compatibility, and pricing
- [ ] Support trip stops, arrival SOC assumptions, and POI overlays
- [ ] Add fallback reroute logic when a reserved charger faults or occupancy shifts

**Done when:** drivers can reserve/waitlist and follow a route plan that reacts to live station conditions.

---

## Task 164: ISO 15118 Plug & Charge + Certificate Operations
> Goal: prepare for seamless auth and future bidirectional charging standards.

### Subtask 164.1: Certificate lifecycle
- [ ] Design PKI integration for contract certificates, OEM provisioning assumptions, and revocation flow
- [ ] Add secure certificate storage/rotation model and operator tooling
- [ ] Implement audit trail for certificate issue/import/revoke events

### Subtask 164.2: Authorization flow
- [ ] Add Plug & Charge session authorization path and fallback to app/RFID when unavailable
- [ ] Surface PnC capability per charger and per site in driver/operator apps
- [ ] Add diagnostics for failed certificate or contract-chain validation

### Subtask 164.3: Forward compatibility
- [ ] Document V2G/V2H impacts on session, billing, and energy models
- [ ] Extend internal energy-flow models to support bidirectional transactions
- [ ] Define pilot-readiness checklist for OEM/charger interoperability testing

**Done when:** the system has a working PnC architecture/spec and pilot-capable certificate operations path.

---

## Task 165: EMS, DER, and Utility Integration Layer
> Goal: evolve smart charging into a true site energy orchestration platform.

### Subtask 165.1: Energy data model
- [ ] Add site meter, transformer, panel, solar, battery, and utility signal models
- [ ] Ingest external meter/EMS telemetry with timestamp quality/source metadata
- [ ] Build site energy state service combining charger load and external assets

### Subtask 165.2: Control integrations
- [ ] Integrate OpenADR or equivalent utility event ingestion for demand-response signals
- [ ] Add APIs/adapters for BMS/EMS vendors and meter gateways
- [ ] Implement peak-shaving and demand-charge mitigation control loops using site constraints

### Subtask 165.3: UX + reporting
- [ ] Portal views for site load, DER contribution, curtailment events, and avoided demand cost
- [ ] Alerting for meter drift, telemetry loss, and unsafe site load conditions
- [ ] Export utility/compliance reports for managed energy events

**Done when:** a site can optimize charger power using external meter/utility/DER inputs, not charger telemetry alone.

---

## Task 166: Fleet Energy Orchestration and Vehicle-Aware Charging
> Goal: support fleet depots and workplace/fleet operators with vehicle-priority controls.

### Subtask 166.1: Fleet entities
- [ ] Add fleet accounts, depots, vehicles, drivers, and vehicle-assignment relationships
- [ ] Track target departure time, required energy, priority class, and SOC when available
- [ ] Add telematics ingestion contract for OEM/fleet providers

### Subtask 166.2: Scheduling engine
- [ ] Build vehicle-aware scheduling using departure deadlines, site constraints, and tariff windows
- [ ] Support priority override, guaranteed-minimum-charge policies, and missed-target alerts
- [ ] Add depot queue orchestration for limited connector availability

### Subtask 166.3: Fleet UX
- [ ] Fleet dashboard for readiness, missed departures risk, and depot load forecast
- [ ] Vehicle/session drill-down with scheduled vs actual energy delivery
- [ ] Reporting for fleet cost, utilization, and SLA adherence

**Done when:** fleet operators can optimize charging around departure commitments rather than only charger-centric limits.

---

## Task 167: Enterprise Reliability, HA, Multi-Region, and Disaster Recovery
> Goal: harden the platform for large-network uptime and enterprise procurement requirements.

### Subtask 167.1: Architecture hardening
- [ ] Define control-plane/data-plane topology, stateless service boundaries, and queue/event dependencies
- [ ] Design multi-region deployment strategy for API, OCPP ingress, and background jobs
- [ ] Add cache/outbox/idempotency strategy for command delivery and failover recovery

### Subtask 167.2: Backup/recovery
- [ ] Implement documented backup schedules and restore verification for Postgres and object/config artifacts
- [ ] Add disaster-recovery runbooks with RPO/RTO targets and failover drills
- [ ] Add synthetic monitoring for charger command path and session critical flows

### Subtask 167.3: SRE evidence
- [ ] Build uptime/SLO dashboards, incident timeline capture, and status-page integration
- [ ] Add chaos/failure-mode test plan for broker loss, DB failover, regional loss, and reconnect storms
- [ ] Produce enterprise readiness doc for HA/DR posture

**Done when:** the platform has explicit HA/DR architecture, tested restore paths, and measurable SLO evidence.

---

## Task 168: Compliance, Audit, Privacy, and Security Evidence Program
> Goal: move from good security controls to enterprise-auditable compliance readiness.

### Subtask 168.1: Security controls expansion
- [ ] Add immutable audit-log retention/export strategy and privileged-action review workflows
- [ ] Expand secrets rotation, key management, webhook signing, and certificate inventory controls
- [ ] Add field-level data classification and retention policy enforcement jobs

### Subtask 168.2: Compliance tooling
- [ ] Build GDPR/CCPA data-subject request workflow (export, correction, deletion, legal hold exceptions)
- [ ] Add SOC 2 / ISO 27001 evidence checklist mapped to technical controls and runbooks
- [ ] Add consent/version evidence reporting for legal/compliance review

### Subtask 168.3: OCPP/security posture
- [ ] Formalize OCPP advanced security profile roadmap (1.6 hardening + 2.0.1 cert posture)
- [ ] Add security posture dashboard for tenant/operator admins
- [ ] Add periodic compliance export packages for audits and enterprise sales due diligence

**Done when:** security and privacy claims are backed by durable evidence artifacts, exports, and workflows.

---

## Task 169: Globalization, White-Label, and Localization Platform
> Goal: support global operators and reseller deployments cleanly.

### Subtask 169.1: Internationalization
- [ ] Add i18n framework for portal/mobile/email templates/system notifications
- [ ] Externalize copy, currency formatting, tax labels, units, and locale-specific date/time handling
- [ ] Add translation QA workflow and fallback language policy

### Subtask 169.2: White-label control plane
- [ ] Add tenant brand kit management for logos, colors, domains, app config, emails, and QR assets
- [ ] Support per-tenant feature flags, policy text, support contacts, and app-store metadata
- [ ] Add reseller/operator branding boundaries and preview tooling

### Subtask 169.3: Multi-currency/global ops
- [ ] Support currency conversion/reference FX rates for reporting while preserving settlement currency
- [ ] Add country/region config for taxation, accessibility labels, connector taxonomy, and legal docs
- [ ] Add locale-aware receipts/invoices and partner settlement outputs

**Done when:** one codebase can serve multiple branded tenants across languages/currencies without manual forks.

---

## Task 170: Advanced Analytics, Predictive Maintenance, and Report Builder
> Goal: upgrade current analytics into enterprise decision support.

### Subtask 170.1: Data model and pipelines
- [ ] Define canonical fact tables for sessions, uptime, alarms, pricing, settlements, and occupancy
- [ ] Add scheduled materialization/warehouse-ready exports for large-scale analytics workloads
- [ ] Track charger reliability cohorts, MTTR/MTBF, repeat faults, and utilization heatmaps

### Subtask 170.2: Predictive insights
- [ ] Add anomaly detection pipeline for fault bursts, session drop-offs, meter drift, and revenue leakage
- [ ] Build recommendation engine for pricing, maintenance, and capacity planning actions
- [ ] Add operator feedback loop to label recommendations as useful/ignored/false positive

### Subtask 170.3: Report builder
- [ ] Build saved-report definitions with filters, dimensions, measures, schedules, and delivery channels
- [ ] Support CSV/XLSX/PDF export plus email/webhook delivery
- [ ] Add finance, operations, sustainability, and SLA report templates

**Done when:** operators can build/schedule custom reports and receive predictive insights with measurable signal quality.
