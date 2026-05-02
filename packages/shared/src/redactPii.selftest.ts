/**
 * redactPii — Self-Tests (TASK-0198 Phase 1, PR #3)
 * Run: npx ts-node packages/shared/src/redactPii.selftest.ts
 *
 * Pure-function tests. Posture is default-redact-if-uncertain — these
 * tests pin both the positive cases (must redact) and a small set of
 * "looks similar but should NOT" negatives where the cost of over-
 * redaction is unacceptable (e.g. UUIDs that are session ids, not
 * personal identifiers — but per policy we still redact those because
 * UUIDs commonly appear in user fields).
 */

import { redactPii, redactPiiDeep } from './redactPii';

let passed = 0;
let failed = 0;
function assert(c: boolean, name: string) {
  if (c) { passed++; console.log(`  ✅ ${name}`); }
  else   { failed++; console.error(`  ❌ ${name}`); }
}

// ─── empty / null inputs ────────────────────────────────────────
console.log('\n--- empty / null / undefined inputs ---');
{
  assert(redactPii('').text === '', 'empty string passes through');
  assert(redactPii(null).text === '', 'null treated as empty');
  assert(redactPii(undefined).text === '', 'undefined treated as empty');
  assert(redactPii('').summary.redacted === false, 'empty has redacted=false');
}

// ─── VIN ────────────────────────────────────────────────────────
console.log('\n--- VIN (17 chars [A-HJ-NPR-Z0-9]) ---');
{
  const r = redactPii('Driver vehicle VIN is 1HGCM82633A123456 not 5YJ3E1EA7HF000337.');
  assert(r.summary.counts.vin === 2, 'two VINs caught');
  assert(!r.text.includes('1HGCM82633A123456'), 'first VIN replaced');
  assert(!r.text.includes('5YJ3E1EA7HF000337'), 'second VIN replaced');
  assert(r.text.includes('[redacted:vin]'), 'placeholder present');
}
{
  // 16 chars — too short, NOT a VIN.
  const r = redactPii('SHORT1234567890A');
  assert((r.summary.counts.vin ?? 0) === 0, '16-char string not flagged as VIN');
}

// ─── email ──────────────────────────────────────────────────────
console.log('\n--- email ---');
{
  const r = redactPii('contact: jane.doe+driver@example.com or john@sub.tld');
  assert(r.summary.counts.email === 2, 'two emails');
  assert(!r.text.includes('@example.com'), 'first email replaced');
  assert(!r.text.includes('@sub.tld'), 'second email replaced');
}

// ─── phone ──────────────────────────────────────────────────────
console.log('\n--- phone ---');
{
  const cases = [
    '+1 555-867-5309',
    '(415) 555-1234',
    '4155551234',
    '415.555.1234',
    '415-555-1234',
  ];
  for (const c of cases) {
    const r = redactPii(`call ${c} please`);
    assert((r.summary.counts.phone ?? 0) >= 1, `phone shape redacted: ${c}`);
  }
}

// ─── Stripe ids ─────────────────────────────────────────────────
console.log('\n--- Stripe ids ---');
{
  const sample = 'cus_NeGfXm9b1234567890 pm_1NeGfXm9b1234567890Foo seti_1NeGfXm9b12345 pi_3NeGfXm9b12345Bar evt_1NeGfXm9b12345 sub_1NeGfXm9b12345';
  const r = redactPii(sample);
  // Five distinct Stripe-id formats above.
  assert((r.summary.counts.stripe_id ?? 0) >= 5, `≥5 Stripe ids caught (got ${r.summary.counts.stripe_id ?? 0})`);
  assert(!r.text.includes('cus_NeGfXm9b1234567890'), 'cus_ id replaced');
  assert(!r.text.includes('pm_1NeGfXm9b1234567890Foo'), 'pm_ id replaced');
}

// ─── Clerk-style user ids ───────────────────────────────────────
console.log('\n--- Clerk user_* ids ---');
{
  const r = redactPii('clerk id user_2NeGfXm9b1234567890 fired the event');
  assert((r.summary.counts.clerk_user_id ?? 0) === 1, 'clerk user id redacted');
  assert(!r.text.includes('user_2NeGfXm9b1234567890'), 'value replaced');
}

// ─── bearer tokens ──────────────────────────────────────────────
console.log('\n--- bearer tokens ---');
{
  const r = redactPii('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sigsigsig');
  assert((r.summary.counts.bearer_token ?? 0) === 1, 'bearer token redacted');
  assert(!r.text.includes('eyJhbGciOiJIUzI1NiJ9'), 'JWT token replaced');
}

// ─── UUIDs (default-redact) ─────────────────────────────────────
console.log('\n--- UUIDs always redacted (default-redact-if-uncertain) ---');
{
  const r = redactPii('userId=8f0deae8-001b-787b-4352-54bb06365c24 sessionId=991396a8-4270-4312-b78d-dd8e01507ee8');
  assert((r.summary.counts.uuid ?? 0) === 2, 'two UUIDs redacted');
  assert(r.text.split('[redacted:uuid]').length - 1 === 2, 'two placeholders present');
}

// ─── ordering: Stripe ids beat UUIDs ────────────────────────────
console.log('\n--- ordering: Stripe-prefixed ids labeled stripe_id, not uuid ---');
{
  // pm_<UUID> shape — should be caught by stripe_id, not by uuid pass.
  const r = redactPii('pm_NeGfXm9b1234567890');
  assert((r.summary.counts.stripe_id ?? 0) === 1, 'labeled as stripe_id');
  assert((r.summary.counts.uuid ?? 0) === 0, 'NOT labeled as uuid');
}

// ─── multiple kinds in one input ────────────────────────────────
console.log('\n--- mixed input redacts every kind ---');
{
  const input = 'Driver jane@x.com (+1 555-867-5309), VIN 1HGCM82633A123456, paid via cus_NeGfXm9b1234567890. Session 991396a8-4270-4312-b78d-dd8e01507ee8.';
  const r = redactPii(input);
  assert(r.summary.redacted === true, 'redacted flag true');
  assert((r.summary.counts.email ?? 0) >= 1, 'email');
  assert((r.summary.counts.phone ?? 0) >= 1, 'phone');
  assert((r.summary.counts.vin ?? 0) === 1, 'vin');
  assert((r.summary.counts.stripe_id ?? 0) === 1, 'stripe_id');
  assert((r.summary.counts.uuid ?? 0) === 1, 'uuid');
  // No leakage
  for (const sensitive of ['jane@x.com', '555-867-5309', '1HGCM82633A123456', 'cus_NeGfXm9b1234567890', '991396a8-4270-4312-b78d-dd8e01507ee8']) {
    assert(!r.text.includes(sensitive), `original "${sensitive.slice(0, 12)}..." not present in output`);
  }
}

// ─── deep redaction over JSON-shaped values ─────────────────────
console.log('\n--- redactPiiDeep walks objects + arrays ---');
{
  const value = {
    sessionId: '991396a8-4270-4312-b78d-dd8e01507ee8',
    driver: { email: 'a@b.com', phone: '+1 555-555-1234' },
    notes: ['paid via cus_NeGfXm9b1234567890', 'VIN: 1HGCM82633A123456'],
    nested: { deeper: { yetAgain: 'jane@x.com' } },
    metadata: { count: 7, ok: true, nothing: null },
  };
  const r = redactPiiDeep(value);
  const out = r.value as any;
  assert(out.sessionId.includes('[redacted:uuid]'), 'sessionId redacted');
  assert(out.driver.email.includes('[redacted:email]'), 'driver.email redacted');
  assert(out.driver.phone.includes('[redacted:phone]'), 'driver.phone redacted');
  assert(out.notes[0].includes('[redacted:stripe_id]'), 'notes[0] stripe id');
  assert(out.notes[1].includes('[redacted:vin]'), 'notes[1] vin');
  assert(out.nested.deeper.yetAgain.includes('[redacted:email]'), 'deep nested');
  assert(out.metadata.count === 7 && out.metadata.ok === true && out.metadata.nothing === null, 'non-strings pass through');
  assert(r.summary.redacted === true, 'summary flag');
  // Aggregated counts
  assert((r.summary.counts.email ?? 0) >= 2, 'aggregated email count');
  assert((r.summary.counts.uuid ?? 0) >= 1, 'aggregated uuid count');
}

// ─── deep: cycle/depth safety ───────────────────────────────────
console.log('\n--- redactPiiDeep depth limit prevents runaway ---');
{
  // Build a deeply nested object beyond the default depth.
  let v: any = 'jane@x.com';
  for (let i = 0; i < 20; i++) v = { inner: v };
  const r = redactPiiDeep(v, 5); // maxDepth=5
  // The string at depth 20 will not be redacted (we stopped at 5), but
  // the function must NOT throw.
  assert(typeof r.value === 'object', 'returns object without throwing');
}

// ─── idempotence ────────────────────────────────────────────────
console.log('\n--- redactPii is idempotent on already-redacted text ---');
{
  const first = redactPii('jane@x.com VIN 1HGCM82633A123456');
  const second = redactPii(first.text);
  assert(second.text === first.text, 'second pass == first pass');
  assert(second.summary.redacted === false, 'no new redactions on placeholder text');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
