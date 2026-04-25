# F5h field-session scripts

Small bash helpers for the F5h 0 A-tolerance field test on 1A32.

**Context:** `tasks/task-0208-f5h-validation-plan.md`, `tasks/task-0208-f5h-operator-checklist.md`.

These are field-session operator tools only. They do NOT touch production code paths and they do NOT exercise Hybrid-B policy logic (flag stays OFF). They exist so the operator can drive raw TxProfile modulation manually while measuring firmware+vehicle response.

## Setup

```bash
export OCPP_INTERNAL="http://127.0.0.1:9001"         # dev OCPP internal HTTP
export DATABASE_URL="postgresql://evcharger:evcharger@localhost:5432/evcharger"
```

For the dev environment these match the defaults in `CLAUDE.md` (docker-compose Postgres + local OCPP server internal port 9001).

## Scripts

| Script | Purpose |
|--------|---------|
| `push-profile.sh OCPPID AMPS` | Push a stackLevel=90 TxProfile with a single 0-period at `AMPS`. Used for steps 2, 4, 6, 8 of the test sequence. |
| `remote-stop.sh OCPPID TXID` | RemoteStopTransaction by OCPP transaction id. Used for step 9. |
| `wait-ready.sh OCPPID` | Poll `/status` until the charger shows connected + recent heartbeat. Used after a reset pre-sweep. |
| `capture-evidence.sh OCPPID SESSIONID [OUTDIR]` | Dumps OcppLog, Session, StatusNotification, and connector-transition rows for the F5h session into a timestamped dir under `tasks/evidence/`. |

## Safety

- These scripts fire live OCPP commands. Do NOT run them against production.
- They assume the charger is the unit-under-test (1A32) with a vehicle physically plugged.
- Abort any test run if the car shows a warning/error on its dashboard.
