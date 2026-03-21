/* eslint-disable no-console */
const { PrismaClient } = require('../node_modules/.prisma/client');
const { RPCClient } = require('ocpp-rpc');

const prisma = new PrismaClient();

const OCPP_URL = process.env.OCPP_SIM_SERVER || 'ws://localhost:9000';
const CHARGER_ID = process.env.CHARGER_ID || 'CP001';
const CHARGER_PASS = process.env.CHARGER_PASS || 'cp001-secret';
const CONNECTOR_ID = Number(process.env.CONNECTOR_ID || 1);
const ID_TAG = process.env.ID_TAG || 'KC69BD116FC603976D83';

function txDataPoint(ts, context, valueWh) {
  return {
    timestamp: ts,
    sampledValue: [{ value: String(valueWh), context, measurand: 'Energy.Active.Import.Register', unit: 'Wh' }],
  };
}

async function waitForSessionByTransaction(transactionId, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = await prisma.session.findFirst({ where: { transactionId }, orderBy: { createdAt: 'desc' } });
    if (s) return s;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for transaction ${transactionId}`);
}

async function runOne(client, scenario) {
  await client.call('StatusNotification', { connectorId: CONNECTOR_ID, status: 'Preparing', errorCode: 'NoError', timestamp: scenario.startTs });

  const start = await client.call('StartTransaction', {
    connectorId: CONNECTOR_ID,
    idTag: ID_TAG,
    meterStart: scenario.txBeginWh,
    timestamp: scenario.startTs,
  });

  const tx = start.transactionId;
  if (!tx || start?.idTagInfo?.status !== 'Accepted') throw new Error(`StartTransaction failed for ${scenario.name}`);

  await client.call('StatusNotification', { connectorId: CONNECTOR_ID, status: 'Charging', errorCode: 'NoError', timestamp: scenario.startTs });
  await client.call('MeterValues', {
    connectorId: CONNECTOR_ID,
    transactionId: tx,
    meterValue: [txDataPoint(scenario.startTs, 'Sample.Periodic', scenario.txBeginWh + 500)],
  });

  await client.call('StopTransaction', {
    transactionId: tx,
    idTag: ID_TAG,
    meterStop: scenario.txEndWh,
    timestamp: scenario.stopTs,
    reason: 'Local',
    transactionData: [
      txDataPoint(scenario.startTs, 'Transaction.Begin', scenario.txBeginWh),
      txDataPoint(scenario.stopTs, 'Transaction.End', scenario.txEndWh),
    ],
  });

  await client.call('StatusNotification', { connectorId: CONNECTOR_ID, status: 'Available', errorCode: 'NoError', timestamp: scenario.stopTs });
  const session = await waitForSessionByTransaction(tx);
  return { name: scenario.name, transactionId: tx, sessionId: session.id };
}

async function main() {
  const charger = await prisma.charger.findUnique({ where: { ocppId: CHARGER_ID }, include: { site: true } });
  if (!charger) throw new Error(`Charger ${CHARGER_ID} not found`);

  await prisma.site.update({
    where: { id: charger.siteId },
    data: {
      pricingMode: 'tou',
      touWindows: [
        { day: 3, start: '18:00', end: '19:00', pricePerKwhUsd: 0.2, idleFeePerMinUsd: 0.05 },
        { day: 3, start: '19:00', end: '20:00', pricePerKwhUsd: 0.5, idleFeePerMinUsd: 0.2 },
      ],
      pricePerKwhUsd: 0.35,
      idleFeePerMinUsd: 0.08,
      activationFeeUsd: 1.25,
      gracePeriodMin: 5,
    },
  });

  const client = new RPCClient({ endpoint: OCPP_URL, identity: CHARGER_ID, password: CHARGER_PASS, protocols: ['ocpp1.6'], strictMode: false });
  client.handle('RemoteStartTransaction', () => ({ status: 'Accepted' }));
  client.handle('RemoteStopTransaction', () => ({ status: 'Accepted' }));

  await client.connect();
  await client.call('BootNotification', { chargePointVendor: 'ABB', chargePointModel: 'Terra 54', chargePointSerialNumber: `SIM-${CHARGER_ID}`, firmwareVersion: '1.0.0' });
  await client.call('Heartbeat', {});
  await client.call('StatusNotification', { connectorId: CONNECTOR_ID, status: 'Available', errorCode: 'NoError', timestamp: new Date().toISOString() });

  const scenarios = [
    { name: 'cross-window', startTs: '2026-03-18T18:50:00.000Z', stopTs: '2026-03-18T19:20:00.000Z', txBeginWh: 30000, txEndWh: 35000 },
    { name: 'idle-activation', startTs: '2026-03-18T18:00:00.000Z', stopTs: '2026-03-18T18:30:00.000Z', txBeginWh: 40000, txEndWh: 43000 },
  ];

  const out = [];
  for (const s of scenarios) out.push(await runOne(client, s));
  console.log(JSON.stringify({ idTag: ID_TAG, userSessions: out }, null, 2));

  await client.close();
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
