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
# local simulator
npm run ios        # APP_ENV=dev
npm run ios:prod   # APP_ENV=prod

# EAS builds
npm run build:dev
npm run build:prod
```

## Required mobile env vars

Set these for each environment (locally or in EAS env):

- `EXPO_PUBLIC_API_URL`
- `EXPO_PUBLIC_AUTH_MODE`
- `EXPO_PUBLIC_MAPBOX_TOKEN`
- `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY` (recommended; required for live payment flow)

Optional:

- `EXPO_PUBLIC_ENV_LABEL` (defaults to `DEV`/`PROD`)

## Verification in app

Profile tab now shows:

- `Version`
- `Environment`
- `API <base-url>`

Use this to confirm dev build is pointed at local services and prod build is pointed at production services.
