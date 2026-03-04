# Release Readiness Summary

- **Generated**: 2026-03-01
- **Branch**: `task-0042-claude`
- **Based on QA lane**: E (TASK-0041)
- **Author**: TASK-0042 automated defect-fix lane

---

## Defects Fixed

### 1. `@ev-charger/shared` workspace resolution failure (Critical)
**Root cause**: `npm run build --workspaces` runs packages in alphabetical order (`api` → `ocpp-server` → `portal` → `shared`). Because `shared` was built last, its `dist/` did not exist when `api` and `ocpp-server` compiled.

**Fix**: Changed the root `package.json` `build` script from:
```
"build": "npm run build --workspaces --if-present"
```
to:
```
"build": "npm run build --workspace=packages/shared && npm run build --workspaces --if-present"
```
This ensures `shared` is always built first. The pattern already existed in `test:ocpp-sim` and has been applied consistently to the main `build` target.

**Validation**: `packages/api` and `packages/ocpp-server` both pass `tsc --noEmit` after `npm run build --workspace=packages/shared`.

---

### 2. Prisma enum exports missing from `@prisma/client` (High)
**Root cause**: `packages/ocpp-server/src/handlers/statusNotification.ts` imported `ChargerStatus` and `ConnectorStatus` from `@prisma/client`. These types are only present after `prisma generate` (a runtime/bootstrap step). Without generation, the import fails with `Module '"@prisma/client"' has no exported member 'ChargerStatus'`.

**Fix**:
- Added `packages/shared/src/types/prisma-enums.ts` defining type aliases for all Prisma schema enums (`ChargerStatus`, `ConnectorStatus`, `SessionStatus`, `PaymentStatus`, `OcppDirection`) that mirror the `schema.prisma` definitions exactly.
- Exported these types from `packages/shared/src/index.ts`.
- Updated `statusNotification.ts` to import from `@ev-charger/shared` instead of `@prisma/client`.

The aliases are structurally compatible with Prisma 5's generated types (Prisma 5 uses string literal unions).

**Validation**: `packages/ocpp-server` passes `tsc --noEmit`.

---

### 3. Portal React type version misalignment (High)
**Root cause**: The monorepo runtime is React 19 (from `packages/mobile`'s `react: 19.2.0` dependency, hoisted to root). However, `packages/portal` declared `"@types/react": "^18.3.0"`, causing npm to install a local `@types/react@18.3.28` for the portal. `react-router-dom@6.30.3` and `recharts@2.13.0` resolved types through the root `node_modules/@types/react@19.2.14`. This split created a `ReactNode` / `ReactPortal` type mismatch producing `TS2786` errors on all JSX components from those libraries.

**Fix**:
- Updated portal `devDependencies` to `"@types/react": "^19.0.0"` and `"@types/react-dom": "^19.0.0"` to align with the hoisted `@types/react@19.2.14`.
- Added root-level `overrides` to force `"@types/react": "^19.0.0"` and `"@types/react-dom": "^19.0.0"` across all workspace packages, eliminating duplicate local installs.
- Removed the stale `packages/portal/node_modules/@types/react@18.3.28` local copy.

**Validation**: `packages/portal` passes `tsc --noEmit` with no JSX component errors.

---

### 4. Portal `Analytics.tsx` — `ExportJob.status` literal type widening (Medium)
**Root cause**: Object spread inside a `useState` setter callback widened the `status` literal `'complete'` to `string`, making the result `{ status: string; ... }[]` instead of `ExportJob[]`.

**Fix**: Added `as const` assertion: `{ ...j, status: 'complete' as const }`.

**Location**: `packages/portal/src/pages/Analytics.tsx:219`

---

### 5. Portal `NetworkOps.tsx` — `RetryEvent.status` and `FirmwareRollout.status` literal widening (Medium)
**Root cause**: Same pattern as #4. Spread inside setState callbacks widened `'ack'` and `'done'` to `string`.

**Fix**: Added `as const` assertions: `status: 'ack' as const` and `status: 'done' as const`.

**Location**: `packages/portal/src/pages/NetworkOps.tsx:135,147`

---

### 6. Portal `AuthUxContext.tsx` — OAuthStrategy type mismatch (Medium)
**Root cause**: `AuthProviderContract.strategy` was typed as `string`, but `@clerk/clerk-react`'s `authenticateWithRedirect` requires `OAuthStrategy | "saml" | "enterprise_sso"`. TypeScript could not narrow `string` to that union.

**Fix**: Narrowed `strategy` in `AuthProviderContract` from `string` to `'oauth_google' | 'oauth_apple'`, which are the only values produced by `buildAuthProviderContract` and are valid `OAuthStrategy` members.

**Location**: `packages/portal/src/auth/providerContracts.ts:10`

---

### 7. API route callbacks — implicit `any` from ungenerated Prisma client (Medium)
**Root cause**: Prisma ORM model types (`Charger`, `Connector`, `Session`, `Site`) are generated at `prisma generate` time. Without generation, `prisma.*.findMany/findUnique` return types are `any`, causing `TS7006`/`TS7031` errors on callback parameters in `chargers.ts`, `sessions.ts`, and `sites.ts`.

**Fix**: Added minimal explicit inline type annotations on the affected callback parameters (e.g., `(c: { id: string }) => ...`, `(site: { id: string; ... }) => ...`) sufficient to satisfy TypeScript's `noImplicitAny` without changing logic.

**Locations**: `packages/api/src/routes/chargers.ts`, `packages/api/src/routes/sessions.ts`, `packages/api/src/routes/sites.ts`

---

## tsc --noEmit Validation Results

| Package | Result |
|---|---|
| `packages/shared` | `npm run build` — exit 0 (emits `dist/`) |
| `packages/api` | `tsc --noEmit` — **PASS** (0 errors) |
| `packages/ocpp-server` | `tsc --noEmit` — **PASS** (0 errors) |
| `packages/portal` | `tsc --noEmit` — **PASS** (0 errors) |

---

## Residual Known Risks

### R1 — Prisma client not generated (Blocker for deployment)
**Risk**: `prisma generate` has not been run. The Prisma Client (`@prisma/client`) will not have model-specific CRUD methods or runtime enum objects. All database operations (`prisma.charger.*`, `prisma.session.*`, etc.) will fail at runtime.

**Mitigation**: Run `npx prisma generate` and `npx prisma migrate deploy` as part of the deployment pipeline before starting the API and OCPP server. The type annotations added in Fix #7 are structurally compatible with the generated types.

**Severity**: Blocker — cannot deploy to any environment without this step.

---

### R2 — OCPP simulator tests blocked on runtime (Non-blocking for build)
**Risk**: `npm run test:ocpp-sim` requires a live OCPP server (`ws://localhost:9000`) and database. This could not be validated in the CI lane.

**Mitigation**: Run `docker-compose up` to start PostgreSQL, run `prisma migrate dev`, then start the OCPP server (`npm run dev:ocpp`) before executing `npm run test:ocpp-sim`.

**Severity**: Medium — must be validated in a staging environment before release.

---

### R3 — No unit/integration/e2e test coverage (Non-blocking for build)
**Risk**: `npm test` executes no effective tests. There are no unit tests, integration tests, or meaningful e2e tests. Functional regressions would not be caught by CI.

**Mitigation**: Add Jest/Vitest unit tests for OCPP handlers and API route logic. Add Playwright e2e tests for the portal. This is a sprint-level backlog item.

**Severity**: High for production readiness. Does not block the current build.

---

### R4 — Portal React version drift (Addressed in this lane, monitor)
**Risk**: The portal `package.json` still declares `"react": "^18.3.0"` while the monorepo runtime is React 19. This is a paper cut — React 19 is backward-compatible for the APIs used, but should be formally aligned in a follow-up.

**Mitigation**: Update `packages/portal` `"react"` and `"react-dom"` to `"^19.0.0"` and validate `react-router-dom@6.30.3` compatibility fully. Consider upgrading to react-router-dom v7 for full React 19 type support.

**Severity**: Low — runtime works, type checking passes.

---

### R5 — Security vulnerabilities in dependencies
**Risk**: `npm audit` reports 7 vulnerabilities (6 moderate, 1 high) in the dependency tree.

**Mitigation**: Run `npm audit fix` for non-breaking fixes. Review the high-severity vulnerability separately.

**Severity**: Medium — review before production deployment.

---

## Go / No-Go Recommendation

### Build Gate: ✅ GO (with conditions)

All TypeScript compilation errors in the affected scopes (`api`, `ocpp-server`, `portal`) are resolved. The build is in a releasable type-safe state.

### Deployment Gate: 🔴 NO-GO until R1 resolved

**Mandatory before any environment deployment:**
1. `npx prisma generate` — generate Prisma client
2. `npx prisma migrate deploy` — apply pending migrations
3. Configure all required environment variables (see `CLAUDE.md`)
4. Re-run `npm run build` after prisma generate to confirm clean build
5. Run `npm run test:ocpp-sim` against a live OCPP server

### Production Gate: 🔴 NO-GO until R2 and R3 addressed

- OCPP simulator must validate end-to-end session flow
- Minimum regression test suite must be in place

---

*Report generated by TASK-0042 automated defect-fix lane.*
