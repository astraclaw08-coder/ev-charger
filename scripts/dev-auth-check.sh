#!/usr/bin/env bash
# dev-auth-check.sh — Verify local Keycloak is reachable and introspection works.
# Run before mobile testing to catch auth 401s early.
set -euo pipefail

# Load API env
ENV_FILE="${1:-packages/api/.env}"
if [ ! -f "$ENV_FILE" ]; then
  echo "❌ Env file not found: $ENV_FILE"
  exit 1
fi
set -a; source "$ENV_FILE"; set +a

echo "🔍 Dev Auth Preflight Check"
echo "   KEYCLOAK_BASE_URL = ${KEYCLOAK_BASE_URL:-<not set>}"
echo "   KEYCLOAK_REALM    = ${KEYCLOAK_REALM:-<not set>}"
echo "   KEYCLOAK_PORTAL_CLIENT_ID = ${KEYCLOAK_PORTAL_CLIENT_ID:-<not set>}"
echo ""

# 1. Check required env vars
MISSING=()
for VAR in KEYCLOAK_BASE_URL KEYCLOAK_REALM KEYCLOAK_PORTAL_CLIENT_ID KEYCLOAK_PORTAL_CLIENT_SECRET; do
  if [ -z "${!VAR:-}" ]; then
    MISSING+=("$VAR")
  fi
done
if [ ${#MISSING[@]} -gt 0 ]; then
  echo "❌ Missing env vars: ${MISSING[*]}"
  echo "   Set them in $ENV_FILE (same key names as prod, different values)."
  exit 1
fi
echo "✅ Required Keycloak env vars present"

# 2. Check Keycloak reachability
KC_WELL_KNOWN="${KEYCLOAK_BASE_URL}/realms/${KEYCLOAK_REALM}/.well-known/openid-configuration"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 "$KC_WELL_KNOWN" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
  echo "✅ Keycloak reachable at ${KEYCLOAK_BASE_URL} (realm: ${KEYCLOAK_REALM})"
else
  echo "❌ Keycloak unreachable (HTTP $HTTP_CODE)"
  echo "   URL tried: $KC_WELL_KNOWN"
  echo "   Is your local Keycloak running? Try: docker compose up keycloak"
  exit 1
fi

# 3. Check token introspection endpoint responds
INTROSPECT_URL="${KEYCLOAK_BASE_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token/introspect"
INTROSPECT_CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 \
  -X POST "$INTROSPECT_URL" \
  -d "token=dummy" \
  -d "client_id=${KEYCLOAK_PORTAL_CLIENT_ID}" \
  -d "client_secret=${KEYCLOAK_PORTAL_CLIENT_SECRET}" \
  2>/dev/null || echo "000")
if [ "$INTROSPECT_CODE" = "200" ]; then
  echo "✅ Token introspection endpoint responds (client credentials accepted)"
elif [ "$INTROSPECT_CODE" = "401" ]; then
  echo "❌ Introspection returned 401 — client credentials rejected"
  echo "   Check KEYCLOAK_PORTAL_CLIENT_ID / KEYCLOAK_PORTAL_CLIENT_SECRET in $ENV_FILE"
  exit 1
else
  echo "⚠️  Introspection returned HTTP $INTROSPECT_CODE (expected 200)"
  echo "   URL: $INTROSPECT_URL"
  exit 1
fi

echo ""
echo "🟢 Dev auth stack is healthy. Mobile/portal auth should work."
