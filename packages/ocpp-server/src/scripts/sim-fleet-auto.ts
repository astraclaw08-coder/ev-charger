/**
 * OCPP 1.6 Fleet-Auto Charger Simulator (TASK-0208 Phase 3 Slice E rehearsal).
 *
 * Drives a server-initiated fleet session end-to-end:
 *   1. Connect, BootNotification, Heartbeat (boot+heartbeat readiness)
 *   2. StatusNotification(Available)
 *   3. StatusNotification(Preparing)  ← plug-in trigger fires maybeAutoStartFleet
 *   4. WAIT for inbound RemoteStartTransaction from server
 *   5. Reply Accepted, then drive Authorize → StartTransaction with the
 *      idTag the server picked (policy.autoStartIdTag)
 *   6. MeterValues (a few samples)
 *   7. StopTransaction → Available
 *
 * Run: SIM_CHARGER_ID=CP002 SIM_CHARGER_PASS=cp002-secret \
 *      OCPP_SIM_SERVER=ws://localhost:9000 \
 *      npx ts-node packages/ocpp-server/src/scripts/sim-fleet-auto.ts
 *
 * Local-only. Never connects to prod. Reads no env beyond the three sim vars.
 */
import 'dotenv/config';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { RPCClient } = require('ocpp-rpc');

const SERVER_URL = process.env.OCPP_SIM_SERVER ?? 'ws://localhost:9000';
const CHARGER_ID = process.env.SIM_CHARGER_ID ?? 'CP002';
const CHARGER_PASS = process.env.SIM_CHARGER_PASS ?? 'cp002-secret';
const CONNECTOR_ID = Number(process.env.SIM_CONNECTOR_ID ?? '1');
const REMOTE_START_TIMEOUT_MS = Number(process.env.SIM_REMOTE_START_TIMEOUT_MS ?? '15000');
const NEGATIVE_MODE = process.env.SIM_NEGATIVE === 'true';

// Profile-shape assertion (TASK-0208 release-stackLevel bug regression guard).
// When SIM_ASSERT_PROFILE_STACK_LEVEL is set (recommended: "90"), the sim
// fails with exit 2 if the FIRST inbound SetChargingProfile push doesn't
// match. Optionally also set SIM_ASSERT_PROFILE_LIMIT to lock the limit
// (e.g. policy maxAmps) — leave unset to skip that part.
const EXPECT_STACK_LEVEL = process.env.SIM_ASSERT_PROFILE_STACK_LEVEL
  ? Number(process.env.SIM_ASSERT_PROFILE_STACK_LEVEL)
  : null;
const EXPECT_LIMIT = process.env.SIM_ASSERT_PROFILE_LIMIT
  ? Number(process.env.SIM_ASSERT_PROFILE_LIMIT)
  : null;

// Slice E negative-test mode: skip Authorize/StartTransaction. We expect
// no RemoteStartTransaction to arrive — exit 0 if the timeout fires;
// exit 1 if one DOES arrive (auto-start should have been suppressed).

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function sep(label: string) {
  console.log(`\n${'─'.repeat(50)}\n  ${label}\n${'─'.repeat(50)}`);
}

async function run() {
  sep(`Fleet-Auto Sim — ${CHARGER_ID} → ${SERVER_URL}`);

  const client = new RPCClient({
    endpoint: SERVER_URL,
    identity: CHARGER_ID,
    password: CHARGER_PASS,
    protocols: ['ocpp1.6'],
    strictMode: false,
  });

  // Capture the idTag from the inbound RemoteStartTransaction call.
  let receivedIdTag: string | null = null;
  let resolveRemoteStart: ((idTag: string) => void) | null = null;
  const remoteStartPromise = new Promise<string>((resolve) => { resolveRemoteStart = resolve; });

  client.handle('RemoteStartTransaction', async ({ params }: any) => {
    receivedIdTag = String(params.idTag);
    console.log(`[Sim] ◀── RemoteStartTransaction received: connectorId=${params.connectorId} idTag=${receivedIdTag}`);
    resolveRemoteStart?.(receivedIdTag);
    return { status: 'Accepted' };
  });
  client.handle('RemoteStopTransaction', async ({ params }: any) => {
    console.log(`[Sim] ◀── RemoteStopTransaction: transactionId=${params.transactionId}`);
    return { status: 'Accepted' };
  });
  // Fleet engine pushes ChargePointMaxProfile on session start; ack to keep
  // the engine happy without simulating real current-control behavior. Also
  // capture and (optionally) assert the profile shape so we catch
  // engine-side regressions in CI rather than only on real hardware.
  const capturedProfiles: Array<{ stackLevel: number; limit: number; profileId: number; receivedAt: string }> = [];
  client.handle('SetChargingProfile', async ({ params }: any) => {
    const cs = params?.csChargingProfiles ?? {};
    const period = cs?.chargingSchedule?.chargingSchedulePeriod?.[0] ?? {};
    const captured = {
      stackLevel: Number(cs.stackLevel),
      limit: Number(period.limit),
      profileId: Number(cs.chargingProfileId),
      receivedAt: new Date().toISOString(),
    };
    capturedProfiles.push(captured);
    console.log(
      `[Sim] ◀── SetChargingProfile #${capturedProfiles.length}: stackLevel=${captured.stackLevel} limit=${captured.limit} profileId=${captured.profileId}`,
    );
    return { status: 'Accepted' };
  });
  client.handle('ClearChargingProfile', async () => ({ status: 'Accepted' }));
  client.handle('TriggerMessage', async () => ({ status: 'Accepted' }));

  await client.connect();
  console.log('✅ Connected');

  sep('Boot + Heartbeat (readiness gate)');
  const boot = await client.call('BootNotification', {
    chargePointVendor: 'SimVendor',
    chargePointModel: 'FleetSim-1',
    chargePointSerialNumber: 'SIM-' + CHARGER_ID,
    firmwareVersion: '1.0.0-sim',
  });
  console.log(`Boot: ${boot.status} interval=${boot.interval}s`);
  if (boot.status !== 'Accepted') throw new Error('BootNotification rejected');
  const hb = await client.call('Heartbeat', {});
  console.log(`Heartbeat: ${hb.currentTime}`);

  sep('StatusNotification: Available (warm-up)');
  await client.call('StatusNotification', {
    connectorId: CONNECTOR_ID,
    status: 'Available',
    errorCode: 'NoError',
    timestamp: new Date().toISOString(),
  });

  // Brief pause so the OCPP server can process the Available transition
  // (orphan-close, transition row, etc.) before we fire Preparing.
  await sleep(500);

  sep('StatusNotification: Preparing  (← Slice C plug-in trigger)');
  const preparingAt = new Date().toISOString();
  await client.call('StatusNotification', {
    connectorId: CONNECTOR_ID,
    status: 'Preparing',
    errorCode: 'NoError',
    timestamp: preparingAt,
  });
  console.log(`Sent Preparing at ${preparingAt}, waiting up to ${REMOTE_START_TIMEOUT_MS}ms for RemoteStartTransaction…`);

  if (NEGATIVE_MODE) {
    sep('NEGATIVE TEST: expecting NO RemoteStartTransaction');
    const result = await Promise.race([
      remoteStartPromise.then((idTag) => ({ kind: 'received' as const, idTag })),
      sleep(REMOTE_START_TIMEOUT_MS).then(() => ({ kind: 'timeout' as const })),
    ]);
    if (result.kind === 'received') {
      console.error(`❌ FAIL: RemoteStartTransaction was received (idTag=${result.idTag}) — auto-start should have been suppressed`);
      await client.close();
      process.exit(1);
    }
    console.log('✅ PASS: no RemoteStartTransaction received within timeout (auto-start correctly suppressed)');
    sep('Cleanup: Available');
    await client.call('StatusNotification', {
      connectorId: CONNECTOR_ID,
      status: 'Available',
      errorCode: 'NoError',
      timestamp: new Date().toISOString(),
    });
    await client.close();
    process.exit(0);
  }

  // Positive path: wait for RemoteStartTransaction to arrive.
  const idTag = await Promise.race([
    remoteStartPromise,
    sleep(REMOTE_START_TIMEOUT_MS).then(() => { throw new Error(`Timeout waiting for RemoteStartTransaction after ${REMOTE_START_TIMEOUT_MS}ms`); }),
  ]);
  console.log(`✅ Got auto-start idTag: ${idTag}`);

  // Brief pause: in production, the charger waits for the driver action
  // before proceeding. The OCPP order here mirrors what real chargers do
  // upon RemoteStart Accepted: send Authorize for the supplied idTag,
  // then StartTransaction once the driver actually plugs in (we already
  // sent Preparing).
  await sleep(200);

  sep('Authorize (with auto-start idTag)');
  const auth = await client.call('Authorize', { idTag });
  console.log(`Authorize: ${auth.idTagInfo?.status}`);
  if (auth.idTagInfo?.status !== 'Accepted') {
    throw new Error(`Authorize rejected for idTag=${idTag}: ${auth.idTagInfo?.status}`);
  }

  sep('StartTransaction');
  const METER_START = 100000;
  const start = await client.call('StartTransaction', {
    connectorId: CONNECTOR_ID,
    idTag,
    meterStart: METER_START,
    timestamp: new Date().toISOString(),
  });
  console.log(`StartTransaction: txn=${start.transactionId} status=${start.idTagInfo?.status}`);
  if (start.idTagInfo?.status !== 'Accepted' || !start.transactionId) {
    throw new Error(`StartTransaction rejected: ${JSON.stringify(start)}`);
  }
  const transactionId = start.transactionId;

  sep('StatusNotification: Charging');
  await client.call('StatusNotification', {
    connectorId: CONNECTOR_ID,
    status: 'Charging',
    errorCode: 'NoError',
    timestamp: new Date().toISOString(),
  });

  sep('MeterValues x3');
  const readings = [METER_START + 500, METER_START + 1000, METER_START + 1500];
  for (let i = 0; i < readings.length; i++) {
    await sleep(800);
    await client.call('MeterValues', {
      connectorId: CONNECTOR_ID,
      transactionId,
      meterValue: [{
        timestamp: new Date().toISOString(),
        sampledValue: [{
          value: String(readings[i]),
          measurand: 'Energy.Active.Import.Register',
          unit: 'Wh',
          context: 'Sample.Periodic',
        }],
      }],
    });
    console.log(`  meter ${i + 1}: ${readings[i]} Wh`);
  }

  sep('StopTransaction');
  const METER_STOP = readings[readings.length - 1];
  const stop = await client.call('StopTransaction', {
    transactionId,
    idTag,
    meterStop: METER_STOP,
    timestamp: new Date().toISOString(),
    reason: 'Local',
  });
  console.log(`Stop: idTagInfo=${stop.idTagInfo?.status ?? '(none)'} kWh=${((METER_STOP - METER_START)/1000).toFixed(3)}`);

  sep('StatusNotification: Available (cleanup)');
  await client.call('StatusNotification', {
    connectorId: CONNECTOR_ID,
    status: 'Available',
    errorCode: 'NoError',
    timestamp: new Date().toISOString(),
  });

  // Profile-shape assertion. Fails the sim with exit 2 if the FIRST captured
  // push doesn't match. Catches the 2026-04-29 release-stackLevel-loses-to-
  // baseline bug class permanently in CI.
  if (EXPECT_STACK_LEVEL !== null) {
    sep('Assert: SetChargingProfile shape');
    if (capturedProfiles.length === 0) {
      console.error('❌ FAIL: SIM_ASSERT_PROFILE_STACK_LEVEL set but no SetChargingProfile was received');
      await client.close();
      process.exit(2);
    }
    const first = capturedProfiles[0];
    let ok = true;
    if (first.stackLevel !== EXPECT_STACK_LEVEL) {
      console.error(`❌ FAIL: first SetChargingProfile stackLevel=${first.stackLevel}, expected ${EXPECT_STACK_LEVEL}`);
      ok = false;
    }
    if (EXPECT_LIMIT !== null && first.limit !== EXPECT_LIMIT) {
      console.error(`❌ FAIL: first SetChargingProfile limit=${first.limit}, expected ${EXPECT_LIMIT}`);
      ok = false;
    }
    if (!ok) {
      console.error(`   Captured profiles: ${JSON.stringify(capturedProfiles)}`);
      await client.close();
      process.exit(2);
    }
    const limitNote = EXPECT_LIMIT !== null ? `, limit=${EXPECT_LIMIT}` : '';
    console.log(`✅ profile shape matches expectation (stackLevel=${EXPECT_STACK_LEVEL}${limitNote})`);
  }

  sep('✅ SIMULATION COMPLETE');
  console.log(`  charger        : ${CHARGER_ID}`);
  console.log(`  transactionId  : ${transactionId}`);
  console.log(`  idTag (auto)   : ${idTag}`);
  console.log(`  energy (Wh)    : ${METER_STOP - METER_START}`);
  console.log(`  profilesSeen   : ${capturedProfiles.length}`);
  console.log('');
  console.log('Now query DB for: Session.fleetPolicyId, Session.userId (synthetic), BillingSnapshot.gatedPricingMode.');

  await client.close();
  process.exit(0);
}

run().catch((err: Error) => {
  console.error('\n❌ Sim error:', err.message);
  process.exit(1);
});
