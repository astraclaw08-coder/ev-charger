/**
 * Persistent OCPP 1.6 Charger Simulator
 * Connects as CP001, stays online, and responds to RemoteStartTransaction.
 *
 * Usage: OCPP_SIM_SERVER=wss://ocpp-server-production.up.railway.app npx ts-node src/scripts/sim-persistent.ts
 */
import 'dotenv/config';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { RPCClient } = require('ocpp-rpc');

const SERVER_URL = process.env.OCPP_SIM_SERVER ?? 'ws://localhost:9000';
const CHARGER_ID = process.env.CHARGER_ID ?? 'CP001';
const CHARGER_PASS = process.env.CHARGER_PASS ?? 'cp001-secret';
const CONNECTOR_ID = 1;
const METER_START_WH = 10000;

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function runSession(client: any, connectorId: number, idTag: string) {
  log(`[Session] Starting for idTag=${idTag} connector=${connectorId}`);

  // Authorize
  const auth = await client.call('Authorize', { idTag });
  log(`[Authorize] status=${auth.idTagInfo?.status}`);

  // StatusNotification — Preparing
  await client.call('StatusNotification', {
    connectorId,
    status: 'Preparing',
    errorCode: 'NoError',
    timestamp: new Date().toISOString(),
  });

  // StartTransaction
  const start = await client.call('StartTransaction', {
    connectorId,
    idTag,
    meterStart: METER_START_WH,
    timestamp: new Date().toISOString(),
  });
  const transactionId = start.transactionId;
  log(`[StartTransaction] transactionId=${transactionId}`);

  // StatusNotification — Charging
  await client.call('StatusNotification', {
    connectorId,
    status: 'Charging',
    errorCode: 'NoError',
    timestamp: new Date().toISOString(),
  });
  log('[Status] Charging');

  // MeterValues — 3 readings over ~6 seconds
  const meterReadings = [10500, 11000, 11500];
  for (let i = 0; i < meterReadings.length; i++) {
    await sleep(2000);
    await client.call('MeterValues', {
      connectorId,
      transactionId,
      meterValue: [{
        timestamp: new Date().toISOString(),
        sampledValue: [{
          value: String(meterReadings[i]),
          measurand: 'Energy.Active.Import.Register',
          unit: 'Wh',
          context: 'Sample.Periodic',
        }],
      }],
    });
    log(`[MeterValues] ${meterReadings[i]} Wh`);
  }

  // StopTransaction
  await client.call('StopTransaction', {
    transactionId,
    idTag,
    meterStop: 11500,
    timestamp: new Date().toISOString(),
    reason: 'Local',
  });
  const kWh = (11500 - METER_START_WH) / 1000;
  log(`[StopTransaction] complete — ${kWh.toFixed(3)} kWh delivered`);

  // StatusNotification — Available again
  await client.call('StatusNotification', {
    connectorId,
    status: 'Available',
    errorCode: 'NoError',
    timestamp: new Date().toISOString(),
  });
  log('[Status] Available — ready for next session');
}

async function run() {
  log(`Connecting to ${SERVER_URL} as ${CHARGER_ID}...`);

  const client = new RPCClient({
    endpoint: SERVER_URL,
    identity: CHARGER_ID,
    password: CHARGER_PASS,
    protocols: ['ocpp1.6'],
    strictMode: false,
  });

  // Handle RemoteStartTransaction — triggered by the app
  client.handle('RemoteStartTransaction', async ({ params }: any) => {
    log(`[RemoteStart] connectorId=${params.connectorId} idTag=${params.idTag}`);
    // Accept immediately, then run session asynchronously
    setImmediate(() => runSession(client, params.connectorId ?? CONNECTOR_ID, params.idTag));
    return { status: 'Accepted' };
  });

  // Handle RemoteStopTransaction
  client.handle('RemoteStopTransaction', ({ params }: any) => {
    log(`[RemoteStop] transactionId=${params.transactionId}`);
    return { status: 'Accepted' };
  });

  await client.connect();
  log('✅ Connected');

  // BootNotification
  const boot = await client.call('BootNotification', {
    chargePointVendor: 'ABB',
    chargePointModel: 'Terra 54',
    chargePointSerialNumber: `SIM-${CHARGER_ID}`,
    firmwareVersion: '1.0.0',
  });
  log(`[BootNotification] status=${boot.status} interval=${boot.interval}`);

  // Heartbeat loop
  const heartbeatInterval = setInterval(async () => {
    try {
      await client.call('Heartbeat', {});
    } catch {
      // ignore
    }
  }, (boot.interval ?? 60) * 1000);

  // StatusNotification — Available
  await client.call('StatusNotification', {
    connectorId: CONNECTOR_ID,
    status: 'Available',
    errorCode: 'NoError',
    timestamp: new Date().toISOString(),
  });
  log('[Status] Available — waiting for RemoteStartTransaction...');

  // Keep alive
  process.on('SIGINT', async () => {
    log('Shutting down...');
    clearInterval(heartbeatInterval);
    await client.close();
    process.exit(0);
  });
}

run().catch((err: Error) => {
  console.error('❌ Simulator error:', err.message);
  process.exit(1);
});
