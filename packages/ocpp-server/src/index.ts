import 'dotenv/config';
import { startServer } from './server';
import { startInternalHttpServer } from './internalHttp';

const PORT = parseInt(process.env.OCPP_PORT ?? '9000', 10);
const INTERNAL_PORT = parseInt(process.env.OCPP_INTERNAL_PORT ?? '9001', 10);

startServer(PORT).catch((err: Error) => {
  console.error('[Startup] Failed to start OCPP server:', err);
  process.exit(1);
});

startInternalHttpServer(INTERNAL_PORT);
