# TASK-0088 — Tiered portal authz claims + backend policy matrix

## 1) Claim contract (versioned)

New normalized operator access contract (v1):

```json
{
  "authz": {
    "v": 1,
    "orgId": "org-west",
    "roles": ["operator", "data_analyst"],
    "siteIds": ["site-a", "site-b"],
    "dataScopes": ["limited"]
  }
}
```

Accepted aliases/backward-compatible inputs:
- role claims: `authz.roles`, `roles`, `realm_access.roles`, Clerk `publicMetadata.role/roles`
- org/tenant claims: `authz.orgId`, `orgId`, `tenantId`, `tenant_id`, metadata `orgId/tenantId`
- site grants: `authz.siteIds`, `site_ids`, metadata `siteIds/site_ids`
- data scopes: `authz.dataScopes`, `data_scopes`, metadata `dataScopes`

Data scopes hierarchy:
- `read-only`
- `limited`
- `full`

If no data scope claim is present, backend defaults to `full` for compatibility.

## 2) Backend policy matrix

Implemented in `packages/api/src/lib/policyMatrix.ts` and enforced via `requirePolicy(...)` middleware.

Examples:
- `site.list` → `site:read` + min scope `read-only`
- `site.create` / `site.update` → `site:write` + min scope `full`
- `charger.reset` → `charger:control` + min scope `full` (sensitive)
- `admin.users.write` / `admin.security.breakglass` → `rbac:manage` + min scope `full` (sensitive)

Denied responses now include explicit reasons:

```json
{
  "error": "Forbidden",
  "denyReason": {
    "code": "SITE_OUT_OF_SCOPE",
    "reason": "Site site-x is not in granted siteIds",
    "policy": "site.analytics.read"
  }
}
```

## 3) Keycloak mapper/group/role readiness

Recommended Keycloak token mapper shape:
- Add a client scope/mapper that emits a nested `authz` object:
  - `authz.v` (hardcoded `1`)
  - `authz.orgId` from group attribute (tenant/org)
  - `authz.roles` from realm roles (`operator`, `owner`, etc.)
  - `authz.siteIds` from group/attribute values
  - `authz.dataScopes` from role or group attribute

Minimum compatibility path if nested mapper is not ready:
- emit `realm_access.roles`
- optional flat aliases `tenantId`, `site_ids`, `data_scopes`
- backend parser will normalize these into v1 in request context.

## 4) Migration/backfill strategy

For existing users without new claims:
1. Keep legacy role paths active (`realm_access.roles`, Clerk metadata role/roles).
2. Roll out parser first (already done) with fallback defaults:
   - no `siteIds` => unrestricted (legacy behavior)
   - no `dataScopes` => `full` (legacy behavior)
3. Backfill Keycloak group attributes and mapper output in batches by tenant.
4. Enable tighter site/data-scope governance gradually per tenant.
5. Monitor denyReason telemetry for false positives before enforcing strict scope-only mode.

## 5) Auditability

Sensitive policy allows and all authorization denies are logged with structured context:
- operatorId
- policy key
- deny code/reason
- request path/method
- orgId, roles, siteIds

This is emitted through API logger (`authz-deny`, `authz-sensitive-allow`).

## 6) Rollout checklist

1. Deploy API with parser + policy middleware in compatibility mode.
2. Configure Keycloak mapper for `authz.v1` contract.
3. Backfill tenant/org/site/dataScope attributes.
4. Run smoke tests on:
   - site list/read/update
   - charger reset/register
   - admin user/security routes
5. Verify denyReason payloads and audit logs.
6. After stable period, remove legacy fallback for selected tenants (future toggle).
