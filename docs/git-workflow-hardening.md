# Git Workflow Hardening (dev/main)

This repository follows a two-branch GitFlow model:

- `dev`: integration branch for all regular work
- `main`: production branch promoted from `dev`

## Enforced PR policy

CI now enforces branch-source policy for pull requests targeting `dev` or `main`:

- `* -> main` is **allowed only** from:
  - `dev`
  - `hotfix/*`
- `* -> dev` is **allowed only** from:
  - `feature/*`
  - `fix/*`
  - `chore/*`
  - `hotfix/*`
  - `dependabot/*`

Implementation:

- Workflow: `.github/workflows/branch-policy-guard.yml`
- Validator script: `scripts/verify-branch-policy.cjs`

## Branch protection hardening

Use the script below to apply/refresh GitHub branch protection rules for both `dev` and `main`.

```bash
scripts/harden-branch-protections.sh
# or
scripts/harden-branch-protections.sh owner/repo
```

This sets:

- required status checks:
  - `required-checks-always-report`
  - `branch-policy-guard`
  - `Build + validate with env-scoped DATABASE_URL`
- PR-only changes (1 approval, stale review dismissal, code-owner reviews)
- linear history required
- force-push disabled
- branch deletion blocked
- conversation resolution required
- admin enforcement enabled

## Expected developer flow

1. Branch from `dev`: `feature/*`, `fix/*`, or `chore/*`
2. Open PR into `dev`
3. After CI + review, merge to `dev`
4. Promote with PR `dev -> main`
5. Use `hotfix/*` from `main` only for emergency prod fixes
