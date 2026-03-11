# TASK-0143 — Dev/Prod Watchdog Hardening

## Goal
Prevent silent service drops (API, portal, mobile bundler, OCPP) by introducing simple supervision with health checks + auto-restart.

## Dev Supervision (implemented)
A local watchdog now exists at:

- `scripts/dev-supervisor.js`

Supervised services:

- API `:3001` (`npm run dev:api`)
- Portal `:5175` (`npm run dev:portal -- --host 127.0.0.1 --port 5175`)
- Mobile bundler `:8082` (`npm run dev:mobile -- --port 8082`)
- OCPP `:9000` (`npm run dev:ocpp`)

Health probes:

- API: `GET http://127.0.0.1:3001/health` and DB sanity token (`"db":"ok"`)
- Portal: TCP reachability on `127.0.0.1:5175`
- Mobile bundler: TCP reachability on `127.0.0.1:8082`
- OCPP: `GET http://127.0.0.1:9000/health`

Behavior:

- Spawns all services and monitors every 5s
- Auto-restarts crashed services
- Auto-restarts unhealthy services
- Writes concise runtime logs to `logs/dev-supervisor.log`
- Writes state snapshots to `.runtime/dev-supervisor-state.json`

## Operator Commands
From repo root:

- Start all supervised services:
  - `npm run watchdog:start`
- Status check:
  - `npm run watchdog:status`
- Restart failed services:
  - `npm run watchdog:restart-failed`
- Restart one service:
  - `node scripts/dev-supervisor.js restart api`
  - `node scripts/dev-supervisor.js restart portal`
  - `node scripts/dev-supervisor.js restart mobile`
  - `node scripts/dev-supervisor.js restart ocpp`
- Stop supervisor:
  - `npm run watchdog:stop`

## Production-Oriented Architecture Notes
For production, keep two layers:

### 1) Host-level Supervisor (required)
Use a process supervisor that restarts on crash/reboot and captures logs:

- Recommended: `systemd` (Linux) or equivalent host supervisor
- Configure:
  - `Restart=always`
  - `RestartSec=2`
  - sane start limits (avoid flapping storms)
  - per-service stdout/stderr log routing

### 2) App-level Health Probes (required)
Expose and monitor endpoint-level readiness/liveness:

- API: `/health` includes DB sanity (`SELECT 1`)
- OCPP: `/health`
- Portal: reachable HTTP/TCP
- Mobile bundler (dev): reachable TCP

### Alerting
Hook health failures / restart loops into alerting (Slack/PagerDuty/etc). The important part is **detect + restart + alert**.

### Production-ready artifacts (implemented)
- Systemd templates: `deploy/systemd/ev-*.service.template`
- Health monitor: `scripts/prod-health-monitor.js`
- Telegram alert script: `scripts/alert-telegram.sh`
- Generic webhook alert script: `scripts/alert-webhook.sh`
- Env template: `deploy/env/watchdog.env.example`
- Rollout docs: `docs/watchdog-production-rollout.md`

### Why this layout
- Host supervisor handles process lifecycle resiliency
- App probes detect dependency-level failures (process alive but unhealthy)
- Together they prevent silent downtime
