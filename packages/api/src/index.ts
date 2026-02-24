import 'dotenv/config';
import { buildServer } from './server';

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

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
