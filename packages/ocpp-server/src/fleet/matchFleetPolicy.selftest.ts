/**
 * matchFleetPolicy — Self-Tests (TASK-0208 Phase 2, PR-b)
 * Run: npx ts-node packages/ocpp-server/src/fleet/matchFleetPolicy.selftest.ts
 */

import { matchFleetPolicy, type FleetPolicyForMatch } from './matchFleetPolicy';

let passed = 0;
let failed = 0;
function assert(c: boolean, name: string) {
  if (c) { passed++; console.log(`  ✅ ${name}`); }
  else   { failed++; console.error(`  ❌ ${name}`); }
}

function policy(
  partial: Partial<FleetPolicyForMatch> & { idTagPrefix: string; id: string },
): FleetPolicyForMatch {
  return {
    siteId: 'site-A',
    name: partial.id,
    status: 'ENABLED',
    maxAmps: 32,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...partial,
  };
}

function fetcherOf(list: FleetPolicyForMatch[]) {
  return async (_siteId: string) => list;
}

async function main() {

// ─── no policies → null ──────────────────────────────────────────────
console.log('\n--- empty policy list returns null ---');
{
  const r = await matchFleetPolicy({
    siteId: 'site-A', idTag: 'FLEET-1', fetchPolicies: fetcherOf([]),
  });
  assert(r === null, 'null on empty list');
}

// ─── no matching prefix → null ───────────────────────────────────────
console.log('\n--- no prefix match returns null ---');
{
  const r = await matchFleetPolicy({
    siteId: 'site-A', idTag: 'RETAIL-1',
    fetchPolicies: fetcherOf([policy({ id: 'p1', idTagPrefix: 'FLEET-' })]),
  });
  assert(r === null, 'RETAIL-1 does not match FLEET-');
}

// ─── DISABLED excluded ────────────────────────────────────────────────
console.log('\n--- DISABLED / DRAFT policies excluded ---');
{
  const r = await matchFleetPolicy({
    siteId: 'site-A', idTag: 'FLEET-1',
    fetchPolicies: fetcherOf([
      policy({ id: 'p1', idTagPrefix: 'FLEET-', status: 'DISABLED' }),
      policy({ id: 'p2', idTagPrefix: 'FLEET-', status: 'DRAFT' }),
    ]),
  });
  assert(r === null, 'only ENABLED considered');
}

// ─── longest prefix wins ──────────────────────────────────────────────
console.log('\n--- longest prefix wins ---');
{
  const r = await matchFleetPolicy({
    siteId: 'site-A', idTag: 'FLEET-NORTH-DRIVER-1',
    fetchPolicies: fetcherOf([
      policy({ id: 'broad', idTagPrefix: 'FLEET-' }),
      policy({ id: 'narrow', idTagPrefix: 'FLEET-NORTH-' }),
      policy({ id: 'narrowest', idTagPrefix: 'FLEET-NORTH-DRIVER-' }),
    ]),
  });
  assert(r?.id === 'narrowest', `longest prefix matched (got ${r?.id})`);
}

// ─── same-length tie → newest updatedAt ───────────────────────────────
console.log('\n--- same-length tie → newest updatedAt wins, warning logged ---');
{
  // Construct a synthetic tie: two policies whose prefixes are different
  // but happen to both have length 3 and both prefix the same idTag.
  // This is only possible if they are both the SAME prefix string — which
  // the DB unique constraint forbids — so we bypass that by lying to the
  // fetcher with two entries sharing a prefix. Verifies the defensive
  // tie-break path.
  const warnings: string[] = [];
  const r = await matchFleetPolicy({
    siteId: 'site-A', idTag: 'ABC-driver',
    fetchPolicies: fetcherOf([
      policy({ id: 'older',  idTagPrefix: 'ABC', updatedAt: new Date('2026-01-01') }),
      policy({ id: 'newer',  idTagPrefix: 'ABC', updatedAt: new Date('2026-04-01') }),
    ]),
    warn: (m) => warnings.push(m),
  });
  assert(r?.id === 'newer', 'newer updatedAt wins on tie');
  assert(warnings.length === 1, 'one warning emitted');
  assert(warnings[0].includes('ambiguous'), 'warning says ambiguous');
  assert(warnings[0].includes('older') && warnings[0].includes('newer'), 'warning names both policies');
}

// ─── no tie → no warning ──────────────────────────────────────────────
console.log('\n--- no tie → no warning ---');
{
  const warnings: string[] = [];
  await matchFleetPolicy({
    siteId: 'site-A', idTag: 'FLEET-NORTH-1',
    fetchPolicies: fetcherOf([
      policy({ id: 'broad',  idTagPrefix: 'FLEET-' }),
      policy({ id: 'narrow', idTagPrefix: 'FLEET-NORTH-' }),
    ]),
    warn: (m) => warnings.push(m),
  });
  assert(warnings.length === 0, 'no warning when unambiguous');
}

// ─── case-sensitive matching (delegated to shared.matchesFleetPolicy) ─
console.log('\n--- case-sensitive prefix match (inherits from shared) ---');
{
  const r = await matchFleetPolicy({
    siteId: 'site-A', idTag: 'fleet-1',
    fetchPolicies: fetcherOf([policy({ id: 'p1', idTagPrefix: 'FLEET-' })]),
  });
  assert(r === null, 'lowercase does not match uppercase prefix');
}

// ─── empty idTag → no match ───────────────────────────────────────────
console.log('\n--- empty idTag returns null ---');
{
  const r = await matchFleetPolicy({
    siteId: 'site-A', idTag: '',
    fetchPolicies: fetcherOf([policy({ id: 'p1', idTagPrefix: 'FLEET-' })]),
  });
  assert(r === null, 'empty idTag unmatched');
}

console.log(`\n${'='.repeat(50)}`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) process.exit(1);

}

main().catch((err) => {
  console.error('Selftest crashed:', err);
  process.exit(1);
});
