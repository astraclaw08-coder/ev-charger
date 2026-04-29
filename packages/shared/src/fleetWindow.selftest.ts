/**
 * Fleet window evaluation — Self-Tests (TASK-0208 Phase 1)
 * Run: npx ts-node packages/shared/src/fleetWindow.selftest.ts
 */
import {
  evaluateFleetWindowAt,
  matchesFleetPolicy,
  normalizeFleetWindows,
} from './fleetWindow';

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else            { failed++; console.error(`  ❌ ${name}`); }
}

// UTC helper — build a Date at a specific UTC wall-time, so we can then
// evaluate it against a given site timezone and check the localized day/minute
// math.
function utc(y: number, mo: number, d: number, h: number, m: number): Date {
  return new Date(Date.UTC(y, mo - 1, d, h, m, 0, 0));
}

// ─── Test 1: normalize strips bad rows ───────────────────────────────
console.log('\nTest 1: normalizeFleetWindows rejects bad entries');
{
  const out = normalizeFleetWindows([
    { day: 1, start: '09:00', end: '17:00' },           // good
    { day: 7, start: '09:00', end: '17:00' },           // bad day
    { day: 2, start: '99:99', end: '17:00' },           // bad start
    { day: 3, start: '09:00', end: '09:00' },           // zero-length
    { day: 4, start: '22:00', end: '02:00' },           // overnight — rejected
    { day: 5, start: '22:00', end: '23:59' },           // legacy end
  ]);
  assert(out.length === 2, `2 valid entries kept (got ${out.length})`);
  assert(out[0].day === 1 && out[0].start === '09:00', 'first is Mon 09–17');
  assert(out[1].end === '00:00', 'legacy 23:59 normalized to 00:00');
}

// ─── Test 2: accepts wrapped { windows: [...] } shape ─────────────────
console.log('\nTest 2: accepts { windows: [...] } wrapped shape');
{
  const out = normalizeFleetWindows({ windows: [{ day: 0, start: '00:00', end: '06:00' }] });
  assert(out.length === 1, 'one window');
}

// ─── Test 3: empty windows → permanently inactive ────────────────────
console.log('\nTest 3: empty windows → active=false, no transition');
{
  const r = evaluateFleetWindowAt({ at: utc(2026, 4, 23, 10, 0), windows: [], timeZone: 'America/Los_Angeles' });
  assert(r.active === false, 'inactive');
  assert(r.nextTransitionAt === null, 'no transition');
  assert(r.matchedWindow === null, 'no matched window');
}

// ─── Test 4: LA midnight window — UTC clock hits inside ───────────────
console.log('\nTest 4: LA 22:00–06:00 overnight (split into two windows)');
{
  // Split: Mon 22:00–00:00 + Tue 00:00–06:00
  const windows = [
    { day: 1, start: '22:00', end: '00:00' },
    { day: 2, start: '00:00', end: '06:00' },
  ];
  // Monday LA 23:00 = Tuesday 06:00 UTC (PDT = UTC-7 in April)
  const insideLate   = utc(2026, 4, 21, 6, 0);  // Tue 06:00 UTC = Mon 23:00 LA (PDT)
  const insideEarly  = utc(2026, 4, 21, 11, 0); // Tue 11:00 UTC = Tue 04:00 LA
  const outsideDay   = utc(2026, 4, 21, 20, 0); // Tue 20:00 UTC = Tue 13:00 LA
  const rLate = evaluateFleetWindowAt({ at: insideLate, windows, timeZone: 'America/Los_Angeles' });
  const rEarly = evaluateFleetWindowAt({ at: insideEarly, windows, timeZone: 'America/Los_Angeles' });
  const rOut = evaluateFleetWindowAt({ at: outsideDay, windows, timeZone: 'America/Los_Angeles' });
  assert(rLate.active === true, 'active at Mon 23:00 LA');
  assert(rEarly.active === true, 'active at Tue 04:00 LA');
  assert(rOut.active === false, 'inactive at Tue 13:00 LA');
  assert(rEarly.nextTransitionAt !== null, 'has transition at');
}

// ─── Test 5: merged overnight window transition ──────────────────────
console.log('\nTest 5: split overnight windows merge for transition math');
{
  const windows = [
    { day: 1, start: '22:00', end: '00:00' }, // Mon 22–24
    { day: 2, start: '00:00', end: '06:00' }, // Tue 00–06
  ];
  // Inside at Mon 23:00 LA; expect transition at Tue 06:00 LA (not Tue 00:00)
  const at = utc(2026, 4, 21, 6, 0); // Mon 23:00 LA (PDT)
  const r = evaluateFleetWindowAt({ at, windows, timeZone: 'America/Los_Angeles' });
  assert(r.active === true, 'active');
  // Tue 06:00 LA PDT = Tue 13:00 UTC
  const expected = utc(2026, 4, 21, 13, 0);
  assert(r.nextTransitionAt !== null && r.nextTransitionAt.getTime() === expected.getTime(),
    `transition at Tue 13:00 UTC (got ${r.nextTransitionAt?.toISOString()})`);
}

// ─── Test 6: outside-window → next transition is window start ─────────
console.log('\nTest 6: outside window — next transition is window start');
{
  const windows = [{ day: 2, start: '09:00', end: '17:00' }]; // Tue 09–17 LA
  // Tue 08:30 LA PDT = Tue 15:30 UTC
  const at = utc(2026, 4, 21, 15, 30);
  const r = evaluateFleetWindowAt({ at, windows, timeZone: 'America/Los_Angeles' });
  assert(r.active === false, 'inactive');
  // Tue 09:00 LA PDT = Tue 16:00 UTC
  const expected = utc(2026, 4, 21, 16, 0);
  assert(r.nextTransitionAt !== null && r.nextTransitionAt.getTime() === expected.getTime(),
    `transition at Tue 16:00 UTC (got ${r.nextTransitionAt?.toISOString()})`);
}

// ─── Test 7: week-wrap — Saturday window, evaluated Sunday ────────────
console.log('\nTest 7: week wrap — next-window calc spans Sat → Mon');
{
  const windows = [{ day: 1, start: '09:00', end: '17:00' }]; // Mon only
  // Sunday 12:00 LA → next activation is Monday 09:00 LA
  // Sun 12:00 LA PDT = Sun 19:00 UTC
  const at = utc(2026, 4, 19, 19, 0);
  const r = evaluateFleetWindowAt({ at, windows, timeZone: 'America/Los_Angeles' });
  assert(r.active === false, 'inactive Sunday');
  // Mon 09:00 LA PDT = Mon 16:00 UTC
  const expected = utc(2026, 4, 20, 16, 0);
  assert(r.nextTransitionAt !== null && r.nextTransitionAt.getTime() === expected.getTime(),
    `wrap-around transition (got ${r.nextTransitionAt?.toISOString()})`);
}

// ─── Test 8: UTC fallback (no timezone) ───────────────────────────────
console.log('\nTest 8: UTC fallback matches when timeZone omitted');
{
  const windows = [{ day: 2, start: '09:00', end: '17:00' }]; // Tue 09–17 UTC
  const at = utc(2026, 4, 21, 10, 0); // Tue 10:00 UTC
  const r = evaluateFleetWindowAt({ at, windows });
  assert(r.active === true, 'active at Tue 10:00 UTC');
}

// ─── Test 9: bad timezone degrades to UTC ─────────────────────────────
console.log('\nTest 9: invalid timezone string degrades gracefully');
{
  const windows = [{ day: 2, start: '09:00', end: '17:00' }];
  const at = utc(2026, 4, 21, 10, 0);
  const r = evaluateFleetWindowAt({ at, windows, timeZone: 'Not/A_Real_Zone' });
  assert(r.active === true, 'still evaluates (falls back to UTC)');
}

// ─── Test 10: idTag prefix matching ───────────────────────────────────
console.log('\nTest 10: matchesFleetPolicy');
{
  assert(matchesFleetPolicy('FLEET-001', 'FLEET-') === true, 'prefix match');
  assert(matchesFleetPolicy('fleet-001', 'FLEET-') === false, 'case sensitive');
  assert(matchesFleetPolicy('NOPE', 'FLEET-') === false, 'no match');
  assert(matchesFleetPolicy('', 'FLEET-') === false, 'empty tag');
  assert(matchesFleetPolicy('FLEET-001', '') === false, 'empty prefix (don\'t match everything)');
}

// ─── Test 11: transition is minute-aligned ────────────────────────────
console.log('\nTest 11: nextTransitionAt aligned to minute boundary');
{
  const windows = [{ day: 2, start: '09:00', end: '17:00' }];
  // Tue 08:30:47 UTC → next at Tue 09:00:00 UTC
  const at = new Date(Date.UTC(2026, 3, 21, 8, 30, 47, 123));
  const r = evaluateFleetWindowAt({ at, windows });
  assert(r.nextTransitionAt !== null, 'has transition');
  assert(r.nextTransitionAt!.getUTCSeconds() === 0 && r.nextTransitionAt!.getUTCMilliseconds() === 0,
    'seconds/ms zeroed');
}

// ─── Test 12: alwaysOn=true short-circuits to permanently active ──────
console.log('\nTest 12: alwaysOn=true → active regardless of windows');
{
  const r1 = evaluateFleetWindowAt({
    at: utc(2026, 4, 23, 10, 0),
    windows: [],
    timeZone: 'America/Los_Angeles',
    alwaysOn: true,
  });
  assert(r1.active === true, 'alwaysOn + empty windows → active');
  assert(r1.matchedWindow === null, 'matchedWindow is null when alwaysOn (no window matched)');
  assert(r1.nextTransitionAt === null, 'nextTransitionAt is null when alwaysOn');

  // Outside the windowed config (Sunday 00:00 LA, windowed Mon 09–17)
  const r2 = evaluateFleetWindowAt({
    at: utc(2026, 4, 26, 7, 0), // Sunday 00:00 LA
    windows: [{ day: 1, start: '09:00', end: '17:00' }],
    timeZone: 'America/Los_Angeles',
    alwaysOn: true,
  });
  assert(r2.active === true, 'alwaysOn + windowed config outside window → still active');
  assert(r2.nextTransitionAt === null, 'no transition when alwaysOn');

  // Regression guard: alwaysOn=false + empty windows → inactive (existing behavior)
  const r3 = evaluateFleetWindowAt({
    at: utc(2026, 4, 23, 10, 0),
    windows: [],
    timeZone: 'America/Los_Angeles',
    alwaysOn: false,
  });
  assert(r3.active === false, 'alwaysOn=false + empty windows → inactive');

  // Regression guard: alwaysOn omitted defaults to off
  const r4 = evaluateFleetWindowAt({
    at: utc(2026, 4, 23, 10, 0),
    windows: [],
    timeZone: 'America/Los_Angeles',
  });
  assert(r4.active === false, 'alwaysOn omitted defaults off (existing callers unaffected)');
}

// ─── Summary ──────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
