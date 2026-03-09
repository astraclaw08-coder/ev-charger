#!/usr/bin/env bash
set -euo pipefail

# TASK-0087 Keycloak cutover smoke checks
# Usage:
#   API_BASE=https://api.example.com \
#   OPERATOR_TOKEN=... \
#   SUPPORT_TOKEN=... \
#   BAD_TOKEN=bad.jwt.here \
#   ./scripts/auth/keycloak-cutover-check.sh

if [[ -z "${API_BASE:-}" ]]; then
  echo "ERROR: API_BASE is required" >&2
  exit 1
fi

if [[ -z "${OPERATOR_TOKEN:-}" ]]; then
  echo "ERROR: OPERATOR_TOKEN is required" >&2
  exit 1
fi

BAD_TOKEN="${BAD_TOKEN:-invalid.token.value}"

pass() { printf "✅ %s\n" "$1"; }
warn() { printf "⚠️  %s\n" "$1"; }
fail() { printf "❌ %s\n" "$1"; exit 1; }

status_code() {
  local method="$1"; shift
  local url="$1"; shift
  curl -sS -o /tmp/task0087-body.$$ -w '%{http_code}' -X "$method" "$url" "$@"
}

check_2xx() {
  local name="$1"; shift
  local code="$1"; shift
  if [[ "$code" =~ ^2 ]]; then
    pass "$name ($code)"
  else
    echo "---- response ----"
    cat /tmp/task0087-body.$$ || true
    echo
    fail "$name expected 2xx got $code"
  fi
}

check_one_of() {
  local name="$1"; shift
  local code="$1"; shift
  local allowed="$1"; shift
  if [[ ",$allowed," == *",$code,"* ]]; then
    pass "$name ($code)"
  else
    echo "---- response ----"
    cat /tmp/task0087-body.$$ || true
    echo
    fail "$name expected one of [$allowed] got $code"
  fi
}

echo "== TASK-0087 Keycloak cutover checks =="
echo "API_BASE=$API_BASE"

# 1) Valid operator token: protected profile endpoint
code=$(status_code GET "$API_BASE/me/profile" -H "Authorization: Bearer $OPERATOR_TOKEN")
check_2xx "Operator token can access /me/profile" "$code"

# 2) Invalid token should fail
code=$(status_code GET "$API_BASE/me/profile" -H "Authorization: Bearer $BAD_TOKEN")
check_one_of "Invalid token rejected" "$code" "401,403"

# 3) Operator should reach admin audit endpoint
code=$(status_code GET "$API_BASE/admin/users/audit?limit=5" -H "Authorization: Bearer $OPERATOR_TOKEN")
check_2xx "Operator can access admin audit endpoint" "$code"

# 4) Lower privilege token should be denied admin endpoint (optional)
if [[ -n "${SUPPORT_TOKEN:-}" ]]; then
  code=$(status_code GET "$API_BASE/admin/users/audit?limit=5" -H "Authorization: Bearer $SUPPORT_TOKEN")
  check_one_of "Support token denied admin endpoint" "$code" "401,403"
else
  warn "SUPPORT_TOKEN not set; skipped low-privilege deny check"
fi

# 5) Security posture endpoint (operator)
code=$(status_code GET "$API_BASE/admin/security/posture" -H "Authorization: Bearer $OPERATOR_TOKEN")
check_2xx "Operator can access security posture endpoint" "$code"

rm -f /tmp/task0087-body.$$ 2>/dev/null || true
pass "All cutover smoke checks passed"
