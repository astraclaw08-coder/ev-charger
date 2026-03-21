/**
 * Smart Charging Gate Integration Test
 *
 * Tests the new post-commit gating logic:
 * 1. Boot → NO ClearChargingProfile or SetChargingProfile should fire before heartbeat
 * 2. First Heartbeat → server may evaluate smart charging
 * 3. For charger with NO profile assigned → never receive Clear/Set
 * 4. Verify gate holds for at least 30s post-boot without profile spam
 *
 * Usage:
 *   CHARGER_ID=TEST-GATE-001 ts-node src/scripts/test-smart-charging-gate.ts
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { RPCClient } = require('ocpp-rpc');

const SERVER_URL = process.env.OCPP_SIM_SERVER ?? 'ws://192.168.68.115:9000';
const CHARGER_ID = process.env.CHARGER_ID ?? 'TEST-GATE-001';
const TEST_DURATION_MS = 45_000;

type ReceivedCall = { time: number; action: string; payload: unknown };

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

const received: ReceivedCall[] = [];
let bootTime: number | null = null;
let firstHeartbeatSent: number | null = null;

async function main() {
  log(`Starting smart-charging gate test with CHARGER_ID=${CHARGER_ID}`);
  log(`Server: ${SERVER_URL}`);
  log(`Test duration: ${TEST_DURATION_MS / 1000}s`);

  const client = new RPCClient({
    endpoint: SERVER_URL,
    identity: CHARGER_ID,
    protocols: ['ocpp1.6'],
    strictMode: false,
  });

  client.handle(({ method, params }: { method: string; params: unknown }) => {
    const entry = { time: Date.now(), action: method, payload: params };
    received.push(entry);

    const relBoot = bootTime ? `+${((entry.time - bootTime) / 1000).toFixed(1)}s after boot` : 'pre-boot';
    const relHB = firstHeartbeatSent ? `+${((entry.time - firstHeartbeatSent) / 1000).toFixed(1)}s after HB1` : 'before HB1';
    log(`⬅️  INBOUND: ${method} [${relBoot}, ${relHB}]`);

    if (method === 'ClearChargingProfile') return { status: 'Accepted' };
    if (method === 'SetChargingProfile') return { status: 'Accepted' };
    if (method === 'TriggerMessage') return { status: 'Accepted' };
    if (method === 'GetConfiguration') return { configurationKey: [], unknownKey: [] };
    return { status: 'Accepted' };
  });

  await client.connect();
  log('✅ Connected to OCPP server');

  bootTime = Date.now();
  const boot = await client.call('BootNotification', {
    chargePointVendor: 'TestVendor',
    chargePointModel: 'GateTest',
    chargePointSerialNumber: `SIM-${CHARGER_ID}`,
    firmwareVersion: 'gate-test-1.0',
  });
  log(`📣 BootNotification → status=${boot.status} interval=${boot.interval}`);

  await client.call('StatusNotification', {
    connectorId: 0, status: 'Available', errorCode: 'NoError', timestamp: new Date().toISOString(),
  });
  await client.call('StatusNotification', {
    connectorId: 1, status: 'Available', errorCode: 'NoError', timestamp: new Date().toISOString(),
  });

  log('⏳ Waiting 5s before first heartbeat (checking for premature Clear/Set)...');
  await sleep(5000);

  const preHBProfiles = received.filter((r) => r.action === 'ClearChargingProfile' || r.action === 'SetChargingProfile');
  if (preHBProfiles.length > 0) {
    log(`❌ FAIL: Received ${preHBProfiles.length} profile commands BEFORE first heartbeat!`);
    preHBProfiles.forEach((r) => log(`   - ${r.action}`));
  } else {
    log('✅ PASS: No profile commands before first heartbeat (gate holding)');
  }

  firstHeartbeatSent = Date.now();
  const hb1 = await client.call('Heartbeat', {});
  log(`💓 Heartbeat[1] → currentTime=${hb1.currentTime}`);

  await sleep(8000);
  const postHBProfiles = received.filter(
    (r) => (r.action === 'ClearChargingProfile' || r.action === 'SetChargingProfile')
      && r.time >= (firstHeartbeatSent ?? 0),
  );
  if (postHBProfiles.length > 0) {
    log(`⚠️  Profile commands received after first HB: ${postHBProfiles.length} (charger may have an active profile assigned)`);
    postHBProfiles.forEach((r) => log(`   - ${r.action}`));
  } else {
    log('✅ PASS: No profile commands after first HB either (no active profile for this charger — as expected)');
  }

  log(`⏳ Running ${TEST_DURATION_MS / 1000}s soak...`);
  const end = Date.now() + (TEST_DURATION_MS - 13000);
  let hbCount = 1;
  while (Date.now() < end) {
    await sleep(10000);
    hbCount += 1;
    const hbn = await client.call('Heartbeat', {});
    log(`💓 Heartbeat[${hbCount}] → ${hbn.currentTime}`);
  }

  log('\n========= TEST SUMMARY =========');
  log(`Total inbound server calls: ${received.length}`);
  const grouped: Record<string, number> = {};
  for (const r of received) grouped[r.action] = (grouped[r.action] ?? 0) + 1;
  for (const [action, count] of Object.entries(grouped)) {
    log(`  ${action}: ${count}x`);
  }

  const profileCalls = received.filter((r) => r.action === 'ClearChargingProfile' || r.action === 'SetChargingProfile');
  const preBootProfile = profileCalls.filter((r) => r.time < (firstHeartbeatSent ?? Number.POSITIVE_INFINITY));
  const postHbProfile = profileCalls.filter((r) => r.time >= (firstHeartbeatSent ?? Number.POSITIVE_INFINITY));

  log(`\nProfile commands before first HB: ${preBootProfile.length} (expected: 0)`);
  log(`Profile commands after first HB:  ${postHbProfile.length} (expected: 0 — no profile assigned to TEST-GATE-001)`);

  const pass = preBootProfile.length === 0 && postHbProfile.length === 0;
  log(`\n${pass ? '✅ ALL TESTS PASSED' : '❌ TESTS FAILED'} — gate is ${pass ? 'working correctly' : 'NOT working as expected'}`);

  await client.close();
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
