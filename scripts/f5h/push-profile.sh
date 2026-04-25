#!/usr/bin/env bash
# push-profile.sh OCPPID AMPS
# Pushes a stackLevel=90 TxProfile with a single period at AMPS (chargingRateUnit=A).
# Used for F5h steps 2/4/6/8 (0 A, max, 0 A, 16 A).
#
# Not for production use. Field-session only.
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 OCPPID AMPS" >&2
  exit 2
fi

OCPPID="$1"
AMPS="$2"
OCPP_INTERNAL="${OCPP_INTERNAL:-http://127.0.0.1:9001}"

# A random positive int32 profile id keeps concurrent pushes from colliding with
# a stale cached profile. connectorId=0 = applies to all connectors; adjust if
# the unit-under-test has > 1 connector and you want per-connector targeting.
PROFILE_ID=$(( ( RANDOM << 15 ) | RANDOM ))

PROFILE_JSON=$(cat <<EOF
{
  "ocppId": "${OCPPID}",
  "profile": {
    "connectorId": 0,
    "csChargingProfiles": {
      "chargingProfileId": ${PROFILE_ID},
      "stackLevel": 90,
      "chargingProfilePurpose": "TxProfile",
      "chargingProfileKind": "Absolute",
      "chargingSchedule": {
        "chargingRateUnit": "A",
        "chargingSchedulePeriod": [
          { "startPeriod": 0, "limit": ${AMPS} }
        ]
      }
    }
  }
}
EOF
)

TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "[${TS}] F5h push: ocppId=${OCPPID} amps=${AMPS} profileId=${PROFILE_ID}" >&2

curl -sS -X POST "${OCPP_INTERNAL}/set-charging-profile" \
  -H 'content-type: application/json' \
  -d "${PROFILE_JSON}" \
  | tee -a "tasks/evidence/f5h-$(date -u +%Y%m%d)-push-log.jsonl"
echo
