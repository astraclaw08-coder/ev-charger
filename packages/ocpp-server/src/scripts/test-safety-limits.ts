/**
 * Test script for session safety limits.
 * Connects a simulated charger, starts a charging session, and waits
 * for the safety enforcement loop to auto-stop it.
 */
import { RPCClient } from 'ocpp-rpc';

const WS_URL = process.env.OCPP_URL ?? 'ws://127.0.0.1:9000';
const CHARGER_ID = 'SAFETY-TEST-001';
const CONNECTOR_ID = 1;
const ID_TAG = 'TESTDRIVER0001';

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  log(`Connecting to ${WS_URL}/${CHARGER_ID}...`);
  const client = new RPCClient({
    endpoint: `${WS_URL}/${CHARGER_ID}`,
    identity: CHARGER_ID,
    protocols: ['ocpp1.6'],
    strictMode: false,
  });

  let stopped = false;

  // Handle RemoteStopTransaction from server
  client.handle('RemoteStopTransaction', ({ params }: any) => {
    log(`🛑 RECEIVED RemoteStopTransaction! transactionId=${params.transactionId}`);
    log('✅ Safety enforcement loop triggered the stop!');
    stopped = true;
    return { status: 'Accepted' };
  });

  // Handle other server-initiated messages
  client.handle('SetChargingProfile', () => ({ status: 'Accepted' }));
  client.handle('GetConfiguration', () => ({ configurationKey: [], unknownKey: [] }));
  client.handle('TriggerMessage', () => ({ status: 'Accepted' }));
  client.handle('RemoteStartTransaction', () => ({ status: 'Accepted' }));
  client.handle('Reset', () => ({ status: 'Accepted' }));

  await client.connect();
  log('Connected. Sending BootNotification...');

  const boot = await client.call('BootNotification', {
    chargePointVendor: 'TestVendor',
    chargePointModel: 'SafetyTest',
    chargePointSerialNumber: 'ST-001',
    firmwareVersion: '1.0.0',
  });
  log(`BootNotification: ${boot.status}`);

  // Send heartbeat (required before commands per boot gate)
  await client.call('Heartbeat', {});
  log('Heartbeat sent.');

  // Report Available status
  await client.call('StatusNotification', {
    connectorId: CONNECTOR_ID,
    status: 'Available',
    errorCode: 'NoError',
    timestamp: new Date().toISOString(),
  });

  await sleep(1000);

  // Authorize
  const auth = await client.call('Authorize', { idTag: ID_TAG });
  log(`Authorize: ${auth.idTagInfo.status}`);

  // Start transaction
  const meterStart = 10000; // 10 kWh already on meter
  const start = await client.call('StartTransaction', {
    connectorId: CONNECTOR_ID,
    idTag: ID_TAG,
    meterStart,
    timestamp: new Date().toISOString(),
  });
  const transactionId = start.transactionId;
  log(`StartTransaction: transactionId=${transactionId}, meterStart=${meterStart}`);

  // Report Charging status
  await client.call('StatusNotification', {
    connectorId: CONNECTOR_ID,
    status: 'Charging',
    errorCode: 'NoError',
    timestamp: new Date().toISOString(),
  });

  // Send meter values every 30 seconds, simulating energy flow
  let currentMeter = meterStart;
  const interval = setInterval(async () => {
    if (stopped) return;
    currentMeter += 500; // +0.5 kWh per reading
    try {
      await client.call('MeterValues', {
        connectorId: CONNECTOR_ID,
        transactionId,
        meterValue: [{
          timestamp: new Date().toISOString(),
          sampledValue: [{
            value: String(currentMeter),
            measurand: 'Energy.Active.Import.Register',
            unit: 'Wh',
          }],
        }],
      });
      const kwh = (currentMeter - meterStart) / 1000;
      log(`MeterValues: ${currentMeter} Wh (${kwh.toFixed(1)} kWh delivered)`);
    } catch (err) {
      log(`MeterValues error: ${err}`);
    }
  }, 30_000);

  // Wait up to 4 minutes for safety enforcement to stop us
  log('Waiting for safety enforcement loop to stop the session (maxChargeDuration=2min)...');
  const startTime = Date.now();
  while (!stopped && Date.now() - startTime < 240_000) {
    await sleep(5_000);
    const elapsed = ((Date.now() - startTime) / 60_000).toFixed(1);
    if (!stopped) log(`Still charging... elapsed=${elapsed}min`);
  }

  clearInterval(interval);

  if (stopped) {
    // Send StopTransaction
    await client.call('StopTransaction', {
      transactionId,
      meterStop: currentMeter,
      timestamp: new Date().toISOString(),
      reason: 'Remote',
      idTag: ID_TAG,
    });
    log(`StopTransaction sent. Final meter: ${currentMeter} Wh, kWh: ${((currentMeter - meterStart) / 1000).toFixed(1)}`);
    log('🎉 TEST PASSED — safety enforcement auto-stopped the session!');
  } else {
    log('❌ TEST FAILED — session was NOT stopped within 4 minutes.');
  }

  await client.close();
  process.exit(stopped ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
