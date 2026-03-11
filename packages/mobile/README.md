# Mobile app auth modes

The app supports three auth modes via `EXPO_PUBLIC_AUTH_MODE`:

- `dev` (default when no auth env is set): guest/dev headers flow
- `clerk` (legacy): Clerk session + JWT
- `keycloak` (TASK-0083): native username/password + refresh via API

## Keycloak mode env

Set these in mobile runtime (`.env`, EAS, or Expo config):

- `EXPO_PUBLIC_AUTH_MODE=keycloak`
- `EXPO_PUBLIC_API_URL=https://<api-host>`

And in API runtime (already required for portal password login):

- `KEYCLOAK_BASE_URL`
- `KEYCLOAK_REALM`
- `KEYCLOAK_PORTAL_CLIENT_ID` (or `KEYCLOAK_ADMIN_CLIENT_ID`)
- `KEYCLOAK_PORTAL_CLIENT_SECRET` (or `KEYCLOAK_ADMIN_CLIENT_SECRET`)

## Session lifecycle (keycloak mode)

- Login: `POST /auth/password-login`
- Refresh: `POST /auth/password-refresh`
- Storage: session persisted in `expo-secure-store`
- Startup restore: restored on app boot; expired tokens are refreshed when possible
- Logout: clears secure store session, bearer token, and local favorites cache
