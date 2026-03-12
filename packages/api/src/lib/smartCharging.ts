import { prisma, resolveEffectiveSmartChargingLimit, parseSmartChargingSchedule, type SmartChargingProfileLike } from '@ev-charger/shared';
import type { SmartChargingScope } from '@ev-charger/shared';
import { setChargingProfile } from './ocppClient';

export type SmartChargingApplyStatus = 'APPLIED' | 'PENDING_OFFLINE' | 'ERROR' | 'FALLBACK_APPLIED';
const db: any = prisma;

const DEFAULT_SAFE_LIMIT_KW = 7.2;
const SAFE_LIMIT_KW = (() => {
  const parsed = Number(process.env.SMART_CHARGING_SAFE_LIMIT_KW ?? DEFAULT_SAFE_LIMIT_KW);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SAFE_LIMIT_KW;
})();

const DEFAULT_STACK_LEVEL = 50;
const STACK_LEVEL = (() => {
  const parsed = Number.parseInt(process.env.SMART_CHARGING_STACK_LEVEL ?? String(DEFAULT_STACK_LEVEL), 10);
  return Number.isFinite(parsed) ? parsed : DEFAULT_STACK_LEVEL;
})();

function asProfileLike(profile: {
  id: string;
  name: string;
  scope: SmartChargingScope;
  enabled: boolean;
  priority: number;
  defaultLimitKw: number | null;
  schedule: unknown;
  validFrom: Date | null;
  validTo: Date | null;
  updatedAt: Date;
}): SmartChargingProfileLike {
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

function toWatt(limitKw: number): number {
  return Math.max(1, Math.round(limitKw * 1000));
}

function buildSetChargingProfilePayload(limitKw: number): Record<string, unknown> {
  return {
    connectorId: 0,
    csChargingProfiles: {
      chargingProfileId: 1,
      stackLevel: STACK_LEVEL,
      chargingProfilePurpose: 'ChargePointMaxProfile',
      chargingProfileKind: 'Absolute',
      chargingSchedule: {
        chargingRateUnit: 'W',
        chargingSchedulePeriod: [
          {
            startPeriod: 0,
            limit: toWatt(limitKw),
          },
        ],
      },
    },
  };
}

async function loadScopeProfiles(chargerId: string): Promise<{
  charger: { id: string; ocppId: string; siteId: string; groupId: string | null; status: string };
  chargerProfiles: SmartChargingProfileLike[];
  groupProfiles: SmartChargingProfileLike[];
  siteProfiles: SmartChargingProfileLike[];
}> {
  const charger = await db.charger.findUnique({
    where: { id: chargerId },
    select: { id: true, ocppId: true, siteId: true, groupId: true, status: true },
  });

  if (!charger) {
    throw new Error('Charger not found');
  }

  const [chargerProfiles, groupProfiles, siteProfiles] = await Promise.all([
    db.smartChargingProfile.findMany({
      where: { scope: 'CHARGER', chargerId: charger.id, enabled: true },
      orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
    }),
    charger.groupId
      ? db.smartChargingProfile.findMany({
          where: { scope: 'GROUP', chargerGroupId: charger.groupId, enabled: true },
          orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
        })
      : Promise.resolve([]),
    db.smartChargingProfile.findMany({
      where: { scope: 'SITE', siteId: charger.siteId, enabled: true },
      orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
    }),
  ]);

  return {
    charger,
    chargerProfiles: chargerProfiles.map(asProfileLike),
    groupProfiles: groupProfiles.map(asProfileLike),
    siteProfiles: siteProfiles.map(asProfileLike),
  };
}

export async function previewEffectiveSmartChargingLimit(chargerId: string, at?: Date) {
  const scoped = await loadScopeProfiles(chargerId);
  const resolution = resolveEffectiveSmartChargingLimit({
    chargerProfiles: scoped.chargerProfiles,
    groupProfiles: scoped.groupProfiles,
    siteProfiles: scoped.siteProfiles,
    at,
    fallbackLimitKw: SAFE_LIMIT_KW,
  });

  const persisted = await db.smartChargingState.findUnique({
    where: { chargerId },
    include: { sourceProfile: { select: { id: true, name: true, scope: true } } },
  });

  return {
    charger: scoped.charger,
    calculated: resolution,
    persisted,
    config: {
      safeFallbackLimitKw: SAFE_LIMIT_KW,
      ocppStackLevel: STACK_LEVEL,
      timezone: 'UTC',
    },
  };
}

export async function reconcileSmartChargingForCharger(chargerId: string, trigger: string) {
  const scoped = await loadScopeProfiles(chargerId);
  const now = new Date();

  const resolution = resolveEffectiveSmartChargingLimit({
    chargerProfiles: scoped.chargerProfiles,
    groupProfiles: scoped.groupProfiles,
    siteProfiles: scoped.siteProfiles,
    at: now,
    fallbackLimitKw: SAFE_LIMIT_KW,
  });

  let status: SmartChargingApplyStatus;
  let lastError: string | null = null;
  let lastAppliedAt: Date | null = null;
  let ocppResponseStatus: string | null = null;

  if (scoped.charger.status !== 'ONLINE') {
    status = resolution.fallbackApplied ? 'FALLBACK_APPLIED' : 'PENDING_OFFLINE';
  } else {
    const payload = buildSetChargingProfilePayload(resolution.effectiveLimitKw);
    ocppResponseStatus = await setChargingProfile(scoped.charger.ocppId, payload);

    if (ocppResponseStatus === 'Accepted') {
      status = resolution.fallbackApplied ? 'FALLBACK_APPLIED' : 'APPLIED';
      lastAppliedAt = now;
    } else {
      status = 'ERROR';
      lastError = `SetChargingProfile rejected (${ocppResponseStatus})`;
    }
  }

  const sourceReason = `${resolution.sourceReason}; trigger=${trigger}; invalidProfiles=${resolution.invalidProfileIds.length}`;

  const persisted = await db.smartChargingState.upsert({
    where: { chargerId: scoped.charger.id },
    create: {
      chargerId: scoped.charger.id,
      effectiveLimitKw: resolution.effectiveLimitKw,
      fallbackApplied: resolution.fallbackApplied,
      sourceScope: resolution.sourceScope,
      sourceProfileId: resolution.sourceProfileId,
      sourceWindowId: resolution.sourceWindowId,
      sourceReason,
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
      sourceReason,
      status,
      lastAttemptAt: now,
      lastAppliedAt,
      lastError,
    },
    include: {
      sourceProfile: { select: { id: true, name: true, scope: true } },
    },
  });

  return {
    chargerId: scoped.charger.id,
    ocppId: scoped.charger.ocppId,
    chargerStatus: scoped.charger.status,
    trigger,
    calculated: resolution,
    applied: {
      status,
      ocppResponseStatus,
    },
    persisted,
  };
}

export async function reconcileSmartChargingForChargers(chargerIds: string[], trigger: string) {
  const results = await Promise.allSettled(chargerIds.map((chargerId) => reconcileSmartChargingForCharger(chargerId, trigger)));

  return results.map((result, idx) => {
    if (result.status === 'fulfilled') {
      return { chargerId: chargerIds[idx], ok: true, data: result.value };
    }
    return {
      chargerId: chargerIds[idx],
      ok: false,
      error: result.reason instanceof Error ? result.reason.message : String(result.reason),
    };
  });
}

export function validateProfileSchedule(schedule: unknown): { ok: true; normalized: unknown } | { ok: false; error: string } {
  const parsed = parseSmartChargingSchedule(schedule);
  if (parsed.errors.length > 0) {
    return {
      ok: false,
      error: `Invalid schedule: ${parsed.errors.join('; ')}`,
    };
  }

  return { ok: true, normalized: parsed.windows };
}

export function getSmartChargingConfig() {
  return {
    safeFallbackLimitKw: SAFE_LIMIT_KW,
    ocppStackLevel: STACK_LEVEL,
    timezone: 'UTC',
  };
}
