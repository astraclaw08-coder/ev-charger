# Mobile app env modes

The app now supports two testing environments:

- `dev` → local/dev services
- `prod` → production services
- `rc` → RC app identity, typically production services unless overridden explicitly

## Runtime env selection

The app config resolves environment from:

1. `APP_ENV` (`dev`, `rc`, or `prod`)
2. fallback: `EAS_BUILD_PROFILE`
3. fallback: `dev`

Dynamic values by env include app name, scheme, iOS bundle id, and Android package id.

## Build profiles

In `eas.json`:

- `development` profile sets `APP_ENV=dev`
- `production` profile sets `APP_ENV=prod`
- `rc` profile can set `APP_ENV=rc` when you want RC app identity

Commands:

```bash
# local simulator (isolated ports + schemes)
npm run ios        # APP_ENV=dev, port 8081, scheme evcharger-dev, API -> http://127.0.0.1:3001 (Debug)
npm run ios:prod   # APP_ENV=prod, port 8083, scheme evcharger (Release -> RC/prod app identity)

# EAS builds
npm run build:dev
npm run build:prod
```

## Required mobile env vars

Set these for each environment (locally or in EAS env):

- `EXPO_PUBLIC_API_URL`
- `GOOGLE_MAPS_API_KEY_IOS`
- `GOOGLE_MAPS_API_KEY_ANDROID`
- `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY` (prod/live payment flow)

Notes:
- Auth is Keycloak-only.
- Keep key names the same across envs; only values change per profile (`development`, `rc`, `production`).

## Verification in app

Profile tab now shows:

- `Version`
- `Environment`
- `API <base-url>`

Use this to confirm dev build is pointed at local services and prod build is pointed at production services.
