# API notes

## Keycloak admin user-management env vars

For `/admin/users` operations, set:

- `KEYCLOAK_BASE_URL` (example: `https://sso.example.com`)
- `KEYCLOAK_REALM` (example: `ev-prod`)
- `KEYCLOAK_ADMIN_CLIENT_ID`
- `KEYCLOAK_ADMIN_CLIENT_SECRET`
- `KEYCLOAK_ASSIGNABLE_ROLES` (optional comma-separated allowlist for role add/remove; default: `owner,operator,customer_support,network_reliability,analyst`)

The API uses client-credentials against `/{realm}/protocol/openid-connect/token`, then calls Keycloak Admin REST endpoints.
