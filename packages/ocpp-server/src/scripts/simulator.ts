/**
 * OCPP 1.6 Charger Simulator
 * Connects as CP001 and runs a full charging session end-to-end.
 *
 * Usage:  npm run test:ocpp-sim  (from project root or packages/ocpp-server)
 * Requires the OCPP server to be running on localhost:9000.
 */
import 'dotenv/config';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { RPCClient } = require('ocpp-rpc');

const SERVER_URL = process.env.OCPP_SIM_SERVER ?? 'ws://localhost:9000';
const CHARGER_ID = 'CP001';
const CHARGER_PASS = 'cp001-secret';
const CONNECTOR_ID = 1;
const ID_TAG = 'TESTDRIVER0001';

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function printSep(label: string) {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  ${label}`);
  console.log('─'.repeat(50));
}

async function run() {
  printSep('EV Charger Simulator — OCPP 1.6J');
  console.log(`Server : ${SERVER_URL}`);
  console.log(`Charger: ${CHARGER_ID}  pass: ${CHARGER_PASS}`);
  console.log(`IdTag  : ${ID_TAG}`);

  // ── 1. Connect ──────────────────────────────────────────────────────────────
  printSep('Step 1: Connect to server');
  const client = new RPCClient({
    endpoint: SERVER_URL,
    identity: CHARGER_ID,
    password: CHARGER_PASS,
    protocols: ['ocpp1.6'],
    strictMode: false,
  });

  await client.connect();
  console.log('✅ Connected');

  // Register handler for RemoteStartTransaction (server → charger)
  client.handle('RemoteStartTransaction', ({ params }: any) => {
    console.log(`[Sim] Received RemoteStartTransaction: connectorId=${params.connectorId} idTag=${params.idTag}`);
    return { status: 'Accepted' };
  });

  // Register handler for RemoteStopTransaction (server → charger)
  client.handle('RemoteStopTransaction', ({ params }: any) => {
    console.log(`[Sim] Received RemoteStopTransaction: transactionId=${params.transactionId}`);
    return { status: 'Accepted' };
  });

  // ── 2. BootNotification ─────────────────────────────────────────────────────
  printSep('Step 2: BootNotification');
  const boot = await client.call('BootNotification', {
    chargePointVendor: 'ABB',
    chargePointModel: 'Terra 54',
    chargePointSerialNumber: 'ABB-EVL9-001',
    firmwareVersion: '1.0.0',
  });
  console.log(`← status: ${boot.status}, interval: ${boot.interval}s`);
  console.log(`  serverTime: ${boot.currentTime}`);
  if (boot.status !== 'Accepted') {
    throw new Error(`BootNotification rejected: ${boot.status}`);
  }

  // ── 3. Heartbeat ────────────────────────────────────────────────────────────
  printSep('Step 3: Heartbeat');
  const hb = await client.call('Heartbeat', {});
  console.log(`← currentTime: ${hb.currentTime}`);

  // ── 4. StatusNotification — charger available ───────────────────────────────
  printSep('Step 4: StatusNotification (Available)');
  await client.call('StatusNotification', {
    connectorId: CONNECTOR_ID,
    status: 'Available',
    errorCode: 'NoError',
    timestamp: new Date().toISOString(),
  });
  console.log('← {} (acknowledged)');

  // ── 5. Authorize ────────────────────────────────────────────────────────────
  printSep('Step 5: Authorize');
  const auth = await client.call('Authorize', { idTag: ID_TAG });
  console.log(`← idTagInfo.status: ${auth.idTagInfo.status}`);
  if (auth.idTagInfo.status !== 'Accepted') {
    throw new Error(`Authorization failed: ${auth.idTagInfo.status}`);
  }

  // ── 6. StatusNotification — preparing ──────────────────────────────────────
  printSep('Step 6: StatusNotification (Preparing)');
  await client.call('StatusNotification', {
    connectorId: CONNECTOR_ID,
    status: 'Preparing',
    errorCode: 'NoError',
    timestamp: new Date().toISOString(),
  });
  console.log('← {} (acknowledged)');

  // ── 7. StartTransaction ────────────────────────────────────────────────────
  printSep('Step 7: StartTransaction');
  const METER_START_WH = 10000;
  const start = await client.call('StartTransaction', {
    connectorId: CONNECTOR_ID,
    idTag: ID_TAG,
    meterStart: METER_START_WH,
    timestamp: new Date().toISOString(),
  });
  console.log(`← transactionId: ${start.transactionId}`);
  console.log(`  idTagInfo.status: ${start.idTagInfo.status}`);

  const transactionId: number = start.transactionId;

  if (start.idTagInfo.status !== 'Accepted' || !transactionId) {
    throw new Error(`StartTransaction failed: ${JSON.stringify(start)}`);
  }

  // ── 8. StatusNotification — charging ───────────────────────────────────────
  printSep('Step 8: StatusNotification (Charging)');
  await client.call('StatusNotification', {
    connectorId: CONNECTOR_ID,
    status: 'Charging',
    errorCode: 'NoError',
    timestamp: new Date().toISOString(),
  });
  console.log('← {} (acknowledged)');

  // ── 9. MeterValues (x3 over 6 seconds) ────────────────────────────────────
  printSep('Step 9: MeterValues (3 readings)');
  const meterReadings = [10500, 11000, 11500]; // Wh
  for (let i = 0; i < meterReadings.length; i++) {
    await sleep(1000);
    const reading = meterReadings[i];
    await client.call('MeterValues', {
      connectorId: CONNECTOR_ID,
      transactionId,
      meterValue: [{
        timestamp: new Date().toISOString(),
        sampledValue: [{
          value: String(reading),
          measurand: 'Energy.Active.Import.Register',
          unit: 'Wh',
          context: 'Sample.Periodic',
        }],
      }],
    });
    console.log(`  Reading ${i + 1}: ${reading} Wh`);
  }
  console.log('← {} (all acknowledged)');

  // ── 10. StopTransaction ────────────────────────────────────────────────────
  printSep('Step 10: StopTransaction');
  const METER_STOP_WH = 11500;
  const stop = await client.call('StopTransaction', {
    transactionId,
    idTag: ID_TAG,
    meterStop: METER_STOP_WH,
    timestamp: new Date().toISOString(),
    reason: 'Local',
  });
  console.log(`← idTagInfo.status: ${stop.idTagInfo?.status ?? '(none)'}`);

  const kwhDelivered = (METER_STOP_WH - METER_START_WH) / 1000;
  console.log(`  Energy delivered: ${kwhDelivered.toFixed(3)} kWh`);

  // ── 11. StatusNotification — available again ───────────────────────────────
  printSep('Step 11: StatusNotification (Available)');
  await client.call('StatusNotification', {
    connectorId: CONNECTOR_ID,
    status: 'Available',
    errorCode: 'NoError',
    timestamp: new Date().toISOString(),
  });
  console.log('← {} (acknowledged)');

  // ── Done ───────────────────────────────────────────────────────────────────
  printSep('✅ Simulation complete!');
  console.log(`Session summary:`);
  console.log(`  Charger      : ${CHARGER_ID}`);
  console.log(`  TransactionId: ${transactionId}`);
  console.log(`  Energy       : ${kwhDelivered.toFixed(3)} kWh`);
  console.log(`  Cost estimate: $${(kwhDelivered * 0.35).toFixed(2)} @ $0.35/kWh`);
  console.log('');
  console.log('Check the database — Session should be COMPLETED with kwhDelivered set.');
  console.log('');

  await client.close();
  process.exit(0);
}

run().catch((err: Error) => {
  console.error('\n❌ Simulator error:', err.message);
  process.exit(1);
});
