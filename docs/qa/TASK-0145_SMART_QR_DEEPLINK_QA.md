# TASK-0145 — Smart per-charger QR deep link + app-store fallback

## What was implemented

- Public smart-redirect endpoint: `GET /r/charger/:chargerId`
  - Valid charger id required.
  - Builds per-charger deep link: `${EV_APP_DEEP_LINK_SCHEME}://charger/detail/:chargerId`.
  - iOS user-agent fallback → `EV_APP_IOS_APP_STORE_URL`.
  - Android user-agent fallback → `EV_APP_ANDROID_PLAY_STORE_URL`.
  - Android launch strategy uses `intent://...#Intent;scheme=...;package=...;S.browser_fallback_url=...;end`.
  - Includes HTML fallback screen with manual **Open app** and **Get app** buttons.
- Portal charger detail UX now includes **Smart QR Deep Link** card:
  - **Generate** QR (per charger)
  - **Copy Link**
  - **Download QR** PNG
- Config docs/examples updated with required env vars.

## Environment configuration

### API (`deploy/env/api.*.keycloak.env.example`)

- `EV_APP_DEEP_LINK_SCHEME`
- `EV_APP_ANDROID_PACKAGE_NAME`
- `EV_APP_IOS_APP_STORE_URL`
- `EV_APP_ANDROID_PLAY_STORE_URL`
- `EV_APP_DOWNLOAD_WEB_URL`

### Portal (Vite env)

- `VITE_QR_REDIRECT_BASE_URL`
  - Optional override used to generate QR links in portal.
  - Defaults to `VITE_API_URL`.

## QA notes — iOS/Android camera scan flows

> Camera scan behavior is implemented via standard HTTPS QR URL (`/r/charger/:id`) so native camera opens browser first, then the redirect page attempts app open and falls back to store URL.

### iOS manual validation flow

1. Generate charger QR in portal.
2. Scan from iPhone Camera app.
3. Tap camera banner.
4. Expected:
   - If EV app installed: opens `evcharger://charger/detail/:id` (or configured scheme).
   - If not installed: after ~1.4s redirects to `EV_APP_IOS_APP_STORE_URL`.

### Android manual validation flow

1. Generate charger QR in portal.
2. Scan from Android Camera/Google Lens.
3. Open detected link.
4. Expected:
   - If EV app installed: `intent://` launches app directly to charger detail.
   - If not installed: browser fallback redirects to `EV_APP_ANDROID_PLAY_STORE_URL`.

## Build/check evidence

Executed in repo root:

```bash
npm run build --workspace=packages/shared && npm run build --workspace=packages/api && npm run build --workspace=packages/portal
```

Result: ✅ success for shared/api/portal builds.
