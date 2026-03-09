# TASK-0087 — Keycloak E2E Verification Plan (Portal + Mobile + API)

## Test objective

Verify that Keycloak-backed auth works end-to-end for allowed roles and fails correctly for denied roles, without regressions in core charging flows.

## Preconditions

- Stage/prod-like environment with Keycloak realm configured.
- API supports issuer allowlist / dual-auth transition mode.
- Test accounts provisioned per matrix in `docs/migration/TASK-0087_KEYCLOAK_CUTOVER_RUNBOOK.md`.
- API base URL + bearer tokens available to QA operator.

## Verification tracks

## A) API auth contract checks

Run:

```bash
./scripts/auth/keycloak-cutover-check.sh
```

Expected:

- Protected endpoint succeeds with valid token.
- Invalid/expired token is rejected (401).
- Role-protected endpoint rejects insufficient role (403/401 per implementation).
- Security posture and audit endpoints reachable for operator role.

## B) Portal user journeys

For each relevant persona:

1. Sign in via Keycloak.
2. Load dashboard and verify role-appropriate data visibility.
3. Attempt restricted action:
   - owner/operator: can manage users and charger ops,
   - non-privileged roles: blocked with expected UX/API status.
4. Validate audit event created for privileged attempts.

Record artifacts:

- screenshot of login success,
- screenshot/API trace for denied action,
- request id / timestamp.

## C) Mobile user journeys (driver)

1. Sign in with Keycloak-backed driver user.
2. Browse map and charger detail.
3. Start session on available charger.
4. Stop session and verify summary.
5. Negative check: driver cannot access operator/admin actions.

Record artifacts:

- session id,
- charger id,
- auth provider claim,
- API status codes for denied paths.

## D) Dual-auth window checks (optional but recommended)

During dual-accept stage:

- Clerk token still accepted for legacy active sessions.
- Keycloak token accepted for new sign-ins.
- Metrics segmented by provider confirm expected traffic shift.

---

## Test checklist (signoff)

- [ ] Owner/operator login + admin actions pass
- [ ] Support role allowed paths pass; restricted ops blocked
- [ ] NRE role ops-only paths pass; privileged admin blocked
- [ ] Analyst role analytics pass; operational/admin blocked
- [ ] Mobile driver full session flow passes
- [ ] Disabled/no-role users denied everywhere
- [ ] Audit entries present for privileged role actions
- [ ] Token errors and role denials visible in telemetry panels
- [ ] Keycloak dependency health green during run
- [ ] Rollback rehearsal executed and documented (stage required)

---

## Evidence package format

Create one folder per environment:

```text
docs/qa/evidence/keycloak-cutover/<env>/<yyyy-mm-dd>/
  - api-check.log
  - portal-owner-pass.png
  - portal-analyst-deny.png
  - mobile-driver-session.png
  - metrics-snapshot.png
  - audit-sample.json
  - signoff.md
```

`signoff.md` should include:

- environment + build/version
- tester + timestamp
- pass/fail by checklist item
- known issues (if any)
- go/no-go recommendation
