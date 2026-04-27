#!/usr/bin/env bash
# remote-stop.sh OCPPID TXID
# Sends RemoteStopTransaction for the given OCPP transaction id.
# Used for F5h step 9.
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 OCPPID TXID" >&2
  exit 2
fi

OCPPID="$1"
TXID="$2"
OCPP_INTERNAL="${OCPP_INTERNAL:-http://127.0.0.1:9001}"

TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "[${TS}] F5h remote-stop: ocppId=${OCPPID} txId=${TXID}" >&2

curl -sS -X POST "${OCPP_INTERNAL}/remote-stop" \
  -H 'content-type: application/json' \
  -d "{\"ocppId\":\"${OCPPID}\",\"transactionId\":${TXID}}"
echo
