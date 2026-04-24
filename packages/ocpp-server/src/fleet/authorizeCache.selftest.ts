/**
 * authorizeCache — Self-Tests (TASK-0208 Phase 2, PR-b)
 * Run: npx ts-node packages/ocpp-server/src/fleet/authorizeCache.selftest.ts
 */

import {
  putFleetAuthorize,
  consumeFleetAuthorize,
  getFleetAuthorizeCacheSize,
  __resetFleetAuthorizeCacheForTests,
  FLEET_AUTHORIZE_CACHE_LIMITS,
} from './authorizeCache';

let passed = 0;
let failed = 0;
function assert(c: boolean, name: string) {
  if (c) { passed++; console.log(`  ✅ ${name}`); }
  else   { failed++; console.error(`  ❌ ${name}`); }
}

const ON = () => true;
const OFF = () => false;
const CID = 'charger-A';
const IDT = 'FLEET-DRIVER-1';

async function main() {

// ─── flag-off no-op ──────────────────────────────────────────────────
console.log('\n--- flag-off: put and consume are no-ops ---');
{
  __resetFleetAuthorizeCacheForTests();
  const r = putFleetAuthorize({ chargerId: CID, idTag: IDT, fleetPolicyId: 'p', flagEnabled: OFF });
  assert(r === null, 'put returns null when flag off');
  assert(getFleetAuthorizeCacheSize() === 0, 'nothing stored');
  const c = consumeFleetAuthorize({ chargerId: CID, idTag: IDT, flagEnabled: OFF });
  assert(c === null, 'consume returns null when flag off');
}

// ─── round-trip ──────────────────────────────────────────────────────
console.log('\n--- put then consume returns the entry and deletes it ---');
{
  __resetFleetAuthorizeCacheForTests();
  const now = () => 1_000_000_000_000;
  putFleetAuthorize({ chargerId: CID, idTag: IDT, fleetPolicyId: 'policy-1', flagEnabled: ON, now });
  assert(getFleetAuthorizeCacheSize() === 1, 'size=1 after put');
  const got = consumeFleetAuthorize({ chargerId: CID, idTag: IDT, flagEnabled: ON, now });
  assert(got !== null && got.fleetPolicyId === 'policy-1', 'consume returns same entry');
  assert(getFleetAuthorizeCacheSize() === 0, 'size=0 after consume');
  const again = consumeFleetAuthorize({ chargerId: CID, idTag: IDT, flagEnabled: ON, now });
  assert(again === null, 'second consume returns null (deleted)');
}

// ─── TTL expiry ──────────────────────────────────────────────────────
console.log('\n--- entry older than TTL expires on consume ---');
{
  __resetFleetAuthorizeCacheForTests();
  const t0 = 2_000_000_000_000;
  putFleetAuthorize({ chargerId: CID, idTag: IDT, fleetPolicyId: 'p', flagEnabled: ON, now: () => t0 });
  const later = () => t0 + FLEET_AUTHORIZE_CACHE_LIMITS.ttlMs + 1;
  const got = consumeFleetAuthorize({ chargerId: CID, idTag: IDT, flagEnabled: ON, now: later });
  assert(got === null, 'expired entry not returned');
}

// ─── key isolation ────────────────────────────────────────────────────
console.log('\n--- different chargers / idTags are isolated ---');
{
  __resetFleetAuthorizeCacheForTests();
  putFleetAuthorize({ chargerId: 'A', idTag: 'x', fleetPolicyId: 'pa', flagEnabled: ON });
  putFleetAuthorize({ chargerId: 'B', idTag: 'x', fleetPolicyId: 'pb', flagEnabled: ON });
  putFleetAuthorize({ chargerId: 'A', idTag: 'y', fleetPolicyId: 'pay', flagEnabled: ON });
  assert(getFleetAuthorizeCacheSize() === 3, 'three distinct keys');
  const g1 = consumeFleetAuthorize({ chargerId: 'A', idTag: 'x', flagEnabled: ON });
  assert(g1?.fleetPolicyId === 'pa', 'A:x returns pa');
  const g2 = consumeFleetAuthorize({ chargerId: 'B', idTag: 'x', flagEnabled: ON });
  assert(g2?.fleetPolicyId === 'pb', 'B:x returns pb');
  const g3 = consumeFleetAuthorize({ chargerId: 'A', idTag: 'y', flagEnabled: ON });
  assert(g3?.fleetPolicyId === 'pay', 'A:y returns pay');
}

// ─── same key replace (LRU move-to-tail) ──────────────────────────────
console.log('\n--- putting same key twice keeps one entry, latest value ---');
{
  __resetFleetAuthorizeCacheForTests();
  putFleetAuthorize({ chargerId: CID, idTag: IDT, fleetPolicyId: 'first', flagEnabled: ON });
  putFleetAuthorize({ chargerId: CID, idTag: IDT, fleetPolicyId: 'second', flagEnabled: ON });
  assert(getFleetAuthorizeCacheSize() === 1, 'size stays 1');
  const g = consumeFleetAuthorize({ chargerId: CID, idTag: IDT, flagEnabled: ON });
  assert(g?.fleetPolicyId === 'second', 'latest value retained');
}

// ─── capacity cap with LRU eviction ───────────────────────────────────
console.log('\n--- capacity cap = 1000 with LRU eviction ---');
{
  __resetFleetAuthorizeCacheForTests();
  const MAX = FLEET_AUTHORIZE_CACHE_LIMITS.maxEntries;
  for (let i = 0; i < MAX + 5; i++) {
    putFleetAuthorize({ chargerId: 'c', idTag: `t${i}`, fleetPolicyId: 'p', flagEnabled: ON });
  }
  assert(getFleetAuthorizeCacheSize() === MAX, `size bounded at ${MAX}`);
  // First 5 should have been evicted
  assert(consumeFleetAuthorize({ chargerId: 'c', idTag: 't0', flagEnabled: ON }) === null, 'oldest evicted (t0)');
  assert(consumeFleetAuthorize({ chargerId: 'c', idTag: 't4', flagEnabled: ON }) === null, 'oldest evicted (t4)');
  assert(consumeFleetAuthorize({ chargerId: 'c', idTag: `t${MAX + 4}`, flagEnabled: ON }) !== null, 'newest preserved');
}

// ─── plugInAt override vs default ─────────────────────────────────────
console.log('\n--- plugInAt defaults to now(), honors override ---');
{
  __resetFleetAuthorizeCacheForTests();
  const t0 = 3_000_000_000_000;
  putFleetAuthorize({ chargerId: CID, idTag: IDT, fleetPolicyId: 'p', flagEnabled: ON, now: () => t0 });
  const g = consumeFleetAuthorize({ chargerId: CID, idTag: IDT, flagEnabled: ON, now: () => t0 + 1000 });
  assert(g?.plugInAt.getTime() === t0, 'plugInAt defaults to now() at put time');

  __resetFleetAuthorizeCacheForTests();
  const custom = new Date('2026-04-24T12:00:00Z');
  putFleetAuthorize({ chargerId: CID, idTag: IDT, fleetPolicyId: 'p', plugInAt: custom, flagEnabled: ON });
  const g2 = consumeFleetAuthorize({ chargerId: CID, idTag: IDT, flagEnabled: ON });
  assert(g2?.plugInAt.getTime() === custom.getTime(), 'plugInAt override used');
}

console.log(`\n${'='.repeat(50)}`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) process.exit(1);

}

main().catch((err) => {
  console.error('Selftest crashed:', err);
  process.exit(1);
});
