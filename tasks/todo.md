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
