# Mobile two-environment simulator workflow (DEV + PROD)

RC is treated as PROD. Only two tracks exist.

## 1) Start local dev services

From repo root:

```bash
npm run dev:stack:start
npm run dev:stack:status
npm run dev:stack:health
```

Expected health targets:
- API: `http://127.0.0.1:3001/health`
- OCPP: `http://127.0.0.1:9000/health`

## 2) Run DEV app in simulator (local services)

```bash
cd packages/mobile
cp .env.dev.example .env.local  # then fill real values
npm run ios
```

Checks in app (Profile tab):
- Environment: `DEV`
- API: `http://127.0.0.1:3001`

## 3) Run PROD app in simulator (production services)

```bash
cd packages/mobile
cp .env.prod.example .env.local  # then fill real values
npm run ios:prod
```

Checks in app (Profile tab):
- Environment: `PROD`
- API: `https://api-production-26cf.up.railway.app`

## 4) EAS builds

```bash
cd packages/mobile
npm run build:dev
npm run build:prod
```

- `build:dev` -> EAS `development` profile, `APP_ENV=dev`
- `build:prod` -> EAS `production` profile, `APP_ENV=prod`

## 5) Ongoing testing rule

Before each test cycle:
1. `npm run dev:stack:health`
2. Confirm Profile tab env + API URL
3. Run test scenario
4. Capture screenshot/log evidence

## 6) Safety guardrails

- Never use prod keys in `.env.dev*`
- Never point `APP_ENV=dev` build to prod API
- Keep dev and prod app installs side-by-side via distinct bundle/package ids
