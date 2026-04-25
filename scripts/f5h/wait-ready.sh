#!/usr/bin/env bash
# wait-ready.sh OCPPID
# Polls /status until the charger reports connected + a heartbeat within 30s.
# Used after a pre-sweep reset.
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 OCPPID" >&2
  exit 2
fi

OCPPID="$1"
OCPP_INTERNAL="${OCPP_INTERNAL:-http://127.0.0.1:9001}"
MAX_SECONDS="${MAX_SECONDS:-120}"

start=$(date +%s)
while :; do
  now=$(date +%s)
  elapsed=$(( now - start ))
  if [[ "${elapsed}" -ge "${MAX_SECONDS}" ]]; then
    echo "[wait-ready] timeout after ${MAX_SECONDS}s waiting for ${OCPPID}" >&2
    exit 1
  fi

  resp=$(curl -sS "${OCPP_INTERNAL}/status?ocppId=${OCPPID}" || true)
  # Heuristic readiness: connected=true AND lastHeartbeatAt within last 30s.
  if echo "${resp}" | grep -q '"connected":true' \
     && echo "${resp}" | grep -q '"lastHeartbeatAt"'; then
    echo "[wait-ready] ${OCPPID} connected + heartbeating after ${elapsed}s"
    echo "${resp}"
    exit 0
  fi

  sleep 3
done
