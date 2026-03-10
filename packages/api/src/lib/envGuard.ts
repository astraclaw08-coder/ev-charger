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
