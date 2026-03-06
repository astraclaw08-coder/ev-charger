# TASK-0087 — Keycloak Cutover Runbook (Migration + QA Signoff)

## Scope

Cut over auth from current provider (Clerk) to Keycloak with staged, reversible rollout across API + portal + mobile, while preserving auditability and production safety.

---

## 1) Staged Migration / Cutover Plan (dev → stage → prod)

### Guiding principles

- Additive first (no destructive auth-path deletions before production stability).
- Keep rollback fast: config toggles + deploy rollback, no schema rewrites needed.
- Explicit go/no-go gate at each environment.
- Every gate requires attached evidence artifacts.

### Required feature flags / toggles

Use env-based runtime flags (or equivalent deployment config) for deterministic control:

- `AUTH_PROVIDER_PRIMARY=clerk|keycloak`
- `AUTH_PROVIDER_DUAL_ACCEPT=true|false` (API accepts both token issuers during transition)
- `AUTH_PROVIDER_ISSUER_ALLOWLIST=<comma-separated issuers>`
- `AUTH_MIGRATION_DRY_RUN=true|false` (log-only claim mapping validation)

> If some flags are not yet wired, treat these as deployment controls to be implemented before Stage gate.

### Phase A — Development (internal)

1. Configure Keycloak realm/client/roles to mirror production role semantics:
   - `owner`, `operator`, `customer_support`, `network_reliability`, `analyst`, mobile driver role(s).
2. Enable dual-accept in API (`AUTH_PROVIDER_DUAL_ACCEPT=true`) and keep Clerk primary.
3. Run full auth regression (portal login, mobile login, API bearer access, admin role workflows).
4. Validate logs/metrics for both issuers.

**Dev go/no-go gate**

- ✅ Auth success rate >= 99% over test run.
- ✅ No unexpected 401/403 increase vs baseline (>2% relative delta is no-go).
- ✅ Admin user management endpoints function for Keycloak test users.
- ✅ Audit trail contains provider + subject + action for all privileged calls.

### Phase B — Staging

1. Promote same config with production-like IdP settings.
2. Run optional **dual-auth window** (recommended 24–72h):
   - API accepts both Clerk + Keycloak tokens.
   - Portal/mobile sign-in default points to Keycloak for pilot cohorts.
3. Execute E2E checklist (see `docs/qa/TASK-0087_E2E_VERIFICATION.md`).
4. Run synthetic auth probes every 5 minutes (success + expected-deny cases).

**Stage go/no-go gate**

- ✅ P95 auth latency within +20% of baseline.
- ✅ Keycloak token validation error rate < 0.5%.
- ✅ Role-denial (403) ratio matches expected scenario profile (no random spikes).
- ✅ Keycloak dependency health stable (no >=2 consecutive failed probes).
- ✅ Incident rollback rehearsal completed once in staging.

### Phase C — Production

1. Start with canary cohort (internal + selected operators).
2. Keep `AUTH_PROVIDER_DUAL_ACCEPT=true` during canary.
3. Monitor 2–4h; if stable, switch primary to Keycloak for all users.
4. Keep dual-auth safety window for 24h post-cutover.
5. After stability window + signoff, disable Clerk acceptance.

**Prod go/no-go gate**

- ✅ 0 Sev-1 auth incidents during canary window.
- ✅ Login/session start success >= 99.5% for portal + mobile.
- ✅ 401/403/5xx auth-related error budgets remain within threshold.
- ✅ Support queue auth ticket volume not >2x normal.
- ✅ On-call + product + security signoff recorded in release report.

---

## 2) Test Account Matrix (Personas + Expected AuthZ Outcomes)

| Persona | Keycloak roles | Portal login | Mobile login | API `/me/profile` | Admin user mgmt | Charger ops/reset | Analytics export | Refund action |
|---|---|---|---|---|---|---|---|---|
| Owner/Operator | `owner` + `operator` | Allow | Optional | Allow | Allow | Allow | Allow | Allow |
| Support | `customer_support` | Allow | N/A | Allow | Deny (403) | Deny (403) | Read-only/limited | Allow (if support flow allows) |
| NRE | `network_reliability` | Allow | N/A | Allow | Deny (403) | Allow (ops endpoints) | Limited | Deny |
| Analyst | `analyst` | Allow | N/A | Allow | Deny (403) | Deny (403) | Allow (non-operational) | Deny |
| Mobile Driver | `driver` (or app driver scope) | N/A | Allow | Allow (driver-scoped) | Deny (403) | Deny (403) | Deny | N/A |
| No role / deactivated | none | Deny (401/403) | Deny (401/403) | Deny | Deny | Deny | Deny | Deny |

### Required test identities

- `kc-owner-01@example.com`
- `kc-support-01@example.com`
- `kc-nre-01@example.com`
- `kc-analyst-01@example.com`
- `kc-driver-01@example.com`
- `kc-disabled-01@example.com` (disabled user)

Store credentials in secure vault, never in repo.

---

## 3) Rollback Plan (Triggers + Exact Reversal Steps)

### Trigger thresholds (rollback if any are met)

- Auth success drops below 98.5% for 10 minutes.
- 401/403 auth failures increase >3x baseline for 10 minutes.
- Keycloak token introspection/verification failures >2% sustained 5 minutes.
- Keycloak dependency health endpoint fails 3 consecutive checks.
- Sev-1 customer-impacting login/session incident declared.

### Fast rollback steps (target: <= 15 minutes)

1. Flip auth config:
   - `AUTH_PROVIDER_PRIMARY=clerk`
   - `AUTH_PROVIDER_DUAL_ACCEPT=true`
   - remove/disable Keycloak-only sign-in UI links if required.
2. Redeploy API + portal/mobile config bundle.
3. Invalidate problematic Keycloak sessions if security requires containment.
4. Announce rollback in incident channel and status page.
5. Confirm recovery:
   - auth success and latency return to baseline,
   - support tickets normalize,
   - synthetic probes green.
6. Preserve evidence:
   - deployment id,
   - timestamps,
   - metrics snapshots,
   - sample failed JWT claims,
   - incident commander notes.

### Full reversal (if prolonged outage)

- Keep Keycloak integration artifacts in place but disable traffic.
- Re-run Clerk-only smoke tests.
- Open postmortem with “re-entry criteria” before retrying migration.

---

## 4) Telemetry / Observability Checks

## Metrics to track

### Auth flow

- `auth_requests_total{provider, outcome}`
- `auth_latency_ms{provider, route}` (P50/P95/P99)
- `auth_token_verify_fail_total{provider, reason}`
- `auth_role_denied_total{role, route}`

### Product outcomes

- Portal login success/failure
- Mobile login success/failure
- API protected-route success rate
- Session start/stop success after login

### Keycloak dependency

- token endpoint availability/latency
- JWKS fetch/refresh success
- admin API call success rate (if used in workflows)

### Auditability

Every privileged action log should include:

- `actorId`
- `actorProvider` (`clerk|keycloak`)
- `roles[]`
- `action`
- `target`
- `requestId/correlationId`
- `outcome`

## Operational checks

- Dashboard panel: auth success %, 401/403 trends, token errors, Keycloak health.
- Alerting:
  - critical: auth success < 98.5% for 5m,
  - warning: role-denied spikes >2x baseline,
  - critical: Keycloak health red >=3 checks.
- Log query examples and API probes are in `scripts/auth/keycloak-cutover-check.sh`.

---

## Operator Runbook Notes

- Keep dual-auth window until at least one full business day of stable traffic.
- Avoid role model changes during cutover window.
- Freeze unrelated deployments during production cutover.
- Require explicit signoff from Engineering + Product + Support + Security before disabling Clerk acceptance.
