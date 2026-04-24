/**
 * FleetPolicy validator — Self-Tests (TASK-0208 Phase 2.5 PR-A)
 * Run: npx ts-node --transpile-only packages/shared/src/fleetPolicy.selftest.ts
 */
import {
  validateFleetPolicyInput,
  prefixesCollide,
  FLEET_POLICY_MIN_AMPS,
  FLEET_POLICY_MAX_AMPS,
  type SiblingPolicy,
} from './fleetPolicy';

let passed = 0;
let failed = 0;

function assert(cond: boolean, name: string) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else      { failed++; console.error(`  ❌ ${name}`); }
}

const BASE_INPUT = {
  name: 'Acme Fleet',
  idTagPrefix: 'FLEET-ACME-',
  maxAmps: 32,
  windowsJson: { windows: [{ day: 1, start: '09:00', end: '17:00' }] },
};

const NO_SIBLINGS: SiblingPolicy[] = [];

// ─── Test 1: happy path ──────────────────────────────────────────────
console.log('\nTest 1: valid input normalizes cleanly');
{
  const r = validateFleetPolicyInput(BASE_INPUT, { siblingPolicies: NO_SIBLINGS });
  assert(r.ok === true, 'accepted');
  if (r.ok) {
    assert(r.normalized.name === 'Acme Fleet', 'name preserved');
    assert(r.normalized.idTagPrefix === 'FLEET-ACME-', 'prefix preserved');
    assert(r.normalized.maxAmps === 32, 'maxAmps preserved');
    assert(r.normalized.ocppStackLevel === 90, 'stackLevel defaults to 90');
    assert(r.normalized.windows.length === 1, 'windows normalized');
    assert(r.normalized.notes === null, 'notes null when absent');
  }
}

// ─── Test 2: name rules ──────────────────────────────────────────────
console.log('\nTest 2: name required + length capped');
{
  const r1 = validateFleetPolicyInput({ ...BASE_INPUT, name: '   ' }, { siblingPolicies: NO_SIBLINGS });
  assert(r1.ok === false, 'blank name rejected');
  if (!r1.ok) assert(r1.errors.some(e => e.field === 'name' && e.code === 'REQUIRED'), 'name REQUIRED');

  const r2 = validateFleetPolicyInput({ ...BASE_INPUT, name: 'x'.repeat(81) }, { siblingPolicies: NO_SIBLINGS });
  assert(r2.ok === false, '81-char name rejected');
  if (!r2.ok) assert(r2.errors.some(e => e.field === 'name' && e.code === 'TOO_LONG'), 'name TOO_LONG');
}

// ─── Test 3: idTagPrefix format ──────────────────────────────────────
console.log('\nTest 3: idTagPrefix format');
{
  const bad = ['', 'a', 'lowercase', 'HAS SPACE', 'HAS.DOT', '-LEADINGHYPHEN', 'x'.repeat(33)];
  for (const v of bad) {
    const r = validateFleetPolicyInput({ ...BASE_INPUT, idTagPrefix: v }, { siblingPolicies: NO_SIBLINGS });
    assert(r.ok === false, `rejects "${v}"`);
    if (!r.ok) {
      const err = r.errors.find(e => e.field === 'idTagPrefix');
      assert(!!err, `  error for "${v}"`);
    }
  }
  const good = ['FLEET-', 'FLEET-ACME-', 'AB', 'F1', 'A_B', '1X'];
  for (const v of good) {
    const r = validateFleetPolicyInput({ ...BASE_INPUT, idTagPrefix: v }, { siblingPolicies: NO_SIBLINGS });
    assert(r.ok === true, `accepts "${v}"`);
  }
}

// ─── Test 4: maxAmps range [6, 80] ───────────────────────────────────
console.log('\nTest 4: maxAmps range enforcement');
{
  assert(FLEET_POLICY_MIN_AMPS === 6, 'min is 6');
  assert(FLEET_POLICY_MAX_AMPS === 80, 'max is 80');
  for (const v of [0, 1, 5, 81, 100, 3.5, NaN]) {
    const r = validateFleetPolicyInput({ ...BASE_INPUT, maxAmps: v }, { siblingPolicies: NO_SIBLINGS });
    assert(r.ok === false, `rejects maxAmps=${v}`);
  }
  for (const v of [6, 16, 32, 48, 80]) {
    const r = validateFleetPolicyInput({ ...BASE_INPUT, maxAmps: v }, { siblingPolicies: NO_SIBLINGS });
    assert(r.ok === true, `accepts maxAmps=${v}`);
  }
}

// ─── Test 5: ocppStackLevel range [51, 98] ───────────────────────────
console.log('\nTest 5: ocppStackLevel range');
{
  for (const v of [50, 99, 100, -1, 3.5]) {
    const r = validateFleetPolicyInput({ ...BASE_INPUT, ocppStackLevel: v }, { siblingPolicies: NO_SIBLINGS });
    assert(r.ok === false, `rejects stackLevel=${v}`);
  }
  for (const v of [51, 75, 90, 98]) {
    const r = validateFleetPolicyInput({ ...BASE_INPUT, ocppStackLevel: v }, { siblingPolicies: NO_SIBLINGS });
    assert(r.ok === true, `accepts stackLevel=${v}`);
  }
}

// ─── Test 6: windowsJson — empty ok by default, required when requested ─
console.log('\nTest 6: windowsJson shape');
{
  const r1 = validateFleetPolicyInput(
    { ...BASE_INPUT, windowsJson: { windows: [] } },
    { siblingPolicies: NO_SIBLINGS },
  );
  assert(r1.ok === true, 'empty windows ok when requireWindows=false');

  const r2 = validateFleetPolicyInput(
    { ...BASE_INPUT, windowsJson: { windows: [] } },
    { siblingPolicies: NO_SIBLINGS, requireWindows: true },
  );
  assert(r2.ok === false, 'empty windows rejected when requireWindows=true');
  if (!r2.ok) assert(r2.errors.some(e => e.code === 'EMPTY_WINDOWS'), 'EMPTY_WINDOWS emitted');

  // All-bad windows also yields 0 after normalize
  const r3 = validateFleetPolicyInput(
    { ...BASE_INPUT, windowsJson: { windows: [{ day: 99, start: '9', end: '?' }] } },
    { siblingPolicies: NO_SIBLINGS, requireWindows: true },
  );
  assert(r3.ok === false, 'all-malformed windows rejected on enable');
}

// ─── Test 7: prefix-collision ────────────────────────────────────────
console.log('\nTest 7: prefix collision');
{
  assert(prefixesCollide('FLEET-', 'FLEET-ACME-') === true, 'FLEET- collides with FLEET-ACME-');
  assert(prefixesCollide('FLEET-ACME-', 'FLEET-') === true, 'reverse also collides');
  assert(prefixesCollide('FLEET-', 'FLEET-') === true, 'exact dupe collides');
  assert(prefixesCollide('FLEET-ACME-', 'FLEET-BETA-') === false, 'sibling non-overlap');
  assert(prefixesCollide('ACME-', 'FLEET-') === false, 'unrelated roots');

  // ENABLED sibling blocks
  const siblings1: SiblingPolicy[] = [
    { id: 'p1', idTagPrefix: 'FLEET-', status: 'ENABLED' },
  ];
  const r1 = validateFleetPolicyInput(
    { ...BASE_INPUT, idTagPrefix: 'FLEET-ACME-' },
    { siblingPolicies: siblings1 },
  );
  assert(r1.ok === false, 'collision with ENABLED sibling rejected');
  if (!r1.ok) {
    const err = r1.errors.find(e => e.code === 'PREFIX_COLLISION');
    assert(!!err, 'PREFIX_COLLISION emitted');
    assert((err?.detail as any)?.conflictingPolicyId === 'p1', 'detail carries conflicting id');
  }

  // DISABLED sibling does NOT block
  const siblings2: SiblingPolicy[] = [
    { id: 'p1', idTagPrefix: 'FLEET-', status: 'DISABLED' },
  ];
  const r2 = validateFleetPolicyInput(
    { ...BASE_INPUT, idTagPrefix: 'FLEET-ACME-' },
    { siblingPolicies: siblings2 },
  );
  assert(r2.ok === true, 'DISABLED sibling ignored in collision check');

  // DRAFT sibling DOES block (not DISABLED)
  const siblings3: SiblingPolicy[] = [
    { id: 'p1', idTagPrefix: 'FLEET-', status: 'DRAFT' },
  ];
  const r3 = validateFleetPolicyInput(
    { ...BASE_INPUT, idTagPrefix: 'FLEET-ACME-' },
    { siblingPolicies: siblings3 },
  );
  assert(r3.ok === false, 'DRAFT sibling still blocks');

  // selfId skips self
  const siblings4: SiblingPolicy[] = [
    { id: 'self', idTagPrefix: 'FLEET-ACME-', status: 'ENABLED' },
  ];
  const r4 = validateFleetPolicyInput(
    { ...BASE_INPUT, idTagPrefix: 'FLEET-ACME-' },
    { siblingPolicies: siblings4, selfId: 'self' },
  );
  assert(r4.ok === true, 'selfId excluded from collision check');

  // Non-overlapping sibling allowed
  const siblings5: SiblingPolicy[] = [
    { id: 'p1', idTagPrefix: 'ACME-', status: 'ENABLED' },
  ];
  const r5 = validateFleetPolicyInput(
    { ...BASE_INPUT, idTagPrefix: 'FLEET-' },
    { siblingPolicies: siblings5 },
  );
  assert(r5.ok === true, 'unrelated prefixes coexist');
}

// ─── Test 8: notes ───────────────────────────────────────────────────
console.log('\nTest 8: notes optional + length cap');
{
  const r1 = validateFleetPolicyInput({ ...BASE_INPUT, notes: '   ' }, { siblingPolicies: NO_SIBLINGS });
  assert(r1.ok === true && r1.normalized.notes === null, 'whitespace-only notes → null');

  const r2 = validateFleetPolicyInput({ ...BASE_INPUT, notes: 'ok' }, { siblingPolicies: NO_SIBLINGS });
  assert(r2.ok === true && r2.ok && r2.normalized.notes === 'ok', 'notes preserved when non-empty');

  const r3 = validateFleetPolicyInput(
    { ...BASE_INPUT, notes: 'x'.repeat(2001) },
    { siblingPolicies: NO_SIBLINGS },
  );
  assert(r3.ok === false, '2001-char notes rejected');
}

// ─── Test 9: multi-error accumulation ─────────────────────────────────
console.log('\nTest 9: multiple errors returned at once');
{
  const r = validateFleetPolicyInput(
    { name: '', idTagPrefix: '!!', maxAmps: 999, windowsJson: null },
    { siblingPolicies: NO_SIBLINGS, requireWindows: true },
  );
  assert(r.ok === false, 'rejected');
  if (!r.ok) {
    const fields = new Set(r.errors.map(e => e.field));
    assert(fields.has('name'), 'name error present');
    assert(fields.has('idTagPrefix'), 'prefix error present');
    assert(fields.has('maxAmps'), 'maxAmps error present');
    assert(fields.has('windowsJson'), 'windows error present');
  }
}

// ─── Summary ──────────────────────────────────────────────────────────
console.log(`\n\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
