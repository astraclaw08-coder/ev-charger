import assert from 'assert';
import { parseSmartChargingSchedule, resolveEffectiveSmartChargingLimit, type SmartChargingProfileLike } from '@ev-charger/shared';

function profile(input: Partial<SmartChargingProfileLike> & Pick<SmartChargingProfileLike, 'id' | 'name' | 'scope'>): SmartChargingProfileLike {
  return {
    id: input.id,
    name: input.name,
    scope: input.scope,
    enabled: input.enabled ?? true,
    priority: input.priority ?? 0,
    defaultLimitKw: input.defaultLimitKw ?? null,
    schedule: input.schedule ?? [],
    validFrom: input.validFrom ?? null,
    validTo: input.validTo ?? null,
    updatedAt: input.updatedAt ?? new Date('2026-01-01T00:00:00.000Z'),
  };
}

const validSchedule = parseSmartChargingSchedule([
  {
    id: 'overnight',
    daysOfWeek: [1, 2, 3, 4, 5],
    startTime: '22:00',
    endTime: '06:00',
    limitKw: 10,
  },
]);

assert.equal(validSchedule.errors.length, 0, 'valid schedule must parse');

const invalidSchedule = parseSmartChargingSchedule([{ daysOfWeek: ['x'], startTime: '99:00', endTime: '11:00', limitKw: -1 }]);
assert.ok(invalidSchedule.errors.length > 0, 'invalid schedule must fail');

const at = new Date('2026-03-09T23:30:00.000Z'); // Monday

const resolved = resolveEffectiveSmartChargingLimit({
  chargerProfiles: [
    profile({
      id: 'charger-p1',
      name: 'charger profile',
      scope: 'CHARGER',
      priority: 100,
      schedule: [{ id: 'w1', daysOfWeek: [1], startTime: '20:00', endTime: '23:59', limitKw: 12 }],
    }),
  ],
  groupProfiles: [
    profile({
      id: 'group-p1',
      name: 'group profile',
      scope: 'GROUP',
      priority: 50,
      defaultLimitKw: 20,
    }),
  ],
  siteProfiles: [
    profile({
      id: 'site-p1',
      name: 'site profile',
      scope: 'SITE',
      priority: 10,
      defaultLimitKw: 30,
    }),
  ],
  at,
  fallbackLimitKw: 7.2,
});

assert.equal(resolved.effectiveLimitKw, 12, 'charger scope must win precedence');
assert.equal(resolved.sourceScope, 'CHARGER');
assert.equal(resolved.fallbackApplied, false);

const fallbackResolved = resolveEffectiveSmartChargingLimit({
  chargerProfiles: [
    profile({
      id: 'broken-charger',
      name: 'broken',
      scope: 'CHARGER',
      schedule: [{ startTime: 'bad', endTime: '10:00', daysOfWeek: [1], limitKw: 5 }],
    }),
  ],
  groupProfiles: [],
  siteProfiles: [],
  at,
  fallbackLimitKw: 7.2,
});

assert.equal(fallbackResolved.effectiveLimitKw, 7.2, 'fallback safe limit should apply when profile invalid');
assert.equal(fallbackResolved.fallbackApplied, true);
assert.ok(fallbackResolved.invalidProfileIds.includes('broken-charger'));

console.log('[smartCharging.selftest] all checks passed');
