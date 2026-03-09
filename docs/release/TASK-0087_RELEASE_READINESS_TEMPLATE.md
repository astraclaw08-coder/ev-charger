# TASK-0087 — Keycloak Cutover Release Readiness Report (Template)

- **Date**:
- **Environment**: dev / stage / prod
- **Release owner**:
- **Auth migration lead**:
- **Incident commander (if cutover)**:
- **Build/commit**:

## 1) Scope

- Cutover mode: `clerk-only | dual-auth | keycloak-primary`
- Services in scope: API / Portal / Mobile
- Out of scope:

## 2) Go/No-Go Gates

### Functional
- [ ] Persona matrix validated (owner/support/NRE/analyst/driver)
- [ ] E2E flows pass (portal + mobile + API)
- [ ] Admin workflows pass (user/role/audit)

### Reliability
- [ ] Auth success >= target
- [ ] Auth latency (P95) within threshold
- [ ] Keycloak dependency health stable

### Security/Audit
- [ ] Token verification failures within threshold
- [ ] Role-denied behavior correct and observable
- [ ] Audit trail complete for privileged actions

## 3) Telemetry Snapshot

- Auth success rate:
- Auth failure rate:
- Token verify failures:
- Role denied rates:
- Keycloak uptime/latency:

## 4) Risks / Open Issues

| ID | Risk | Severity | Owner | Mitigation | Status |
|---|---|---|---|---|---|

## 5) Rollback Readiness

- [ ] Rollback trigger thresholds agreed
- [ ] Rollback command/config steps verified
- [ ] Last rollback rehearsal date:
- [ ] Communication template prepared

## 6) Final Decision

- Decision: **GO / NO-GO**
- Conditions:
- Approvers (Eng/Product/Sec/Ops):
