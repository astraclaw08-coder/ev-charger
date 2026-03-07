#!/usr/bin/env bash
set -euo pipefail

REPO="/Users/son/projects/ev-charger"
cd "$REPO"

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; exit 1; }
assert_grep() {
  local pattern="$1" file="$2" label="$3"
  if rg -n "$pattern" "$file" >/dev/null 2>&1; then pass "$label"; else fail "$label"; fi
}

echo "== Phase 1 pricing QC (automated wiring + compile checks) =="

# Compile gates for touched backend services
npm run build --workspace=packages/shared >/dev/null
npm run build --workspace=packages/api >/dev/null
npm run build --workspace=packages/ocpp-server >/dev/null
pass "shared/api/ocpp-server compile"

# Mobile compile gate
(cd packages/mobile && npx tsc --noEmit >/dev/null)
pass "mobile typecheck"

# Wiring assertions
assert_grep "pricingMode\s+String" packages/shared/prisma/schema.prisma "schema has pricingMode"
assert_grep "pricePerKwhUsd\s+Float" packages/shared/prisma/schema.prisma "schema has pricePerKwhUsd"
assert_grep "idleFeePerMinUsd\s+Float" packages/shared/prisma/schema.prisma "schema has idleFeePerMinUsd"
assert_grep "gracePeriodMin\s+Int" packages/shared/prisma/schema.prisma "schema has gracePeriodMin"
assert_grep "touWindows\s+Json\?" packages/shared/prisma/schema.prisma "schema has touWindows"

assert_grep "ratePerKwh:\s*connector\.charger\.site\.pricePerKwhUsd" packages/ocpp-server/src/handlers/startTransaction.ts "OCPP locks session rate from site pricing"

assert_grep "pricingMode" packages/api/src/routes/sites.ts "sites API exposes pricing"
assert_grep "pricePerKwhUsd" packages/api/src/routes/sites.ts "sites API updates pricePerKwhUsd"
assert_grep "touWindows" packages/api/src/routes/sites.ts "sites API updates touWindows"

assert_grep "updateSite\(site\.id, \{" packages/portal/src/pages/SiteDetail.tsx "portal saves tariff via API"
assert_grep "pricingMode: tariff\.mode" packages/portal/src/pages/SiteDetail.tsx "portal sends pricingMode"

assert_grep "ratePerKwh=\{selectedCharger\.site\.pricePerKwhUsd \?\? RATE_PER_KWH\}" packages/mobile/app/charger/\[id\]\.tsx "mobile charger UI shows site-backed rate"
assert_grep "const liveRate = session\.ratePerKwh \?\? RATE_PER_KWH" packages/mobile/app/session/\[id\]\.tsx "mobile live session uses session locked rate"

echo "== QC COMPLETE =="
