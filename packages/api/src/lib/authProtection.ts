type FailureWindow = {
  firstFailureAt: number;
  count: number;
  blockedUntil: number;
};

const failuresByKey = new Map<string, FailureWindow>();

function readNumberEnv(name: string, fallback: number) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function settings() {
  const env = (process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development').toLowerCase();
  return {
    enabled: env === 'production',
    maxAttempts: readNumberEnv('SECURITY_AUTH_FAILURE_MAX_ATTEMPTS', 8),
    windowSeconds: readNumberEnv('SECURITY_AUTH_FAILURE_WINDOW_SECONDS', 300),
    blockSeconds: readNumberEnv('SECURITY_AUTH_BLOCK_SECONDS', 900),
  };
}

function normalizedKey(input: { ip?: string; routeScope: string }) {
  const ip = (input.ip ?? 'unknown').trim().toLowerCase();
  return `${input.routeScope}:${ip}`;
}

export function isBlocked(input: { ip?: string; routeScope: string }) {
  const cfg = settings();
  if (!cfg.enabled) return { blocked: false } as const;

  const now = Date.now();
  const key = normalizedKey(input);
  const bucket = failuresByKey.get(key);
  if (!bucket) return { blocked: false } as const;
  if (bucket.blockedUntil > now) {
    return {
      blocked: true,
      retryAfterSeconds: Math.ceil((bucket.blockedUntil - now) / 1000),
    } as const;
  }
  return { blocked: false } as const;
}

export function recordAuthFailure(input: { ip?: string; routeScope: string }) {
  const now = Date.now();
  const key = normalizedKey(input);
  const cfg = settings();
  if (!cfg.enabled) return;
  const existing = failuresByKey.get(key);

  if (!existing || now - existing.firstFailureAt > cfg.windowSeconds * 1000) {
    failuresByKey.set(key, { firstFailureAt: now, count: 1, blockedUntil: 0 });
    return;
  }

  existing.count += 1;
  if (existing.count >= cfg.maxAttempts) {
    existing.blockedUntil = now + cfg.blockSeconds * 1000;
  }
  failuresByKey.set(key, existing);
}

export function recordAuthSuccess(input: { ip?: string; routeScope: string }) {
  const key = normalizedKey(input);
  failuresByKey.delete(key);
}
