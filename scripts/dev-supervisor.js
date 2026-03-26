#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const RUNTIME_DIR = path.join(ROOT, '.runtime');
const PID_FILE = path.join(RUNTIME_DIR, 'dev-supervisor.pid');
const STATE_FILE = path.join(RUNTIME_DIR, 'dev-supervisor-state.json');
const LOG_FILE = path.join(ROOT, 'logs', 'dev-supervisor.log');
const CONTROL_PORT = 9077;

const SERVICES = {
  api: {
    name: 'api',
    port: 3001,
    cmd: ['npm', ['run', 'dev:api']],
    startupGraceMs: 45000,
    maxConsecutiveHealthFailures: 3,
    health: [{ type: 'http', url: 'http://127.0.0.1:3001/health', expect: ['"status":"ok"', '"db":"ok"'] }],
  },
  portal: {
    name: 'portal',
    port: 5175,
    cmd: ['npm', ['run', 'dev', '--workspace=packages/portal', '--', '--host', '127.0.0.1', '--port', '5175']],
    health: [{ type: 'tcp', host: '127.0.0.1', port: 5175 }],
  },
  mobile: {
    name: 'mobile',
    port: 8082,
    cmd: ['bash', ['-lc', 'pkill -f "expo start --port 8082" >/dev/null 2>&1 || true; npm run dev --workspace=packages/mobile -- --port 8082']],
    env: { CI: '1', EXPO_NO_INTERACTIVE: '1' },
    health: [{ type: 'tcp', host: '127.0.0.1', port: 8082 }],
  },
  ocpp: {
    name: 'ocpp',
    port: 9000,
    cmd: ['npm', ['run', 'dev:ocpp']],
    health: [{ type: 'http', url: 'http://127.0.0.1:9000/health', expect: ['"status":"ok"'] }],
  },
};

function ensureDirs() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
}

function runDockerCompose(args) {
  return new Promise((resolve) => {
    const child = spawn('docker', ['compose', ...args], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('exit', (code) => resolve({ code: code || 0, stdout, stderr }));
    child.on('error', (error) => resolve({ code: 1, stdout, stderr: error.message }));
  });
}

async function ensureInfra() {
  log('infra: ensuring docker services (postgres, keycloak, pgadmin)');
  const result = await runDockerCompose(['up', '-d', 'postgres', 'keycloak', 'pgadmin']);
  if (result.stdout.trim()) fs.appendFileSync(LOG_FILE, `[${now()}] infra: ${result.stdout.trim()}\n`);
  if (result.stderr.trim()) fs.appendFileSync(LOG_FILE, `[${now()}] infra [err]: ${result.stderr.trim()}\n`);
  if (result.code !== 0) {
    throw new Error(`docker compose up failed: ${result.stderr || result.stdout || `exit ${result.code}`}`);
  }
}

function now() {
  return new Date().toISOString();
}

function log(message) {
  const line = `[${now()}] ${message}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function killKnownDevProcesses() {
  const patterns = [
    'ts-node-dev --respawn src/index.ts',
    'vite --host 127.0.0.1 --port 5175',
    'expo start --port 8082',
    'packages/ocpp-server',
  ];
  for (const pat of patterns) {
    try {
      execFileSync('pkill', ['-f', pat], { stdio: 'ignore' });
      log(`preflight: terminated stale process pattern="${pat}"`);
    } catch {
      // no-op when no matching process
    }
  }
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid() {
  if (!fs.existsSync(PID_FILE)) return null;
  const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
  return Number.isFinite(pid) ? pid : null;
}

function httpJson(url, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (d) => { body += d.toString('utf8'); });
      res.on('end', () => resolve({ statusCode: res.statusCode || 0, body }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout ${timeoutMs}ms`)));
  });
}

function tcpCheck(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (ok, detail) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, detail });
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => finish(true, 'connected'));
    socket.on('timeout', () => finish(false, 'timeout'));
    socket.on('error', (e) => finish(false, e.message));
  });
}

async function checkHealth(spec) {
  if (spec.type === 'tcp') {
    const result = await tcpCheck(spec.host, spec.port);
    return result.ok ? { ok: true } : { ok: false, detail: result.detail };
  }
  if (spec.type === 'http') {
    try {
      const result = await httpJson(spec.url);
      if (result.statusCode < 200 || result.statusCode >= 300) {
        return { ok: false, detail: `http ${result.statusCode}` };
      }
      if (Array.isArray(spec.expect)) {
        for (const token of spec.expect) {
          if (!result.body.includes(token)) {
            return { ok: false, detail: `missing token ${token}` };
          }
        }
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: e.message };
    }
  }
  return { ok: false, detail: 'unknown health type' };
}

class Supervisor {
  constructor() {
    this.children = {};
    this.healthState = {};
    this.restartBackoffMs = {};
    this.server = null;
    this.stopping = false;
    this.serviceMeta = {};
  }

  writeState() {
    const out = {};
    for (const [name, svc] of Object.entries(SERVICES)) {
      const child = this.children[name];
      out[name] = {
        pid: child?.pid || null,
        running: !!(child && !child.killed),
        health: this.healthState[name] || 'unknown',
        port: svc.port,
      };
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ts: now(), services: out }, null, 2));
  }

  spawnService(name) {
    if (this.stopping) return;
    const svc = SERVICES[name];
    if (!svc) return;

    const [cmd, args] = svc.cmd;
    const child = spawn(cmd, args, {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0', ...(svc.env || {}) },
    });

    this.children[name] = child;
    this.restartBackoffMs[name] = Math.min((this.restartBackoffMs[name] || 500) * 2, 15000);
    this.serviceMeta[name] = { startedAt: Date.now(), consecutiveHealthFailures: 0 };
    log(`${name}: started pid=${child.pid}`);

    child.stdout.on('data', (d) => {
      const line = d.toString('utf8').trim();
      if (line) fs.appendFileSync(LOG_FILE, `[${now()}] ${name}: ${line}\n`);
    });
    child.stderr.on('data', (d) => {
      const line = d.toString('utf8').trim();
      if (line) fs.appendFileSync(LOG_FILE, `[${now()}] ${name} [err]: ${line}\n`);
    });

    child.on('exit', async (code, signal) => {
      if (this.children[name] !== child) return;
      delete this.children[name];
      delete this.serviceMeta[name];
      this.healthState[name] = 'down';
      this.writeState();
      log(`${name}: exited code=${code} signal=${signal || 'none'}; scheduling restart`);
      if (this.stopping) return;
      await sleep(this.restartBackoffMs[name] || 1000);
      this.spawnService(name);
    });

    this.writeState();
  }

  async restartService(name, reason = 'manual') {
    const child = this.children[name];
    if (!child) {
      this.spawnService(name);
      return;
    }
    log(`${name}: restarting (${reason})`);
    child.kill('SIGTERM');
    await sleep(1200);
    if (this.children[name]) {
      this.children[name].kill('SIGKILL');
    }
  }

  async healthLoop() {
    while (!this.stopping) {
      for (const [name, svc] of Object.entries(SERVICES)) {
        const child = this.children[name];
        if (!child) {
          this.healthState[name] = 'down';
          continue;
        }

        let ok = true;
        let detail = '';
        for (const probe of svc.health) {
          const result = await checkHealth(probe);
          if (!result.ok) {
            ok = false;
            detail = result.detail || 'probe failed';
            break;
          }
        }

        const prev = this.healthState[name];
        const meta = this.serviceMeta[name] || { startedAt: Date.now(), consecutiveHealthFailures: 0 };

        if (ok) {
          meta.consecutiveHealthFailures = 0;
          this.healthState[name] = 'ok';
        } else {
          meta.consecutiveHealthFailures += 1;
          this.healthState[name] = `fail:${detail}`;

          const startupGraceMs = svc.startupGraceMs || 15000;
          const maxConsecutiveHealthFailures = svc.maxConsecutiveHealthFailures || 2;
          const ageMs = Date.now() - meta.startedAt;
          const inGrace = ageMs < startupGraceMs;
          const shouldRestart = !inGrace && meta.consecutiveHealthFailures >= maxConsecutiveHealthFailures;

          if (shouldRestart) {
            log(`${name}: health failed (${detail}) x${meta.consecutiveHealthFailures}, auto-restart`);
            meta.consecutiveHealthFailures = 0;
            await this.restartService(name, `health:${detail}`);
          } else if (prev !== this.healthState[name]) {
            log(`${name}: health probe failed (${detail}) x${meta.consecutiveHealthFailures}${inGrace ? ' (within startup grace)' : ''}`);
          }
        }

        this.serviceMeta[name] = meta;
      }

      this.writeState();
      await sleep(5000);
    }
  }

  startControlServer() {
    this.server = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/status') {
        this.writeState();
        const payload = fs.existsSync(STATE_FILE)
          ? fs.readFileSync(STATE_FILE, 'utf8')
          : JSON.stringify({ ts: now(), services: {} });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(payload);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/restart-failed') {
        const failed = Object.keys(SERVICES).filter((k) => (this.healthState[k] || '').startsWith('fail') || this.healthState[k] === 'down');
        for (const name of failed) await this.restartService(name, 'restart-failed');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ restarted: failed }));
        return;
      }

      if (req.method === 'POST' && url.pathname.startsWith('/restart/')) {
        const name = url.pathname.split('/').pop();
        if (!name || !SERVICES[name]) {
          res.writeHead(404); res.end('unknown service'); return;
        }
        await this.restartService(name, 'manual-service');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ restarted: [name] }));
        return;
      }

      res.writeHead(404);
      res.end('not found');
    });

    this.server.listen(CONTROL_PORT, '127.0.0.1', () => {
      log(`control: listening on 127.0.0.1:${CONTROL_PORT}`);
    });
  }

  async start() {
    ensureDirs();
    fs.writeFileSync(PID_FILE, String(process.pid));
    log(`supervisor: started pid=${process.pid}`);
    await ensureInfra();
    for (const name of Object.keys(SERVICES)) this.spawnService(name);
    this.startControlServer();
    this.healthLoop();

    const stop = async () => {
      if (this.stopping) return;
      this.stopping = true;
      log('supervisor: stopping');
      if (this.server) this.server.close();
      for (const child of Object.values(this.children)) {
        child.kill('SIGTERM');
      }
      await sleep(500);
      for (const child of Object.values(this.children)) {
        if (!child.killed) child.kill('SIGKILL');
      }
      if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
      this.writeState();
      process.exit(0);
    };

    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  }
}

async function request(pathname, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: CONTROL_PORT, path: pathname, method }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d.toString('utf8'); });
      res.on('end', () => resolve({ statusCode: res.statusCode || 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function cli() {
  ensureDirs();
  const cmd = process.argv[2] || 'help';

  if (cmd === 'daemon') {
    const sup = new Supervisor();
    await sup.start();
    return;
  }

  if (cmd === 'start') {
    const pid = readPid();
    if (isPidAlive(pid)) {
      console.log(`dev-supervisor already running pid=${pid}`);
      return;
    }
    killKnownDevProcesses();
    const child = spawn(process.execPath, [__filename, 'daemon'], {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
    await sleep(400);
    const newPid = readPid();
    console.log(`dev-supervisor started pid=${newPid || child.pid}`);
    return;
  }

  if (cmd === 'stop') {
    const pid = readPid();
    if (!isPidAlive(pid)) {
      console.log('dev-supervisor is not running');
      return;
    }
    process.kill(pid, 'SIGTERM');
    await sleep(500);
    console.log('dev-supervisor stop signal sent');
    return;
  }

  if (cmd === 'status') {
    try {
      const res = await request('/status');
      if (res.statusCode !== 200) throw new Error(`status ${res.statusCode}`);
      const data = JSON.parse(res.body);
      console.log(`ts=${data.ts}`);
      for (const [name, s] of Object.entries(data.services)) {
        console.log(`${name}\trunning=${s.running}\thealth=${s.health}\tpid=${s.pid || '-'}\tport=${s.port}`);
      }
    } catch (e) {
      const pid = readPid();
      if (isPidAlive(pid) && fs.existsSync(STATE_FILE)) {
        const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        console.log(`ts=${data.ts} (stale-state)`);
        for (const [name, s] of Object.entries(data.services)) {
          console.log(`${name}\trunning=${s.running}\thealth=${s.health}\tpid=${s.pid || '-'}\tport=${s.port}`);
        }
      } else {
        console.log('dev-supervisor is not running');
      }
    }
    return;
  }

  if (cmd === 'restart-failed') {
    const res = await request('/restart-failed', 'POST');
    console.log(res.body || '{}');
    return;
  }

  if (cmd === 'restart') {
    const service = process.argv[3];
    if (!service) {
      console.error('usage: dev-supervisor.js restart <api|portal|mobile|ocpp>');
      process.exit(1);
    }
    const res = await request(`/restart/${service}`, 'POST');
    console.log(res.body || '{}');
    return;
  }

  if (cmd === 'health-check') {
    for (const [name, svc] of Object.entries(SERVICES)) {
      let ok = true;
      let detail = '';
      for (const probe of svc.health) {
        const result = await checkHealth(probe);
        if (!result.ok) {
          ok = false;
          detail = result.detail || 'failed';
          break;
        }
      }
      console.log(`${name}\t${ok ? 'ok' : `fail:${detail}`}`);
    }
    return;
  }

  console.log('usage: node scripts/dev-supervisor.js <start|stop|status|restart-failed|restart <service>|health-check>');
}

cli().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
