/**
 * preDeliveryGatedMinutes — Self-Tests (TASK-0208 Phase 2, PR-c)
 * Run: npx ts-node packages/ocpp-server/src/fleet/preDeliveryGatedMinutes.selftest.ts
 */

import { computePreDeliveryGatedMinutes } from './preDeliveryGatedMinutes';

let passed = 0;
let failed = 0;
function assert(c: boolean, name: string) {
  if (c) { passed++; console.log(`  ✅ ${name}`); }
  else   { failed++; console.error(`  ❌ ${name}`); }
}

async function main() {

// ─── normal case ─────────────────────────────────────────────────────
console.log('\n--- normal: 12.5 min gated ---');
{
  const plug = new Date('2026-04-24T12:00:00Z');
  const first = new Date('2026-04-24T12:12:30Z');
  const r = computePreDeliveryGatedMinutes(plug, first);
  assert(r === 12.5, `12.5 min (got ${r})`);
}

// ─── zero-gap ────────────────────────────────────────────────────────
console.log('\n--- zero gap (firstEnergy == plugIn) ---');
{
  const d = new Date('2026-04-24T12:00:00Z');
  const r = computePreDeliveryGatedMinutes(d, d);
  assert(r === 0, 'exactly 0 min');
}

// ─── negative (clock skew) clamps to 0 ───────────────────────────────
console.log('\n--- clock-skew negative clamps to 0 ---');
{
  const plug = new Date('2026-04-24T12:05:00Z');
  const first = new Date('2026-04-24T12:04:00Z'); // earlier than plugIn
  const r = computePreDeliveryGatedMinutes(plug, first);
  assert(r === 0, 'negative clamped to 0');
}

// ─── null inputs return null ─────────────────────────────────────────
console.log('\n--- missing inputs return null ---');
{
  assert(computePreDeliveryGatedMinutes(null, new Date()) === null, 'plugInAt null');
  assert(computePreDeliveryGatedMinutes(new Date(), null) === null, 'firstEnergyAt null');
  assert(computePreDeliveryGatedMinutes(null, null) === null, 'both null');
  assert(computePreDeliveryGatedMinutes(undefined, undefined) === null, 'both undefined');
}

// ─── fractional minutes preserved ────────────────────────────────────
console.log('\n--- sub-minute precision preserved ---');
{
  const plug = new Date('2026-04-24T12:00:00.000Z');
  const first = new Date('2026-04-24T12:00:30.000Z');
  const r = computePreDeliveryGatedMinutes(plug, first);
  assert(r === 0.5, `0.5 min (got ${r})`);
}

console.log(`\n${'='.repeat(50)}`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) process.exit(1);

}

main().catch((err) => {
  console.error('Selftest crashed:', err);
  process.exit(1);
});
