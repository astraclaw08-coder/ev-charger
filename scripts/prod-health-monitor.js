#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RUNTIME_DIR = path.join(ROOT, '.runtime');
const LOG_DIR = path.join(ROOT, 'logs');
const STATE_FILE = path.join(RUNTIME_DIR, 'prod-health-monitor-state.json');
const LOG_FILE = path.join(LOG_DIR, 'prod-health-monitor.log');

const HEALTH_INTERVAL_MS = Number(process.env.WATCHDOG_INTERVAL_MS || 10000);
const HEALTH_TIMEOUT_MS = Number(process.env.WATCHDOG_HTTP_TIMEOUT_MS || 3000);
const RESTART_WINDOW_MS = Number(process.env.WATCHDOG_RESTART_WINDOW_MS || 10 * 60 * 1000);
const RESTART_MAX_IN_WINDOW = Number(process.env.WATCHDOG_RESTART_MAX || 4);
const RESTART_COOLDOWN_MS = Number(process.env.WATCHDOG_RESTART_COOLDOWN_MS || 30 * 1000);
const ALERT_COMMAND = process.env.WATCHDOG_ALERT_COMMAND || '';
const ALERT_WEBHOOK_URL = process.env.WATCHDOG_ALERT_WEBHOOK_URL || '';
const DRY_RUN = /^(1|true|yes)$/i.test(process.env.WATCHDOG_DRY_RUN || '');

const SERVICES = {
  api: {
    systemdUnit: process.env.WATCHDOG_API_UNIT || 'ev-api.service',
    probes: [{ type: 'http', url: process.env.WATCHDOG_API_HEALTH_URL || 'http://127.0.0.1:3001/health', expect: ['"status":"ok"', '"db":"ok"'] }],
  },
  ocpp: {
    systemdUnit: process.env.WATCHDOG_OCPP_UNIT || 'ev-ocpp.service',
    probes: [{ type: 'http', url: process.env.WATCHDOG_OCPP_HEALTH_URL || 'http://127.0.0.1:9000/health', expect: ['"status":"ok"'] }],
  },
};

if ((process.env.WATCHDOG_ENABLE_PORTAL || '').toLowerCase() === 'true') {
  SERVICES.portal = {
    systemdUnit: process.env.WATCHDOG_PORTAL_UNIT || 'ev-portal.service',
    probes: [{ type: 'http', url: process.env.WATCHDOG_PORTAL_HEALTH_URL || 'http://127.0.0.1:4175/', expect: [] }],
  };
}

function ensureDirs() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function log(msg) {
  const line = `[${nowIso()}] ${msg}`;
  fs.appendFileSync(LOG_FILE, `${line}\n`);
  console.log(line);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { services: {} };
  }
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ ...state, ts: nowIso() }, null, 2));
}

function httpGet(url, timeoutMs) {
  const client = url.startsWith('https://') ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk.toString('utf8'); });
      res.on('end', () => resolve({ statusCode: res.statusCode || 0, body }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`timeout ${timeoutMs}ms`));
    });
  });
}

async function probeService(name, service) {
  for (const probe of service.probes) {
    try {
      if (probe.type !== 'http') return { ok: false, detail: `unsupported probe type: ${probe.type}` };
      const res = await httpGet(probe.url, HEALTH_TIMEOUT_MS);
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return { ok: false, detail: `http ${res.statusCode} from ${probe.url}` };
      }
      for (const token of probe.expect || []) {
        if (!res.body.includes(token)) {
          return { ok: false, detail: `missing token ${token} from ${probe.url}` };
        }
      }
    } catch (error) {
      return { ok: false, detail: `${probe.url}: ${error.message}` };
    }
  }
  return { ok: true, detail: 'ok' };
}

function runExecFile(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 15000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${command} ${args.join(' ')} failed: ${stderr || error.message}`));
        return;
      }
      resolve((stdout || '').trim());
    });
  });
}

async function restartUnit(serviceName, unitName, reason) {
  if (DRY_RUN) {
    log(`[dry-run] restart ${serviceName} (${unitName}) reason=${reason}`);
    return;
  }
  await runExecFile('systemctl', ['restart', unitName]);
  log(`restarted ${serviceName} (${unitName}) reason=${reason}`);
}

async function postWebhook(event) {
  if (!ALERT_WEBHOOK_URL) return;

  const payload = JSON.stringify(event);
  const url = new URL(ALERT_WEBHOOK_URL);
  const client = url.protocol === 'https:' ? https : http;

  await new Promise((resolve, reject) => {
    const req = client.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
      timeout: 5000,
    }, (res) => {
      if ((res.statusCode || 500) >= 400) {
        reject(new Error(`webhook status=${res.statusCode}`));
        return;
      }
      resolve();
    });

    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('webhook timeout')));
    req.write(payload);
    req.end();
  });
}

async function runAlert(event) {
  const message = `${event.kind}: ${event.service} - ${event.detail}`;

  if (ALERT_COMMAND) {
    try {
      const args = [message, event.severity || 'warn'];
      if (DRY_RUN) {
        log(`[dry-run] alert command: ${ALERT_COMMAND} ${args.join(' ')}`);
      } else {
        const [cmd, ...baseArgs] = ALERT_COMMAND.split(' ');
        await runExecFile(cmd, [...baseArgs, ...args]);
      }
    } catch (error) {
      log(`alert command failed: ${error.message}`);
    }
  }

  try {
    await postWebhook(event);
  } catch (error) {
    log(`alert webhook failed: ${error.message}`);
  }
}

function cleanupOldRestartTimestamps(serviceState, nowMs) {
  serviceState.restartTimestamps = (serviceState.restartTimestamps || []).filter((t) => nowMs - t <= RESTART_WINDOW_MS);
}

async function monitorLoop() {
  ensureDirs();
  log('prod-health-monitor started');
  log(`config interval=${HEALTH_INTERVAL_MS}ms timeout=${HEALTH_TIMEOUT_MS}ms restartWindow=${RESTART_WINDOW_MS}ms restartMax=${RESTART_MAX_IN_WINDOW}`);

  const state = readState();
  state.services = state.services || {};

  while (true) {
    const nowMs = Date.now();

    for (const [serviceName, service] of Object.entries(SERVICES)) {
      const serviceState = state.services[serviceName] || { restartTimestamps: [], status: 'unknown', lastError: null };
      cleanupOldRestartTimestamps(serviceState, nowMs);

      const probe = await probeService(serviceName, service);
      serviceState.status = probe.ok ? 'ok' : 'fail';
      serviceState.lastCheckedAt = nowIso();
      serviceState.lastError = probe.ok ? null : probe.detail;

      if (probe.ok) {
        state.services[serviceName] = serviceState;
        continue;
      }

      const tooManyRestarts = serviceState.restartTimestamps.length >= RESTART_MAX_IN_WINDOW;
      const inCooldown = serviceState.lastRestartAtMs && (nowMs - serviceState.lastRestartAtMs) < RESTART_COOLDOWN_MS;

      if (tooManyRestarts) {
        const event = {
          kind: 'restart-loop-detected',
          severity: 'critical',
          service: serviceName,
          detail: `probe failed and restart threshold reached (${serviceState.restartTimestamps.length}/${RESTART_MAX_IN_WINDOW}) in ${Math.round(RESTART_WINDOW_MS / 1000)}s`,
          ts: nowIso(),
        };
        log(`${serviceName}: ${event.detail}`);
        await runAlert(event);
        state.services[serviceName] = serviceState;
        continue;
      }

      if (inCooldown) {
        log(`${serviceName}: health failed but in cooldown (${probe.detail})`);
        state.services[serviceName] = serviceState;
        continue;
      }

      try {
        await restartUnit(serviceName, service.systemdUnit, probe.detail);
        serviceState.lastRestartAtMs = nowMs;
        serviceState.restartTimestamps.push(nowMs);
        const event = {
          kind: 'service-restarted',
          severity: 'warn',
          service: serviceName,
          detail: `health probe failed: ${probe.detail}; restarted unit ${service.systemdUnit}`,
          ts: nowIso(),
        };
        await runAlert(event);
      } catch (error) {
        const event = {
          kind: 'restart-failed',
          severity: 'critical',
          service: serviceName,
          detail: error.message,
          ts: nowIso(),
        };
        log(`${serviceName}: ${error.message}`);
        await runAlert(event);
      }

      state.services[serviceName] = serviceState;
    }

    writeState(state);
    await sleep(HEALTH_INTERVAL_MS);
  }
}

monitorLoop().catch((error) => {
  log(`fatal: ${error.message}`);
  process.exit(1);
});
