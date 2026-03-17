import { prisma, parseSmartChargingSchedule, resolveEffectiveSmartChargingLimit, type SmartChargingProfileLike } from '@ev-charger/shared';
import { remoteClearChargingProfile, remoteSetChargingProfile } from './remote';

const SAFE_LIMIT_KW = Number(process.env.SMART_CHARGING_SAFE_LIMIT_KW ?? '7.2') || 7.2;
const STACK_LEVEL = Number.parseInt(process.env.SMART_CHARGING_STACK_LEVEL ?? '50', 10) || 50;

function toProfileLike(profile: any): SmartChargingProfileLike {
  return {
    id: profile.id,
    name: profile.name,
    scope: profile.scope,
    enabled: profile.enabled,
    priority: profile.priority,
    defaultLimitKw: profile.defaultLimitKw,
    schedule: profile.schedule,
    validFrom: profile.validFrom,
    validTo: profile.validTo,
    updatedAt: profile.updatedAt,
  };
}

function toW(limitKw: number): number {
  return Math.max(1, Math.round(limitKw * 1000));
}

function startOfUtcWeek(at: Date): Date {
  const d = new Date(at);
  const day = d.getUTCDay(); // Sun=0
  d.setUTCDate(d.getUTCDate() - day);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function hhmmToSec(v: string): number {
  const [h, m] = v.split(':').map((x) => Number(x));
  return (h * 3600) + (m * 60);
}

function buildRecurringWeeklyPayload(profile: SmartChargingProfileLike, fallbackLimitKw: number, at: Date) {
  const parsed = parseSmartChargingSchedule(profile.schedule);
  if (parsed.windows.length === 0) return null;

  const baseLimitKw = (profile.defaultLimitKw != null && profile.defaultLimitKw > 0) ? profile.defaultLimitKw : fallbackLimitKw;
  const periods: Array<{ startPeriod: number; limit: number }> = [{ startPeriod: 0, limit: toW(baseLimitKw) }];

  for (const w of parsed.windows) {
    const startSecInDay = hhmmToSec(w.startTime);
    const endSecInDay = hhmmToSec(w.endTime);

    for (const day of w.daysOfWeek) {
      const dayBase = day * 86400;
      periods.push({ startPeriod: dayBase + startSecInDay, limit: toW(w.limitKw) });
      if (startSecInDay < endSecInDay) {
        periods.push({ startPeriod: dayBase + endSecInDay, limit: toW(baseLimitKw) });
      } else if (startSecInDay > endSecInDay) {
        // Overnight window: restore next day
        const restore = ((day + 1) % 7) * 86400 + endSecInDay;
        periods.push({ startPeriod: restore, limit: toW(baseLimitKw) });
      }
    }
  }

  // Keep earliest period per second; sorted ascending
  const unique = new Map<number, number>();
  for (const p of periods.sort((a, b) => a.startPeriod - b.startPeriod)) unique.set(p.startPeriod, p.limit);

  return {
    connectorId: 0,
    csChargingProfiles: {
      chargingProfileId: 1,
      stackLevel: STACK_LEVEL,
      chargingProfilePurpose: 'ChargePointMaxProfile',
      chargingProfileKind: 'Recurring',
      recurrencyKind: 'Weekly',
      ...(profile.validFrom ? { validFrom: profile.validFrom.toISOString() } : {}),
      ...(profile.validTo ? { validTo: profile.validTo.toISOString() } : {}),
      chargingSchedule: {
        startSchedule: startOfUtcWeek(at).toISOString(),
        duration: 7 * 24 * 3600,
        chargingRateUnit: 'W',
        chargingSchedulePeriod: Array.from(unique.entries()).map(([startPeriod, limit]) => ({ startPeriod, limit })),
      },
    },
  };
}

function buildConstantPayload(limitKw: number, profile?: SmartChargingProfileLike) {
  return {
    connectorId: 0,
    csChargingProfiles: {
      chargingProfileId: 1,
      stackLevel: STACK_LEVEL,
      chargingProfilePurpose: 'ChargePointMaxProfile',
      chargingProfileKind: 'Absolute',
      ...(profile?.validFrom ? { validFrom: profile.validFrom.toISOString() } : {}),
      ...(profile?.validTo ? { validTo: profile.validTo.toISOString() } : {}),
      chargingSchedule: {
        chargingRateUnit: 'W',
        chargingSchedulePeriod: [{ startPeriod: 0, limit: toW(limitKw) }],
      },
    },
  };
}

export async function applySmartChargingForCharger(chargerId: string, trigger: string): Promise<void> {
  const charger = await prisma.charger.findUnique({
    where: { id: chargerId },
    select: { id: true, ocppId: true, siteId: true, groupId: true, status: true },
  });
  if (!charger) return;

  const [chargerProfiles, groupProfiles, siteProfiles] = await Promise.all([
    prisma.smartChargingProfile.findMany({ where: { scope: 'CHARGER', chargerId, enabled: true }, orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }] }),
    charger.groupId
      ? prisma.smartChargingProfile.findMany({ where: { scope: 'GROUP', chargerGroupId: charger.groupId, enabled: true }, orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }] })
      : Promise.resolve([]),
    prisma.smartChargingProfile.findMany({ where: { scope: 'SITE', siteId: charger.siteId, enabled: true }, orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }] }),
  ]);

  const resolution = resolveEffectiveSmartChargingLimit({
    chargerProfiles: chargerProfiles.map(toProfileLike),
    groupProfiles: groupProfiles.map(toProfileLike),
    siteProfiles: siteProfiles.map(toProfileLike),
    fallbackLimitKw: SAFE_LIMIT_KW,
  });

  let status: 'APPLIED' | 'PENDING_OFFLINE' | 'ERROR' | 'FALLBACK_APPLIED' = 'PENDING_OFFLINE';
  let lastError: string | null = null;
  let lastAppliedAt: Date | null = null;

  if (charger.status === 'ONLINE') {
    const allProfiles = [...chargerProfiles, ...groupProfiles, ...siteProfiles].map(toProfileLike);
    const sourceProfile = resolution.sourceProfileId
      ? allProfiles.find((p) => p.id === resolution.sourceProfileId)
      : undefined;

    const payload = sourceProfile
      ? (buildRecurringWeeklyPayload(sourceProfile, resolution.effectiveLimitKw, new Date()) ?? buildConstantPayload(resolution.effectiveLimitKw, sourceProfile))
      : buildConstantPayload(resolution.effectiveLimitKw);

    // Avoid stale constraints from previous pushes at same stack/purpose.
    await remoteClearChargingProfile(charger.ocppId, {
      connectorId: 0,
      chargingProfilePurpose: 'ChargePointMaxProfile',
      stackLevel: STACK_LEVEL,
    });

    const ocppStatus = await remoteSetChargingProfile(charger.ocppId, payload);
    if (ocppStatus === 'Accepted') {
      status = resolution.fallbackApplied ? 'FALLBACK_APPLIED' : 'APPLIED';
      lastAppliedAt = new Date();
    } else {
      status = 'ERROR';
      lastError = `SetChargingProfile rejected (${ocppStatus})`;
    }
  } else {
    status = resolution.fallbackApplied ? 'FALLBACK_APPLIED' : 'PENDING_OFFLINE';
  }

  const now = new Date();
  await prisma.smartChargingState.upsert({
    where: { chargerId: charger.id },
    create: {
      chargerId: charger.id,
      effectiveLimitKw: resolution.effectiveLimitKw,
      fallbackApplied: resolution.fallbackApplied,
      sourceScope: resolution.sourceScope,
      sourceProfileId: resolution.sourceProfileId,
      sourceWindowId: resolution.sourceWindowId,
      sourceReason: `${resolution.sourceReason}; trigger=${trigger}; invalidProfiles=${resolution.invalidProfileIds.length}`,
      status,
      lastAttemptAt: now,
      lastAppliedAt,
      lastError,
    },
    update: {
      effectiveLimitKw: resolution.effectiveLimitKw,
      fallbackApplied: resolution.fallbackApplied,
      sourceScope: resolution.sourceScope,
      sourceProfileId: resolution.sourceProfileId,
      sourceWindowId: resolution.sourceWindowId,
      sourceReason: `${resolution.sourceReason}; trigger=${trigger}; invalidProfiles=${resolution.invalidProfileIds.length}`,
      status,
      lastAttemptAt: now,
      lastAppliedAt,
      lastError,
    },
  });
}
