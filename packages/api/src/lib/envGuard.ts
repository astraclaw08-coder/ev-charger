const PROD_HOST_HINTS = ['railway.app', 'rds.amazonaws.com', 'supabase.co', 'neon.tech'];

type AppEnv = 'development' | 'production' | 'staging' | 'test';

export function getAppEnv(): AppEnv {
  const raw = (process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development').toLowerCase();
  if (raw === 'prod') return 'production';
  if (raw === 'stage') return 'staging';
  if (raw === 'dev') return 'development';
  if (raw === 'test') return 'test';
  return 'development';
}

function looksLikeProdDb(url: string): boolean {
  const value = url.toLowerCase();
  if (value.includes('prod')) return true;
  return PROD_HOST_HINTS.some((hint) => value.includes(hint));
}

const REQUIRED_KEYCLOAK_VARS = [
  'KEYCLOAK_BASE_URL',
  'KEYCLOAK_REALM',
  'KEYCLOAK_PORTAL_CLIENT_ID',
  'KEYCLOAK_PORTAL_CLIENT_SECRET',
] as const;

/**
 * Fail-fast if Keycloak auth config is incomplete.
 * Dev and prod use the same key names — only values differ.
 */
export function assertKeycloakConfig(): void {
  const missing: string[] = [];
  for (const key of REQUIRED_KEYCLOAK_VARS) {
    if (!process.env[key]?.trim()) missing.push(key);
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing required Keycloak env vars: ${missing.join(', ')}. ` +
        'Dev and prod use identical key names — set values in .env for your environment.',
    );
  }

  // Verify Keycloak URL is a valid URL
  const url = process.env.KEYCLOAK_BASE_URL!.trim();
  try {
    new URL(url);
  } catch {
    throw new Error(
      `KEYCLOAK_BASE_URL is not a valid URL: "${url}". ` +
        'Expected format: http://localhost:8090 (dev) or https://keycloak.example.com (prod).',
    );
  }
}

export function assertDatabaseUrlSafety(): void {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('Missing DATABASE_URL. Set environment-specific DATABASE_URL before starting API.');
  }

  const appEnv = getAppEnv();
  const allowProdInDev = process.env.ALLOW_PROD_DB_IN_DEV === 'true';

  if ((appEnv === 'development' || appEnv === 'test') && looksLikeProdDb(databaseUrl) && !allowProdInDev) {
    throw new Error(
      `Unsafe DATABASE_URL for ${appEnv}: appears production-like. Refusing startup. ` +
        'Set a dev/test DB URL or override intentionally with ALLOW_PROD_DB_IN_DEV=true.',
    );
  }
}
