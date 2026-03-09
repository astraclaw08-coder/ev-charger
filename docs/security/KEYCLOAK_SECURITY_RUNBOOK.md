# Keycloak Security Hardening Runbook (TASK-0086)

## Scope

This runbook covers MFA baseline, SSO claim mapping readiness, SCIM hook onboarding, auth anomaly controls, token rotation policy tracking, and break-glass handling.

For tiered portal authorization claims and backend policy enforcement, see `docs/security/TASK-0088_AUTHZ_RUNBOOK.md`.

## 1) Prerequisites

Set required Keycloak admin env vars in API runtime:

- `KEYCLOAK_BASE_URL`
- `KEYCLOAK_REALM`
- `KEYCLOAK_ADMIN_CLIENT_ID`
- `KEYCLOAK_ADMIN_CLIENT_SECRET`

For portal username/password sign-in and token introspection (confidential backend-only client):

- `KEYCLOAK_PORTAL_CLIENT_ID` (recommended, can fallback to admin client id)
- `KEYCLOAK_PORTAL_CLIENT_SECRET` (recommended, can fallback to admin client secret)
- `SUPER_ADMIN_BOOTSTRAP_SECRET` (one-time bootstrap guard secret)
- `KEYCLOAK_OWNER_ROLES` (optional, default: `owner,operator`)

Restart API after env updates.

## 1.1) Bootstrap first owner (one-time)

Call backend bootstrap endpoint once (from trusted operator terminal/network):

```bash
curl -sS -X POST "$API_BASE/auth/bootstrap-super-admin" \
  -H 'Content-Type: application/json' \
  -d '{
    "bootstrapSecret":"'$SUPER_ADMIN_BOOTSTRAP_SECRET'",
    "username":"<son-username>",
    "email":"<son-email>",
    "password":"<temporary-strong-password>",
    "firstName":"Son"
  }'
```

Behavior:

- Creates or updates account in Keycloak
- Assigns owner-level roles (`KEYCLOAK_OWNER_ROLES`)
- Sets temporary password + required action `UPDATE_PASSWORD`
- Endpoint is guarded by rate-limit and one-time in-memory lock after success

Immediately after success:

1. Log in through portal username/password.
2. Complete forced password update.
3. Rotate `SUPER_ADMIN_BOOTSTRAP_SECRET` and restart API.
4. Store rotated secret in your secret manager only (never in git).

## 2) Enable posture + baseline controls

Recommended baseline:

```bash
SECURITY_MFA_REQUIRED_ROLES=owner,operator
SECURITY_MFA_REQUIRED_ACR_VALUES=urn:mace:incommon:iap:silver,phr
SECURITY_MFA_TRUSTED_DEVICE_DAYS=14
SECURITY_MFA_GRACE_PERIOD_HOURS=24

SECURITY_SSO_OIDC_REQUIRED_CLAIMS=sub,email,email_verified
SECURITY_SSO_ROLE_CLAIM_PATHS=realm_access.roles,resource_access.ev-portal.roles
SECURITY_SSO_SAML_ENABLED=false
SECURITY_SSO_SAML_NAMEID_FORMAT=urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress
SECURITY_SSO_SAML_REQUIRED_ATTRIBUTES=email,firstName,lastName
SECURITY_SSO_SAML_ROLE_ATTRIBUTES=Role,Groups

SECURITY_AUTH_FAILURE_MAX_ATTEMPTS=8
SECURITY_AUTH_FAILURE_WINDOW_SECONDS=300
SECURITY_AUTH_BLOCK_SECONDS=900
SECURITY_SENSITIVE_ACTION_BURST=30
SECURITY_SENSITIVE_ACTION_WINDOW_SECONDS=60

SECURITY_ACCESS_TOKEN_MAX_TTL_SECONDS=900
KEYCLOAK_ADMIN_SECRET_ROTATION_DAYS=90
SECURITY_SIGNING_KEY_ROTATION_DAYS=30
```

Validate posture:

```bash
curl -sS "$API_BASE/admin/security/posture" -H "Authorization: Bearer $TOKEN" | jq
```

## 3) SCIM readiness (safe contract mode)

Enable hooks in dry-run mode first:

```bash
SECURITY_SCIM_ENABLED=true
SECURITY_SCIM_DRY_RUN=true
```

Test event ingestion:

```bash
curl -sS -X POST "$API_BASE/admin/scim/hooks/user.created" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "tenantId":"enterprise-a",
    "correlationId":"req-123",
    "user":{"externalId":"u-100","email":"ops@example.com","roles":["operator"]}
  }'
```

Expected:

- HTTP 200 `{ ok: true, accepted: true, dryRun: true }`
- matching audit event with action `security.scim.user.created`

## 4) Break-glass controls

Enable only with incident process in place:

```bash
SECURITY_BREAK_GLASS_ENABLED=true
SECURITY_BREAK_GLASS_SECRET=<long-random-secret>
```

Emergency owner grant:

```bash
curl -sS -X POST "$API_BASE/admin/security/break-glass/grant-owner" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-break-glass-secret: $SECURITY_BREAK_GLASS_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{
    "userId":"<keycloak-user-id>",
    "incidentId":"INC-2026-03-0086",
    "reason":"Primary owners locked out after IdP outage",
    "confirmEmergency":true,
    "revokeSessions":true
  }'
```

Expected audit action: `security.break_glass.owner_granted`.

## 5) Rotation operations

On each admin client-secret rotation:

1. Rotate in Keycloak
2. Update runtime secret store
3. Set `KEYCLOAK_ADMIN_SECRET_ROTATED_AT=<ISO timestamp>`
4. Restart API
5. Verify `nextRotationDueAt` in `/admin/security/posture`

## 6) Portal password-login flow

Portal sends username/password to API `POST /auth/password-login`.
API exchanges credentials with Keycloak (password grant) using confidential client secret on backend only.
Portal stores short-lived bearer token in session storage and uses normal `Authorization: Bearer ...` for operator routes.

Guardrails:

- login endpoint and bootstrap endpoint are both throttled by auth anomaly controls
- login success/failure and bootstrap events are written to API audit logs (`portal-password-login-*`, `bootstrap-super-admin-*`)
- operator routes accept Clerk JWT (existing) and Keycloak tokens via introspection fallback

## 7) Incident response checks

- Check recent auth throttles / lock patterns via API logs (429 on auth middleware)
- Pull admin audit trail:

```bash
curl -sS "$API_BASE/admin/users/audit?limit=200" -H "Authorization: Bearer $TOKEN" | jq
```

- Confirm any break-glass access has:
  - incident id
  - explicit reason
  - operator trace

## 8) Rollback

If this hardening blocks legitimate traffic:

1. Raise thresholds (`SECURITY_AUTH_FAILURE_MAX_ATTEMPTS`, `SECURITY_SENSITIVE_ACTION_BURST`)
2. Temporarily disable SCIM ingress (`SECURITY_SCIM_ENABLED=false`)
3. Disable break-glass path (`SECURITY_BREAK_GLASS_ENABLED=false`) when not actively required
4. Restart API and re-validate posture endpoint
