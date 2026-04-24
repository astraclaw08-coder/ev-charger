/**
 * priorEnergyState — Self-Tests (TASK-0208 Phase 2, PR-c)
 * Run: npx ts-node packages/ocpp-server/src/fleet/priorEnergyState.selftest.ts
 */

import {
  putPriorEnergy,
  getPriorEnergy,
  clearPriorEnergy,
  getPriorEnergyStateSize,
  __resetPriorEnergyStateForTests,
  PRIOR_ENERGY_STATE_LIMITS,
} from './priorEnergyState';

let passed = 0;
let failed = 0;
function assert(c: boolean, name: string) {
  if (c) { passed++; console.log(`  ✅ ${name}`); }
  else   { failed++; console.error(`  ❌ ${name}`); }
}

async function main() {

// ─── put / get round-trip ────────────────────────────────────────────
console.log('\n--- put then get returns the entry ---');
{
  __resetPriorEnergyStateForTests();
  putPriorEnergy('s1', { lastWh: 12345, lastTsMs: 1000 });
  const g = getPriorEnergy('s1');
  assert(g !== null, 'got entry back');
  assert(g?.lastWh === 12345, 'lastWh preserved');
  assert(g?.lastTsMs === 1000, 'lastTsMs preserved');
  assert(getPriorEnergyStateSize() === 1, 'size=1');
}

// ─── missing key returns null ────────────────────────────────────────
console.log('\n--- missing sessionId returns null ---');
{
  __resetPriorEnergyStateForTests();
  const g = getPriorEnergy('never-set');
  assert(g === null, 'null when absent');
}

// ─── clear is idempotent ─────────────────────────────────────────────
console.log('\n--- clear removes entry and is idempotent ---');
{
  __resetPriorEnergyStateForTests();
  putPriorEnergy('s1', { lastWh: 1, lastTsMs: 1 });
  clearPriorEnergy('s1');
  assert(getPriorEnergy('s1') === null, 'gone after clear');
  // Safe to clear again
  clearPriorEnergy('s1');
  clearPriorEnergy('never-existed');
  assert(getPriorEnergyStateSize() === 0, 'size=0');
}

// ─── update moves to tail (LRU behavior) ─────────────────────────────
console.log('\n--- re-put moves to tail for LRU ---');
{
  __resetPriorEnergyStateForTests();
  putPriorEnergy('a', { lastWh: 1, lastTsMs: 1 });
  putPriorEnergy('b', { lastWh: 2, lastTsMs: 2 });
  putPriorEnergy('a', { lastWh: 99, lastTsMs: 99 }); // refresh 'a' → moves to tail
  // Order now: [b, a]. 'b' is oldest. Fill up to exactly MAX, then one more
  // put evicts only 'b'.
  const MAX = PRIOR_ENERGY_STATE_LIMITS.maxEntries;
  for (let i = 0; i < MAX - 2; i++) {
    putPriorEnergy(`filler-${i}`, { lastWh: i, lastTsMs: i });
  }
  assert(getPriorEnergyStateSize() === MAX, `at cap: ${MAX}`);
  // One more put triggers exactly one eviction: head = 'b'.
  putPriorEnergy('new', { lastWh: 0, lastTsMs: 0 });
  assert(getPriorEnergyStateSize() === MAX, `still at cap after overflow`);
  assert(getPriorEnergy('b') === null, 'b evicted (oldest)');
  assert(getPriorEnergy('a') !== null, 'a preserved (was refreshed, still within cap)');
}

// ─── TTL expiry ──────────────────────────────────────────────────────
console.log('\n--- TTL-expired entries return null and self-evict ---');
{
  __resetPriorEnergyStateForTests();
  const t0 = 2_000_000_000_000;
  putPriorEnergy('s1', { lastWh: 1, lastTsMs: 1 }, () => t0);
  assert(getPriorEnergyStateSize() === 1, 'stored');
  const later = () => t0 + PRIOR_ENERGY_STATE_LIMITS.ttlMs + 1;
  const g = getPriorEnergy('s1', later);
  assert(g === null, 'expired entry returns null');
  assert(getPriorEnergyStateSize() === 0, 'self-evicted on stale read');
}

// ─── not-yet-expired still returns entry ─────────────────────────────
console.log('\n--- within TTL returns entry unchanged ---');
{
  __resetPriorEnergyStateForTests();
  const t0 = 3_000_000_000_000;
  putPriorEnergy('s1', { lastWh: 42, lastTsMs: 100 }, () => t0);
  const later = () => t0 + PRIOR_ENERGY_STATE_LIMITS.ttlMs - 1;
  const g = getPriorEnergy('s1', later);
  assert(g?.lastWh === 42, 'still present at TTL-1ms');
}

// ─── capacity cap enforced ───────────────────────────────────────────
console.log('\n--- capacity cap evicts oldest ---');
{
  __resetPriorEnergyStateForTests();
  const MAX = PRIOR_ENERGY_STATE_LIMITS.maxEntries;
  for (let i = 0; i < MAX + 5; i++) {
    putPriorEnergy(`s${i}`, { lastWh: i, lastTsMs: i });
  }
  assert(getPriorEnergyStateSize() === MAX, `bounded at ${MAX}`);
  assert(getPriorEnergy('s0') === null, 's0 evicted');
  assert(getPriorEnergy('s4') === null, 's4 evicted');
  assert(getPriorEnergy(`s${MAX + 4}`) !== null, 'newest preserved');
}

console.log(`\n${'='.repeat(50)}`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) process.exit(1);

}

main().catch((err) => {
  console.error('Selftest crashed:', err);
  process.exit(1);
});
