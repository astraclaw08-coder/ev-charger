/**
 * Smart Charging Stacking — Self-Tests
 * Run: npx ts-node packages/shared/src/smartCharging.selftest.ts
 */
import { resolveAllActiveProfiles, resolveEffectiveSmartChargingLimit, computeMergedSchedule, type SmartChargingProfileLike } from './smartCharging';

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.error(`  ❌ ${name}`);
  }
}

function makeProfile(overrides: Partial<SmartChargingProfileLike> & { id: string; name: string }): SmartChargingProfileLike {
  return {
    scope: 'CHARGER' as any,
    enabled: true,
    priority: 0,
    defaultLimitKw: null,
    schedule: null,
    validFrom: null,
    validTo: null,
    updatedAt: new Date(),
    ...overrides,
  };
}

// ─── Test 1: Single CHARGER profile, constant limit ──────────────────

console.log('\nTest 1: Single CHARGER profile, 6 kW always');
{
  const p = makeProfile({ id: 'p1', name: 'Peak Cap', defaultLimitKw: 6 });
  const result = resolveAllActiveProfiles({
    chargerProfiles: [p],
    groupProfiles: [],
    siteProfiles: [],
  });
  assert(result.length === 1, 'Returns 1 profile');
  assert(result[0].ocppStackLevel === 50, 'CHARGER base stackLevel = 50');
  assert(result[0].ocppChargingProfileId === 1, 'chargingProfileId = 1');
  assert(result[0].profile.id === 'p1', 'Correct profile');
}

// ─── Test 2: Two non-overlapping profiles ──────────────────────────

console.log('\nTest 2: Two CHARGER profiles, non-overlapping windows');
{
  const pA = makeProfile({
    id: 'pA', name: 'Morning Cap', defaultLimitKw: 20,
    schedule: [{ id: 'w1', daysOfWeek: [0,1,2,3,4,5,6], startTime: '10:00', endTime: '12:00', limitKw: 6 }],
  });
  const pB = makeProfile({
    id: 'pB', name: 'Evening Cap', defaultLimitKw: 20, priority: 1,
    schedule: [{ id: 'w2', daysOfWeek: [0,1,2,3,4,5,6], startTime: '14:00', endTime: '16:00', limitKw: 8 }],
  });
  const result = resolveAllActiveProfiles({
    chargerProfiles: [pA, pB],
    groupProfiles: [],
    siteProfiles: [],
  });
  assert(result.length === 2, 'Returns 2 profiles');
  assert(result[0].ocppStackLevel !== result[1].ocppStackLevel || result[0].ocppChargingProfileId !== result[1].ocppChargingProfileId,
    'Different stackLevel or profileId');
}

// ─── Test 3: Overlapping — CHARGER + SITE scope stacking ────────────

console.log('\nTest 3: CHARGER (6kW 10-12) + SITE (10kW always) — scope stacking');
{
  const pCharger = makeProfile({
    id: 'pc', name: 'Charger Peak', defaultLimitKw: 20,
    schedule: [{ id: 'w1', daysOfWeek: [0,1,2,3,4,5,6], startTime: '10:00', endTime: '12:00', limitKw: 6 }],
  });
  const pSite = makeProfile({
    id: 'ps', name: 'Site Default', scope: 'SITE' as any, defaultLimitKw: 10,
  });
  const result = resolveAllActiveProfiles({
    chargerProfiles: [pCharger],
    groupProfiles: [],
    siteProfiles: [pSite],
  });
  assert(result.length === 2, 'Returns 2 profiles (CHARGER + SITE)');
  const chargerEntry = result.find(r => r.scope === 'CHARGER');
  const siteEntry = result.find(r => r.scope === 'SITE');
  assert(chargerEntry != null && siteEntry != null, 'Both scopes present');
  assert(chargerEntry!.ocppStackLevel > siteEntry!.ocppStackLevel, 'CHARGER stackLevel > SITE stackLevel');

  // Merged schedule: at 10:00, effective = min(6, 10) = 6
  const merged = computeMergedSchedule({
    stackedProfiles: result,
    fallbackLimitKw: 50,
  });
  const slot10 = merged.find(s => s.hour === 10);
  const slot8 = merged.find(s => s.hour === 8);
  assert(slot10?.effectiveLimitKw === 6, 'At 10:00 effective = 6 kW (CHARGER window wins)');
  assert(slot8?.effectiveLimitKw === 10, 'At 8:00 effective = 10 kW (SITE default wins)');
}

// ─── Test 4: Full scope stacking — SITE + GROUP + CHARGER ───────────

console.log('\nTest 4: Triple scope stacking SITE + GROUP + CHARGER');
{
  const pSite = makeProfile({ id: 's1', name: 'Site 15kW', scope: 'SITE' as any, defaultLimitKw: 15 });
  const pGroup = makeProfile({ id: 'g1', name: 'Group 10kW', scope: 'GROUP' as any, defaultLimitKw: 10 });
  const pCharger = makeProfile({
    id: 'c1', name: 'Charger 6kW peak',
    schedule: [{ id: 'w1', daysOfWeek: [0,1,2,3,4,5,6], startTime: '10:00', endTime: '12:00', limitKw: 6 }],
    defaultLimitKw: 20,
  });
  const result = resolveAllActiveProfiles({
    chargerProfiles: [pCharger],
    groupProfiles: [pGroup],
    siteProfiles: [pSite],
  });
  assert(result.length === 3, 'Returns 3 profiles');
  const levels = result.map(r => ({ scope: r.scope, level: r.ocppStackLevel }));
  const chargerLevel = levels.find(l => l.scope === 'CHARGER')!.level;
  const groupLevel = levels.find(l => l.scope === 'GROUP')!.level;
  const siteLevel = levels.find(l => l.scope === 'SITE')!.level;
  assert(chargerLevel > groupLevel, 'CHARGER > GROUP stackLevel');
  assert(groupLevel > siteLevel, 'GROUP > SITE stackLevel');

  // Merged: at 10:00 = min(6, 10, 15) = 6; at 14:00 = min(20, 10, 15) = 10
  const merged = computeMergedSchedule({ stackedProfiles: result, fallbackLimitKw: 50 });
  assert(merged.find(s => s.hour === 10)?.effectiveLimitKw === 6, 'At 10:00 = 6 kW');
  assert(merged.find(s => s.hour === 14)?.effectiveLimitKw === 10, 'At 14:00 = 10 kW (GROUP default)');
}

// ─── Test 5: Disabled profile excluded ───────────────────────────────

console.log('\nTest 5: Disabled profile excluded from stacking');
{
  const pEnabled = makeProfile({ id: 'e1', name: 'Active', defaultLimitKw: 6 });
  const pDisabled = makeProfile({ id: 'd1', name: 'Disabled', defaultLimitKw: 10, enabled: false });
  const result = resolveAllActiveProfiles({
    chargerProfiles: [pEnabled, pDisabled],
    groupProfiles: [],
    siteProfiles: [],
  });
  assert(result.length === 1, 'Only enabled profile returned');
  assert(result[0].profile.id === 'e1', 'Correct profile');
}

// ─── Test 6: Validity window filtering ───────────────────────────────

console.log('\nTest 6: Expired profile excluded');
{
  const pValid = makeProfile({ id: 'v1', name: 'Current', defaultLimitKw: 6 });
  const pExpired = makeProfile({
    id: 'x1', name: 'Expired', defaultLimitKw: 10,
    validTo: new Date('2020-01-01'),
  });
  const result = resolveAllActiveProfiles({
    chargerProfiles: [pValid, pExpired],
    groupProfiles: [],
    siteProfiles: [],
  });
  assert(result.length === 1, 'Only valid profile returned');
}

// ─── Test 7: Priority affects stackLevel ─────────────────────────────

console.log('\nTest 7: Priority offsets stackLevel');
{
  const pLow = makeProfile({ id: 'lo', name: 'Low', defaultLimitKw: 10, priority: 0 });
  const pHigh = makeProfile({ id: 'hi', name: 'High', defaultLimitKw: 6, priority: 5 });
  const result = resolveAllActiveProfiles({
    chargerProfiles: [pLow, pHigh],
    groupProfiles: [],
    siteProfiles: [],
  });
  const lo = result.find(r => r.profile.id === 'lo')!;
  const hi = result.find(r => r.profile.id === 'hi')!;
  assert(hi.ocppStackLevel === 55, 'High priority = base 50 + 5');
  assert(lo.ocppStackLevel === 50, 'Low priority = base 50 + 0');
  assert(hi.ocppStackLevel > lo.ocppStackLevel, 'Higher priority → higher stackLevel');
}

// ─── Test 8: Legacy single-winner still works ────────────────────────

console.log('\nTest 8: Legacy resolveEffectiveSmartChargingLimit unchanged');
{
  const pCharger = makeProfile({
    id: 'c1', name: 'Charger 6kW',
    schedule: [{ id: 'w1', daysOfWeek: [0,1,2,3,4,5,6], startTime: '10:00', endTime: '12:00', limitKw: 6 }],
    defaultLimitKw: 20,
  });
  const pSite = makeProfile({ id: 's1', name: 'Site 10kW', scope: 'SITE' as any, defaultLimitKw: 10 });

  // At 10:30 — charger window active, should win (first scope match)
  const at1030 = new Date(); at1030.setUTCHours(10, 30, 0, 0);
  const res = resolveEffectiveSmartChargingLimit({
    chargerProfiles: [pCharger],
    groupProfiles: [],
    siteProfiles: [pSite],
    at: at1030,
    fallbackLimitKw: 50,
  });
  assert(res.effectiveLimitKw === 6, 'Single-winner: charger window 6 kW');
  assert(res.sourceScope === 'CHARGER', 'Source: CHARGER');
}

// ─── Summary ─────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
