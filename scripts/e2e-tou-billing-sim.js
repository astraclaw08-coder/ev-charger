/* eslint-disable no-console */
const { PrismaClient } = require('../node_modules/.prisma/client');
const { RPCClient } = require('ocpp-rpc');

const prisma = new PrismaClient();

const OCPP_URL = process.env.OCPP_SIM_SERVER || 'ws://localhost:9000';
const API_URL = process.env.API_URL || 'http://localhost:3001';
const CHARGER_ID = process.env.CHARGER_ID || 'CP001';
const CHARGER_PASS = process.env.CHARGER_PASS || 'cp001-secret';
const CONNECTOR_ID = Number(process.env.CONNECTOR_ID || 1);
const ID_TAG = process.env.ID_TAG || 'TESTDRIVER0001';

function approxEq(a, b, eps = 0.02) {
  return Math.abs(Number(a) - Number(b)) <= eps;
}

function fmt(n) {
  return Number(n).toFixed(2);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const { computeSessionAmounts } = require('../packages/api/dist/lib/sessionBilling.js');

async function buildSessionViewModel(session) {
  const amounts = computeSessionAmounts({
    ...session,
    pricingMode: session.connector?.charger?.site?.pricingMode,
    pricePerKwhUsd: session.connector?.charger?.site?.pricePerKwhUsd,
    idleFeePerMinUsd: session.connector?.charger?.site?.idleFeePerMinUsd,
    activationFeeUsd: session.connector?.charger?.site?.activationFeeUsd,
    gracePeriodMin: session.connector?.charger?.site?.gracePeriodMin,
    touWindows: session.connector?.charger?.site?.touWindows,
    softwareVendorFeeMode: session.connector?.charger?.site?.softwareVendorFeeMode,
    softwareVendorFeeValue: session.connector?.charger?.site?.softwareVendorFeeValue,
    softwareFeeIncludesActivation: session.connector?.charger?.site?.softwareFeeIncludesActivation,
  });

  return {
    ...session,
    estimatedAmountCents: amounts.estimatedAmountCents,
    effectiveAmountCents: amounts.effectiveAmountCents,
    amountState: amounts.amountState,
    amountLabel: amounts.amountLabel,
    isAmountFinal: amounts.isAmountFinal,
    billingBreakdown: amounts.billingBreakdown,
  };
}

async function waitForSessionByTransaction(transactionId, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = await prisma.session.findFirst({
      where: { transactionId },
      include: { connector: { include: { charger: { include: { site: true } } } }, payment: true },
      orderBy: { createdAt: 'desc' },
    });
    if (s) return s;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for session transactionId=${transactionId}`);
}

function txDataPoint(ts, context, valueWh) {
  return {
    timestamp: ts,
    sampledValue: [
      {
        value: String(valueWh),
        context,
        measurand: 'Energy.Active.Import.Register',
        unit: 'Wh',
      },
    ],
  };
}

async function runScenario(client, siteId, scenario) {
  const {
    name,
    pricingMode,
    touWindows,
    pricePerKwhUsd,
    idleFeePerMinUsd,
    activationFeeUsd,
    gracePeriodMin,
    startTs,
    stopTs,
    meterStart,
    txBeginWh,
    txEndWh,
    expected,
  } = scenario;

  await prisma.site.update({
    where: { id: siteId },
    data: {
      pricingMode,
      touWindows,
      pricePerKwhUsd,
      idleFeePerMinUsd,
      activationFeeUsd,
      gracePeriodMin,
    },
  });

  await client.call('StatusNotification', {
    connectorId: CONNECTOR_ID,
    status: 'Preparing',
    errorCode: 'NoError',
    timestamp: startTs,
  });

  const startRes = await client.call('StartTransaction', {
    connectorId: CONNECTOR_ID,
    idTag: ID_TAG,
    meterStart,
    timestamp: startTs,
  });
  assert(startRes?.idTagInfo?.status === 'Accepted', `${name}: StartTransaction rejected`);
  const transactionId = startRes.transactionId;
  assert(Number.isInteger(transactionId) && transactionId > 0, `${name}: invalid transactionId`);

  await client.call('StatusNotification', {
    connectorId: CONNECTOR_ID,
    status: 'Charging',
    errorCode: 'NoError',
    timestamp: startTs,
  });

  await client.call('MeterValues', {
    connectorId: CONNECTOR_ID,
    transactionId,
    meterValue: [txDataPoint(startTs, 'Sample.Periodic', meterStart + 500)],
  });

  await client.call('StopTransaction', {
    transactionId,
    idTag: ID_TAG,
    meterStop: txEndWh,
    timestamp: stopTs,
    reason: 'Local',
    transactionData: [
      txDataPoint(startTs, 'Transaction.Begin', txBeginWh),
      txDataPoint(stopTs, 'Transaction.End', txEndWh),
    ],
  });

  await client.call('StatusNotification', {
    connectorId: CONNECTOR_ID,
    status: 'Available',
    errorCode: 'NoError',
    timestamp: stopTs,
  });

  const session = await waitForSessionByTransaction(transactionId);
  const apiSession = await buildSessionViewModel(session);
  const breakdown = apiSession.billingBreakdown;
  assert(breakdown, `${name}: billingBreakdown missing`);

  const actual = {
    pricingMode: breakdown.pricingMode,
    energyUsd: Number(breakdown.totals?.energyUsd ?? breakdown.energy?.totalUsd ?? 0),
    idleUsd: Number(breakdown.totals?.idleUsd ?? breakdown.idle?.totalUsd ?? 0),
    activationUsd: Number(breakdown.totals?.activationUsd ?? breakdown.activation?.totalUsd ?? 0),
    grossUsd: Number(breakdown.totals?.grossUsd ?? breakdown.grossTotalUsd ?? 0),
    idleMinutes: Number(breakdown.idle?.minutes ?? 0),
    segments: Number((breakdown.energy?.segments || []).length),
    amountState: apiSession.amountState,
  };

  assert(actual.pricingMode === expected.pricingMode, `${name}: pricingMode expected ${expected.pricingMode} got ${actual.pricingMode}`);
  if (expected.minSegments != null) assert(actual.segments >= expected.minSegments, `${name}: expected >=${expected.minSegments} segments got ${actual.segments}`);
  if (expected.segments != null) assert(actual.segments === expected.segments, `${name}: expected ${expected.segments} segments got ${actual.segments}`);
  if (expected.energyUsd != null) assert(approxEq(actual.energyUsd, expected.energyUsd), `${name}: energyUsd expected ${fmt(expected.energyUsd)} got ${fmt(actual.energyUsd)}`);
  if (expected.idleUsd != null) assert(approxEq(actual.idleUsd, expected.idleUsd), `${name}: idleUsd expected ${fmt(expected.idleUsd)} got ${fmt(actual.idleUsd)}`);
  if (expected.activationUsd != null) assert(approxEq(actual.activationUsd, expected.activationUsd), `${name}: activationUsd expected ${fmt(expected.activationUsd)} got ${fmt(actual.activationUsd)}`);
  if (expected.grossUsd != null) assert(approxEq(actual.grossUsd, expected.grossUsd), `${name}: grossUsd expected ${fmt(expected.grossUsd)} got ${fmt(actual.grossUsd)}`);
  if (expected.idleMinutes != null) assert(approxEq(actual.idleMinutes, expected.idleMinutes, 0.1), `${name}: idleMinutes expected ${expected.idleMinutes} got ${actual.idleMinutes}`);

  return {
    name,
    transactionId,
    sessionId: session.id,
    actual,
    receiptPreview: {
      amountState: apiSession.amountState,
      amountLabel: apiSession.amountLabel,
      lineItems: (apiSession.billingBreakdown?.energy?.segments || []).map((s) => ({
        window: `${s.startedAt} -> ${s.endedAt}`,
        kwh: s.kwh,
        rate: s.pricePerKwhUsd,
        energyAmountUsd: s.energyAmountUsd,
      })),
    },
  };
}

async function main() {
  const charger = await prisma.charger.findUnique({
    where: { ocppId: CHARGER_ID },
    include: { site: true },
  });
  if (!charger) throw new Error(`Charger ${CHARGER_ID} not found`);

  const originalSite = {
    pricingMode: charger.site.pricingMode,
    touWindows: charger.site.touWindows,
    pricePerKwhUsd: charger.site.pricePerKwhUsd,
    idleFeePerMinUsd: charger.site.idleFeePerMinUsd,
    activationFeeUsd: charger.site.activationFeeUsd,
    gracePeriodMin: charger.site.gracePeriodMin,
  };

  const client = new RPCClient({
    endpoint: OCPP_URL,
    identity: CHARGER_ID,
    password: CHARGER_PASS,
    protocols: ['ocpp1.6'],
    strictMode: false,
  });

  client.handle('RemoteStartTransaction', () => ({ status: 'Accepted' }));
  client.handle('RemoteStopTransaction', () => ({ status: 'Accepted' }));

  const scenarios = [
    {
      name: 'S1-flat-fallback-no-window-match',
      pricingMode: 'tou',
      touWindows: [
        { day: 3, start: '18:00', end: '19:00', pricePerKwhUsd: 0.2, idleFeePerMinUsd: 0.05 },
      ],
      pricePerKwhUsd: 0.35,
      idleFeePerMinUsd: 0.08,
      activationFeeUsd: 0,
      gracePeriodMin: 10,
      startTs: '2026-03-18T17:30:00.000Z',
      stopTs: '2026-03-18T17:50:00.000Z',
      meterStart: 10000,
      txBeginWh: 10000,
      txEndWh: 12000,
      expected: {
        pricingMode: 'tou',
        segments: 1,
        energyUsd: 0.7,
        idleMinutes: 10,
        idleUsd: 0.8,
        activationUsd: 0,
        grossUsd: 1.5,
      },
    },
    {
      name: 'S2-single-window-tou',
      pricingMode: 'tou',
      touWindows: [
        { day: 3, start: '18:00', end: '19:00', pricePerKwhUsd: 0.2, idleFeePerMinUsd: 0.05 },
      ],
      pricePerKwhUsd: 0.35,
      idleFeePerMinUsd: 0.08,
      activationFeeUsd: 0,
      gracePeriodMin: 10,
      startTs: '2026-03-18T18:10:00.000Z',
      stopTs: '2026-03-18T18:40:00.000Z',
      meterStart: 20000,
      txBeginWh: 20000,
      txEndWh: 24000,
      expected: {
        pricingMode: 'tou',
        segments: 1,
        energyUsd: 0.8,
        idleMinutes: 20,
        idleUsd: 1.0,
        activationUsd: 0,
        grossUsd: 1.8,
      },
    },
    {
      name: 'S3-cross-window-tou-segmentation',
      pricingMode: 'tou',
      touWindows: [
        { day: 3, start: '18:00', end: '19:00', pricePerKwhUsd: 0.2, idleFeePerMinUsd: 0.05 },
        { day: 3, start: '19:00', end: '20:00', pricePerKwhUsd: 0.5, idleFeePerMinUsd: 0.2 },
      ],
      pricePerKwhUsd: 0.35,
      idleFeePerMinUsd: 0.08,
      activationFeeUsd: 0,
      gracePeriodMin: 10,
      startTs: '2026-03-18T18:50:00.000Z',
      stopTs: '2026-03-18T19:20:00.000Z',
      meterStart: 30000,
      txBeginWh: 30000,
      txEndWh: 35000,
      expected: {
        pricingMode: 'tou',
        minSegments: 2,
        energyUsd: 2.0,
        idleMinutes: 20,
        idleUsd: 3.0,
        activationUsd: 0,
        grossUsd: 5.0,
      },
    },
    {
      name: 'S4-idle-plus-activation',
      pricingMode: 'tou',
      touWindows: [
        { day: 3, start: '18:00', end: '19:00', pricePerKwhUsd: 0.2, idleFeePerMinUsd: 0.05 },
      ],
      pricePerKwhUsd: 0.35,
      idleFeePerMinUsd: 0.08,
      activationFeeUsd: 1.25,
      gracePeriodMin: 5,
      startTs: '2026-03-18T18:00:00.000Z',
      stopTs: '2026-03-18T18:30:00.000Z',
      meterStart: 40000,
      txBeginWh: 40000,
      txEndWh: 43000,
      expected: {
        pricingMode: 'tou',
        segments: 1,
        energyUsd: 0.6,
        idleMinutes: 25,
        idleUsd: 1.25,
        activationUsd: 1.25,
        grossUsd: 3.1,
      },
    },
  ];

  const results = [];
  try {
    await client.connect();
    const boot = await client.call('BootNotification', {
      chargePointVendor: 'ABB',
      chargePointModel: 'Terra 54',
      chargePointSerialNumber: `SIM-${CHARGER_ID}`,
      firmwareVersion: '1.0.0',
    });
    if (boot?.status !== 'Accepted') throw new Error(`BootNotification rejected: ${boot?.status}`);

    await client.call('Heartbeat', {});
    await client.call('StatusNotification', {
      connectorId: CONNECTOR_ID,
      status: 'Available',
      errorCode: 'NoError',
      timestamp: new Date().toISOString(),
    });

    for (const s of scenarios) {
      const r = await runScenario(client, charger.siteId, s);
      results.push(r);
      console.log(`PASS ${r.name} tx=${r.transactionId} session=${r.sessionId} gross=$${fmt(r.actual.grossUsd)} segments=${r.actual.segments}`);
    }

    console.log('\n=== E2E TOU BILLING SUMMARY ===');
    for (const r of results) {
      console.log(`${r.name}: gross=$${fmt(r.actual.grossUsd)} energy=$${fmt(r.actual.energyUsd)} idle=$${fmt(r.actual.idleUsd)} activation=$${fmt(r.actual.activationUsd)} state=${r.actual.amountState}`);
    }
    console.log('ALL_SCENARIOS_PASS');
  } finally {
    await prisma.site.update({ where: { id: charger.siteId }, data: originalSite });
    await client.close().catch(() => {});
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(`FAIL ${err.message}`);
  process.exit(1);
});
