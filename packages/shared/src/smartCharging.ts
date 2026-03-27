import type { SmartChargingScope } from './types/prisma-enums';

export type SmartChargingWindow = {
  id: string;
  daysOfWeek: number[];
  startTime: string;
  endTime: string;
  limitKw: number;
};

export type SmartChargingProfileLike = {
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
};

export type SmartChargingResolution = {
  effectiveLimitKw: number;
  fallbackApplied: boolean;
  sourceScope: SmartChargingScope | null;
  sourceProfileId: string | null;
  sourceWindowId: string | null;
  sourceReason: string;
  invalidProfileIds: string[];
};

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function toObject(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function parseTimeToMinuteOfDay(time: string): number | null {
  const match = TIME_RE.exec(time);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function normalizeDays(input: unknown): number[] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const set = new Set<number>();

  for (const value of input) {
    const day = Number(value);
    if (!Number.isInteger(day) || day < 0 || day > 6) return null;
    set.add(day);
  }

  return Array.from(set.values()).sort((a, b) => a - b);
}

function parseWindow(raw: unknown, idx: number): SmartChargingWindow | null {
  const obj = toObject(raw);
  if (!obj) return null;

  const id = typeof obj.id === 'string' && obj.id.trim() ? obj.id.trim() : `window-${idx + 1}`;
  const startTime = typeof obj.startTime === 'string' ? obj.startTime.trim() : '';
  const endTime = typeof obj.endTime === 'string' ? obj.endTime.trim() : '';
  const limitKw = Number(obj.limitKw);
  const daysOfWeek = normalizeDays(obj.daysOfWeek);

  if (!daysOfWeek) return null;
  if (parseTimeToMinuteOfDay(startTime) == null) return null;
  if (parseTimeToMinuteOfDay(endTime) == null) return null;
  if (!Number.isFinite(limitKw) || limitKw <= 0) return null;

  return { id, daysOfWeek, startTime, endTime, limitKw };
}

export function parseSmartChargingSchedule(schedule: unknown): {
  windows: SmartChargingWindow[];
  errors: string[];
} {
  if (schedule == null) return { windows: [], errors: [] };
  if (!Array.isArray(schedule)) {
    return { windows: [], errors: ['schedule must be an array'] };
  }

  const windows: SmartChargingWindow[] = [];
  const errors: string[] = [];

  for (let i = 0; i < schedule.length; i += 1) {
    const parsed = parseWindow(schedule[i], i);
    if (!parsed) {
      errors.push(`window[${i}] is invalid`);
      continue;
    }
    windows.push(parsed);
  }

  return { windows, errors };
}

function isProfileWithinValidityWindow(profile: SmartChargingProfileLike, at: Date): boolean {
  if (profile.validFrom && at < profile.validFrom) return false;
  if (profile.validTo && at > profile.validTo) return false;
  return true;
}

// Timezone-aware local day/minute resolver (same pattern as touPricing.ts)
const scDtfCache = new Map<string, Intl.DateTimeFormat>();
function scLocalDayMinute(at: Date, timeZone?: string | null): { day: number; minuteOfDay: number } {
  if (!timeZone) {
    // Fallback to UTC if no timezone
    return { day: at.getUTCDay(), minuteOfDay: at.getUTCHours() * 60 + at.getUTCMinutes() };
  }
  const key = timeZone.trim();
  let fmt = scDtfCache.get(key);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: key,
        hour12: false,
        weekday: 'short',
        hour: 'numeric',
        minute: 'numeric',
      });
      scDtfCache.set(key, fmt);
    } catch {
      return { day: at.getUTCDay(), minuteOfDay: at.getUTCHours() * 60 + at.getUTCMinutes() };
    }
  }
  const parts = fmt.formatToParts(at);
  const dayStr = parts.find((p) => p.type === 'weekday')?.value ?? '';
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { day: dayMap[dayStr] ?? at.getUTCDay(), minuteOfDay: hour * 60 + minute };
}

function isWindowActive(window: SmartChargingWindow, at: Date, timeZone?: string | null): boolean {
  const { day, minuteOfDay } = scLocalDayMinute(at, timeZone);

  if (!window.daysOfWeek.includes(day)) return false;

  const start = parseTimeToMinuteOfDay(window.startTime);
  const end = parseTimeToMinuteOfDay(window.endTime);
  if (start == null || end == null) return false;

  if (start === end) return true;
  if (start < end) return minuteOfDay >= start && minuteOfDay < end;

  // Overnight window (e.g. 22:00 -> 06:00)
  return minuteOfDay >= start || minuteOfDay < end;
}

function sortProfiles(profiles: SmartChargingProfileLike[]): SmartChargingProfileLike[] {
  return [...profiles].sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return b.updatedAt.getTime() - a.updatedAt.getTime();
  });
}

export function resolveEffectiveSmartChargingLimit(args: {
  chargerProfiles: SmartChargingProfileLike[];
  groupProfiles: SmartChargingProfileLike[];
  siteProfiles: SmartChargingProfileLike[];
  at?: Date;
  timeZone?: string | null;
  fallbackLimitKw: number;
}): SmartChargingResolution {
  const at = args.at ?? new Date();
  const timeZone = args.timeZone;
  const invalidProfileIds: string[] = [];
  const scopeOrder: Array<{ scope: SmartChargingScope; profiles: SmartChargingProfileLike[] }> = [
    { scope: 'CHARGER', profiles: sortProfiles(args.chargerProfiles) },
    { scope: 'GROUP', profiles: sortProfiles(args.groupProfiles) },
    { scope: 'SITE', profiles: sortProfiles(args.siteProfiles) },
  ];

  for (const bucket of scopeOrder) {
    for (const profile of bucket.profiles) {
      if (!profile.enabled) continue;
      if (!isProfileWithinValidityWindow(profile, at)) continue;

      const parsed = parseSmartChargingSchedule(profile.schedule);
      if (parsed.errors.length > 0) {
        invalidProfileIds.push(profile.id);
        continue;
      }

      const activeWindow = parsed.windows.find((w) => isWindowActive(w, at, timeZone));
      if (activeWindow) {
        return {
          effectiveLimitKw: activeWindow.limitKw,
          fallbackApplied: false,
          sourceScope: bucket.scope,
          sourceProfileId: profile.id,
          sourceWindowId: activeWindow.id,
          sourceReason: `Active ${bucket.scope.toLowerCase()} window ${activeWindow.id} from profile ${profile.name}`,
          invalidProfileIds,
        };
      }

      if (profile.defaultLimitKw != null && Number.isFinite(profile.defaultLimitKw) && profile.defaultLimitKw > 0) {
        return {
          effectiveLimitKw: profile.defaultLimitKw,
          fallbackApplied: false,
          sourceScope: bucket.scope,
          sourceProfileId: profile.id,
          sourceWindowId: null,
          sourceReason: `Default ${bucket.scope.toLowerCase()} limit from profile ${profile.name}`,
          invalidProfileIds,
        };
      }
    }
  }

  return {
    effectiveLimitKw: args.fallbackLimitKw,
    fallbackApplied: true,
    sourceScope: null,
    sourceProfileId: null,
    sourceWindowId: null,
    sourceReason: invalidProfileIds.length > 0
      ? 'Fallback safe limit applied: invalid active profiles'
      : 'Fallback safe limit applied: no active profiles',
    invalidProfileIds,
  };
}

// --- Stacking support ---

const SCOPE_STACK_BASE: Record<SmartChargingScope, number> = {
  SITE: 10,
  GROUP: 30,
  CHARGER: 50,
};

export type StackedProfileEntry = {
  profile: SmartChargingProfileLike;
  scope: SmartChargingScope;
  ocppStackLevel: number;
  ocppChargingProfileId: number;
};

/**
 * Returns ALL enabled+valid profiles for a charger with deterministic OCPP stackLevel
 * and chargingProfileId assignments. Used for multi-push stacking.
 *
 * stackLevel = scope base (SITE=10, GROUP=30, CHARGER=50) + profile.priority
 * chargingProfileId = 1-based index in returned array (stable per reconcile call)
 */
export function resolveAllActiveProfiles(args: {
  chargerProfiles: SmartChargingProfileLike[];
  groupProfiles: SmartChargingProfileLike[];
  siteProfiles: SmartChargingProfileLike[];
  at?: Date;
  timeZone?: string | null;
}): StackedProfileEntry[] {
  const at = args.at ?? new Date();
  const results: StackedProfileEntry[] = [];

  const scopeOrder: Array<{ scope: SmartChargingScope; profiles: SmartChargingProfileLike[] }> = [
    { scope: 'CHARGER', profiles: sortProfiles(args.chargerProfiles) },
    { scope: 'GROUP', profiles: sortProfiles(args.groupProfiles) },
    { scope: 'SITE', profiles: sortProfiles(args.siteProfiles) },
  ];

  for (const bucket of scopeOrder) {
    for (const profile of bucket.profiles) {
      if (!profile.enabled) continue;
      if (!isProfileWithinValidityWindow(profile, at)) continue;

      const parsed = parseSmartChargingSchedule(profile.schedule);
      if (parsed.errors.length > 0) continue; // skip invalid

      // Profile has either a schedule or a default limit — it's applicable
      const hasScheduleWindows = parsed.windows.length > 0;
      const hasDefaultLimit = profile.defaultLimitKw != null && Number.isFinite(profile.defaultLimitKw) && profile.defaultLimitKw > 0;

      if (!hasScheduleWindows && !hasDefaultLimit) continue; // no actionable limit

      results.push({
        profile,
        scope: bucket.scope,
        ocppStackLevel: SCOPE_STACK_BASE[bucket.scope] + profile.priority,
        ocppChargingProfileId: 0, // assigned below
      });
    }
  }

  // Assign deterministic 1-based chargingProfileId
  for (let i = 0; i < results.length; i++) {
    results[i].ocppChargingProfileId = i + 1;
  }

  return results;
}

/**
 * Compute the merged effective schedule (what the charger should enforce)
 * for a set of stacked profiles over a 24h period. Returns hourly slots.
 * At each slot, the effective limit is the MINIMUM across all active profiles.
 */
export function computeMergedSchedule(args: {
  stackedProfiles: StackedProfileEntry[];
  at?: Date;
  timeZone?: string | null;
  fallbackLimitKw: number;
}): Array<{ hour: number; effectiveLimitKw: number; sourceProfileIds: string[] }> {
  const at = args.at ?? new Date();
  const timeZone = args.timeZone;
  const slots: Array<{ hour: number; effectiveLimitKw: number; sourceProfileIds: string[] }> = [];

  for (let h = 0; h < 24; h++) {
    const slotTime = new Date(at);
    slotTime.setHours(h, 30, 0, 0); // mid-hour sample

    let minLimit = Infinity;
    const activeIds: string[] = [];

    for (const entry of args.stackedProfiles) {
      const parsed = parseSmartChargingSchedule(entry.profile.schedule);
      const activeWindow = parsed.windows.find((w) => isWindowActive(w, slotTime, timeZone));

      let limitForSlot: number | null = null;
      if (activeWindow) {
        limitForSlot = activeWindow.limitKw;
      } else if (entry.profile.defaultLimitKw != null && entry.profile.defaultLimitKw > 0) {
        limitForSlot = entry.profile.defaultLimitKw;
      }

      if (limitForSlot != null && limitForSlot < minLimit) {
        minLimit = limitForSlot;
        activeIds.length = 0;
        activeIds.push(entry.profile.id);
      } else if (limitForSlot != null && Math.abs(limitForSlot - minLimit) < 0.001) {
        activeIds.push(entry.profile.id);
      }
    }

    slots.push({
      hour: h,
      effectiveLimitKw: Number.isFinite(minLimit) ? minLimit : args.fallbackLimitKw,
      sourceProfileIds: activeIds.length > 0 ? activeIds : [],
    });
  }

  return slots;
}
