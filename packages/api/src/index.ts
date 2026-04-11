import 'dotenv/config';
import { buildServer } from './server';
import { assertDatabaseUrlSafety, assertKeycloakConfig, getAppEnv } from './lib/envGuard';
import { materializeUptime } from './workers/uptimeMaterializer';
import { startReservationExpiryJob } from './jobs/reservationExpiry';
import { startReservationFeeCaptureJob } from './jobs/reservationFeeCapture';
import { startStaleSessionCleanupJob } from './jobs/staleSessionCleanup';

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

try {
  assertDatabaseUrlSafety();
  assertKeycloakConfig();
  console.log(`[Startup] APP_ENV=${getAppEnv()} — DB + Keycloak env checks passed`);
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

      // Uptime materializer: run immediately, then every 5 minutes
      materializeUptime().catch((e) => console.error('[UptimeMaterializer] Initial run failed:', e));
      setInterval(() => {
        materializeUptime().catch((e) => console.error('[UptimeMaterializer] Periodic run failed:', e));
      }, 5 * 60 * 1000);
      console.log('[UptimeMaterializer] Scheduled every 5 minutes');

      // Reservation expiry job: expire stale reservations every 30s
      startReservationExpiryJob();

      // Reservation fee capture job: capture authorized fees after grace period
      startReservationFeeCaptureJob();

      // Stale session cleanup: auto-close ACTIVE sessions older than 6h with no updates
      startStaleSessionCleanupJob();
    });
  })
  .catch((err) => {
    console.error('[Startup] Failed to start API server:', err);
    process.exit(1);
  });
