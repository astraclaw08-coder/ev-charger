# API security & identity notes

## Keycloak admin user-management env vars

For `/admin/users` operations, set:

- `KEYCLOAK_BASE_URL` (example: `https://sso.example.com`)
- `KEYCLOAK_REALM` (example: `ev-prod`)
- `KEYCLOAK_ADMIN_CLIENT_ID`
- `KEYCLOAK_ADMIN_CLIENT_SECRET`
- `KEYCLOAK_ASSIGNABLE_ROLES` (optional comma-separated allowlist for role add/remove; default: `owner,operator,customer_support,network_reliability,analyst`)

The API uses client-credentials against `/{realm}/protocol/openid-connect/token`, then calls Keycloak Admin REST endpoints.

## Security hardening controls (TASK-0086)

### 1) MFA baseline policy

Expose posture via `GET /admin/security/posture`:

- `mfa.requiredForRoles` (default: `owner,operator`)
- `mfa.requiredAcrValues` (default: `urn:mace:incommon:iap:silver,phr`)
- `mfa.trustedDeviceDays` (default: `14`)
- `mfa.gracePeriodHours` (default: `24`)

Config env vars:

- `SECURITY_MFA_REQUIRED_ROLES`
- `SECURITY_MFA_REQUIRED_ACR_VALUES`
- `SECURITY_MFA_TRUSTED_DEVICE_DAYS`
- `SECURITY_MFA_GRACE_PERIOD_HOURS`

### 2) SSO readiness (OIDC + SAML)

Posture endpoint includes claim/attribute expectations:

- OIDC required claims: `sub,email,email_verified`
- OIDC role claim paths: `realm_access.roles,resource_access.ev-portal.roles`
- SAML defaults: NameID email format + role attrs (`Role`, `Groups`)

Config env vars:

- `SECURITY_SSO_OIDC_REQUIRED_CLAIMS`
- `SECURITY_SSO_ROLE_CLAIM_PATHS`
- `SECURITY_SSO_SAML_ENABLED`
- `SECURITY_SSO_SAML_NAMEID_FORMAT`
- `SECURITY_SSO_SAML_REQUIRED_ATTRIBUTES`
- `SECURITY_SSO_SAML_ROLE_ATTRIBUTES`

### 3) SCIM provisioning hooks/contracts

Additive ingestion hook for provisioning events:

- `POST /admin/scim/hooks/:eventType`
- Supported `eventType` values:
  - `user.created`
  - `user.updated`
  - `user.deactivated`
  - `group.membership.changed`

Behavior:

- Requires operator auth
- Writes event details to `AdminAuditEvent`
- Does not mutate users directly (safe contract/dry-run first)

Config env vars:

- `SECURITY_SCIM_ENABLED=true` (required)
- `SECURITY_SCIM_DRY_RUN=true|false` (default `true`)
- `SECURITY_SCIM_BASE_PATH` (for posture docs only; default `/admin/scim/hooks`)

### 4) Auth anomaly + rate-limit protections

In-memory protections (additive, no schema changes):

- Failed auth throttling in `requireAuth` + `requireOperator`
- Burst control on sensitive `/admin/users` mutations

Config env vars:

- `SECURITY_AUTH_FAILURE_MAX_ATTEMPTS` (default `8`)
- `SECURITY_AUTH_FAILURE_WINDOW_SECONDS` (default `300`)
- `SECURITY_AUTH_BLOCK_SECONDS` (default `900`)
- `SECURITY_SENSITIVE_ACTION_BURST` (default `30`)
- `SECURITY_SENSITIVE_ACTION_WINDOW_SECONDS` (default `60`)

### 5) Token rotation policy surfaces

Posture endpoint includes policy details:

- `tokenRotation.maxAccessTokenTtlSeconds` (default `900`)
- `tokenRotation.adminClientSecretRotationDays` (default `90`)
- `tokenRotation.signingKeyRotationDays` (default `30`)
- optional last/next rotation timestamps

Config env vars:

- `SECURITY_ACCESS_TOKEN_MAX_TTL_SECONDS`
- `KEYCLOAK_ADMIN_SECRET_ROTATION_DAYS`
- `SECURITY_SIGNING_KEY_ROTATION_DAYS`
- `KEYCLOAK_ADMIN_SECRET_ROTATED_AT` (ISO timestamp)

### 6) Guarded break-glass admin path

Emergency owner grant endpoint:

- `POST /admin/security/break-glass/grant-owner`
- Requires:
  - operator auth
  - `SECURITY_BREAK_GLASS_ENABLED=true`
  - `x-break-glass-secret: <SECURITY_BREAK_GLASS_SECRET>` header
  - body: `userId`, `incidentId`, `reason`, `confirmEmergency=true`

Behavior:

- Adds Keycloak realm role `owner` to target user
- Optionally revokes active sessions (`revokeSessions`, default `true`)
- Always writes audit event `security.break_glass.owner_granted`

### 7) Operational runbook

See `docs/security/KEYCLOAK_SECURITY_RUNBOOK.md` for enablement, validation, and incident response steps.
