#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(ROOT, 'state');
const STATE_FILE = path.join(STATE_DIR, 'prod-health-monitor.json');
const CONFIG_FILE = path.join(STATE_DIR, 'prod-health-monitor.config.json');
const LOCK_FILE = path.join(STATE_DIR, 'prod-health-monitor.lock');

const NOW = () => Date.now();
const nowIso = () => new Date().toISOString();
const HOST = os.hostname();
const PID = process.pid;

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function envRequired(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function envOptional(name, fallback = '') {
  const value = process.env[name];
  return value == null || value === '' ? fallback : value;
}

function envBool(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Invalid numeric env var ${name}=${raw}`);
  return n;
}

function authHeaders(auth) {
  if (!auth || auth.type === 'none') return {};
  if (auth.type === 'bearer') return { Authorization: `Bearer ${auth.token}` };
  if (auth.type === 'internal-token') return { 'X-Internal-Token': auth.token };
  throw new Error(`Unsupported auth type: ${auth.type}`);
}

function request(urlString, options = {}) {
  const url = new URL(urlString);
  const client = url.protocol === 'https:' ? https : http;
  const timeoutMs = options.timeoutMs ?? 8000;
  const headers = options.headers ?? {};

  return new Promise((resolve, reject) => {
    const req = client.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: options.method || 'GET',
      headers,
      timeout: timeoutMs,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    if (options.body) req.write(options.body);
    req.end();
  });
}

function truncate(text, max = 300) {
  if (text == null) return '';
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function sha1(input) {
  return crypto.createHash('sha1').update(input).digest('hex');
}

function loadConfig() {
  const fileConfig = readJson(CONFIG_FILE, {});

  const config = {
    monitorName: envOptional('PROD_HEALTH_MONITOR_NAME', fileConfig.monitorName || 'prod_health_monitor'),
    intervalMinutes: envInt('PROD_HEALTH_INTERVAL_MINUTES', fileConfig.intervalMinutes || 15),
    timeoutMs: envInt('PROD_HEALTH_TIMEOUT_MS', fileConfig.timeoutMs || 8000),
    failureThreshold: envInt('PROD_HEALTH_FAILURE_THRESHOLD', fileConfig.failureThreshold || 2),
    recoveryThreshold: envInt('PROD_HEALTH_RECOVERY_THRESHOLD', fileConfig.recoveryThreshold || 1),
    alertCooldownMinutes: envInt('PROD_HEALTH_ALERT_COOLDOWN_MINUTES', fileConfig.alertCooldownMinutes || 120),
    chargerOfflineMinutes: envInt('PROD_HEALTH_CHARGER_OFFLINE_MINUTES', fileConfig.chargerOfflineMinutes || 20),
    lockStaleMinutes: envInt('PROD_HEALTH_LOCK_STALE_MINUTES', fileConfig.lockStaleMinutes || 30),
    startupStrict: envBool('PROD_HEALTH_STARTUP_STRICT', fileConfig.startupStrict ?? true),
    telegram: {
      botTokenEnv: envOptional('PROD_HEALTH_TELEGRAM_BOT_TOKEN_ENV', fileConfig.telegram?.botTokenEnv || 'TELEGRAM_BOT_TOKEN'),
      chatIdEnv: envOptional('PROD_HEALTH_TELEGRAM_CHAT_ID_ENV', fileConfig.telegram?.chatIdEnv || 'TELEGRAM_CHAT_ID'),
      apiBase: envOptional('TELEGRAM_API_BASE', fileConfig.telegram?.apiBase || 'https://api.telegram.org'),
    },
    deadman: {
      urlEnv: envOptional('PROD_HEALTH_DEADMAN_URL_ENV', fileConfig.deadman?.urlEnv || 'PROD_HEALTHCHECKS_PING_URL'),
      graceUrlEnv: envOptional('PROD_HEALTH_DEADMAN_GRACE_URL_ENV', fileConfig.deadman?.graceUrlEnv || ''),
      enabled: envBool('PROD_HEALTH_DEADMAN_ENABLED', fileConfig.deadman?.enabled ?? true),
    },
    llm: {
      escalationModel: envOptional('PROD_HEALTH_ESCALATION_MODEL', fileConfig.llm?.escalationModel || 'openai-codex/gpt-5.4'),
    },
    checks: fileConfig.checks || [
      {
        key: 'ocpp_fresh',
        label: 'OCPP fresh',
        kind: 'http-json',
        url: 'https://ocpp-server-fresh-production.up.railway.app/health',
        expectStatus: 200,
        expectJson: { status: 'ok' },
      },
      {
        key: 'api',
        label: 'API',
        kind: 'http-json',
        url: 'https://api-production-26cf.up.railway.app/health',
        expectStatus: 200,
        expectJson: { status: 'ok', db: 'ok' },
      },
      {
        key: 'portal',
        label: 'Portal',
        kind: 'http-status',
        url: 'https://portal.lumeopower.com',
        expectStatus: 200,
      },
      {
        key: 'keycloak_oidc',
        label: 'Keycloak OIDC',
        kind: 'http-status',
        url: 'https://keycloak-live-production.up.railway.app/realms/ev-charger-prod/.well-known/openid-configuration',
        expectStatus: 200,
      },
      {
        key: 'charger_cp_00008',
        label: 'Charger CP-00008 heartbeat',
        kind: 'charger-heartbeat',
        url: 'https://api-production-26cf.up.railway.app/chargers/1A32-1-2010-00008',
        expectStatus: 200,
        heartbeatField: 'lastHeartbeat',
        maxAgeMinutes: fileConfig.chargerOfflineMinutes || 20,
        expectJson: { ocppId: '1A32-1-2010-00008' },
      },
    ],
  };

  if (!config.telegram.botTokenEnv || !config.telegram.chatIdEnv) {
    throw new Error('Telegram env names must be configured');
  }
  return config;
}

function validateStartup(config) {
  const missing = [];

  const tgToken = process.env[config.telegram.botTokenEnv]?.trim();
  const tgChat = process.env[config.telegram.chatIdEnv]?.trim();
  if (!tgToken) missing.push(config.telegram.botTokenEnv);
  if (!tgChat) missing.push(config.telegram.chatIdEnv);

  if (config.deadman.enabled) {
    const pingUrl = process.env[config.deadman.urlEnv]?.trim();
    if (!pingUrl) missing.push(config.deadman.urlEnv);
  }

  for (const check of config.checks) {
    if (check.auth?.tokenEnv && !process.env[check.auth.tokenEnv]?.trim()) {
      missing.push(check.auth.tokenEnv);
    }
  }

  if (missing.length > 0) {
    const message = `prod-health-monitor startup validation failed, missing env vars: ${Array.from(new Set(missing)).join(', ')}`;
    if (config.startupStrict) throw new Error(message);
    console.warn(message);
  }
}

function acquireLock(config) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const staleMs = config.lockStaleMinutes * 60 * 1000;
  const payload = { pid: PID, host: HOST, acquiredAt: nowIso() };

  try {
    const fd = fs.openSync(LOCK_FILE, 'wx');
    fs.writeFileSync(fd, JSON.stringify(payload, null, 2));
    fs.closeSync(fd);
    return;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  const existing = readJson(LOCK_FILE, {});
  const acquiredAtMs = existing?.acquiredAt ? new Date(existing.acquiredAt).getTime() : 0;
  const stale = !acquiredAtMs || (NOW() - acquiredAtMs) > staleMs;
  if (!stale) {
    fail(`prod-health-monitor lock active, pid=${existing?.pid ?? 'unknown'} host=${existing?.host ?? 'unknown'} acquiredAt=${existing?.acquiredAt ?? 'unknown'}`);
  }

  fs.rmSync(LOCK_FILE, { force: true });
  const fd = fs.openSync(LOCK_FILE, 'wx');
  fs.writeFileSync(fd, JSON.stringify({ ...payload, replacedStaleLockFrom: existing }, null, 2));
  fs.closeSync(fd);
}

function releaseLock() {
  fs.rmSync(LOCK_FILE, { force: true });
}

function resolveAuth(check) {
  if (!check.auth) return { type: 'none' };
  const token = process.env[check.auth.tokenEnv]?.trim();
  if (!token) throw new Error(`Missing auth token env ${check.auth.tokenEnv} for check ${check.key}`);
  return { type: check.auth.type, token };
}

function expectJsonSubset(actual, expected) {
  for (const [key, value] of Object.entries(expected || {})) {
    if (actual == null || actual[key] !== value) return `expected ${key}=${JSON.stringify(value)}, got ${JSON.stringify(actual?.[key])}`;
  }
  return null;
}

async function runCheck(check, config) {
  const base = { key: check.key, label: check.label, checkedAt: nowIso() };
  const auth = resolveAuth(check);
  const headers = authHeaders(auth);
  const response = await request(check.url, { timeoutMs: config.timeoutMs, headers });

  if (response.status !== (check.expectStatus || 200)) {
    return { ...base, ok: false, status: response.status, detail: `HTTP ${response.status} from ${check.url}`, bodySnippet: truncate(response.body) };
  }

  if (check.kind === 'http-status') {
    return { ...base, ok: true, status: response.status, detail: `HTTP ${response.status}` };
  }

  let json;
  try {
    json = JSON.parse(response.body || '{}');
  } catch {
    return { ...base, ok: false, status: response.status, detail: `invalid JSON from ${check.url}`, bodySnippet: truncate(response.body) };
  }

  const subsetError = expectJsonSubset(json, check.expectJson);
  if (subsetError) {
    return { ...base, ok: false, status: response.status, detail: subsetError, bodySnippet: truncate(response.body) };
  }

  if (check.kind === 'charger-heartbeat') {
    const heartbeatRaw = json[check.heartbeatField];
    if (!heartbeatRaw) {
      return { ...base, ok: false, status: response.status, detail: `missing ${check.heartbeatField} in charger status`, bodySnippet: truncate(response.body) };
    }
    const heartbeatMs = new Date(heartbeatRaw).getTime();
    if (!Number.isFinite(heartbeatMs)) {
      return { ...base, ok: false, status: response.status, detail: `invalid ${check.heartbeatField} value ${JSON.stringify(heartbeatRaw)}` };
    }
    const ageMinutes = Math.floor((NOW() - heartbeatMs) / 60000);
    const maxAge = check.maxAgeMinutes || config.chargerOfflineMinutes;
    if (ageMinutes > maxAge) {
      return {
        ...base,
        ok: false,
        status: response.status,
        detail: `lastHeartbeat stale: ${ageMinutes}m old, threshold ${maxAge}m`,
        heartbeatAt: heartbeatRaw,
      };
    }
    return {
      ...base,
      ok: true,
      status: response.status,
      detail: `lastHeartbeat ${ageMinutes}m old`,
      heartbeatAt: heartbeatRaw,
    };
  }

  return { ...base, ok: true, status: response.status, detail: 'ok' };
}

function initialState(config) {
  return {
    monitorName: config.monitorName,
    createdAt: nowIso(),
    checks: {},
    lastRunAt: null,
    lastSuccessAt: null,
    lastSummary: null,
    lastDeadmanPingAt: null,
  };
}

function updateTransition(existing, result, config) {
  const state = existing || {
    status: 'unknown',
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    lastAlertAt: null,
    lastAlertFingerprint: null,
    lastStatusChangeAt: null,
    openIncidentStartedAt: null,
  };

  if (result.ok) {
    state.consecutiveSuccesses += 1;
    state.consecutiveFailures = 0;
    state.lastSuccessAt = result.checkedAt;
    if (state.status !== 'healthy' && state.consecutiveSuccesses >= config.recoveryThreshold) {
      state.status = 'healthy';
      state.lastStatusChangeAt = result.checkedAt;
    }
    if (state.status === 'healthy') state.openIncidentStartedAt = null;
  } else {
    state.consecutiveFailures += 1;
    state.consecutiveSuccesses = 0;
    state.lastFailureAt = result.checkedAt;
    if (state.status !== 'failing' && state.consecutiveFailures >= config.failureThreshold) {
      state.status = 'failing';
      state.lastStatusChangeAt = result.checkedAt;
      state.openIncidentStartedAt = state.openIncidentStartedAt || result.checkedAt;
    }
  }

  state.lastResult = result;
  return state;
}

function severityFor(result) {
  return result.key.startsWith('charger_') ? 'critical' : 'warn';
}

function shouldSendAlert(checkState, fingerprint, config) {
  const cooldownMs = config.alertCooldownMinutes * 60 * 1000;
  const lastAlertMs = checkState.lastAlertAt ? new Date(checkState.lastAlertAt).getTime() : 0;
  if (!lastAlertMs) return true;
  if (checkState.lastAlertFingerprint !== fingerprint) return true;
  return (NOW() - lastAlertMs) >= cooldownMs;
}

async function sendTelegram(config, text) {
  const token = envRequired(config.telegram.botTokenEnv);
  const chatId = envRequired(config.telegram.chatIdEnv);
  const apiBase = config.telegram.apiBase.replace(/\/$/, '');
  const body = new URLSearchParams({
    chat_id: chatId,
    text,
    disable_web_page_preview: 'true',
  }).toString();

  const url = `${apiBase}/bot${token}/sendMessage`;
  await request(url, {
    method: 'POST',
    timeoutMs: 8000,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': String(Buffer.byteLength(body)) },
    body,
  });
}

function buildDownMessage(config, failing, allResults) {
  const lines = [
    `🚨 ${config.monitorName}: prod issue detected`,
    ...failing.map((r) => `- ${r.label}: ${r.detail}`),
  ];
  const healthy = allResults.filter((r) => r.ok).map((r) => `${r.label}: ok`);
  if (healthy.length) lines.push('', 'Healthy:', ...healthy.map((s) => `- ${s}`));
  lines.push('', `Escalation model if needed: ${config.llm.escalationModel}`);
  return lines.join('\n');
}

function buildRecoveryMessage(config, recovered) {
  return [
    `✅ ${config.monitorName}: recovery detected`,
    ...recovered.map((r) => `- ${r.label}: recovered (${r.detail})`),
  ].join('\n');
}

async function pingDeadman(config, suffix = '') {
  if (!config.deadman.enabled) return;
  const baseUrl = process.env[config.deadman.urlEnv]?.trim();
  if (!baseUrl) return;
  if (baseUrl.includes('example.com') || baseUrl.includes('placeholder')) return;
  const url = suffix ? `${baseUrl.replace(/\/$/, '')}${suffix}` : baseUrl;
  await request(url, { method: 'GET', timeoutMs: 8000 });
}

async function main() {
  const config = loadConfig();
  validateStartup(config);
  acquireLock(config);

  const state = readJson(STATE_FILE, initialState(config)) || initialState(config);
  const results = [];
  const alerts = [];
  const recoveries = [];

  try {
    for (const check of config.checks) {
      let result;
      try {
        result = await runCheck(check, config);
      } catch (error) {
        result = { key: check.key, label: check.label, checkedAt: nowIso(), ok: false, detail: error.message };
      }

      results.push(result);
      const updated = updateTransition(state.checks[check.key], result, config);
      state.checks[check.key] = updated;

      const fingerprint = sha1(`${result.key}|${updated.status}|${result.detail}`);
        const previousResultOk = state.checks[check.key]?.lastResult?.ok;
      if (!result.ok && updated.status === 'failing' && shouldSendAlert(updated, fingerprint, config)) {
        updated.lastAlertAt = result.checkedAt;
        updated.lastAlertFingerprint = fingerprint;
        alerts.push({ result, severity: severityFor(result) });
      }

      if (result.ok && previousResultOk === false && updated.status === 'healthy') {
        recoveries.push(result);
      }
    }

    if (alerts.length) {
      const message = buildDownMessage(config, alerts.map((a) => a.result), results);
      await sendTelegram(config, message);
    } else if (recoveries.length) {
      const message = buildRecoveryMessage(config, recoveries);
      await sendTelegram(config, message);
    }

    await pingDeadman(config);
    state.lastDeadmanPingAt = nowIso();
    state.lastRunAt = nowIso();
    state.lastSuccessAt = nowIso();
    state.lastSummary = {
      failing: results.filter((r) => !r.ok).map((r) => ({ key: r.key, detail: r.detail })),
      healthyCount: results.filter((r) => r.ok).length,
      total: results.length,
    };
    writeJson(STATE_FILE, state);

    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      console.log(JSON.stringify({ ok: false, failing: failed, checkedAt: nowIso() }, null, 2));
      process.exitCode = 1;
      return;
    }

    console.log(JSON.stringify({ ok: true, checkedAt: nowIso(), total: results.length }, null, 2));
  } catch (error) {
    try {
      const graceSuffix = process.env[config.deadman.graceUrlEnv]?.trim() || '/fail';
      await pingDeadman(config, graceSuffix);
    } catch {}
    throw error;
  } finally {
    releaseLock();
  }
}

main().catch((error) => fail(`prod-health-monitor failed: ${error.stack || error.message}`));
