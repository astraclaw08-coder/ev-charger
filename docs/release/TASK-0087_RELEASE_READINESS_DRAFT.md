# TASK-0087 — Keycloak Cutover Release Readiness Report (Current Draft)

- **Date**: 2026-03-05
- **Environment**: stage-prep (documentation + tooling readiness)
- **Release owner**: TBD
- **Auth migration lead**: TBD
- **Build/commit**: (to be filled post-merge)

## 1) Scope

- Cutover mode currently prepared: `dual-auth` (recommended first), then `keycloak-primary`.
- Services in scope: API, Portal, Mobile.
- Out of scope in this task: deep auth middleware rewrite; objective is runbook + verification + release controls.

## 2) Gate status (current)

### Functional gate
- [x] Persona authz matrix defined.
- [x] E2E verification checklist defined for portal/mobile/API.
- [x] API smoke verification script added.
- [ ] Environment execution evidence attached (pending stage run).

### Reliability gate
- [x] Explicit thresholds defined for go/no-go and rollback triggers.
- [ ] Metrics dashboard screenshots attached (pending stage run).
- [ ] 24h dual-auth observation complete (pending).

### Security/Audit gate
- [x] Required audit fields and telemetry checks documented.
- [x] Keycloak security posture endpoint included in checks.
- [ ] Audit sample from stage attached (pending run).

## 3) Risks / Open Issues

| ID | Risk | Severity | Owner | Mitigation | Status |
|---|---|---|---|---|---|
| R-0087-1 | Runtime dual-auth flags may not yet be fully wired in all services | High | API owner | Implement/verify `AUTH_PROVIDER_*` controls before stage cutover | Open |
| R-0087-2 | Mobile and portal provider switch timing mismatch can cause temporary login confusion | Medium | Frontend owner | Coordinate feature flag rollout + release notes | Open |
| R-0087-3 | Insufficient baseline metrics could hide regression signal | Medium | SRE | Capture pre-cutover baseline for 7 days or nearest available | Open |

## 4) Rollback readiness

- [x] Trigger thresholds documented.
- [x] Exact reversal steps documented.
- [ ] Stage rollback rehearsal executed and logged.
- [ ] Production comms draft approved.

## 5) Recommendation

**Current recommendation: CONDITIONAL GO for stage only** once the following are complete:

1. Confirm dual-auth runtime controls exist and are tested in dev.
2. Execute `scripts/auth/keycloak-cutover-check.sh` in stage with all persona tokens.
3. Attach evidence package per QA doc.
4. Run one rollback drill and capture timing/results.

**Production recommendation:** NO-GO until stage evidence passes all checklist items and rollback rehearsal is successful.
