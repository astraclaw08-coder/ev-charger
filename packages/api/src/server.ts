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
import { prisma } from '@ev-charger/shared';

export async function buildServer() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
  });

  await app.register(cors, { origin: true });

  // Parse JSON bodies as Buffer so Stripe webhook can verify raw signature.
  // The parsed object is still available as req.body; raw buffer at req.rawBody.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_req, body, done) => {
      (_req as unknown as { rawBody: Buffer }).rawBody = body as Buffer;
      try {
        done(null, JSON.parse((body as Buffer).toString()));
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
      return { status: 'degraded', service: 'ev-charger-api', db: 'down' };
    }
  });

  await app.register(chargerRoutes);
  await app.register(sessionRoutes);
  await app.register(siteRoutes);
  await app.register(paymentRoutes);
  await app.register(profileRoutes);
  await app.register(authRoutes);
  await app.register(adminUserRoutes);
  await app.register(adminSecurityRoutes);
  await app.register(adminSettingsRoutes);

  return app;
}
