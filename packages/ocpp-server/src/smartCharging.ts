/**
 * Smart Charging — OCPP 1.6 ChargePointMaxProfile management
 *
 * Architecture: MERGED-PROFILE MODEL
 * -----------------------------------
 * The DB can hold multiple SmartChargingProfile rows per charger (site-level,
 * group-level, charger-level).  However, the charger receives exactly ONE
 * Absolute ChargePointMaxProfile whose limit is the minimum of all active
 * profiles' effective limits at the current point in time.
 *
 * Do NOT assume charger firmware correctly handles native OCPP profile
 * stacking (multiple profiles at different stackLevels).  See CLAUDE.md
 * rules 8-11 under "Smart Charging (Firmware)" for the production incident
 * history that led to this design.
 *
 * Key flows:
 *  - applySmartChargingStacked()  — called on heartbeat, boot, reconnect,
 *    and API-triggered reconcile.  Merges + pushes the single profile.
 *  - applySmartChargingLegacy()   — fallback for chargers that reject
 *    ChargePointMaxProfile entirely.
 */
import { prisma, parseSmartChargingSchedule, resolveEffectiveSmartChargingLimit, resolveAllActiveProfiles, type SmartChargingProfileLike, type StackedProfileEntry } from '@ev-charger/shared';
import { remoteClearChargingProfile, remoteSetChargingProfile, remoteGetCompositeSchedule } from './remote';
import { clientRegistry } from './clientRegistry';
import { createHash } from 'crypto';

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

/**
 * Compute a fingerprint of the profile definition (schedule + defaultLimitKw + validity).
 * Used to detect when the profile definition has changed on the server side and
 * the charger needs a fresh SetChargingProfile push.
 */
function profileFingerprint(profile: SmartChargingProfileLike): string {
  const canonical = JSON.stringify({
    d: profile.defaultLimitKw,
    s: profile.schedule,
    vf: profile.validFrom?.toISOString() ?? null,
    vt: profile.validTo?.toISOString() ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/**
 * Resolve the currently-active window limit for a profile at a given time.
 * Returns the window's limitKw if a window is active, else the defaultLimitKw.
 * Schedule times are stored in UTC (portal converts local→UTC on save).
 */
function resolveCurrentLimitKw(profile: SmartChargingProfileLike, at: Date): number {
  const parsed = parseSmartChargingSchedule(profile.schedule);
  for (const w of parsed.windows) {
    const day = at.getUTCDay();
    if (!w.daysOfWeek.includes(day)) continue;
    const minuteOfDay = at.getUTCHours() * 60 + at.getUTCMinutes();
    const start = hhmmToMinuteOfDay(w.startTime);
    const end = hhmmToMinuteOfDay(w.endTime);
    if (start == null || end == null) continue;
    let active = false;
    if (start === end) active = true;
    else if (start < end) active = minuteOfDay >= start && minuteOfDay < end;
    else active = minuteOfDay >= start || minuteOfDay < end; // overnight
    if (active) return w.limitKw;
  }
  return profile.defaultLimitKw ?? SAFE_LIMIT_KW;
}

function hhmmToMinuteOfDay(v: string): number | null {
  const parts = v.split(':').map(Number);
  if (parts.length < 2 || isNaN(parts[0]) || isNaN(parts[1])) return null;
  return parts[0] * 60 + parts[1];
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
 * Merged-profile mode (formerly "stacking mode").
 *
 * WHY NOT NATIVE STACKING:
 * OCPP 1.6 says chargers should accept multiple ChargePointMaxProfile at
 * different stackLevels and enforce the minimum.  In practice, LOOP EX-1762
 * firmware (and likely other budget chargers) keeps multiple profiles at the
 * SAME stackLevel and applies the HIGHER limit, not the lower.  Recurring
 * Weekly profiles are also unreliable — firmware accepts them but miscomputes
 * schedule period offsets, silently applying the wrong limit.
 *
 * WHAT THIS FUNCTION DOES INSTEAD:
 * 1. Resolves ALL enabled SmartChargingProfile entries for the charger
 * 2. Computes the MINIMUM effective limit (kW) across all active entries
 * 3. Clears ALL existing ChargePointMaxProfile from the charger
 * 4. Pushes a SINGLE Absolute ChargePointMaxProfile with that minimum limit
 * 5. Heartbeat-driven re-invocations handle schedule window transitions
 *
 * The DB still tracks per-source-profile state rows (for the portal to show
 * which profiles are contributing), but the charger only ever sees ONE OCPP
 * profile.  When the set of active profiles changes (enable/disable/delete),
 * the merged profile is always recomputed and re-pushed — never skipped by
 * the equivalence check.
 *
 * Verified on production charger 1A32 (LOOP EX-1762) — 2026-04-16.
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

  // ── Merge all active profiles into a SINGLE Absolute OCPP profile ──
  // Instead of pushing one OCPP profile per SmartChargingProfile entry (which
  // creates stack-level conflicts on chargers like LOOP EX-1762 that don't
  // correctly replace profiles at the same stackLevel), we compute the MINIMUM
  // effective limit across all active entries and push one merged profile.
  // This is the correct OCPP 1.6 semantic (ChargePointMaxProfile = the cap)
  // and avoids firmware-specific stacking bugs entirely.

  const MERGED_STACK_LEVEL = 60;
  const MERGED_PROFILE_ID = 1;

  // Resolve each entry's current effective kW and fingerprint
  const entryDetails = activeEntries.map((entry) => ({
    entry,
    effectiveKw: resolveCurrentLimitKw(entry.profile, now),
    fingerprint: profileFingerprint(entry.profile),
  }));

  // The merged limit is the MINIMUM across all active profiles
  const mergedLimitKw = entryDetails.length > 0
    ? Math.min(...entryDetails.map((d) => d.effectiveKw))
    : SAFE_LIMIT_KW;

  // Build a composite fingerprint from all contributing profiles
  const mergedFingerprint = entryDetails.map((d) => `${d.entry.profile.id}:${d.fingerprint}:${d.effectiveKw}`).sort().join('|');

  let mergedStatus: string = 'PENDING_OFFLINE';
  let mergedLastError: string | null = null;
  let mergedLastAppliedAt: Date | null = null;

  if (isOnline && connectionReady) {
    // Check if the merged profile is unchanged:
    // 1. No stale profiles were just removed (set of active profiles unchanged)
    // 2. ALL existing states are APPLIED with matching fingerprints and limits
    // If stale profiles were cleared, the merged limit may have changed even if
    // remaining profiles' individual fingerprints are identical.
    const setChanged = staleStates.length > 0;
    const allEquivalent = !setChanged && entryDetails.every((d) => {
      const existing: any = existingByProfileId.get(d.entry.profile.id);
      return Boolean(
        existing
        && existing.status === 'APPLIED'
        && existing.profileFingerprint === d.fingerprint
        && Math.abs(existing.effectiveLimitKw - d.effectiveKw) < 0.001,
      );
    });

    if (allEquivalent) {
      console.log(`[SmartCharging:Stacked] ${charger.ocppId} merged profile already equivalent (limit=${mergedLimitKw}kW, ${entryDetails.length} sources) — skipping push`);
      mergedStatus = 'APPLIED';
    } else {
      console.log(`[SmartCharging:Stacked] ${charger.ocppId} pushing MERGED profile: ${mergedLimitKw}kW (${toA(mergedLimitKw)}A) from ${entryDetails.length} active profiles`);
      for (const d of entryDetails) {
        console.log(`  → "${d.entry.profile.name}" [${d.entry.scope}] effective=${d.effectiveKw}kW`);
      }

      // Clear ALL ChargePointMaxProfile from the charger first to remove any
      // stale profiles (including manually-pushed test profiles)
      try {
        await remoteClearChargingProfile(charger.ocppId, {
          connectorId: 0,
          chargingProfilePurpose: 'ChargePointMaxProfile',
        });
        console.log(`[SmartCharging:Stacked] ${charger.ocppId} cleared all ChargePointMaxProfile`);
      } catch (err) {
        console.warn(`[SmartCharging:Stacked] ${charger.ocppId} clear failed (non-fatal):`, err);
      }

      // Push a single merged Absolute profile
      const payload = {
        connectorId: 0,
        csChargingProfiles: {
          chargingProfileId: MERGED_PROFILE_ID,
          stackLevel: MERGED_STACK_LEVEL,
          chargingProfilePurpose: 'ChargePointMaxProfile',
          chargingProfileKind: 'Absolute',
          chargingSchedule: {
            chargingRateUnit: 'A',
            chargingSchedulePeriod: [{ startPeriod: 0, limit: toA(mergedLimitKw) }],
          },
        },
      };

      const ocppStatus = await remoteSetChargingProfile(charger.ocppId, payload);
      if (ocppStatus === 'Accepted') {
        mergedStatus = 'APPLIED';
        mergedLastAppliedAt = now;
      } else if (ocppStatus === 'NotSupported') {
        stackingUnsupportedChargers.add(chargerId);
        console.warn(`[SmartCharging:Stacked] ${charger.ocppId} returned NotSupported — flagging for legacy fallback`);
        return applySmartChargingLegacy(chargerId, trigger);
      } else {
        mergedStatus = 'ERROR';
        mergedLastError = `SetChargingProfile rejected (${ocppStatus})`;
      }
    }
  } else if (!isOnline) {
    mergedStatus = 'PENDING_OFFLINE';
  } else {
    mergedStatus = 'PENDING_OFFLINE';
    mergedLastError = 'Connection not ready';
  }

  // Update state rows for each source profile (tracking which DB profiles contributed)
  for (const d of entryDetails) {
    const existing: any = existingByProfileId.get(d.entry.profile.id);
    await prisma.smartChargingState.upsert({
      where: { chargerId_sourceProfileId: { chargerId: charger.id, sourceProfileId: d.entry.profile.id } },
      create: {
        chargerId: charger.id,
        effectiveLimitKw: d.effectiveKw,
        fallbackApplied: false,
        sourceScope: d.entry.scope,
        sourceProfileId: d.entry.profile.id,
        sourceWindowId: null,
        sourceReason: `Merged ${d.entry.scope.toLowerCase()} profile "${d.entry.profile.name}" → min=${mergedLimitKw}kW; trigger=${trigger}`,
        status: mergedStatus,
        lastAttemptAt: now,
        lastAppliedAt: mergedLastAppliedAt ?? existing?.lastAppliedAt ?? null,
        lastError: mergedLastError,
        ocppChargingProfileId: MERGED_PROFILE_ID,
        ocppStackLevel: MERGED_STACK_LEVEL,
        profileFingerprint: d.fingerprint,
      },
      update: {
        effectiveLimitKw: d.effectiveKw,
        fallbackApplied: false,
        sourceScope: d.entry.scope,
        sourceProfileId: d.entry.profile.id,
        sourceReason: `Merged ${d.entry.scope.toLowerCase()} profile "${d.entry.profile.name}" → min=${mergedLimitKw}kW; trigger=${trigger}`,
        status: mergedStatus,
        lastAttemptAt: now,
        lastAppliedAt: mergedLastAppliedAt ?? existing?.lastAppliedAt ?? null,
        lastError: mergedLastError,
        ocppChargingProfileId: MERGED_PROFILE_ID,
        ocppStackLevel: MERGED_STACK_LEVEL,
        compositeScheduleVerified: false,
        compositeScheduleVerifiedAt: null,
        profileFingerprint: d.fingerprint,
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

/**
 * Build an Absolute profile that sets the current effective limit.
 * This avoids firmware-specific bugs in Recurring Weekly schedule interpretation
 * and relies on heartbeat-driven re-push to handle window transitions.
 */
function buildAbsolutePayloadFromCurrentLimit(entry: StackedProfileEntry, currentLimitKw: number) {
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
        chargingSchedulePeriod: [{ startPeriod: 0, limit: toA(currentLimitKw) }],
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
