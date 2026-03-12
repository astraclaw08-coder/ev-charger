# CI/CD Environment Promotion (dev -> prod)

This project now uses branch-based GitHub Environments to automatically select the correct `DATABASE_URL` and related secrets.

## Branch -> Environment mapping

- Push to `dev` -> GitHub Environment: `development`
- Push to `main` -> GitHub Environment: `production`

Workflow: `.github/workflows/cicd-env-promotion.yml`

## Production portal/mobile version stamp

On pushes to `main` (production environment), CI generates a deterministic app version stamp and injects it into both apps:

- `VITE_APP_VERSION` (portal)
- `EXPO_PUBLIC_APP_VERSION` (mobile)

Stamp format:

- `YYYY.MM.DD.N`
- `YYYY.MM.DD` is the UTC commit date of the pushed production commit.
- `N` is a zero-based same-day index on `main` first-parent history (0 for first prod push that day, 1 for second, etc.).

This gives stable, reproducible versions across reruns for the same commit and supports multiple production pushes in one day.

### Local usage

Generate the expected production stamp for a commit:

```bash
node scripts/prod-version-stamp.cjs --sha <commit-ish> --branch main
```

Validate portal/mobile values against the expected stamp:

```bash
VITE_APP_VERSION=2026.03.11.1 \
EXPO_PUBLIC_APP_VERSION=2026.03.11.1 \
node scripts/check-prod-version-stamp.cjs --sha <commit-ish> --branch main
```

NPM shortcuts:

```bash
npm run version:prod:stamp -- --sha <commit-ish> --branch main
npm run version:prod:check -- --sha <commit-ish> --branch main --portal-version 2026.03.11.1 --mobile-version 2026.03.11.1
```

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
2. Enable hardened Git branch protections for `dev` and `main` (see `docs/git-workflow-hardening.md`).
3. Configure deploy steps (Railway/Vercel) to run after `build-and-validate` job.
4. Keep prod credentials out of repository `.env*` files; store only in GitHub/Railway/Vercel secrets.
