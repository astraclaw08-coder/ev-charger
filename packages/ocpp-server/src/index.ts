import 'dotenv/config';
import { startServer } from './server';
import { attachInternalRoutes } from './internalHttp';

const PORT = parseInt(process.env.OCPP_PORT ?? '9000', 10);

startServer(PORT)
  .then(({ httpServer }) => {
    // Management REST routes share the same port as the OCPP WebSocket server.
    // On Railway, only the declared PORT is reachable on the private network,
    // so we can't run a separate management server on a different port.
    attachInternalRoutes(httpServer);
  })
  .catch((err: Error) => {
    console.error('[Startup] Failed to start OCPP server:', err);
    process.exit(1);
  });
