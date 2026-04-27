#!/usr/bin/env bash
# capture-evidence.sh OCPPID SESSIONID [OUTDIR]
#
# Dumps F5h field-test evidence to a timestamped directory. Run post-test,
# before leaving the site, while the server + DB are still reachable.
#
# Outputs (all newline-delimited JSON where possible):
#   session.json              — the Session row
#   session-billing.json      — the SessionBillingSnapshot row if present
#   charger.json              — the Charger row (stackLevel hint, password
#                               redacted)
#   ocpp-log.jsonl            — full OcppLog rows for the charger scoped to
#                               the session time window
#   connector-transitions.jsonl — ConnectorStateTransition rows (charger
#                               state timeline)
#   meter-values.jsonl        — MeterValues filtered from OcppLog
#   profile-pushes.jsonl      — SetChargingProfile CALL rows from OcppLog
#   summary.md                — human-readable session overview (start/stop,
#                               meter, kWh, status-transition count, profile
#                               push count)
#
# Requires: psql + env DATABASE_URL
#
# This script ONLY reads. It makes no writes, no deletions, and touches no
# live chargers.
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 OCPPID SESSIONID [OUTDIR]" >&2
  exit 2
fi

OCPPID="$1"
SESSIONID="$2"
: "${DATABASE_URL:?DATABASE_URL must be set}"

DATE_STAMP=$(date -u +%Y%m%d-%H%M%S)
OUTDIR="${3:-tasks/evidence/f5h-${DATE_STAMP}-${OCPPID}}"
mkdir -p "${OUTDIR}"

echo "[capture] ocppId=${OCPPID} sessionId=${SESSIONID}" >&2
echo "[capture] outdir=${OUTDIR}" >&2

# Helper: run a single-statement psql query, emit raw output.
pq() {
  psql "${DATABASE_URL}" -AtX -v ON_ERROR_STOP=1 -c "$1"
}

# ---- 1. Session row ----
pq "SELECT row_to_json(s) FROM \"Session\" s WHERE id = '${SESSIONID}';" \
  > "${OUTDIR}/session.json"

# ---- 2. Session billing snapshot (if exists) ----
pq "SELECT COALESCE(row_to_json(b), '{}'::json)
    FROM \"SessionBillingSnapshot\" b WHERE \"sessionId\" = '${SESSIONID}';" \
  > "${OUTDIR}/session-billing.json" || true

# ---- 3. Charger (redact password) ----
pq "SELECT row_to_json(c) FROM (
      SELECT id, \"ocppId\", status, \"lastBootAt\", \"lastHeartbeatAt\",
             \"firmwareVersion\", \"vendor\", \"model\", \"smartChargingState\"
      FROM \"Charger\" WHERE \"ocppId\" = '${OCPPID}'
    ) c;" \
  > "${OUTDIR}/charger.json"

# ---- 4. OcppLog scoped to the session's time window (± 60s slack) ----
pq "
SELECT row_to_json(l) FROM \"OcppLog\" l
  JOIN \"Charger\" c ON c.id = l.\"chargerId\"
 WHERE c.\"ocppId\" = '${OCPPID}'
   AND l.\"createdAt\" >= (
     SELECT \"createdAt\" - INTERVAL '60 seconds'
     FROM \"Session\" WHERE id = '${SESSIONID}'
   )
   AND l.\"createdAt\" <= COALESCE(
     (SELECT \"completedAt\" + INTERVAL '60 seconds'
      FROM \"Session\" WHERE id = '${SESSIONID}'),
     NOW()
   )
 ORDER BY l.\"createdAt\" ASC;
" > "${OUTDIR}/ocpp-log.jsonl"

# ---- 5. ConnectorStateTransition timeline ----
pq "
SELECT row_to_json(t) FROM \"ConnectorStateTransition\" t
  JOIN \"Charger\" c ON c.id = t.\"chargerId\"
 WHERE c.\"ocppId\" = '${OCPPID}'
   AND t.\"occurredAt\" >= (
     SELECT \"createdAt\" - INTERVAL '60 seconds'
     FROM \"Session\" WHERE id = '${SESSIONID}'
   )
   AND t.\"occurredAt\" <= COALESCE(
     (SELECT \"completedAt\" + INTERVAL '60 seconds'
      FROM \"Session\" WHERE id = '${SESSIONID}'),
     NOW()
   )
 ORDER BY t.\"occurredAt\" ASC;
" > "${OUTDIR}/connector-transitions.jsonl"

# ---- 6. MeterValues slice of OcppLog ----
grep -i '"MeterValues"' "${OUTDIR}/ocpp-log.jsonl" > "${OUTDIR}/meter-values.jsonl" || true

# ---- 7. SetChargingProfile slice of OcppLog ----
grep -i '"SetChargingProfile"' "${OUTDIR}/ocpp-log.jsonl" > "${OUTDIR}/profile-pushes.jsonl" || true

# ---- 8. Human-readable summary ----
LOG_COUNT=$(wc -l < "${OUTDIR}/ocpp-log.jsonl" | tr -d ' ')
TRANS_COUNT=$(wc -l < "${OUTDIR}/connector-transitions.jsonl" | tr -d ' ')
MV_COUNT=$(wc -l < "${OUTDIR}/meter-values.jsonl" | tr -d ' ')
PP_COUNT=$(wc -l < "${OUTDIR}/profile-pushes.jsonl" | tr -d ' ')

cat > "${OUTDIR}/summary.md" <<EOF
# F5h evidence — ${OCPPID} — ${DATE_STAMP}

- **Session id:** \`${SESSIONID}\`
- **Charger:** \`${OCPPID}\`
- **Captured at (UTC):** ${DATE_STAMP}

## Counts
- OcppLog rows: ${LOG_COUNT}
- ConnectorStateTransition rows: ${TRANS_COUNT}
- MeterValues frames: ${MV_COUNT}
- SetChargingProfile pushes: ${PP_COUNT}

## Files
- \`session.json\` — Session row
- \`session-billing.json\` — SessionBillingSnapshot row (may be empty)
- \`charger.json\` — Charger row (password redacted)
- \`ocpp-log.jsonl\` — full OCPP message log for the session window
- \`connector-transitions.jsonl\` — connector-state timeline
- \`meter-values.jsonl\` — MeterValues frames only
- \`profile-pushes.jsonl\` — SetChargingProfile CALLs only

## Next step
Attach a short narrative to \`tasks/task-0208-f5-server-gate-firmware-check.md\`
under a new "F5h — result" section, referencing this directory.
EOF

echo "[capture] done: ${OUTDIR}" >&2
ls -la "${OUTDIR}"
