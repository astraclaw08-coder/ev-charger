# Keycloak Security Hardening Runbook (TASK-0086)

## Scope

This runbook covers MFA baseline, SSO claim mapping readiness, SCIM hook onboarding, auth anomaly controls, token rotation policy tracking, and break-glass handling.

## 1) Prerequisites

Set required Keycloak admin env vars in API runtime:

- `KEYCLOAK_BASE_URL`
- `KEYCLOAK_REALM`
- `KEYCLOAK_ADMIN_CLIENT_ID`
- `KEYCLOAK_ADMIN_CLIENT_SECRET`

Restart API after env updates.

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

## 6) Incident response checks

- Check recent auth throttles / lock patterns via API logs (429 on auth middleware)
- Pull admin audit trail:

```bash
curl -sS "$API_BASE/admin/users/audit?limit=200" -H "Authorization: Bearer $TOKEN" | jq
```

- Confirm any break-glass access has:
  - incident id
  - explicit reason
  - operator trace

## 7) Rollback

If this hardening blocks legitimate traffic:

1. Raise thresholds (`SECURITY_AUTH_FAILURE_MAX_ATTEMPTS`, `SECURITY_SENSITIVE_ACTION_BURST`)
2. Temporarily disable SCIM ingress (`SECURITY_SCIM_ENABLED=false`)
3. Disable break-glass path (`SECURITY_BREAK_GLASS_ENABLED=false`) when not actively required
4. Restart API and re-validate posture endpoint
