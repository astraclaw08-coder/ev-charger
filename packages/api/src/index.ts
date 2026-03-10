import 'dotenv/config';
import { buildServer } from './server';
import { assertDatabaseUrlSafety, getAppEnv } from './lib/envGuard';

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

try {
  assertDatabaseUrlSafety();
  console.log(`[Startup] APP_ENV=${getAppEnv()} DATABASE_URL safety check passed`);
} catch (err) {
  console.error('[Startup] Environment safety check failed:', err);
  process.exit(1);
}

buildServer()
  .then((app) => {
    app.listen({ port: PORT, host: HOST }, (err, address) => {
      if (err) {
        app.log.error(err);
        process.exit(1);
      }
      console.log(`[API] REST API listening on ${address}`);
    });
  })
  .catch((err) => {
    console.error('[Startup] Failed to start API server:', err);
    process.exit(1);
  });
