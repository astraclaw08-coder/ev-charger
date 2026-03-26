import { prisma, parseSmartChargingSchedule, resolveEffectiveSmartChargingLimit, type SmartChargingProfileLike } from '@ev-charger/shared';
import { remoteClearChargingProfile, remoteSetChargingProfile } from './remote';
import { clientRegistry } from './clientRegistry';

const SAFE_LIMIT_KW = Number(process.env.SMART_CHARGING_SAFE_LIMIT_KW ?? '7.2') || 7.2;
const STACK_LEVEL = Number.parseInt(process.env.SMART_CHARGING_STACK_LEVEL ?? '50', 10) || 50;
const MIN_HEARTBEATS_AFTER_BOOT = Number.parseInt(process.env.SMART_CHARGING_MIN_HEARTBEATS_AFTER_BOOT ?? '1', 10) || 1;
const MIN_SECONDS_AFTER_BOOT = Number.parseInt(process.env.SMART_CHARGING_MIN_SECONDS_AFTER_BOOT ?? '0', 10) || 0;

async function connectionReadyForSmartCharging(chargerId: string, ocppId: string): Promise<{ ready: boolean; reason: string }> {
  // If charger has an active WS connection in the registry, it's ready.
  // This handles reconnections that skip BootNotification (e.g. after server
  // redeploy where the charger reconnects without a full boot cycle).
  if (clientRegistry.has(ocppId)) {
    return { ready: true, reason: 'Active WS connection in registry' };
  }

  const latestBoot = await prisma.ocppEventOutbox.findFirst({
    where: { chargerId, eventType: 'BootNotification' },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });

  if (!latestBoot) {
    return { ready: false, reason: 'No BootNotification observed yet' };
  }

  const heartbeatCount = await prisma.ocppEventOutbox.count({
    where: {
      chargerId,
      eventType: 'Heartbeat',
      createdAt: { gte: latestBoot.createdAt },
    },
  });

  if (heartbeatCount < MIN_HEARTBEATS_AFTER_BOOT) {
    return {
      ready: false,
      reason: `Waiting for heartbeat gate (${heartbeatCount}/${MIN_HEARTBEATS_AFTER_BOOT}) after boot`,
    };
  }

  if (MIN_SECONDS_AFTER_BOOT > 0) {
    const ageSec = Math.floor((Date.now() - latestBoot.createdAt.getTime()) / 1000);
    if (ageSec < MIN_SECONDS_AFTER_BOOT) {
      return {
        ready: false,
        reason: `Waiting for boot settle window (${ageSec}/${MIN_SECONDS_AFTER_BOOT}s)`,
      };
    }
  }

  return { ready: true, reason: 'Connection gate satisfied (boot + heartbeat)' };
}

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
    select: { id: true, ocppId: true, siteId: true, groupId: true, status: true, site: { select: { timeZone: true } } },
  });
  if (!charger) return;

  const siteTimeZone = (charger as any).site?.timeZone ?? 'America/Los_Angeles';
  console.log(`[SmartCharging] apply attempt for ${charger.ocppId} trigger=${trigger} status=${charger.status} tz=${siteTimeZone}`);

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
    timeZone: siteTimeZone,
    fallbackLimitKw: SAFE_LIMIT_KW,
  });

  let status: 'APPLIED' | 'PENDING_OFFLINE' | 'ERROR' | 'FALLBACK_APPLIED' = 'PENDING_OFFLINE';
  let lastError: string | null = null;
  let lastAppliedAt: Date | null = null;

  const existingState = await prisma.smartChargingState.findUnique({
    where: { chargerId: charger.id },
    select: { effectiveLimitKw: true, sourceProfileId: true, status: true, lastAppliedAt: true },
  });

  if (charger.status === 'ONLINE') {
    const readiness = await connectionReadyForSmartCharging(charger.id, charger.ocppId);
    if (!readiness.ready) {
      status = 'PENDING_OFFLINE';
      lastError = readiness.reason;
    } else {
      const allProfiles = [...chargerProfiles, ...groupProfiles, ...siteProfiles].map(toProfileLike);
      const sourceProfile = resolution.sourceProfileId
        ? allProfiles.find((p) => p.id === resolution.sourceProfileId)
        : undefined;

      // If no matching profile is active for this charger, do not push default/fallback
      // Clear/SetChargingProfile commands. This avoids applying smart charging to
      // chargers that are not explicitly scoped by a profile.
      if (!sourceProfile) {
        status = 'FALLBACK_APPLIED';
        lastError = null;
      } else {
        const alreadyAppliedEquivalent = Boolean(
          existingState
          && existingState.status === 'APPLIED'
          && existingState.sourceProfileId === resolution.sourceProfileId
          && Math.abs(existingState.effectiveLimitKw - resolution.effectiveLimitKw) < 0.001,
        );

        if (alreadyAppliedEquivalent) {
          status = 'APPLIED';
          lastAppliedAt = existingState?.lastAppliedAt ?? new Date();
          lastError = null;
        } else {
          const payload = buildRecurringWeeklyPayload(sourceProfile, resolution.effectiveLimitKw, new Date())
            ?? buildConstantPayload(resolution.effectiveLimitKw, sourceProfile);

          // Only clear when a new/different profile needs to be applied.
          await remoteClearChargingProfile(charger.ocppId, {
            connectorId: 0,
            chargingProfilePurpose: 'ChargePointMaxProfile',
            stackLevel: STACK_LEVEL,
          });

          const ocppStatus = await remoteSetChargingProfile(charger.ocppId, payload);
          if (ocppStatus === 'Accepted') {
            status = 'APPLIED';
            lastAppliedAt = new Date();
          } else {
            status = 'ERROR';
            lastError = `SetChargingProfile rejected (${ocppStatus})`;
          }
        }
      }
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
