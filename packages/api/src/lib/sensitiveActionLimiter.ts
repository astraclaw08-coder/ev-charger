type Bucket = {
  windowStart: number;
  count: number;
};

const buckets = new Map<string, Bucket>();

function readNumberEnv(name: string, fallback: number) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getSettings() {
  return {
    burst: readNumberEnv('SECURITY_SENSITIVE_ACTION_BURST', 30),
    windowSeconds: readNumberEnv('SECURITY_SENSITIVE_ACTION_WINDOW_SECONDS', 60),
  };
}

function keyFor(operatorId: string, ip?: string) {
  return `${operatorId}:${(ip ?? 'unknown').trim().toLowerCase()}`;
}

export function recordSensitiveAction(operatorId: string, ip?: string) {
  const cfg = getSettings();
  const now = Date.now();
  const key = keyFor(operatorId, ip);
  const current = buckets.get(key);

  if (!current || now - current.windowStart > cfg.windowSeconds * 1000) {
    buckets.set(key, { windowStart: now, count: 1 });
    return { allowed: true } as const;
  }

  current.count += 1;
  buckets.set(key, current);

  if (current.count > cfg.burst) {
    const retryAfterSeconds = Math.ceil((cfg.windowSeconds * 1000 - (now - current.windowStart)) / 1000);
    return { allowed: false, retryAfterSeconds } as const;
  }

  return { allowed: true } as const;
}
