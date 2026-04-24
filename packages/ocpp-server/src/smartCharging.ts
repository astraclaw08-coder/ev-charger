import { prisma, parseSmartChargingSchedule, resolveEffectiveSmartChargingLimit, resolveAllActiveProfiles, type SmartChargingProfileLike, type StackedProfileEntry } from '@ev-charger/shared';
import { remoteClearChargingProfile, remoteSetChargingProfile, remoteGetCompositeSchedule } from './remote';
import { clientRegistry } from './clientRegistry';

// Stacking ON by default — set SMART_CHARGING_STACKING=false to force legacy mode globally
const STACKING_ENABLED = process.env.SMART_CHARGING_STACKING !== 'false';

// Chargers that reject stacked profiles get added here at runtime (cleared on restart)
const stackingUnsupportedChargers = new Set<string>();

const SAFE_LIMIT_KW = Number(process.env.SMART_CHARGING_SAFE_LIMIT_KW ?? '7.2') || 7.2;
const STACK_LEVEL = Number.parseInt(process.env.SMART_CHARGING_STACK_LEVEL ?? '50', 10) || 50;
const MIN_HEARTBEATS_AFTER_BOOT = Number.parseInt(process.env.SMART_CHARGING_MIN_HEARTBEATS_AFTER_BOOT ?? '1', 10) || 1;
const MIN_SECONDS_AFTER_BOOT = Number.parseInt(process.env.SMART_CHARGING_MIN_SECONDS_AFTER_BOOT ?? '0', 10) || 0;

export async function connectionReadyForSmartCharging(chargerId: string, ocppId: string): Promise<{ ready: boolean; reason: string }> {
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

// Convert kW to Amps (single-phase, using nominal voltage from env or 240V default)
const NOMINAL_VOLTAGE = Number(process.env.SMART_CHARGING_NOMINAL_VOLTAGE ?? '240') || 240;
function toA(limitKw: number): number {
  return Math.max(1, Math.round((limitKw * 1000) / NOMINAL_VOLTAGE));
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
  const periods: Array<{ startPeriod: number; limit: number }> = [{ startPeriod: 0, limit: toA(baseLimitKw) }];

  for (const w of parsed.windows) {
    const startSecInDay = hhmmToSec(w.startTime);
    const endSecInDay = hhmmToSec(w.endTime);

    for (const day of w.daysOfWeek) {
      const dayBase = day * 86400;
      periods.push({ startPeriod: dayBase + startSecInDay, limit: toA(w.limitKw) });
      if (startSecInDay < endSecInDay) {
        periods.push({ startPeriod: dayBase + endSecInDay, limit: toA(baseLimitKw) });
      } else if (startSecInDay > endSecInDay) {
        // Overnight window: restore next day
        const restore = ((day + 1) % 7) * 86400 + endSecInDay;
        periods.push({ startPeriod: restore, limit: toA(baseLimitKw) });
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
        chargingRateUnit: 'A',
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
        chargingRateUnit: 'A',
        chargingSchedulePeriod: [{ startPeriod: 0, limit: toA(limitKw) }],
      },
    },
  };
}

export async function applySmartChargingForCharger(chargerId: string, trigger: string): Promise<void> {
  if (STACKING_ENABLED && !stackingUnsupportedChargers.has(chargerId)) {
    return applySmartChargingStacked(chargerId, trigger);
  }
  if (stackingUnsupportedChargers.has(chargerId)) {
    console.log(`[SmartCharging] ${chargerId} flagged as stacking-unsupported — using legacy flow`);
  }
  return applySmartChargingLegacy(chargerId, trigger);
}

/**
 * Stacking mode: push ALL applicable profiles to the charger at different stackLevels.
 * Charger natively enforces the lowest effective limit at any point in time.
 */
async function applySmartChargingStacked(chargerId: string, trigger: string): Promise<void> {
  const charger = await prisma.charger.findUnique({
    where: { id: chargerId },
    select: { id: true, ocppId: true, siteId: true, groupId: true, status: true, site: { select: { timeZone: true } } },
  });
  if (!charger) return;

  const siteTimeZone = (charger as any).site?.timeZone ?? 'America/Los_Angeles';
  console.log(`[SmartCharging:Stacked] apply for ${charger.ocppId} trigger=${trigger} status=${charger.status}`);

  const [chargerProfiles, groupProfiles, siteProfiles] = await Promise.all([
    prisma.smartChargingProfile.findMany({ where: { scope: 'CHARGER', chargerId, enabled: true }, orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }] }),
    charger.groupId
      ? prisma.smartChargingProfile.findMany({ where: { scope: 'GROUP', chargerGroupId: charger.groupId, enabled: true }, orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }] })
      : Promise.resolve([]),
    prisma.smartChargingProfile.findMany({ where: { scope: 'SITE', siteId: charger.siteId, enabled: true }, orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }] }),
  ]);

  const activeEntries = resolveAllActiveProfiles({
    chargerProfiles: chargerProfiles.map(toProfileLike),
    groupProfiles: groupProfiles.map(toProfileLike),
    siteProfiles: siteProfiles.map(toProfileLike),
    timeZone: siteTimeZone,
  });

  const now = new Date();
  const activeProfileIds = new Set(activeEntries.map((e) => e.profile.id));

  // Load existing state rows for this charger
  const existingStates = await prisma.smartChargingState.findMany({ where: { chargerId: charger.id } });
  const existingByProfileId = new Map(existingStates.map((s: any) => [s.sourceProfileId, s]));

  // Determine stale states to clear (profiles no longer active)
  const staleStates = existingStates.filter((s: any) => s.sourceProfileId && !activeProfileIds.has(s.sourceProfileId));

  const isOnline = charger.status === 'ONLINE';
  let connectionReady = false;
  if (isOnline) {
    const readiness = await connectionReadyForSmartCharging(charger.id, charger.ocppId);
    connectionReady = readiness.ready;
    if (!connectionReady) {
      console.log(`[SmartCharging:Stacked] ${charger.ocppId} not ready: ${readiness.reason}`);
    }
  }

  // Clear stale profiles from charger
  for (const stale of staleStates) {
    if (isOnline && connectionReady && stale.ocppChargingProfileId != null) {
      await remoteClearChargingProfile(charger.ocppId, {
        id: stale.ocppChargingProfileId,
        connectorId: 0,
        chargingProfilePurpose: 'ChargePointMaxProfile',
        stackLevel: stale.ocppStackLevel ?? STACK_LEVEL,
      });
    }
    await prisma.smartChargingState.delete({ where: { id: stale.id } });
    console.log(`[SmartCharging:Stacked] Cleared stale profile ${stale.sourceProfileId} from ${charger.ocppId}`);
  }

  // Push each active profile
  for (const entry of activeEntries) {
    const existing: any = existingByProfileId.get(entry.profile.id);
    let status: string = 'PENDING_OFFLINE';
    let lastError: string | null = null;
    let lastAppliedAt: Date | null = existing?.lastAppliedAt ?? null;

    if (isOnline && connectionReady) {
      // Check if already applied with same params
      const alreadyEquivalent = Boolean(
        existing
        && existing.status === 'APPLIED'
        && existing.ocppStackLevel === entry.ocppStackLevel
        && existing.ocppChargingProfileId === entry.ocppChargingProfileId
        && Math.abs(existing.effectiveLimitKw - (entry.profile.defaultLimitKw ?? 0)) < 0.001,
      );

      if (alreadyEquivalent) {
        status = 'APPLIED';
        lastError = null;
      } else {
        const payload = buildRecurringWeeklyPayloadStacked(entry, SAFE_LIMIT_KW, now)
          ?? buildConstantPayloadStacked(entry);

        const ocppStatus = await remoteSetChargingProfile(charger.ocppId, payload);
        if (ocppStatus === 'Accepted') {
          status = 'APPLIED';
          lastAppliedAt = now;
        } else if (ocppStatus === 'NotSupported') {
          // Charger doesn't support stacking — flag it and fallback to legacy
          stackingUnsupportedChargers.add(chargerId);
          console.warn(`[SmartCharging:Stacked] ${charger.ocppId} returned NotSupported — flagging for legacy fallback`);
          return applySmartChargingLegacy(chargerId, trigger);
        } else {
          status = 'ERROR';
          lastError = `SetChargingProfile rejected (${ocppStatus})`;
        }
      }
    } else if (!isOnline) {
      status = 'PENDING_OFFLINE';
    } else {
      status = 'PENDING_OFFLINE';
      lastError = 'Connection not ready';
    }

    const effectiveLimit = entry.profile.defaultLimitKw ?? SAFE_LIMIT_KW;

    await prisma.smartChargingState.upsert({
      where: { chargerId_sourceProfileId: { chargerId: charger.id, sourceProfileId: entry.profile.id } },
      create: {
        chargerId: charger.id,
        effectiveLimitKw: effectiveLimit,
        fallbackApplied: false,
        sourceScope: entry.scope,
        sourceProfileId: entry.profile.id,
        sourceWindowId: null,
        sourceReason: `Stacked ${entry.scope.toLowerCase()} profile "${entry.profile.name}"; trigger=${trigger}`,
        status,
        lastAttemptAt: now,
        lastAppliedAt,
        lastError,
        ocppChargingProfileId: entry.ocppChargingProfileId,
        ocppStackLevel: entry.ocppStackLevel,
      },
      update: {
        effectiveLimitKw: effectiveLimit,
        fallbackApplied: false,
        sourceScope: entry.scope,
        sourceProfileId: entry.profile.id,
        sourceReason: `Stacked ${entry.scope.toLowerCase()} profile "${entry.profile.name}"; trigger=${trigger}`,
        status,
        lastAttemptAt: now,
        lastAppliedAt,
        lastError,
        ocppChargingProfileId: entry.ocppChargingProfileId,
        ocppStackLevel: entry.ocppStackLevel,
        compositeScheduleVerified: false,
        compositeScheduleVerifiedAt: null,
      },
    });
  }

  // Verify via GetCompositeSchedule (best effort)
  if (isOnline && connectionReady && activeEntries.length > 0) {
    try {
      const composite = await remoteGetCompositeSchedule(charger.ocppId, { connectorId: 0, duration: 86400 });
      if (composite && composite.status === 'Accepted') {
        await prisma.smartChargingState.updateMany({
          where: { chargerId: charger.id },
          data: { compositeScheduleVerified: true, compositeScheduleVerifiedAt: now },
        });
        console.log(`[SmartCharging:Stacked] ${charger.ocppId} composite schedule verified`);
      } else if (composite && composite.status === 'Rejected') {
        console.log(`[SmartCharging:Stacked] ${charger.ocppId} GetCompositeSchedule not supported — skipping verification`);
      }
    } catch (err) {
      console.warn(`[SmartCharging:Stacked] ${charger.ocppId} GetCompositeSchedule failed:`, err);
    }
  }

  if (activeEntries.length === 0) {
    // No profiles → clean up any remaining state
    await prisma.smartChargingState.deleteMany({ where: { chargerId: charger.id } });
  }

  console.log(`[SmartCharging:Stacked] ${charger.ocppId} reconcile complete: ${activeEntries.length} profiles pushed, ${staleStates.length} cleared`);
}

function buildRecurringWeeklyPayloadStacked(entry: StackedProfileEntry, fallbackLimitKw: number, at: Date) {
  const parsed = parseSmartChargingSchedule(entry.profile.schedule);
  if (parsed.windows.length === 0) return null;

  const baseLimitKw = (entry.profile.defaultLimitKw != null && entry.profile.defaultLimitKw > 0) ? entry.profile.defaultLimitKw : fallbackLimitKw;
  const periods: Array<{ startPeriod: number; limit: number }> = [{ startPeriod: 0, limit: toA(baseLimitKw) }];

  for (const w of parsed.windows) {
    const startSecInDay = hhmmToSec(w.startTime);
    const endSecInDay = hhmmToSec(w.endTime);

    for (const day of w.daysOfWeek) {
      const dayBase = day * 86400;
      periods.push({ startPeriod: dayBase + startSecInDay, limit: toA(w.limitKw) });
      if (startSecInDay < endSecInDay) {
        periods.push({ startPeriod: dayBase + endSecInDay, limit: toA(baseLimitKw) });
      } else if (startSecInDay > endSecInDay) {
        const restore = ((day + 1) % 7) * 86400 + endSecInDay;
        periods.push({ startPeriod: restore, limit: toA(baseLimitKw) });
      }
    }
  }

  const unique = new Map<number, number>();
  for (const p of periods.sort((a, b) => a.startPeriod - b.startPeriod)) unique.set(p.startPeriod, p.limit);

  return {
    connectorId: 0,
    csChargingProfiles: {
      chargingProfileId: entry.ocppChargingProfileId,
      stackLevel: entry.ocppStackLevel,
      chargingProfilePurpose: 'ChargePointMaxProfile',
      chargingProfileKind: 'Recurring',
      recurrencyKind: 'Weekly',
      ...(entry.profile.validFrom ? { validFrom: entry.profile.validFrom.toISOString() } : {}),
      ...(entry.profile.validTo ? { validTo: entry.profile.validTo.toISOString() } : {}),
      chargingSchedule: {
        startSchedule: startOfUtcWeek(at).toISOString(),
        duration: 7 * 24 * 3600,
        chargingRateUnit: 'A',
        chargingSchedulePeriod: Array.from(unique.entries()).map(([startPeriod, limit]) => ({ startPeriod, limit })),
      },
    },
  };
}

function buildConstantPayloadStacked(entry: StackedProfileEntry) {
  const limitKw = entry.profile.defaultLimitKw ?? 7.2;
  return {
    connectorId: 0,
    csChargingProfiles: {
      chargingProfileId: entry.ocppChargingProfileId,
      stackLevel: entry.ocppStackLevel,
      chargingProfilePurpose: 'ChargePointMaxProfile',
      chargingProfileKind: 'Absolute',
      ...(entry.profile.validFrom ? { validFrom: entry.profile.validFrom.toISOString() } : {}),
      ...(entry.profile.validTo ? { validTo: entry.profile.validTo.toISOString() } : {}),
      chargingSchedule: {
        chargingRateUnit: 'A',
        chargingSchedulePeriod: [{ startPeriod: 0, limit: toA(limitKw) }],
      },
    },
  };
}

/** Legacy single-winner flow (feature flag off) */
async function applySmartChargingLegacy(chargerId: string, trigger: string): Promise<void> {
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

  const existingState = await prisma.smartChargingState.findFirst({
    where: { chargerId: charger.id },
    select: { effectiveLimitKw: true, sourceProfileId: true, status: true, lastAppliedAt: true },
    orderBy: { updatedAt: 'desc' },
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
    where: { chargerId_sourceProfileId: { chargerId: charger.id, sourceProfileId: resolution.sourceProfileId ?? '__legacy__' } },
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
