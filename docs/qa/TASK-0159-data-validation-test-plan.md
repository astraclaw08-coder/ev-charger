# TASK-0159 Data Validation Test Plan + Execution Evidence

Date: 2026-03-13
Repo: `~/projects/ev-charger`
Scope: favorites persistence, profile/payment validation, user-scoped transaction history

## Test objectives
1. Verify favorites are persisted server-side and CRUD works per user.
2. Verify profile validation rejects malformed PII fields.
3. Verify payment profile input rejects PAN/CVV-like sensitive card data.
4. Verify `/me/transactions/enriched` route is authenticated/user-scoped and returns expected shape.

## Preconditions
- Applied migration: `20260313103000_task_0159_user_favorites`
- Test API instance launched with `APP_ENV=development` on `127.0.0.1:3101`
- Auth path for local validation: `x-dev-user-id: user-test-driver-001`

## Test matrix and outcomes

### A) Favorites persistence
- `PUT /me/favorites` with one charger id -> **200**
- `GET /me/favorites` -> **200** with expected charger id present
- `DELETE /me/favorites/:chargerId` -> **200**
- `GET /me/favorites` -> **200** with empty set

Observed:
- `fav_get1 { chargerIds: [ 'charger-003' ] }`
- `fav_get2 { chargerIds: [] }`

### B) Profile validation
- Invalid zip (`ABC`) via `PUT /me/profile` -> **400**
  - Error: `Zip code must be 5 digits or ZIP+4 format`
- Valid payload via `PUT /me/profile` -> **200**
  - Observed normalization: `homeState` transformed to `CA`

Observed subset:
- `{ name: 'Test Driver QA', email: 'driver@example.com', homeState: 'CA', homeZipCode: '90210' }`

### C) Payment reference hardening
- PAN-like input (`4242 4242 4242 4242`) via `PUT /me/profile` -> **400**
  - Error: `Payment method reference must not contain card PAN/CVV data`

### D) Transactions route
- `GET /me/transactions/enriched?limit=5` -> **200**
- Shape check -> `{ total, limit, offset, transactions[] }` confirmed

Observed shape:
- `{ total: 26, limit: 5, offset: 0, hasTransactions: true }`

## Build/type checks
- Shared build completed (`packages/shared`)
- API/mobile type checks were previously completed in task implementation cycle

## Notes
- Earlier failure (`relation "UserFavoriteCharger" does not exist`) was resolved by applying migration.
- Validation executed against local dev API instance to isolate auth mode and avoid production side effects.
