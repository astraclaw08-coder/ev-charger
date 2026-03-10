# CI/CD Environment Promotion (dev -> prod)

This project now uses branch-based GitHub Environments to automatically select the correct `DATABASE_URL` and related secrets.

## Branch -> Environment mapping

- Push to `dev` -> GitHub Environment: `development`
- Push to `main` -> GitHub Environment: `production`

Workflow: `.github/workflows/cicd-env-promotion.yml`

## Required GitHub Environment secrets

Set these in **both** environments (`development`, `production`) with environment-specific values:

- `DATABASE_URL`
- `CLERK_SECRET_KEY`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `VITE_API_URL`
- `VITE_CLERK_PUBLISHABLE_KEY`
- `EXPO_PUBLIC_API_URL`
- `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`

The secret **names stay the same**, values differ by environment. This is what automatically changes configuration on prod push.

## Safety guard in API startup

API startup now enforces DB safety:

- Requires `DATABASE_URL`
- Reads `APP_ENV` (`development|staging|production|test`)
- Blocks suspicious prod-like DB URLs while running in `development/test`
- Override only intentionally with `ALLOW_PROD_DB_IN_DEV=true`

Code: `packages/api/src/lib/envGuard.ts`

## Recommended deployment hardening

1. Add GitHub Environment protection rules:
   - `production`: required reviewers + wait timer
   - `development`: no reviewer gate (faster)
2. Configure deploy steps (Railway/Vercel) to run after `build-and-validate` job.
3. Keep prod credentials out of repository `.env*` files; store only in GitHub/Railway/Vercel secrets.
