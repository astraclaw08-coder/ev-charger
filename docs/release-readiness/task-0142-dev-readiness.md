# TASK-0142 — Dev Release Readiness (Phase B8 QC Gate)

Date: 2026-03-10 (PDT)
Branch: `dev`
Scope audited: post TASK-0138/0139/0140/0141 changes in portal/mobile read-model gating + OCPP management endpoints.

## Commit scope reviewed
- `35ce565` feat(portal): gate EVC platform business read-model integration
- `301c032` feat(mobile): gate evc read-model history + summary with fallback
- `dbe2cc0` ocpp: add /status live endpoint and /charger-add direct registration
- `077bc10` ocpp: add trigger-message and get-configuration management endpoints

---

## QC Evidence Table

| QC Gate | Evidence (exact command / action) | Result | Notes / Risks |
|---|---|---|---|
| 1) Build/type checks for touched packages | `npm run build --workspace=packages/ocpp-server` | ✅ PASS | TypeScript build passes. |
| 1) Build/type checks for touched packages | `npm run build --workspace=packages/api` | ✅ PASS | TypeScript build passes. |
| 1) Build/type checks for touched packages | `npx tsc -p packages/mobile/tsconfig.json --noEmit` | ✅ PASS | Mobile TS check passes for changed files. |
| 1) Build/type checks for touched packages | `npm run build --workspace=packages/portal` | ❌ FAIL | Pre-existing React type mismatch (React/`@types/react` incompatibility) causes widespread TS2786 failures, not isolated to TASK-0142 files. Blocks clean portal build gate. |
| 2) Runtime UI verification (portal) | Started API + portal dev servers and inspected `/analytics` screen in browser with `VITE_EVC_PLATFORM_BUSINESS_VIEWS=1` | ✅ PASS (portal) | Verified banner, filters, KPI tiles, charts render and app remains stable with read-model flag enabled. |
| 2) Runtime UI verification (mobile) | Attempted Expo runtime: `npx expo start --web --port 19006` and `npx expo start --ios --port 8082 --non-interactive` | ⚠️ BLOCKED | Web support dependency missing (`react-native-web`), iOS non-interactive run blocked by Expo Go version prompt. No full mobile runtime UI proof captured in this run. |
| 3) API/data verification for read-model endpoints | `curl -i -H 'x-dev-operator-id: operator-001' http://127.0.0.1:3001/analytics/portfolio-summary` | ❌ FAIL | Returns 404 (route not present in local API). |
| 3) API/data verification for read-model endpoints | `curl -i -H 'x-dev-operator-id: operator-001' http://127.0.0.1:3001/transactions/enriched` | ❌ FAIL | Returns 404 (route not present in local API). |
| 3) API/data verification for read-model endpoints | `curl -i -H 'x-dev-operator-id: operator-001' http://127.0.0.1:3001/rebates/intervals` | ❌ FAIL | Returns 404 (route not present in local API). |
| 4) Acceptance criteria behavior checks across B5/B6/B7 | Portal read-model feature-flag behavior observed with data fallback characteristics in UI; mobile/session fallback validated by code-path + TS check | ⚠️ PARTIAL | UI gating present in code and portal runtime, but missing read-model backend routes prevent full end-to-end AC validation. |
| 5) Regression spot-check (auth/guest gates, remote controls unchanged) | `curl -i 'http://127.0.0.1:3001/sessions?limit=1&offset=0'` without auth | ✅ PASS | Returns `401 Unauthorized` (guest/auth gate intact). |
| 5) Regression spot-check (remote controls unchanged) | OCPP internal API checks: `/health`, `/status`, `/remote-start`, `/trigger-message`, `/get-configuration` on local server | ✅ PASS | Endpoints respond correctly; disconnected charger behavior remains safe (`Rejected` / explicit error). |
| 6) SCE sample export sanity (or closest extraction) | No explicit SCE exporter found in repo; closest extraction sanity via session payload query: `curl -H 'x-dev-user-id: user-test-driver-001' '/sessions?limit=1&offset=0'` | ⚠️ PARTIAL | Data extraction path works for session/effectiveAmount fields; explicit SCE export artifact/function absent. |
| 7) Rollback notes | See rollback section below | ✅ READY | Fast rollback is feature-flag based and low risk. |

---

## Commands run (chronological)

```bash
npm run build --workspace=packages/portal
npm run build --workspace=packages/ocpp-server
npm run build --workspace=packages/api
npx tsc -p packages/mobile/tsconfig.json --noEmit

npm run dev --workspace=packages/api
curl -H 'x-dev-operator-id: operator-001' http://127.0.0.1:3001/sites
curl -i -H 'x-dev-operator-id: operator-001' 'http://127.0.0.1:3001/analytics/portfolio-summary?limit=1'
curl -i -H 'x-dev-operator-id: operator-001' 'http://127.0.0.1:3001/transactions/enriched?limit=1'
curl -i -H 'x-dev-operator-id: operator-001' 'http://127.0.0.1:3001/rebates/intervals?limit=1'
curl -H 'x-dev-user-id: user-test-driver-001' 'http://127.0.0.1:3001/sessions?limit=1&offset=0'
curl -i 'http://127.0.0.1:3001/sessions?limit=1&offset=0'

npm run dev --workspace=packages/portal -- --host 127.0.0.1 --port 4173
# Browser verification of /analytics page with VITE_EVC_PLATFORM_BUSINESS_VIEWS=1

npm run dev --workspace=packages/ocpp-server
curl http://127.0.0.1:9000/health
curl http://127.0.0.1:9000/status
curl -X POST http://127.0.0.1:9000/remote-start -H 'content-type: application/json' -d '{"ocppId":"TEST-ASTRA-001","connectorId":1,"idTag":"TEST"}'
curl -X POST http://127.0.0.1:9000/trigger-message -H 'content-type: application/json' -d '{"ocppId":"TEST-ASTRA-001","requestedMessage":"Heartbeat"}'
curl -X POST http://127.0.0.1:9000/get-configuration -H 'content-type: application/json' -d '{"ocppId":"TEST-ASTRA-001","key":["MeterValueSampleInterval"]}'

npx expo start --web --port 19006
npx expo start --ios --port 8082 --non-interactive
```

---

## Blockers & workarounds

1. **Portal build gate blocked**
   - Blocker: `packages/portal` has broad TS2786 JSX incompatibility (React type ecosystem mismatch).
   - Workaround: align `react`/`react-dom`/`@types/react` + dependent type packages, then rerun `npm run build --workspace=packages/portal`.

2. **Mobile runtime verification blocked in this run**
   - Blocker A: Expo web path requires `react-native-web` dependency not installed.
   - Blocker B: iOS non-interactive run halted by Expo Go version interactive prompt.
   - Workaround: run interactive iOS launch on host and capture session-screen evidence, or pin Expo Go / use dev client CI-friendly flow.

3. **Read-model API endpoints unavailable in local API**
   - Blocker: `/analytics/portfolio-summary`, `/transactions/enriched`, `/rebates/intervals` return 404.
   - Workaround: deploy/enable corresponding read-model routes/service in API environment or point portal/mobile to environment where these endpoints exist.

---

## Rollback (fast disable)

If rollout needs immediate rollback while preserving core flows:

1. **Portal rollback switch**
   - Set `VITE_EVC_PLATFORM_BUSINESS_VIEWS=0` (or unset) and redeploy portal.
   - Effect: Fleet Analytics falls back to existing site analytics paths; read-model calls disabled.

2. **Mobile rollback switch**
   - Set `EXPO_PUBLIC_EVC_PLATFORM_BUSINESS_VIEWS=0` (or unset) and publish/rebuild app.
   - Effect: Sessions tab uses existing `/sessions` history path only.

3. **Operational safety**
   - OCPP remote management endpoints are additive; no schema rollback required for disabling UI-level read-model usage.

---

## Recommendation

**NO-GO for dev testing with real chargers (at this moment).**

Reason:
- Core read-model endpoints required by flagged portal/mobile integrations are not available in the tested API environment (404).
- Full mobile runtime verification evidence is incomplete due Expo tooling/runtime blockers.
- Portal package-wide type/build gate currently fails.

**Go criteria to flip to GO**
1. Read-model endpoints respond with expected payload fields (`totals`, `transactions[]`, `intervals[]`) in target dev env.
2. Portal build passes cleanly.
3. Mobile sessions flow runtime-verified on simulator/device with flag on/off.
4. Re-run this QC table and capture final green evidence snapshot.
