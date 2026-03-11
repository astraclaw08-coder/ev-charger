# Production Watchdog Rollout Guide

This guide turns TASK-0143 watchdog hardening into directly deployable production artifacts.

## Artifacts Added

- `deploy/systemd/ev-api.service.template`
- `deploy/systemd/ev-ocpp.service.template`
- `deploy/systemd/ev-portal.service.template` (optional)
- `deploy/systemd/ev-watchdog-monitor.service.template`
- `scripts/prod-health-monitor.js`
- `scripts/alert-telegram.sh`

## 1) Prepare environment

Create an environment file for systemd units, for example:

```bash
sudo install -d -m 0755 /etc/ev-charger
sudo tee /etc/ev-charger/ev-charger.env >/dev/null <<'EOF'
NODE_ENV=production
WATCHDOG_INTERVAL_MS=10000
WATCHDOG_RESTART_WINDOW_MS=600000
WATCHDOG_RESTART_MAX=4
WATCHDOG_RESTART_COOLDOWN_MS=30000
WATCHDOG_ALERT_COMMAND=/opt/ev-charger/scripts/alert-telegram.sh
# Optional generic webhook alert sink
# WATCHDOG_ALERT_WEBHOOK_URL=https://hooks.example.com/ev-watchdog

# Telegram alert integration
TELEGRAM_BOT_TOKEN=123456:replace-me
TELEGRAM_CHAT_ID=-1001234567890
# Optional override
# TELEGRAM_API_BASE=https://api.telegram.org

# Optional portal monitoring
WATCHDOG_ENABLE_PORTAL=true
EOF
```

## 2) Install systemd units

1. Copy templates and replace placeholders:
   - `{{APP_USER}}` -> runtime Linux user (for example `evsvc`)
   - `{{APP_GROUP}}` -> runtime group
   - `{{APP_ROOT}}` -> absolute repo/deploy path (for example `/opt/ev-charger`)
   - `{{ENV_FILE}}` -> env file path (for example `/etc/ev-charger/ev-charger.env`)

2. Install units:

```bash
sudo cp deploy/systemd/ev-*.service.template /etc/systemd/system/
for f in /etc/systemd/system/ev-*.service.template; do
  sudo mv "$f" "${f%.template}"
done

# Edit files to replace placeholders
sudo sed -i 's#{{APP_USER}}#evsvc#g' /etc/systemd/system/ev-*.service
sudo sed -i 's#{{APP_GROUP}}#evsvc#g' /etc/systemd/system/ev-*.service
sudo sed -i 's#{{APP_ROOT}}#/opt/ev-charger#g' /etc/systemd/system/ev-*.service
sudo sed -i 's#{{ENV_FILE}}#/etc/ev-charger/ev-charger.env#g' /etc/systemd/system/ev-*.service

sudo systemctl daemon-reload
```

## 3) Enable + start

Recommended order:

```bash
sudo systemctl enable --now ev-api.service ev-ocpp.service
# Optional if portal is served by local preview/static process:
sudo systemctl enable --now ev-portal.service
sudo systemctl enable --now ev-watchdog-monitor.service
```

## 4) Validate (functional + resiliency)

### Baseline

```bash
systemctl status ev-api.service ev-ocpp.service ev-watchdog-monitor.service --no-pager
curl -fsS http://127.0.0.1:3001/health
curl -fsS http://127.0.0.1:9000/health
```

If portal is enabled:

```bash
curl -I http://127.0.0.1:4175/
```

### Restart behavior

```bash
# Simulate process kill; systemd should restore service
sudo systemctl kill -s SIGKILL ev-api.service
sleep 3
systemctl is-active ev-api.service
```

### Watchdog restart + alert behavior

Dry-run monitor command (no restart side effects):

```bash
WATCHDOG_DRY_RUN=true node scripts/prod-health-monitor.js
```

Live monitor logs:

```bash
journalctl -u ev-watchdog-monitor.service -f
```

Send explicit test alert:

```bash
TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... scripts/alert-telegram.sh "watchdog test alert" warn
```

## 5) Rollback

If rollout causes instability:

```bash
sudo systemctl disable --now ev-watchdog-monitor.service
sudo systemctl disable --now ev-portal.service  # only if enabled
# Keep API/OCPP running under existing process manager if needed
# or disable them too if reverting fully:
# sudo systemctl disable --now ev-api.service ev-ocpp.service
```

To fully remove deployed units:

```bash
sudo rm -f /etc/systemd/system/ev-api.service \
  /etc/systemd/system/ev-ocpp.service \
  /etc/systemd/system/ev-portal.service \
  /etc/systemd/system/ev-watchdog-monitor.service
sudo systemctl daemon-reload
```

## 6) Operational notes

- Restart-loop detection triggers a **critical alert** when restart budget is exhausted.
- `WATCHDOG_ALERT_COMMAND` is expected to accept:
  - arg1: message
  - arg2: severity (`warn` or `critical`)
- You can use only webhook alerting, only command alerting, or both.
