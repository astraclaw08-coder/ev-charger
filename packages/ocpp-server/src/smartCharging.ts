import { prisma, resolveEffectiveSmartChargingLimit, type SmartChargingProfileLike } from '@ev-charger/shared';
import { remoteSetChargingProfile } from './remote';

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

function toSetChargingProfilePayload(limitKw: number) {
  return {
    connectorId: 0,
    csChargingProfiles: {
      chargingProfileId: 1,
      stackLevel: STACK_LEVEL,
      chargingProfilePurpose: 'ChargePointMaxProfile',
      chargingProfileKind: 'Absolute',
      chargingSchedule: {
        chargingRateUnit: 'W',
        chargingSchedulePeriod: [{ startPeriod: 0, limit: Math.max(1, Math.round(limitKw * 1000)) }],
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
    const ocppStatus = await remoteSetChargingProfile(charger.ocppId, toSetChargingProfilePayload(resolution.effectiveLimitKw));
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
