# Prod Health Monitor

Single deterministic production monitor for the EV charger stack.

## Purpose

Replace overlapping agentic watchdogs with one low-cost monitor that:
- polls a fixed set of prod endpoints
- stores state locally in `state/prod-health-monitor.json`
- sends Telegram only on material transitions
- pings a dead-man's switch every successful run
- reserves GPT use for human escalation, not routine polling

## Canonical monitored surfaces

1. `https://ocpp-server-fresh-production.up.railway.app/health`
2. `https://api-production-26cf.up.railway.app/health`
3. `https://portal.lumeopower.com`
4. `https://keycloak-live-production.up.railway.app/realms/ev-charger-prod/.well-known/openid-configuration`
5. `https://api-production-26cf.up.railway.app/chargers/1A32-1-2010-00008/status`

## Charger health contract

Charger health is sourced from the existing operator route:

- path: `/chargers/:id`
- prod URL used by monitor: `/chargers/1A32-1-2010-00008`
- auth: none
- freshness field: `lastHeartbeat`
- freshness threshold: 20 minutes
- identity guard: response must include `ocppId = 1A32-1-2010-00008`

This avoids runtime discovery and uses an existing prod API surface.

## Required env vars

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `PROD_HEALTHCHECKS_PING_URL`

Optional:

- `PROD_HEALTHCHECKS_FAIL_SUFFIX` (default monitor behavior appends `/fail` on fatal run failure if set via config env name)
- `PROD_HEALTH_ESCALATION_MODEL` (default `openai-codex/gpt-5.4`)
- `PROD_HEALTH_INTERVAL_MINUTES`
- `PROD_HEALTH_TIMEOUT_MS`
- `PROD_HEALTH_FAILURE_THRESHOLD`
- `PROD_HEALTH_RECOVERY_THRESHOLD`
- `PROD_HEALTH_ALERT_COOLDOWN_MINUTES`
- `PROD_HEALTH_LOCK_STALE_MINUTES`

## Lock behavior

Lock file: `state/prod-health-monitor.lock`

Rules:
- create with exclusive open at run start
- if lock exists and is younger than 30 minutes, exit non-zero without running probes
- if lock exists and is older than 30 minutes, replace it as stale and continue
- always remove lock on normal exit

## Alert behavior

Down alerts fire only when:
- a check fails for `failureThreshold` consecutive runs, and
- either no previous alert was sent for the same fingerprint or cooldown expired

Recovery alerts fire when:
- a previously failing check becomes healthy and satisfies `recoveryThreshold`

Cooldown default: 120 minutes.

## Dead-man's switch

Day-one scope, required.

Provider contract:
- ping URL comes from `PROD_HEALTHCHECKS_PING_URL`
- monitor sends a success ping after every completed run
- on fatal monitor failure it attempts the configured fail path

Recommended provider: Healthchecks.io or any equivalent URL-based dead-man service.

## GPT usage policy

Routine polling uses no LLM.

Escalation model is pinned to:
- `openai-codex/gpt-5.4`

That model is reserved for future human-facing incident summaries or triage prompts, not for probe execution.

## Rollout and verification gate

Before disabling old cron jobs, verification means all of the following:

1. New monitor runs successfully for at least 24 hours.
2. Dead-man pings are observed for every expected interval in that window.
3. No duplicate Telegram alerts are emitted during stable healthy periods.
4. One forced failure test produces exactly one down alert and one recovery alert.
5. Charger heartbeat check proves stale detection works by threshold logic, not by transport errors alone.

Only after that should the legacy watchdog crons be disabled.

## Legacy jobs to retire after verification

- `prod_services_watchdog_15m`
- `Overnight_OCPP_RP_Watch`
