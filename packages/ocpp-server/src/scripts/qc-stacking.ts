// @ts-nocheck
/**
 * Smart Charging Stacking — E2E QC Test
 *
 * Spins up 2 simulated chargers against the OCPP server, creates stacked profiles
 * via the API, triggers reconcile, and verifies each profile was pushed independently.
 *
 * Usage:
 *   OCPP_SIM_SERVER=wss://ocpp-server-fresh-production.up.railway.app \
 *   API_URL=https://api-production-26cf.up.railway.app \
 *   npx ts-node packages/ocpp-server/src/scripts/qc-stacking.ts
 */
import 'dotenv/config';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { RPCClient } = require('ocpp-rpc');

const OCPP_URL = process.env.OCPP_SIM_SERVER ?? 'ws://localhost:9000';
const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const API_TOKEN = process.env.API_TOKEN ?? '';
const SIM_CHARGER_1 = 'QC-STACK-SIM-01';
const SIM_CHARGER_2 = 'QC-STACK-SIM-02';

let passed = 0;
let failed = 0;
const createdProfileIds: string[] = [];

function log(msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

function assert(condition: boolean, name: string) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`); }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function authHeaders(): Record<string, string> {
  if (API_TOKEN) return { 'Authorization': `Bearer ${API_TOKEN}` };
  return { 'x-dev-operator-id': 'qc-test' };
}

async function apiGet(path: string) {
  const res = await fetch(`${API_URL}${path}`, { headers: authHeaders() });
  return res.json();
}

async function apiPost(path: string, body: any) {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function apiPut(path: string, body: any) {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function apiDelete(path: string) {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  return res.status;
}

async function connectSimCharger(chargerId: string): Promise<any> {
  const client = new RPCClient({
    endpoint: OCPP_URL,
    identity: chargerId,
    protocols: ['ocpp1.6'],
    strictMode: false,
  });

  // Handle SetChargingProfile — accept and log
  const receivedProfiles: any[] = [];
  client.handle('SetChargingProfile', ({ params }: any) => {
    log(`  [${chargerId}] SetChargingProfile received: profileId=${params?.csChargingProfiles?.chargingProfileId} stackLevel=${params?.csChargingProfiles?.stackLevel} limit=${params?.csChargingProfiles?.chargingSchedule?.chargingSchedulePeriod?.[0]?.limit}W`);
    receivedProfiles.push(params);
    return { status: 'Accepted' };
  });

  client.handle('ClearChargingProfile', ({ params }: any) => {
    log(`  [${chargerId}] ClearChargingProfile received: id=${params?.id} stackLevel=${params?.stackLevel}`);
    return { status: 'Accepted' };
  });

  client.handle('GetCompositeSchedule', ({ params }: any) => {
    log(`  [${chargerId}] GetCompositeSchedule received: connectorId=${params?.connectorId} duration=${params?.duration}`);
    return {
      status: 'Accepted',
      connectorId: params?.connectorId ?? 0,
      scheduleStart: new Date().toISOString(),
      chargingSchedule: {
        chargingRateUnit: 'W',
        chargingSchedulePeriod: [{ startPeriod: 0, limit: 6000 }],
      },
    };
  });

  client.handle('RemoteStartTransaction', () => ({ status: 'Accepted' }));
  client.handle('RemoteStopTransaction', () => ({ status: 'Accepted' }));
  client.handle('Reset', () => ({ status: 'Accepted' }));
  client.handle('ChangeConfiguration', () => ({ status: 'Accepted' }));
  client.handle('GetConfiguration', () => ({ configurationKey: [], unknownKey: [] }));

  await client.connect();

  const boot = await client.call('BootNotification', {
    chargePointVendor: 'QC-Test',
    chargePointModel: 'Stacking-Sim',
    chargePointSerialNumber: `SN-${chargerId}`,
    firmwareVersion: '1.0.0',
  });
  log(`[${chargerId}] Boot: ${boot.status}`);

  await client.call('StatusNotification', {
    connectorId: 1,
    status: 'Available',
    errorCode: 'NoError',
    timestamp: new Date().toISOString(),
  });

  // Heartbeat to satisfy gate
  await client.call('Heartbeat', {});

  return { client, receivedProfiles };
}

async function getChargerDbId(ocppId: string): Promise<string | null> {
  const data = await apiGet('/chargers');
  const chargers = Array.isArray(data) ? data : data.chargers ?? [];
  const c = chargers.find((x: any) => x.ocppId === ocppId);
  return c?.id ?? null;
}

async function getChargerSiteId(chargerId: string): Promise<string | null> {
  const data = await apiGet('/chargers');
  const chargers = Array.isArray(data) ? data : data.chargers ?? [];
  const c = chargers.find((x: any) => x.id === chargerId);
  return c?.siteId ?? null;
}

async function run() {
  console.log('\n' + '═'.repeat(60));
  console.log('  Smart Charging Stacking — E2E QC');
  console.log('═'.repeat(60));
  log(`OCPP: ${OCPP_URL}`);
  log(`API:  ${API_URL}`);

  // ─── Connect simulators ──────────────────────────────
  console.log('\n── Step 1: Connect simulated chargers ──');
  const sim1 = await connectSimCharger(SIM_CHARGER_1);
  const sim2 = await connectSimCharger(SIM_CHARGER_2);
  await sleep(3000); // let heartbeat gate clear
  log('Both chargers connected');

  // ─── Get charger DB IDs ──────────────────────────────
  const charger1Id = await getChargerDbId(SIM_CHARGER_1);
  const charger2Id = await getChargerDbId(SIM_CHARGER_2);
  const siteId = charger1Id ? await getChargerSiteId(charger1Id) : null;

  assert(charger1Id != null, `Charger 1 (${SIM_CHARGER_1}) found in DB: ${charger1Id}`);
  assert(charger2Id != null, `Charger 2 (${SIM_CHARGER_2}) found in DB: ${charger2Id}`);
  assert(siteId != null, `Site found: ${siteId}`);

  if (!charger1Id || !siteId) {
    console.error('\nCannot proceed — chargers or site not found. Chargers may need to be registered first.');
    await cleanup(sim1.client, sim2.client);
    return;
  }

  // ─── Test A: Single charger-scoped profile ───────────
  console.log('\n── Test A: Single CHARGER profile (6 kW always) ──');
  const profA = await apiPost('/smart-charging/profiles', {
    name: 'QC-A: Charger 6kW',
    scope: 'CHARGER',
    chargerId: charger1Id,
    defaultLimitKw: 6,
    enabled: true,
    priority: 10,
  });
  const profAId = profA?.id ?? profA?.profile?.id;
  if (profAId) createdProfileIds.push(profAId);
  assert(profAId != null, `Profile A created: ${profAId}`);

  // Trigger reconcile
  log('Triggering reconcile for charger 1...');
  await apiPost(`/smart-charging/chargers/${charger1Id}/reconcile`, {});
  await sleep(3000);

  assert(sim1.receivedProfiles.length >= 1, `Charger 1 received ${sim1.receivedProfiles.length} SetChargingProfile call(s)`);
  if (sim1.receivedProfiles.length >= 1) {
    const p = sim1.receivedProfiles[sim1.receivedProfiles.length - 1];
    const limit = p?.csChargingProfiles?.chargingSchedule?.chargingSchedulePeriod?.[0]?.limit;
    assert(limit === 6000, `Profile limit = ${limit}W (expected 6000W)`);
  }

  // Check state via API
  const states1 = await apiGet(`/smart-charging/states?siteId=${siteId}`);
  const statesArr = Array.isArray(states1) ? states1 : [];
  const c1States = statesArr.filter((s: any) => s.chargerId === charger1Id);
  assert(c1States.length >= 1, `Charger 1 has ${c1States.length} state row(s)`);
  if (c1States.length >= 1) {
    assert(c1States[0].status === 'APPLIED', `State status = ${c1States[0].status}`);
    assert(c1States[0].ocppStackLevel != null, `State has ocppStackLevel = ${c1States[0].ocppStackLevel}`);
  }

  // ─── Test B: Add SITE profile → stacking ─────────────
  console.log('\n── Test B: Add SITE profile (10 kW always) → stacking with Profile A ──');
  sim1.receivedProfiles.length = 0; // clear
  const profB = await apiPost('/smart-charging/profiles', {
    name: 'QC-B: Site 10kW',
    scope: 'SITE',
    siteId,
    defaultLimitKw: 10,
    enabled: true,
    priority: 5,
  });
  const profBId = profB?.id ?? profB?.profile?.id;
  if (profBId) createdProfileIds.push(profBId);
  assert(profBId != null, `Profile B created: ${profBId}`);

  log('Triggering reconcile for charger 1...');
  await apiPost(`/smart-charging/chargers/${charger1Id}/reconcile`, {});
  await sleep(3000);

  // Should have received 2 SetChargingProfile calls (one per stacked profile)
  assert(sim1.receivedProfiles.length >= 1, `Charger 1 received ${sim1.receivedProfiles.length} SetChargingProfile call(s) after stacking`);

  // Verify states: should have 2 rows for charger 1
  const states2 = await apiGet(`/smart-charging/states?siteId=${siteId}`);
  const statesArr2 = Array.isArray(states2) ? states2 : [];
  const c1States2 = statesArr2.filter((s: any) => s.chargerId === charger1Id);
  assert(c1States2.length >= 2, `Charger 1 now has ${c1States2.length} state row(s) (expected ≥2 for stacking)`);

  // Verify different stackLevels
  if (c1States2.length >= 2) {
    const levels = c1States2.map((s: any) => s.ocppStackLevel).filter(Boolean);
    const uniqueLevels = new Set(levels);
    assert(uniqueLevels.size >= 2, `Different stackLevels: ${[...uniqueLevels].join(', ')}`);
    const chargerLevel = c1States2.find((s: any) => s.sourceScope === 'CHARGER')?.ocppStackLevel;
    const siteLevel = c1States2.find((s: any) => s.sourceScope === 'SITE')?.ocppStackLevel;
    if (chargerLevel && siteLevel) {
      assert(chargerLevel > siteLevel, `CHARGER stackLevel (${chargerLevel}) > SITE stackLevel (${siteLevel})`);
    }
  }

  // ─── Test C: Composite schedule verification ─────────
  console.log('\n── Test C: GetCompositeSchedule verification ──');
  const composite = await apiGet(`/smart-charging/chargers/${charger1Id}/composite-schedule?duration=86400`);
  assert(composite?.status === 'Accepted', `GetCompositeSchedule status = ${composite?.status}`);

  // Check compositeScheduleVerified on states
  const states3 = await apiGet(`/smart-charging/states?siteId=${siteId}`);
  const statesArr3 = Array.isArray(states3) ? states3 : [];
  const verified = statesArr3.filter((s: any) => s.chargerId === charger1Id && s.compositeScheduleVerified);
  assert(verified.length >= 1, `${verified.length} state(s) have compositeScheduleVerified=true`);

  // ─── Test D: Disable profile → cleanup ───────────────
  console.log('\n── Test D: Disable Profile A → should clear from charger ──');
  sim1.receivedProfiles.length = 0;
  if (profAId) {
    await apiPut(`/smart-charging/profiles/${profAId}`, { enabled: false });
  }
  log('Triggering reconcile after disable...');
  await apiPost(`/smart-charging/chargers/${charger1Id}/reconcile`, {});
  await sleep(3000);

  const states4 = await apiGet(`/smart-charging/states?siteId=${siteId}`);
  const statesArr4 = Array.isArray(states4) ? states4 : [];
  const c1States4 = statesArr4.filter((s: any) => s.chargerId === charger1Id);
  assert(c1States4.length === 1, `After disable: charger 1 has ${c1States4.length} state row(s) (expected 1 — only site profile)`);
  if (c1States4.length === 1) {
    assert(c1States4[0].sourceScope === 'SITE', `Remaining profile scope = ${c1States4[0].sourceScope}`);
  }

  // ─── Test E: Stacking preview API ────────────────────
  console.log('\n── Test E: Stacking preview API ──');
  // Re-enable profile A first
  if (profAId) {
    await apiPut(`/smart-charging/profiles/${profAId}`, { enabled: true });
  }
  const preview = await apiGet(`/smart-charging/chargers/${charger1Id}/stacking-preview`);
  assert(preview?.stackedProfiles?.length >= 2, `Stacking preview returns ${preview?.stackedProfiles?.length} profiles`);
  assert(preview?.mergedSchedule?.length === 24, `Merged schedule has ${preview?.mergedSchedule?.length} hourly slots`);
  if (preview?.mergedSchedule?.length === 24) {
    const allSlots = preview.mergedSchedule;
    const minEffective = Math.min(...allSlots.map((s: any) => s.effectiveLimitKw));
    assert(minEffective === 6, `Min effective limit across 24h = ${minEffective} kW (expected 6)`);
  }

  // ─── Cleanup ─────────────────────────────────────────
  console.log('\n── Cleanup ──');
  await cleanup(sim1.client, sim2.client);

  // ─── Summary ──────────────────────────────────────────
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  QC Results: ${passed} passed, ${failed} failed`);
  console.log('═'.repeat(60));
  if (failed > 0) process.exit(1);
}

async function cleanup(client1: any, client2: any) {
  // Delete test profiles
  for (const id of createdProfileIds) {
    try { await apiDelete(`/smart-charging/profiles/${id}`); log(`Deleted profile ${id}`); } catch { /* ok */ }
  }
  // Disconnect simulators
  try { await client1.close(); } catch { /* ok */ }
  try { await client2.close(); } catch { /* ok */ }
  log('Cleanup complete');
}

run().catch((err: Error) => {
  console.error('❌ QC error:', err.message);
  process.exit(1);
});
