# Mobile app env modes

The app now supports two testing environments:

- `dev` → local/dev services
- `prod` → production services (RC treated as prod)

## Runtime env selection

The app config resolves environment from:

1. `APP_ENV` (`dev` or `prod`)
2. fallback: `EAS_BUILD_PROFILE`
3. fallback: `dev`

Dynamic values by env include app name, scheme, iOS bundle id, and Android package id.

## Build profiles

In `eas.json`:

- `development` profile sets `APP_ENV=dev`
- `production` profile sets `APP_ENV=prod`

Commands:

```bash
# local simulator (isolated ports + schemes)
npm run ios        # APP_ENV=dev, port 8081, scheme evcharger-dev (Debug)
npm run ios:prod   # APP_ENV=prod, port 8083, scheme evcharger (Release -> RC/prod app identity)

# EAS builds
npm run build:dev
npm run build:prod
```

## Required mobile env vars

Set these for each environment (locally or in EAS env):

- `EXPO_PUBLIC_API_URL_DEV` (dev only)
- `EXPO_PUBLIC_API_URL_PROD` (optional override; defaults to prod Railway API)
- `EXPO_PUBLIC_MAPBOX_TOKEN`
- `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY` (prod/live payment flow)

Notes:
- Auth mode is now hard-separated by app env: `dev -> dev auth`, `prod -> keycloak`.
- `EXPO_PUBLIC_AUTH_MODE` is no longer used for normal env selection.

## Verification in app

Profile tab now shows:

- `Version`
- `Environment`
- `API <base-url>`

Use this to confirm dev build is pointed at local services and prod build is pointed at production services.
