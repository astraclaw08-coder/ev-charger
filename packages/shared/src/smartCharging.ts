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

function isWindowActive(window: SmartChargingWindow, at: Date): boolean {
  const day = at.getUTCDay();
  const minuteOfDay = at.getUTCHours() * 60 + at.getUTCMinutes();

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
  fallbackLimitKw: number;
}): SmartChargingResolution {
  const at = args.at ?? new Date();
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

      const activeWindow = parsed.windows.find((w) => isWindowActive(w, at));
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
