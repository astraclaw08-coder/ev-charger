#!/usr/bin/env bash
set -euo pipefail

# Sends watchdog alerts to an arbitrary webhook endpoint.
# Required env vars:
#   ALERT_WEBHOOK_URL
# Optional env vars:
#   ALERT_WEBHOOK_AUTH_HEADER (e.g. "Authorization: Bearer <token>")
#   ALERT_SOURCE (default: ev-watchdog)

MESSAGE="${1:-}"
SEVERITY="${2:-warn}"

if [[ -z "${MESSAGE}" ]]; then
  echo "usage: alert-webhook.sh '<message>' [severity]" >&2
  exit 2
fi

WEBHOOK_URL="${ALERT_WEBHOOK_URL:-}"
if [[ -z "${WEBHOOK_URL}" ]]; then
  echo "ALERT_WEBHOOK_URL must be set" >&2
  exit 2
fi

TS="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
HOST="$(hostname)"
SOURCE="${ALERT_SOURCE:-ev-watchdog}"

payload=$(cat <<JSON
{
  "source": "${SOURCE}",
  "host": "${HOST}",
  "severity": "${SEVERITY}",
  "message": "${MESSAGE}",
  "timestamp": "${TS}"
}
JSON
)

curl_args=(
  --silent
  --show-error
  --fail
  --request POST
  --url "${WEBHOOK_URL}"
  --header "Content-Type: application/json"
  --data "${payload}"
)

if [[ -n "${ALERT_WEBHOOK_AUTH_HEADER:-}" ]]; then
  curl_args+=(--header "${ALERT_WEBHOOK_AUTH_HEADER}")
fi

curl "${curl_args[@]}" >/dev/null

echo "webhook alert sent"
