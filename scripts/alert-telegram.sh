#!/usr/bin/env bash
set -euo pipefail

# Sends watchdog alerts to Telegram using bot API.
# Required env vars:
#   TELEGRAM_BOT_TOKEN
#   TELEGRAM_CHAT_ID
# Optional env vars:
#   TELEGRAM_API_BASE (default: https://api.telegram.org)
#   TELEGRAM_DISABLE (set to 1/true to no-op)

MESSAGE="${1:-}"
SEVERITY="${2:-warn}"

if [[ -z "${MESSAGE}" ]]; then
  echo "usage: alert-telegram.sh '<message>' [severity]" >&2
  exit 2
fi

if [[ "${TELEGRAM_DISABLE:-}" == "1" || "${TELEGRAM_DISABLE:-}" == "true" ]]; then
  echo "telegram alerts disabled; dropping message"
  exit 0
fi

BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
CHAT_ID="${TELEGRAM_CHAT_ID:-}"
API_BASE="${TELEGRAM_API_BASE:-https://api.telegram.org}"

if [[ -z "${BOT_TOKEN}" || -z "${CHAT_ID}" ]]; then
  echo "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set" >&2
  exit 2
fi

TS="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
HOST="$(hostname)"

if [[ "${SEVERITY}" == "crit" || "${SEVERITY}" == "critical" ]]; then
  ICON="🚨"
else
  ICON="⚠️"
fi

TEXT="${ICON} [${SEVERITY^^}] ev-watchdog@${HOST}\n${MESSAGE}\n${TS}"

curl --silent --show-error --fail \
  --request POST \
  --url "${API_BASE}/bot${BOT_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${CHAT_ID}" \
  --data-urlencode "text=${TEXT}" \
  --data-urlencode "disable_web_page_preview=true" > /dev/null

echo "telegram alert sent"
