import Fastify from 'fastify';
import cors from '@fastify/cors';
import { chargerRoutes } from './routes/chargers';
import { sessionRoutes } from './routes/sessions';
import { siteRoutes } from './routes/sites';
import { paymentRoutes } from './routes/payments';
import { profileRoutes } from './routes/profile';
import { authRoutes } from './routes/auth';
import { adminUserRoutes } from './routes/adminUsers';
import { adminSecurityRoutes } from './routes/adminSecurity';
import { adminSettingsRoutes } from './routes/adminSettings';
import { readModelRoutes } from './routes/readModels';
import { smartChargingRoutes } from './routes/smartCharging';
import { favoriteRoutes } from './routes/favorites';
import { qrRedirectRoutes } from './routes/qrRedirect';
import { supportDriverRoutes } from './routes/supportDrivers';
import { agentChatRoutes } from './routes/agentChat';
import { openaiOAuthRoutes } from './routes/openaiOAuth';
import { organizationRoutes } from './routes/organizations';
import { portfolioRoutes } from './routes/portfolios';
import { reportRoutes } from './routes/reports';
import { internalRoutes } from './routes/internal';
import { reservationRoutes } from './routes/reservations';
// Temporarily disabled until notification Prisma models/types are aligned.
// import { notificationRoutes } from './routes/notifications';
import { prisma } from '@ev-charger/shared';

export async function buildServer() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    // Trust Railway's reverse proxy so req.ip resolves to the real client IP
    // from X-Forwarded-For instead of the internal load-balancer address.
    // Without this every mobile user shares the same IP → shared auth-failure bucket.
    trustProxy: true,
  });

  await app.register(cors, { origin: true });

  // Parse JSON bodies as Buffer so Stripe webhook can verify raw signature.
  // The parsed object is still available as req.body; raw buffer at req.rawBody.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_req, body, done) => {
      (_req as unknown as { rawBody: Buffer }).rawBody = body as Buffer;
      const str = (body as Buffer).toString();
      // Empty body is valid for POST routes that take no request body (e.g. /sessions/:id/stop)
      if (!str) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(str));
      } catch (err: unknown) {
        const e = err as Error & { statusCode?: number };
        e.statusCode = 400;
        done(e, undefined);
      }
    },
  );

  app.get('/health', async () => {
    try {
      await prisma.$queryRawUnsafe('SELECT 1');
      return { status: 'ok', service: 'ev-charger-api', db: 'ok' };
    } catch (error) {
      app.log.error({ error }, 'Health DB check failed');
      return { status: 'error', service: 'ev-charger-api', db: 'down' };
    }
  });

  await app.register(chargerRoutes);
  await app.register(sessionRoutes);
  await app.register(siteRoutes);
  await app.register(organizationRoutes);
  await app.register(portfolioRoutes);
  await app.register(paymentRoutes);
  await app.register(profileRoutes);
  await app.register(favoriteRoutes);
  await app.register(authRoutes);
  await app.register(adminUserRoutes);
  await app.register(adminSecurityRoutes);
  await app.register(adminSettingsRoutes);
  await app.register(readModelRoutes);
  await app.register(smartChargingRoutes);
  await app.register(supportDriverRoutes);
  await app.register(qrRedirectRoutes);
  await app.register(agentChatRoutes);
  await app.register(openaiOAuthRoutes);
  await app.register(reportRoutes);
  await app.register(internalRoutes);
  await app.register(reservationRoutes);
  // await app.register(notificationRoutes);

  return app;
}
