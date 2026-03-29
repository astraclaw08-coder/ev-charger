import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { shortId } from '../lib/shortId';
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { createApiClient, type SiteDetail as SiteDetailType, type ChargerUptime, type SiteUptime, type Analytics as SiteAnalytics, type DailyEntry } from '../api/client';
import { useToken } from '../auth/TokenContext';
import ChargerMap from '../components/ChargerMap';
import StatusBadge from '../components/StatusBadge';
import AddChargerDialog from '../components/AddChargerDialog';
import AddressAutocomplete from '../components/AddressAutocomplete';
import { formatDate } from '../lib/utils';
import { usePortalTheme } from '../theme/ThemeContext';

type RangePreset = '7d' | '30d' | '60d';


// ── TOU v2: Segment-based pricing ────────────────────────────────────────────
// Each price tier is a named bucket (low/medium/high) with energy + idle rates.
// A daily profile holds ordered segments (start/end hour) assigned to a bucket.
type PriceBucket = { id: 'low' | 'medium' | 'high'; label: string; pricePerKwhUsd: number; idleFeePerMinUsd: number };
type TouTierSegment = {
  id: string;
  bucket: 'low' | 'medium' | 'high';
  startHour: number; // 0–23
  endHour: number;   // 1–24, exclusive end; must be > startHour
};
type TouDailyProfile = {
  id: string;
  days: number[]; // 0=Sun … 6=Sat
  segments: TouTierSegment[];
};
// Legacy window type kept for backward-compat API serialization
type TouWindow = {
  id: string;
  day: number;
  start: string;
  end: string;
  pricePerKwhUsd: number;
  idleFeePerMinUsd: number;
};
type TariffConfig = {
  pricePerKwhUsd: number;
  idleFeePerMinUsd: number;
  activationFeeUsd: number;
  gracePeriodMin: number;
  softwareVendorFeeMode: 'none' | 'percentage_total' | 'fixed_per_kwh' | 'fixed_per_minute';
  softwareVendorFeeValue: number;
  softwareFeeIncludesActivation: boolean;
  mode: 'flat' | 'tou';
  buckets: PriceBucket[];
  profiles: TouDailyProfile[];
  windows: TouWindow[]; // derived on save — not stored in state
};

const DEFAULT_BUCKETS: PriceBucket[] = [
  { id: 'low',    label: 'Low',    pricePerKwhUsd: 0.15, idleFeePerMinUsd: 0.02 },
  { id: 'medium', label: 'Medium', pricePerKwhUsd: 0.30, idleFeePerMinUsd: 0.05 },
  { id: 'high',   label: 'High',   pricePerKwhUsd: 0.50, idleFeePerMinUsd: 0.10 },
];

// Text + border colors for bucket labels and badges (no background fills)
const BUCKET_COLORS: Record<string, { text: string; border: string }> = {
  low:    { text: 'text-emerald-600 dark:text-emerald-400', border: 'border-emerald-300 dark:border-emerald-700' },
  medium: { text: 'text-amber-600 dark:text-amber-400',     border: 'border-amber-300 dark:border-amber-700' },
  high:   { text: 'text-rose-600 dark:text-rose-400',       border: 'border-rose-300 dark:border-rose-700' },
  none:   { text: 'text-gray-400 dark:text-slate-500',      border: 'border-gray-200 dark:border-slate-700' },
};
// Solid fill + guaranteed legible white label for timeline segment bars
const SEGMENT_STYLE: Record<string, { bg: string; label: string }> = {
  low:    { bg: 'bg-emerald-500 dark:bg-emerald-600', label: 'text-white' },
  medium: { bg: 'bg-amber-500 dark:bg-amber-600',     label: 'text-white' },
  high:   { bg: 'bg-rose-600 dark:bg-rose-700',       label: 'text-white' },
};
// Add-tier button styles per bucket
const ADD_TIER_CLASSES: Record<string, string> = {
  low:    'border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-700 dark:text-emerald-400 dark:hover:bg-emerald-950/40',
  medium: 'border-amber-300 text-amber-700 hover:bg-amber-50 dark:border-amber-700 dark:text-amber-400 dark:hover:bg-amber-950/40',
  high:   'border-rose-300 text-rose-700 hover:bg-rose-50 dark:border-rose-700 dark:text-rose-400 dark:hover:bg-rose-950/40',
};

type TouDragState = { pi: number; segId: string; handle: 'start' | 'end'; containerLeft: number; containerWidth: number };

function makeDailyProfile(days: number[] = [1,2,3,4,5]): TouDailyProfile {
  return {
    id: crypto.randomUUID(),
    days,
    segments: [
      { id: crypto.randomUUID(), bucket: 'low',    startHour: 0,  endHour: 8  },
      { id: crypto.randomUUID(), bucket: 'medium', startHour: 8,  endHour: 16 },
      { id: crypto.randomUUID(), bucket: 'high',   startHour: 16, endHour: 21 },
      { id: crypto.randomUUID(), bucket: 'low',    startHour: 21, endHour: 24 },
    ],
  };
}

function normalizeSegments(segments: TouTierSegment[]): TouTierSegment[] {
  const sorted = segments
    .slice()
    .filter((s) => s.endHour > s.startHour)
    .sort((a, b) => a.startHour - b.startHour || a.endHour - b.endHour);
  if (sorted.length === 0) return [];
  const merged: TouTierSegment[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = merged[merged.length - 1];
    const curr = sorted[i];
    if (prev.bucket === curr.bucket && prev.endHour >= curr.startHour) {
      merged[merged.length - 1] = { ...prev, endHour: Math.max(prev.endHour, curr.endHour) };
    } else {
      merged.push(curr);
    }
  }
  return merged;
}

function tariffFingerprint(t: TariffConfig): string {
  return JSON.stringify({
    mode: t.mode,
    buckets: t.buckets.map((b) => ({ id: b.id, e: Number(b.pricePerKwhUsd.toFixed(4)), i: Number(b.idleFeePerMinUsd.toFixed(4)) })),
    profiles: t.profiles.map((p) => ({
      days: [...p.days].sort((a, b) => a - b),
      segments: normalizeSegments(p.segments).map((s) => ({ b: s.bucket, s: s.startHour, e: s.endHour })),
    })),
  });
}

// Convert segment profiles → legacy TouWindow[] for API
function profilesToWindows(profiles: TouDailyProfile[], buckets: PriceBucket[]): TouWindow[] {
  const wins: TouWindow[] = [];
  for (const profile of profiles) {
    for (const day of profile.days) {
      for (const seg of profile.segments) {
        const b = buckets.find((b) => b.id === seg.bucket);
        if (!b) continue;
        wins.push({
          id: crypto.randomUUID(),
          day,
          start: `${String(seg.startHour).padStart(2,'0')}:00`,
          end: seg.endHour >= 24 ? '00:00' : `${String(seg.endHour).padStart(2,'0')}:00`,
          pricePerKwhUsd: b.pricePerKwhUsd,
          idleFeePerMinUsd: b.idleFeePerMinUsd,
        });
      }
    }
  }
  return wins;
}

function deriveBucketsFromWindows(windows: TouWindow[]): PriceBucket[] {
  const uniq = new Map<string, { pricePerKwhUsd: number; idleFeePerMinUsd: number }>();
  for (const w of windows) {
    const e = Number(w.pricePerKwhUsd ?? 0);
    const i = Number(w.idleFeePerMinUsd ?? 0);
    const key = `${e.toFixed(6)}|${i.toFixed(6)}`;
    if (!uniq.has(key)) uniq.set(key, { pricePerKwhUsd: e, idleFeePerMinUsd: i });
  }
  const pairs = Array.from(uniq.values()).sort((a, b) => a.pricePerKwhUsd - b.pricePerKwhUsd || a.idleFeePerMinUsd - b.idleFeePerMinUsd);
  if (pairs.length === 0) return DEFAULT_BUCKETS;
  const labels: Array<{ id: 'low'|'medium'|'high'; label: string }> = [
    { id: 'low', label: 'Low' },
    { id: 'medium', label: 'Medium' },
    { id: 'high', label: 'High' },
  ];
  const out: PriceBucket[] = labels.map((l, idx) => {
    const p = pairs[idx] ?? pairs[pairs.length - 1] ?? DEFAULT_BUCKETS[idx];
    return { id: l.id, label: l.label, pricePerKwhUsd: p.pricePerKwhUsd, idleFeePerMinUsd: p.idleFeePerMinUsd };
  });
  return out;
}

function windowsToProfileFromMostCommonSchedule(windows: TouWindow[], buckets: PriceBucket[]): TouDailyProfile[] {
  if (!Array.isArray(windows) || windows.length === 0) return [];

  const bucketForWindow = (w: TouWindow): 'low'|'medium'|'high' => {
    const exact = buckets.find((b) => Number(b.pricePerKwhUsd) === Number(w.pricePerKwhUsd) && Number(b.idleFeePerMinUsd) === Number(w.idleFeePerMinUsd));
    if (exact) return exact.id;
    // fallback: nearest by energy then idle
    let best = buckets[0];
    let bestScore = Number.POSITIVE_INFINITY;
    for (const b of buckets) {
      const score = Math.abs(Number(b.pricePerKwhUsd) - Number(w.pricePerKwhUsd)) + Math.abs(Number(b.idleFeePerMinUsd) - Number(w.idleFeePerMinUsd));
      if (score < bestScore) { best = b; bestScore = score; }
    }
    return best.id;
  };

  const daySegments: Record<number, TouTierSegment[]> = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  for (let day = 0; day < 7; day += 1) {
    const dWins = windows
      .filter((w) => Number(w.day) === day)
      .sort((a, b) => timeToMinutes(String(a.start)) - timeToMinutes(String(b.start)));

    const segs: TouTierSegment[] = dWins.map((w) => {
      const start = Math.max(0, Math.min(23, Math.floor(timeToMinutes(String(w.start)) / 60)));
      const endMins = endTimeToMinutes(String(w.end));
      const end = endMins >= 1440 ? 24 : Math.max(start + 1, Math.min(24, Math.ceil(endMins / 60)));
      return {
        id: crypto.randomUUID(),
        bucket: bucketForWindow(w),
        startHour: start,
        endHour: end,
      };
    });
    daySegments[day] = normalizeSegments(segs);
  }

  const signatureByDay = new Map<number, string>();
  const countBySignature = new Map<string, number>();
  const segmentsBySignature = new Map<string, TouTierSegment[]>();

  for (let day = 0; day < 7; day += 1) {
    const segs = daySegments[day];
    if (segs.length === 0) continue;
    const sig = JSON.stringify(segs.map((s) => ({ b: s.bucket, s: s.startHour, e: s.endHour })));
    signatureByDay.set(day, sig);
    countBySignature.set(sig, (countBySignature.get(sig) ?? 0) + 1);
    if (!segmentsBySignature.has(sig)) segmentsBySignature.set(sig, segs);
  }

  if (countBySignature.size === 0) return [];

  const bestSig = Array.from(countBySignature.entries()).sort((a, b) => b[1] - a[1])[0][0];
  const days = Array.from(signatureByDay.entries()).filter(([, sig]) => sig === bestSig).map(([d]) => d).sort((a, b) => a - b);
  const segments = (segmentsBySignature.get(bestSig) ?? []).map((s) => ({ ...s, id: crypto.randomUUID() }));

  return [{ id: crypto.randomUUID(), days, segments }];
}
type SiteAuditEvent = { id: string; action: string; actor: string; detail: string; createdAt: string };

function auditKey(siteId: string) { return `ev-portal:site:audit:${siteId}`; }

function loadAudit(siteId: string): SiteAuditEvent[] {
  try { const raw = localStorage.getItem(auditKey(siteId)); if (!raw) return []; const x = JSON.parse(raw) as SiteAuditEvent[]; return Array.isArray(x) ? x : []; } catch { return []; }
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function timeToMinutes(v: string): number {
  // '23:59' is legacy end-of-day alias — treat as 1440
  if (v === '23:59') return 1440;
  // '00:00' means either midnight-start (0) or end-of-day (1440); callers must interpret by context
  const [h, m] = v.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return -1;
  return h * 60 + m;
}

/**
 * Like timeToMinutes but treats '00:00' as end-of-day (1440) when used as a window end value.
 * Use this when comparing end times, not start times.
 */
function endTimeToMinutes(v: string): number {
  if (v === '00:00' || v === '23:59') return 1440;
  return timeToMinutes(v);
}

function formatHour12(h: number): string {
  if (h === 0 || h === 24) return '12 AM';
  if (h === 12) return '12 PM';
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

function formatRange12(startHour: number, endHour: number): string {
  return `${formatHour12(startHour)}–${formatHour12(endHour)}`;
}

function validateTouWindows(windows: TouWindow[]): string | null {
  for (const w of windows) {
    const start = timeToMinutes(w.start);
    const end = endTimeToMinutes(w.end);
    if (start < 0 || end < 0 || end <= start) {
      return `Invalid time range in ${DAY_NAMES[w.day]} (${w.start} - ${w.end})`;
    }
  }

  for (let day = 0; day < 7; day += 1) {
    const dayWindows = windows.filter((w) => w.day === day).sort((a, b) => timeToMinutes(a.start) - timeToMinutes(b.start));
    for (let i = 1; i < dayWindows.length; i += 1) {
      const prev = dayWindows[i - 1];
      const curr = dayWindows[i];
      if (timeToMinutes(curr.start) < endTimeToMinutes(prev.end)) {
        return `Overlapping windows on ${DAY_NAMES[day]} (${prev.start}-${prev.end} and ${curr.start}-${curr.end})`;
      }
    }
  }

  return null;
}

function buildPricingSummary(config: TariffConfig): { lines: string[] } {
  const activation = config.activationFeeUsd > 0 ? ` · $${config.activationFeeUsd.toFixed(2)} to start a session` : '';
  const grace = config.gracePeriodMin > 0 ? ` · ${config.gracePeriodMin}-min free grace period after charging ends` : '';

  if (config.mode !== 'tou' || config.profiles.length === 0) {
    const lines = [
      `Customers pay $${config.pricePerKwhUsd.toFixed(2)} per kWh of energy delivered${activation}${grace}.`,
      `If the car sits plugged in after charging, an idle fee of $${config.idleFeePerMinUsd.toFixed(2)}/min applies.`,
    ];
    return { lines };
  }

  // TOU — summarize active profile
  const profile = config.profiles[0];
  const now = new Date();
  const nowH = now.getHours();
  const activeSeg = profile.segments.find(s => nowH >= s.startHour && nowH < s.endHour);
  const activeBucket = activeSeg ? config.buckets.find(b => b.id === activeSeg.bucket) : null;

  const lines: string[] = [
    `Prices vary by time of day (Time-of-Use pricing)${activation}${grace}.`,
  ];

  // Summarize each tier
  for (const bucket of config.buckets) {
    const segs = profile.segments.filter(s => s.bucket === bucket.id).sort((a,b) => a.startHour - b.startHour);
    if (segs.length === 0) continue;
    const ranges = segs.map(s => formatRange12(s.startHour, s.endHour)).join(', ');
    lines.push(`${bucket.label} tier (${ranges}): $${bucket.pricePerKwhUsd.toFixed(2)}/kWh · $${bucket.idleFeePerMinUsd.toFixed(2)}/min idle`);
  }

  if (activeBucket) {
    lines.push(`Right now: ${activeBucket.label} tier — $${activeBucket.pricePerKwhUsd.toFixed(2)}/kWh`);
  }

  return { lines };
}

export default function SiteDetail() {
  const { id } = useParams<{ id: string }>();
  const getToken = useToken();
  const getTokenRef = useRef(getToken);
  useEffect(() => { getTokenRef.current = getToken; }, [getToken]);
  const { theme } = usePortalTheme();
  const isDark = theme === 'dark';
  const chartColors = {
    grid: isDark ? '#334155' : '#e2e8f0',
    tick: isDark ? '#94a3b8' : '#64748b',
    tooltip: isDark
      ? { backgroundColor: '#1e293b', border: '1px solid #334155', color: '#f1f5f9' }
      : { backgroundColor: '#ffffff', border: '1px solid #e2e8f0', color: '#1e293b' },
  };
  const [site, setSite] = useState<SiteDetailType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showAddCharger, setShowAddCharger] = useState(false);
  const [showEditSite, setShowEditSite] = useState(false);
  const [editSiteForm, setEditSiteForm] = useState({ name: '', address: '', lat: '', lng: '', organizationName: '', portfolioName: '' });
  const [editCoordsAutoFilled, setEditCoordsAutoFilled] = useState(false);
  const [chargerUptime, setChargerUptime] = useState<Record<string, ChargerUptime>>({});
  const [siteUptime, setSiteUptime] = useState<SiteUptime | null>(null);
  const [siteAnalytics, setSiteAnalytics] = useState<SiteAnalytics | null>(null);
  const [rangePreset, setRangePreset] = useState<RangePreset>('30d');
  const [trend, setTrend] = useState<Array<{ date: string; label: string; sessions: number; kwhDelivered: number; revenueUsd: number }>>([]);
  const [activeSessions, setActiveSessions] = useState(0);
  const [siteUtilizationPct, setSiteUtilizationPct] = useState<number | null>(null);

  const [tariff, setTariff] = useState<TariffConfig>({ pricePerKwhUsd: 0.35, idleFeePerMinUsd: 0.08, activationFeeUsd: 0, gracePeriodMin: 10, softwareVendorFeeMode: 'none', softwareVendorFeeValue: 0, softwareFeeIncludesActivation: true, mode: 'flat', buckets: DEFAULT_BUCKETS, profiles: [], windows: [] });
  const [savedTariff, setSavedTariff] = useState<TariffConfig | null>(null);
  const [pricingSummaryOpen, setPricingSummaryOpen] = useState(false);
  const touDragRef = useRef<TouDragState | null>(null);
  const [tariffMsg, setTariffMsg] = useState('');
  const [showFeeModal, setShowFeeModal] = useState(false);
  // Superadmin detection: dev mode always grants superadmin; in production read from JWT publicMetadata.
  const isSuperAdmin = true; // TODO: wire to real role claim when auth matures

  const [auditEvents, setAuditEvents] = useState<SiteAuditEvent[]>([]);

  // Session safety limits
  const [safetyLimits, setSafetyLimits] = useState<{
    maxChargeDurationMin: string;
    maxIdleDurationMin: string;
    maxSessionCostUsd: string;
  }>({ maxChargeDurationMin: '', maxIdleDurationMin: '', maxSessionCostUsd: '' });
  const [savedSafetyLimits, setSavedSafetyLimits] = useState<typeof safetyLimits | null>(null);
  const [safetyMsg, setSafetyMsg] = useState('');

  const hasTariffEdits = !savedTariff || tariffFingerprint(tariff) !== tariffFingerprint(savedTariff);

  const load = useCallback(async () => {
    try {
      const token = await getTokenRef.current();
      const client = createApiClient(token);
      const periodDays = rangePreset === '7d' ? 7 : rangePreset === '30d' ? 30 : 60;

      let resolvedSiteId = id!;
      const sites = await client.getSites().catch(() => []);
      const matchedSite = sites.find((s) => s.id === id || s.id.startsWith(id ?? ''));
      if (matchedSite?.id) resolvedSiteId = matchedSite.id;

      const data = await client.getSite(resolvedSiteId);
      setSite(data);
      setEditSiteForm({
        name: data.name,
        address: data.address,
        lat: String(data.lat),
        lng: String(data.lng),
        organizationName: data.organizationName ?? '',
        portfolioName: data.portfolioName ?? '',
      });
      const loadedSafety = {
        maxChargeDurationMin: data.maxChargeDurationMin != null ? String(data.maxChargeDurationMin) : '',
        maxIdleDurationMin: data.maxIdleDurationMin != null ? String(data.maxIdleDurationMin) : '',
        maxSessionCostUsd: data.maxSessionCostUsd != null ? String(data.maxSessionCostUsd) : '',
      };
      setSafetyLimits(loadedSafety);
      setSavedSafetyLimits(loadedSafety);
      const loadedWindows: TouWindow[] = Array.isArray(data.touWindows)
        ? (data.touWindows as Array<Partial<TouWindow>>).map((w) => ({
            id: typeof w.id === 'string' && w.id.length > 0 ? w.id : crypto.randomUUID(),
            day: Number(w.day ?? 0),
            start: String(w.start ?? '09:00'),
            end: String(w.end ?? '17:00'),
            pricePerKwhUsd: Number(w.pricePerKwhUsd ?? data.pricePerKwhUsd ?? 0.35),
            idleFeePerMinUsd: Number(w.idleFeePerMinUsd ?? data.idleFeePerMinUsd ?? 0.08),
          }))
        : [];

      const loadedBuckets: PriceBucket[] = Array.isArray((data as any).priceBuckets) && (data as any).priceBuckets.length === 3
        ? (data as any).priceBuckets
        : deriveBucketsFromWindows(loadedWindows);

      const loadedProfiles: TouDailyProfile[] = Array.isArray((data as any).touProfiles) && (data as any).touProfiles.length > 0
        ? (data as any).touProfiles
        : windowsToProfileFromMostCommonSchedule(loadedWindows, loadedBuckets);

      setTariff({
        pricePerKwhUsd: Number(data.pricePerKwhUsd ?? 0.35),
        idleFeePerMinUsd: Number(data.idleFeePerMinUsd ?? 0.08),
        activationFeeUsd: Number(data.activationFeeUsd ?? 0),
        gracePeriodMin: Number(data.gracePeriodMin ?? 10),
        softwareVendorFeeMode: (data.softwareVendorFeeMode ?? 'none') as TariffConfig['softwareVendorFeeMode'],
        softwareVendorFeeValue: Number(data.softwareVendorFeeValue ?? 0),
        softwareFeeIncludesActivation: Boolean(data.softwareFeeIncludesActivation ?? true),
        mode: data.pricingMode === 'tou' ? 'tou' : 'flat',
        buckets: loadedBuckets,
        profiles: loadedProfiles,
        windows: loadedWindows,
      });
      // Mirror loaded tariff as the last-saved baseline so refreshed UI matches persisted data
      setSavedTariff({
        pricePerKwhUsd: Number(data.pricePerKwhUsd ?? 0.35),
        idleFeePerMinUsd: Number(data.idleFeePerMinUsd ?? 0.08),
        activationFeeUsd: Number(data.activationFeeUsd ?? 0),
        gracePeriodMin: Number(data.gracePeriodMin ?? 10),
        softwareVendorFeeMode: (data.softwareVendorFeeMode ?? 'none') as TariffConfig['softwareVendorFeeMode'],
        softwareVendorFeeValue: Number(data.softwareVendorFeeValue ?? 0),
        softwareFeeIncludesActivation: Boolean(data.softwareFeeIncludesActivation ?? true),
        mode: data.pricingMode === 'tou' ? 'tou' : 'flat',
        buckets: loadedBuckets,
        profiles: loadedProfiles,
        windows: loadedWindows,
      });
      setAuditEvents(loadAudit(data.id));

      const [siteUp, analytics, perCharger] = await Promise.all([
        client.getSiteUptime(data.id).catch(() => null),
        client.getAnalytics(data.id, { periodDays }).catch(() => null),
        Promise.all(data.chargers.map((c) => client.getChargerUptime(c.id).catch(() => null))),
      ]);

      if (siteUp) setSiteUptime(siteUp);
      setSiteAnalytics(analytics);

      // Active sessions count + utilization based on actual session seconds in selected window
      const [chargerStatuses, chargerSessions] = await Promise.all([
        Promise.all(data.chargers.map((c) => client.getChargerStatus(c.id).catch(() => null))),
        Promise.all(data.chargers.map((c) => client.getChargerSessions(c.id).catch(() => []))),
      ]);
      setActiveSessions(
        chargerStatuses.filter(Boolean).reduce((sum, ch) => sum + (ch?.connectors.filter((c) => c.activeSession).length ?? 0), 0),
      );

      const periodEndMs = Date.now();
      const periodStartMs = periodEndMs - (periodDays * 24 * 60 * 60 * 1000);
      const actualChargingSeconds = chargerSessions
        .flat()
        .reduce((sum, session) => {
          const startMs = new Date(session.startedAt).getTime();
          const stopMs = session.stoppedAt ? new Date(session.stoppedAt).getTime() : periodEndMs;
          const overlapStart = Math.max(startMs, periodStartMs);
          const overlapEnd = Math.min(stopMs, periodEndMs);
          if (!Number.isFinite(overlapStart) || !Number.isFinite(overlapEnd) || overlapEnd <= overlapStart) return sum;
          return sum + Math.floor((overlapEnd - overlapStart) / 1000);
        }, 0);
      const connectorCount = data.chargers.reduce((sum, ch) => sum + ch.connectors.length, 0);
      const totalPossibleSeconds = connectorCount > 0 ? connectorCount * periodDays * 24 * 60 * 60 : 0;
      if (totalPossibleSeconds > 0) {
        setSiteUtilizationPct(Math.round((actualChargingSeconds / totalPossibleSeconds) * 10000) / 100);
      } else if (analytics?.utilizationRatePct != null) {
        setSiteUtilizationPct(Number(analytics.utilizationRatePct));
      } else {
        setSiteUtilizationPct(null);
      }

      // Trend data from daily analytics
      const daily = new Map<string, { sessions: number; kwhDelivered: number; revenueCents: number }>();
      (analytics?.daily ?? []).forEach((d: DailyEntry) => {
        const row = daily.get(d.date) ?? { sessions: 0, kwhDelivered: 0, revenueCents: 0 };
        row.sessions += d.sessions;
        row.kwhDelivered += d.kwhDelivered;
        row.revenueCents += d.revenueCents;
        daily.set(d.date, row);
      });
      setTrend(
        Array.from(daily.entries())
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([date, row]) => ({
            date,
            label: date.slice(5),
            sessions: row.sessions,
            kwhDelivered: Math.round(row.kwhDelivered * 1000) / 1000,
            revenueUsd: Math.round(row.revenueCents) / 100,
          })),
      );

      const map: Record<string, ChargerUptime> = {};
      perCharger.forEach((u) => { if (u) map[u.chargerId] = u; });
      setChargerUptime(map);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load site');
    } finally {
      setLoading(false);
    }
  }, [id, rangePreset]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return <div className="flex h-64 items-center justify-center text-gray-400 dark:text-slate-500">Loading…</div>;
  }
  if (error || !site) {
    return <div className="rounded-lg bg-red-50 dark:bg-red-900/20 p-4 text-sm text-red-700 dark:text-red-400">{error || 'Site not found'}</div>;
  }

  const pushAudit = (action: string, detail: string) => {
    const next: SiteAuditEvent[] = [{
      id: crypto.randomUUID(), action, actor: 'operator-admin', detail, createdAt: new Date().toISOString(),
    }, ...auditEvents];
    setAuditEvents(next);
    localStorage.setItem(auditKey(site.id), JSON.stringify(next.slice(0, 250)));
  };

  const totalKwh = siteAnalytics?.kwhDelivered ?? 0;
  const totalRevenue = (siteAnalytics?.revenueCents ?? 0) / 100;
  const utilizationPct = siteUtilizationPct;
  const totalConnectors = site.chargers.reduce((s, c) => s + c.connectors.length, 0);
  const totalChargers = site.chargers.length;

  return (
    <div className="space-y-6">

      {/* ── Header ── */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-slate-400">
            <Link to="/overview" className="hover:text-gray-700 dark:hover:text-slate-200 dark:text-slate-300">Overview</Link>
            <span>/</span>
            <Link to="/sites" className="hover:text-gray-700 dark:hover:text-slate-200 dark:text-slate-300">Sites</Link>
            <span>/</span>
            <span className="text-gray-900 dark:text-slate-100">{site.name}</span>
          </div>
          <h1 className="mt-1 text-2xl font-bold text-gray-900 dark:text-slate-100">{site.name}</h1>
          <p className="text-sm text-gray-500 dark:text-slate-400">{site.address}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={rangePreset}
            onChange={(e) => setRangePreset(e.target.value as RangePreset)}
            className="rounded-md border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-800/60 px-4 py-2 text-sm font-medium text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700"
          >
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="60d">Last 60 days</option>
          </select>
          <button onClick={() => setShowEditSite((v) => !v)} className="rounded-md border border-gray-300 dark:border-slate-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-slate-300 bg-white dark:bg-slate-800/60 hover:bg-gray-50 dark:hover:bg-slate-700">Edit Site</button>
          <Link to={`/sites/${site.id}/analytics`} className="rounded-md border border-gray-300 dark:border-slate-700 px-4 py-2 text-sm font-medium text-gray-600 dark:text-slate-400 bg-white dark:bg-slate-800/60 hover:bg-gray-50 dark:hover:bg-slate-700">Analytics</Link>
          <button onClick={() => setShowAddCharger(true)} className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">+ Add Charger</button>
        </div>
      </div>

      {/* ── Edit site form ── */}
      {showEditSite && (
        <div className="rounded-xl border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
          <h2 className="mb-3 text-sm font-semibold text-gray-700 dark:text-slate-300">Edit site details</h2>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-sm text-gray-700 dark:text-slate-300">Site name
              <input className="mt-1 w-full rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5" value={editSiteForm.name} onChange={(e) => setEditSiteForm((f) => ({ ...f, name: e.target.value }))} />
            </label>
            <label className="text-sm text-gray-700 dark:text-slate-300">Address
              <div className="mt-1">
                <AddressAutocomplete
                  value={editSiteForm.address}
                  className="w-full rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5"
                  placeholder="Start typing an address…"
                  onRawChange={(v) => {
                    setEditSiteForm((f) => ({ ...f, address: v }));
                    if (editCoordsAutoFilled) {
                      setEditCoordsAutoFilled(false);
                      setEditSiteForm((f) => ({ ...f, lat: '', lng: '' }));
                    }
                  }}
                  onChange={(address, lat, lng) => {
                    setEditSiteForm((f) => ({ ...f, address, lat: String(lat), lng: String(lng) }));
                    setEditCoordsAutoFilled(true);
                  }}
                />
              </div>
            </label>
            <label className="text-sm text-gray-700 dark:text-slate-300">Latitude
              <input type="number" step="0.000001" className="mt-1 w-full rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5" value={editSiteForm.lat} readOnly={editCoordsAutoFilled} onChange={(e) => setEditSiteForm((f) => ({ ...f, lat: e.target.value }))} />
            </label>
            <label className="text-sm text-gray-700 dark:text-slate-300">Longitude
              <input type="number" step="0.000001" className="mt-1 w-full rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5" value={editSiteForm.lng} readOnly={editCoordsAutoFilled} onChange={(e) => setEditSiteForm((f) => ({ ...f, lng: e.target.value }))} />
            </label>
            <label className="text-sm text-gray-700 dark:text-slate-300">Organization
              <input className="mt-1 w-full rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5" value={editSiteForm.organizationName} onChange={(e) => setEditSiteForm((f) => ({ ...f, organizationName: e.target.value }))} />
            </label>
            <label className="text-sm text-gray-700 dark:text-slate-300">Portfolio
              <input className="mt-1 w-full rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5" value={editSiteForm.portfolioName} onChange={(e) => setEditSiteForm((f) => ({ ...f, portfolioName: e.target.value }))} />
            </label>
          </div>
          <div className="mt-3 flex gap-2">
            <button className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700"
              onClick={async () => {
                const token = await getToken();
                const payload = {
                  name: editSiteForm.name.trim(),
                  address: editSiteForm.address.trim(),
                  lat: Number(editSiteForm.lat),
                  lng: Number(editSiteForm.lng),
                  organizationName: editSiteForm.organizationName.trim(),
                  portfolioName: editSiteForm.portfolioName.trim(),
                };
                await createApiClient(token).updateSite(site.id, payload);
                pushAudit('site.updated', `${payload.name} @ ${payload.address} | org=${payload.organizationName || '-'} portfolio=${payload.portfolioName || '-'}`);
                setShowEditSite(false);
                await load();
              }}>Save site</button>
            <button className="rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800/60 px-3 py-1.5 text-xs text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700" onClick={() => setShowEditSite(false)}>Cancel</button>
          </div>
        </div>
      )}

      {/* ── KPI tiles (dashboard style) ── */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <SiteKpiTile label={`Total kWh (${rangePreset})`} value={`${totalKwh.toFixed(2)} kWh`} />
        <SiteKpiTile label={`Total Revenue (${rangePreset})`} value={`$${totalRevenue.toFixed(2)}`} />
        <SiteKpiTile label="Total Chargers" value={`${totalChargers}`} live />
        <SiteKpiTile label="Active Sessions" value={`${activeSessions}`} live />
        <SiteKpiTile label="Total Connectors" value={`${totalConnectors}`} live />
        <SiteKpiTile label={`Utilization (${rangePreset})`} value={utilizationPct != null ? `${utilizationPct.toFixed(2)}%` : '—'} />
      </div>

      {/* ── Vendor Fee Modal (superadmin only) ── */}
      {showFeeModal && isSuperAdmin && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={() => setShowFeeModal(false)}>
          <div className="w-full max-w-md rounded-2xl border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-gray-900 dark:text-slate-100">Software Fee</h3>
                <p className="mt-0.5 text-xs text-gray-500 dark:text-slate-400">Superadmin only — not visible to site operators</p>
              </div>
              <button onClick={() => setShowFeeModal(false)} className="rounded-md p-1.5 text-gray-400 dark:text-slate-500 hover:bg-gray-100 dark:hover:bg-slate-700 bg-white dark:bg-slate-800 hover:text-gray-700 dark:hover:text-slate-200 dark:text-slate-300">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" /></svg>
              </button>
            </div>
            <div className="space-y-4">
              <label className="block text-sm text-gray-700 dark:text-slate-300">Fee mode
                <select className="mt-1 w-full rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5" value={tariff.softwareVendorFeeMode} onChange={(e) => setTariff({ ...tariff, softwareVendorFeeMode: e.target.value as TariffConfig['softwareVendorFeeMode'] })}>
                  <option value="none">None</option>
                  <option value="percentage_total">% of total transaction (energy and idle)</option>
                  <option value="fixed_per_kwh">Fixed $ / kWh</option>
                  <option value="fixed_per_minute">Fixed $ / minute</option>
                </select>
              </label>
              <label className="block text-sm text-gray-700 dark:text-slate-300">Fee value
                <input type="number" step="0.0001" min="0" className="mt-1 w-full rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5" value={tariff.softwareVendorFeeValue} onChange={(e) => setTariff({ ...tariff, softwareVendorFeeValue: Number(e.target.value) })} />
                <p className="mt-1 text-xs text-gray-400 dark:text-slate-500">
                  {tariff.softwareVendorFeeMode === 'percentage_total' ? 'Enter as a percentage, e.g. 2.5 for 2.5% (applies to energy + idle only, excludes activation fee)' : tariff.softwareVendorFeeMode === 'none' ? 'No fee applied' : 'Enter dollar amount, e.g. 0.015'}
                </p>
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-slate-300">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-gray-300 dark:border-slate-600 text-brand-600 focus:ring-brand-500"
                  checked={tariff.softwareFeeIncludesActivation}
                  onChange={(e) => setTariff({ ...tariff, softwareFeeIncludesActivation: e.target.checked })}
                />
                Include activation fee in software fee (not site-host revenue)
              </label>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setShowFeeModal(false)} className="rounded-md border border-gray-300 dark:border-slate-600 px-3 py-1.5 text-xs text-gray-700 dark:text-slate-300 bg-white dark:bg-slate-800/60 hover:bg-gray-50 dark:hover:bg-slate-700">Cancel</button>
              <button
                onClick={async () => {
                  try {
                    const token = await getToken();
                    await createApiClient(token).updateSite(site.id, {
                      name: site.name, address: site.address, lat: site.lat, lng: site.lng,
                      softwareVendorFeeMode: tariff.softwareVendorFeeMode,
                      softwareVendorFeeValue: tariff.softwareVendorFeeValue,
                      softwareFeeIncludesActivation: tariff.softwareFeeIncludesActivation,
                    });
                    pushAudit('tariff.vendorFee.updated', `mode=${tariff.softwareVendorFeeMode} value=${tariff.softwareVendorFeeValue} includeActivation=${tariff.softwareFeeIncludesActivation}`);
                    setTariffMsg(`Software fee saved: ${tariff.softwareVendorFeeMode} ${tariff.softwareVendorFeeValue} (include activation: ${tariff.softwareFeeIncludesActivation ? 'yes' : 'no'})`);
                    setShowFeeModal(false);
                    await load();
                  } catch (err) {
                    setTariffMsg(`Save failed: ${err instanceof Error ? err.message : 'unknown error'}`);
                  }
                }}
                className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700"
              >
                Save fee
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Tariff (full width, below tiles) ── */}
      <div className="rounded-xl border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-300">Pricing / Tariff</h2>
          <div className="flex items-center gap-2">
            {tariffMsg && <p className="text-xs text-gray-500 dark:text-slate-400">{tariffMsg}</p>}
            {isSuperAdmin && (
              <button
                onClick={() => setShowFeeModal(true)}
                className="flex items-center gap-1.5 rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2.5 py-1 text-xs font-medium text-gray-700 dark:text-slate-100 hover:bg-gray-50 dark:hover:bg-slate-700"
                title="Configure software vendor fee (superadmin only)"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor"><path d="M8.433 7.418c.155-.103.346-.196.567-.267v1.698a2.305 2.305 0 01-.567-.267C8.07 8.34 8 8.114 8 8c0-.114.07-.34.433-.582zM11 12.849v-1.698c.22.071.412.164.567.267.364.243.433.468.433.582 0 .114-.07.34-.433.582a2.305 2.305 0 01-.567.267z"/><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-13a1 1 0 10-2 0v.092a4.535 4.535 0 00-1.676.662C6.602 6.234 6 7.009 6 8c0 .99.602 1.765 1.324 2.246.48.32 1.054.545 1.676.662v1.941c-.391-.127-.68-.317-.843-.504a1 1 0 10-1.51 1.31c.562.649 1.413 1.076 2.353 1.253V15a1 1 0 102 0v-.092a4.535 4.535 0 001.676-.662C13.398 13.766 14 12.991 14 12c0-.99-.602-1.765-1.324-2.246A4.535 4.535 0 0011 9.092V7.151c.391.127.68.317.843.504a1 1 0 101.511-1.31c-.563-.649-1.413-1.076-2.354-1.253V5z" clipRule="evenodd"/></svg>
                Fee
              </button>
            )}
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <label className="text-sm text-gray-700 dark:text-slate-300">Pricing mode
            <select
              className="mt-1 w-full rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5"
              value={tariff.mode}
              onChange={(e) => setTariff((p) => {
                const nextMode = e.target.value as TariffConfig['mode'];
                if (nextMode === 'tou' && p.profiles.length === 0) {
                  return { ...p, mode: nextMode, profiles: [makeDailyProfile()] };
                }
                return { ...p, mode: nextMode };
              })}
            >
              <option value="flat">Flat rate</option>
              <option value="tou">Time-of-Use (TOU)</option>
            </select>
          </label>
          {/* Flat-rate fields — grayed out when TOU is active since TOU tiers take over */}
          <label className={`text-sm transition-opacity ${tariff.mode === 'tou' ? 'opacity-35 pointer-events-none' : 'text-gray-700 dark:text-slate-300'}`}>
            Price per kWh (USD)
            <input type="number" step="0.01" className="mt-1 w-full rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5 bg-white dark:bg-slate-900" value={tariff.pricePerKwhUsd} onChange={(e) => setTariff({ ...tariff, pricePerKwhUsd: Number(e.target.value) })} disabled={tariff.mode === 'tou'} />
            {tariff.mode === 'tou' && <span className="mt-0.5 block text-[10px] text-gray-400 dark:text-slate-500 italic">Set per tier below</span>}
          </label>
          <label className={`text-sm transition-opacity ${tariff.mode === 'tou' ? 'opacity-35 pointer-events-none' : 'text-gray-700 dark:text-slate-300'}`}>
            Idle fee per min (USD)
            <input type="number" step="0.01" className="mt-1 w-full rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5 bg-white dark:bg-slate-900" value={tariff.idleFeePerMinUsd} onChange={(e) => setTariff({ ...tariff, idleFeePerMinUsd: Number(e.target.value) })} disabled={tariff.mode === 'tou'} />
            {tariff.mode === 'tou' && <span className="mt-0.5 block text-[10px] text-gray-400 dark:text-slate-500 italic">Set per tier below</span>}
          </label>
          <label className="text-sm text-gray-700 dark:text-slate-300">Activation fee (USD)
            <input type="number" step="0.01" className="mt-1 w-full rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5" value={tariff.activationFeeUsd} onChange={(e) => setTariff({ ...tariff, activationFeeUsd: Number(e.target.value) })} />
          </label>
          <label className="text-sm text-gray-700 dark:text-slate-300">Grace period (min)
            <input type="number" className="mt-1 w-full rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5" value={tariff.gracePeriodMin} onChange={(e) => setTariff({ ...tariff, gracePeriodMin: Number(e.target.value) })} />
          </label>
        </div>

        {tariff.mode === 'tou' && (
          <div className="mt-4 space-y-5">

            {/* ── Step 1: Price tiers ───────────────────────────────────── */}
            <div className="rounded-xl border border-gray-200 dark:border-slate-700 p-4">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-slate-400">Price tiers</p>
              <div className="grid gap-3 sm:grid-cols-3">
                {tariff.buckets.map((bucket) => {
                  const col = BUCKET_COLORS[bucket.id] ?? BUCKET_COLORS.none;
                  return (
                    <div key={bucket.id} className="rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3">
                      <p className={`mb-3 text-xs font-bold uppercase tracking-wide ${col.text}`}>{bucket.label}</p>
                      <label className="block text-xs text-gray-600 dark:text-slate-400 mb-1">
                        Energy rate ($/kWh)
                        <input
                          type="number" step="0.01" min="0"
                          className="mt-1 w-full rounded-md border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1.5 text-xs text-gray-900 dark:text-slate-100"
                          value={bucket.pricePerKwhUsd}
                          onChange={(e) => setTariff((p) => ({ ...p, buckets: p.buckets.map((b) => b.id === bucket.id ? { ...b, pricePerKwhUsd: Number(e.target.value) } : b) }))}
                        />
                      </label>
                      <label className="block text-xs text-gray-600 dark:text-slate-400">
                        Idle fee ($/min)
                        <input
                          type="number" step="0.001" min="0"
                          className="mt-1 w-full rounded-md border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1.5 text-xs text-gray-900 dark:text-slate-100"
                          value={bucket.idleFeePerMinUsd}
                          onChange={(e) => setTariff((p) => ({ ...p, buckets: p.buckets.map((b) => b.id === bucket.id ? { ...b, idleFeePerMinUsd: Number(e.target.value) } : b) }))}
                        />
                      </label>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* ── Step 2: Daily schedule (single schedule per site) ─────── */}
            <div className="rounded-xl border border-gray-200 dark:border-slate-700 p-4">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-slate-400">Daily schedule</p>

              {tariff.profiles.length === 0 && (
                <div className="mb-3">
                  <p className="mb-2 text-xs text-gray-400 dark:text-slate-500">No schedule set yet.</p>
                  <button
                    type="button"
                    className="rounded-md border border-brand-300 dark:border-brand-700 px-3 py-1.5 text-xs font-medium text-brand-700 dark:text-brand-400 hover:bg-brand-50 dark:hover:bg-brand-950/40"
                    onClick={() => setTariff((p) => ({ ...p, profiles: [makeDailyProfile()] }))}
                  >
                    + Set daily schedule
                  </button>
                </div>
              )}

              {tariff.profiles.slice(0, 1).map((profile, pi) => (
                <div key={profile.id} className="rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
                  {/* Day selector */}
                  <div className="mb-4 flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium text-gray-500 dark:text-slate-400">Active days:</span>
                    {DAY_NAMES.map((name, di) => {
                      const selected = profile.days.includes(di);
                      return (
                        <button
                          key={name}
                          type="button"
                          onClick={() => setTariff((p) => ({
                            ...p,
                            profiles: p.profiles.map((pr, pIdx) => pIdx !== pi ? pr : {
                              ...pr,
                              days: selected ? pr.days.filter((d) => d !== di) : [...pr.days, di].sort(),
                            }),
                          }))}
                          className={`rounded px-2.5 py-1 text-xs font-medium border transition-colors ${selected ? 'bg-brand-600 text-white border-brand-600' : 'bg-white dark:bg-slate-800 text-gray-600 dark:text-slate-300 border-gray-200 dark:border-slate-600 hover:border-brand-400'}`}
                        >
                          {name}
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      className="ml-auto text-xs text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                      onClick={() => setTariff((p) => ({ ...p, profiles: [] }))}
                    >
                      Remove schedule
                    </button>
                  </div>

                  {/* ── Timeline bar ─────────────────────────────────────── */}
                  <div
                    className="relative mb-8 h-11 rounded-md bg-gray-100 dark:bg-slate-800 select-none overflow-visible"
                    style={{ touchAction: 'none' }}
                    onMouseMove={(e) => {
                      const drag = touDragRef.current;
                      if (!drag || drag.pi !== pi) return;
                      const pct = Math.max(0, Math.min(1, (e.clientX - drag.containerLeft) / drag.containerWidth));
                      const rawHour = Math.round(pct * 24);
                      const clampedHour = Math.max(0, Math.min(24, rawHour));
                      setTariff((p) => ({
                        ...p,
                        profiles: p.profiles.map((pr, pIdx) => {
                          if (pIdx !== pi) return pr;
                          const others = pr.segments.filter((s) => s.id !== drag.segId);
                          return {
                            ...pr,
                            segments: pr.segments.map((seg) => {
                              if (seg.id !== drag.segId) return seg;
                              if (drag.handle === 'start') {
                                // Clamp against adjacent segments to prevent overlap
                                const leftBound = others.filter(s => s.endHour <= seg.startHour || s.endHour <= clampedHour)
                                  .reduce((mx, s) => Math.max(mx, s.endHour), 0);
                                const newStart = Math.max(leftBound, Math.min(clampedHour, seg.endHour - 1));
                                return { ...seg, startHour: Math.max(0, newStart) };
                              } else {
                                const rightBound = others.filter(s => s.startHour >= seg.endHour || s.startHour >= clampedHour)
                                  .reduce((mn, s) => Math.min(mn, s.startHour), 24);
                                const newEnd = Math.min(rightBound, Math.max(clampedHour, seg.startHour + 1));
                                return { ...seg, endHour: Math.min(24, newEnd) };
                              }
                            }),
                          };
                        }),
                      }));
                    }}
                    onMouseUp={() => { touDragRef.current = null; }}
                    onMouseLeave={() => { touDragRef.current = null; }}
                  >
                    {/* Render segments */}
                    {profile.segments.map((seg) => {
                      const left = (seg.startHour / 24) * 100;
                      const width = ((seg.endHour - seg.startHour) / 24) * 100;
                      const style = SEGMENT_STYLE[seg.bucket] ?? { bg: 'bg-gray-300', label: 'text-white' };
                      const durationH = seg.endHour - seg.startHour;
                      const bucketRates = tariff.buckets.find((b) => b.id === seg.bucket);
                      return (
                        <div
                          key={seg.id}
                          className={`absolute top-0 h-full rounded-sm ${style.bg}`}
                          style={{ left: `${left}%`, width: `${width}%` }}
                          title={`${seg.bucket} | ${formatRange12(seg.startHour, seg.endHour)}`}
                        >
                          {/* Label — always white on solid bg */}
                          {durationH >= 2 && (
                            <span className={`absolute inset-0 flex flex-col items-center justify-center text-[10px] font-bold uppercase select-none pointer-events-none drop-shadow-sm ${style.label}`}>
                              <span>{seg.bucket}</span>
                              {durationH >= 3 && bucketRates && (
                                <span className="text-[9px] font-semibold normal-case opacity-95">${bucketRates.pricePerKwhUsd}/kWh · ${bucketRates.idleFeePerMinUsd}/min</span>
                              )}
                            </span>
                          )}
                          {/* Remove button */}
                          <button
                            type="button"
                            className="absolute -top-3 right-0.5 text-[11px] text-gray-400 hover:text-red-500 dark:text-slate-500 dark:hover:text-red-400 z-10 leading-none"
                            onClick={() => setTariff((p) => ({
                              ...p,
                              profiles: p.profiles.map((pr, pIdx) => pIdx !== pi ? pr : { ...pr, segments: pr.segments.filter((s) => s.id !== seg.id) }),
                            }))}
                            title="Remove tier"
                          >✕</button>
                          {/* Start handle */}
                          <div
                            className="absolute left-0 top-0 h-full w-2.5 cursor-ew-resize flex items-center justify-center group z-10"
                            onMouseDown={(e) => {
                              e.preventDefault();
                              const rect = (e.currentTarget.closest('[style]') as HTMLElement)?.parentElement?.getBoundingClientRect()
                                ?? (e.currentTarget.closest('.relative') as HTMLElement)?.getBoundingClientRect();
                              if (!rect) return;
                              touDragRef.current = { pi, segId: seg.id, handle: 'start', containerLeft: rect.left, containerWidth: rect.width };
                            }}
                          >
                            <div className="w-1 h-6 rounded-full bg-white/90 shadow group-hover:bg-white" />
                          </div>
                          {/* End handle */}
                          <div
                            className="absolute right-0 top-0 h-full w-2.5 cursor-ew-resize flex items-center justify-center group z-10"
                            onMouseDown={(e) => {
                              e.preventDefault();
                              const rect = (e.currentTarget.closest('[style]') as HTMLElement)?.parentElement?.getBoundingClientRect()
                                ?? (e.currentTarget.closest('.relative') as HTMLElement)?.getBoundingClientRect();
                              if (!rect) return;
                              touDragRef.current = { pi, segId: seg.id, handle: 'end', containerLeft: rect.left, containerWidth: rect.width };
                            }}
                          >
                            <div className="w-1 h-6 rounded-full bg-white/90 shadow group-hover:bg-white" />
                          </div>
                        </div>
                      );
                    })}
                    {/* Hour tick marks */}
                    {[0,3,6,9,12,15,18,21,24].map((h) => (
                      <div key={h} className="absolute top-0 h-full flex flex-col justify-end pointer-events-none" style={{ left: `${(h/24)*100}%` }}>
                        <span className="absolute -bottom-5 text-[9px] text-gray-400 dark:text-slate-500 -translate-x-1/2 select-none whitespace-nowrap">{formatHour12(h)}</span>
                        <div className="h-2 w-px bg-gray-300 dark:bg-slate-600" />
                      </div>
                    ))}
                  </div>

                  {/* Add price tier: always show all tiers unless every hour is already assigned */}
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-gray-400 dark:text-slate-500">Add price tier:</span>
                    {(() => {
                      const allHoursAssigned = Array.from({ length: 24 }, (_, h) => profile.segments.some((s) => h >= s.startHour && h < s.endHour)).every(Boolean);
                      if (allHoursAssigned) {
                        return <span className="text-xs text-gray-400 dark:text-slate-500 italic">All 24 hours assigned</span>;
                      }
                      return tariff.buckets.map((b) => (
                        <button
                          key={b.id}
                          type="button"
                          className={`rounded border px-2.5 py-1 text-xs font-medium transition-colors ${ADD_TIER_CLASSES[b.id]}`}
                          onClick={() => {
                            const existing = profile.segments.map((s) => ({ s: s.startHour, e: s.endHour, bucket: s.bucket })).sort((a, z) => a.s - z.s);
                            let start = 0; let end = 4;
                            for (let h = 0; h < 24; h++) {
                              if (!existing.some((w) => h >= w.s && h < w.e)) { start = h; end = Math.min(h + 4, 24); break; }
                            }

                            // If adjacent segment has same bucket, attach and normalize (merge)
                            const leftNeighbor = existing.find((w) => w.e === start && w.bucket === b.id);
                            const rightNeighbor = existing.find((w) => w.s === end && w.bucket === b.id);
                            if (leftNeighbor) start = leftNeighbor.s;
                            if (rightNeighbor) end = rightNeighbor.e;

                            setTariff((p) => ({
                              ...p,
                              profiles: p.profiles.map((pr, pIdx) => pIdx !== pi ? pr : {
                                ...pr,
                                segments: normalizeSegments([
                                  ...pr.segments.filter((s) => !(s.bucket === b.id && (s.endHour === start || s.startHour === end))),
                                  { id: crypto.randomUUID(), bucket: b.id, startHour: start, endHour: end },
                                ]),
                              }),
                            }));
                          }}
                        >
                          + {b.label}
                        </button>
                      ));
                    })()}
                  </div>
                </div>
              ))}
            </div>

            {/* Effective TOU schedule card removed per UX request; dynamic tier data stays in timeline bar labels. */}
          </div>
        )}

        {/* ── Collapsible effective pricing summary ────────────────── */}
        {(() => {
          const displayTariff = savedTariff ?? tariff;
          const summary = buildPricingSummary(displayTariff);
          return (
            <div className="mt-4 border-t border-gray-100 dark:border-slate-800 pt-4">
              <div className="flex items-center justify-end gap-2">
                <span className="text-xs font-semibold tracking-wide text-gray-500 dark:text-slate-400">Show effective pricing summary?</span>
                <button
                  type="button"
                  onClick={() => setPricingSummaryOpen((v) => !v)}
                  className="inline-flex items-center justify-center rounded-md border border-gray-200 dark:border-slate-700 p-1.5 hover:bg-gray-50 dark:hover:bg-slate-800"
                  aria-label="Toggle effective pricing summary"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className={`h-3.5 w-3.5 text-gray-400 dark:text-slate-500 transition-transform ${pricingSummaryOpen ? 'rotate-180' : ''}`}
                    fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {savedTariff && <span className="inline-flex items-center rounded-full bg-gray-100 dark:bg-slate-800 px-1.5 py-0.5 text-[10px] font-medium text-gray-500 dark:text-slate-400">saved</span>}
              </div>
              {pricingSummaryOpen && (
                <ul className="mt-2 space-y-1">
                  {summary.lines.map((line, i) => (
                    <li key={i} className="text-xs text-gray-700 dark:text-slate-300">{line}</li>
                  ))}
                </ul>
              )}
            </div>
          );
        })()}

        <div className="mt-3">
          <button
            type="button"
            disabled={!hasTariffEdits}
            className={`rounded-md px-3 py-1.5 text-xs font-medium text-white ${hasTariffEdits ? 'bg-brand-600 hover:bg-brand-700' : 'bg-gray-200 dark:bg-slate-300 cursor-not-allowed text-white'}`}
            onClick={async () => {
              try {
                const token = await getToken();
                const derivedWindows = tariff.mode === 'tou' ? profilesToWindows(tariff.profiles, tariff.buckets) : [];
                await createApiClient(token).updateSite(site.id, {
                  name: site.name,
                  address: site.address,
                  lat: site.lat,
                  lng: site.lng,
                  pricingMode: tariff.mode,
                  pricePerKwhUsd: tariff.pricePerKwhUsd,
                  idleFeePerMinUsd: tariff.idleFeePerMinUsd,
                  activationFeeUsd: tariff.activationFeeUsd,
                  gracePeriodMin: tariff.gracePeriodMin,
                  softwareVendorFeeMode: tariff.softwareVendorFeeMode,
                  softwareVendorFeeValue: tariff.softwareVendorFeeValue,
                  softwareFeeIncludesActivation: tariff.softwareFeeIncludesActivation,
                  touWindows: derivedWindows,
                });
                // Snapshot the saved tariff so saved state card + summary reflect what was saved
                setSavedTariff({ ...tariff, windows: derivedWindows });
                const modeLabel = tariff.mode === 'tou' ? `TOU (${tariff.profiles[0]?.segments.length ?? 0} segments)` : `flat $${tariff.pricePerKwhUsd.toFixed(2)}/kWh`;
                setTariffMsg(`Saved — ${modeLabel}`);
                pushAudit('tariff.updated', tariff.mode === 'tou'
                  ? `tou profiles=${tariff.profiles.length}, segments=${tariff.profiles[0]?.segments.length ?? 0} vendorFee=${tariff.softwareVendorFeeMode}:${tariff.softwareVendorFeeValue}`
                  : `flat price=$${tariff.pricePerKwhUsd}/kWh, idle=$${tariff.idleFeePerMinUsd}/min, activation=$${tariff.activationFeeUsd}, grace=${tariff.gracePeriodMin}m`);
              } catch (err) {
                setTariffMsg(`Save failed: ${err instanceof Error ? err.message : 'unknown error'}`);
              }
            }}>Save tariff</button>
        </div>
      </div>

      {/* ── Trend chart (dashboard style) ── */}
      <div className="rounded-xl border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
        <p className="text-sm font-semibold">
          <span className="text-blue-600">Energy (kWh)</span>
          <span className="text-gray-400 dark:text-slate-500"> | </span>
          <span className="text-emerald-600">Revenue ($)</span>
          <span className="text-gray-400 dark:text-slate-500"> | </span>
          <span className="text-amber-500">Transactions</span>
          <span className="ml-1 text-xs font-normal text-gray-400 dark:text-slate-500">({rangePreset})</span>
        </p>
        <div className="mt-3 h-64">
          {trend.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-gray-400 dark:text-slate-500">No trend data for selected period.</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={trend} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: chartColors.tick }} />
                <YAxis yAxisId="kwh" tick={{ fontSize: 10, fill: chartColors.tick }} />
                <YAxis yAxisId="rev" orientation="right" tick={{ fontSize: 10, fill: chartColors.tick }} tickFormatter={(v: number) => `$${v}`} />
                <Tooltip contentStyle={chartColors.tooltip} formatter={(v: number, name: string) => name === 'revenueUsd' ? [`$${v.toFixed(2)}`, 'Revenue ($)'] : name === 'kwhDelivered' ? [`${v} kWh`, 'Energy (kWh)'] : [v, 'Transactions']} />
                <Bar yAxisId="kwh" dataKey="kwhDelivered" fill="#3b82f6" opacity={0.7} name="Energy (kWh)" />
                <Line yAxisId="rev" type="monotone" dataKey="revenueUsd" stroke="#10b981" dot={false} strokeWidth={2} name="Revenue ($)" />
                <Line yAxisId="kwh" type="monotone" dataKey="sessions" stroke="#f59e0b" dot={false} strokeWidth={1.5} name="Transactions" />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* ── Uptime summary ── */}
      {siteUptime && (
        <div className="grid gap-3 sm:grid-cols-4">
          <div className="rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-3 text-center"><p className="text-xs text-gray-500 dark:text-slate-400">Uptime 24h</p><p className="mt-1 text-lg font-semibold text-gray-900 dark:text-slate-100">{siteUptime.uptimePercent24h.toFixed(1)}%</p></div>
          <div className="rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-3 text-center"><p className="text-xs text-gray-500 dark:text-slate-400">Uptime 7d</p><p className="mt-1 text-lg font-semibold text-gray-900 dark:text-slate-100">{siteUptime.uptimePercent7d.toFixed(1)}%</p></div>
          <div className="rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-3 text-center"><p className="text-xs text-gray-500 dark:text-slate-400">Uptime 30d</p><p className="mt-1 text-lg font-semibold text-gray-900 dark:text-slate-100">{siteUptime.uptimePercent30d.toFixed(1)}%</p></div>
          <div className="rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-3 text-center"><p className="text-xs text-gray-500 dark:text-slate-400">Total chargers</p><p className="mt-1 text-lg font-semibold text-gray-900 dark:text-slate-100">{site.chargers.length}</p></div>
        </div>
      )}

      {/* ── Session Safety Limits ── */}
      <div className="rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-300">Session Safety Limits</h2>
        <p className="mt-1 text-xs text-gray-500 dark:text-slate-400">Auto-stop sessions when limits are reached. Leave blank for no limit.</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <label className="text-sm text-gray-700 dark:text-slate-300">
            Max charge duration
            <div className="relative mt-1">
              <input
                type="number"
                min="1"
                step="1"
                placeholder="No limit"
                className="w-full rounded-md border border-gray-300 dark:border-slate-600 px-3 py-1.5 pr-14 text-sm"
                value={safetyLimits.maxChargeDurationMin}
                onChange={(e) => setSafetyLimits({ ...safetyLimits, maxChargeDurationMin: e.target.value })}
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">min</span>
            </div>
          </label>
          <label className="text-sm text-gray-700 dark:text-slate-300">
            Max idle duration
            <div className="relative mt-1">
              <input
                type="number"
                min="1"
                step="1"
                placeholder="No limit"
                className="w-full rounded-md border border-gray-300 dark:border-slate-600 px-3 py-1.5 pr-14 text-sm"
                value={safetyLimits.maxIdleDurationMin}
                onChange={(e) => setSafetyLimits({ ...safetyLimits, maxIdleDurationMin: e.target.value })}
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">min</span>
            </div>
          </label>
          <label className="text-sm text-gray-700 dark:text-slate-300">
            Max session cost
            <div className="relative mt-1">
              <input
                type="number"
                min="0.01"
                step="0.01"
                placeholder="No limit"
                className="w-full rounded-md border border-gray-300 dark:border-slate-600 px-3 py-1.5 pl-7 text-sm"
                value={safetyLimits.maxSessionCostUsd}
                onChange={(e) => setSafetyLimits({ ...safetyLimits, maxSessionCostUsd: e.target.value })}
              />
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">$</span>
            </div>
          </label>
        </div>
        {(safetyLimits.maxChargeDurationMin !== (savedSafetyLimits?.maxChargeDurationMin ?? '') ||
          safetyLimits.maxIdleDurationMin !== (savedSafetyLimits?.maxIdleDurationMin ?? '') ||
          safetyLimits.maxSessionCostUsd !== (savedSafetyLimits?.maxSessionCostUsd ?? '')) && (
          <div className="mt-4 flex items-center gap-3">
            <button
              className="rounded-md bg-brand-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
              onClick={async () => {
                setSafetyMsg('');
                try {
                  const token = await getToken();
                  const client = createApiClient(token);
                  await client.updateSite(site.id, {
                    name: site.name,
                    address: site.address,
                    lat: site.lat,
                    lng: site.lng,
                    maxChargeDurationMin: safetyLimits.maxChargeDurationMin ? parseInt(safetyLimits.maxChargeDurationMin, 10) : null,
                    maxIdleDurationMin: safetyLimits.maxIdleDurationMin ? parseInt(safetyLimits.maxIdleDurationMin, 10) : null,
                    maxSessionCostUsd: safetyLimits.maxSessionCostUsd ? parseFloat(safetyLimits.maxSessionCostUsd) : null,
                  });
                  setSavedSafetyLimits({ ...safetyLimits });
                  setSafetyMsg('✅ Safety limits saved');
                } catch (err: any) {
                  setSafetyMsg(`❌ ${err.message ?? 'Failed to save'}`);
                }
              }}
            >
              Save limits
            </button>
            <button
              className="rounded-md border border-gray-300 dark:border-slate-600 px-4 py-1.5 text-sm text-gray-600 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800"
              onClick={() => {
                if (savedSafetyLimits) setSafetyLimits({ ...savedSafetyLimits });
                setSafetyMsg('');
              }}
            >
              Reset
            </button>
            {safetyMsg && <span className="text-xs">{safetyMsg}</span>}
          </div>
        )}
        {safetyMsg && !(safetyLimits.maxChargeDurationMin !== (savedSafetyLimits?.maxChargeDurationMin ?? '') ||
          safetyLimits.maxIdleDurationMin !== (savedSafetyLimits?.maxIdleDurationMin ?? '') ||
          safetyLimits.maxSessionCostUsd !== (savedSafetyLimits?.maxSessionCostUsd ?? '')) && (
          <p className="mt-3 text-xs">{safetyMsg}</p>
        )}
      </div>

      {/* ── Map ── */}
      <ChargerMap lat={site.lat} lng={site.lng} siteName={site.name} chargers={site.chargers} />

      {/* ── Charger list ── */}
      <div>
        <h2 className="mb-3 text-lg font-semibold text-gray-900 dark:text-slate-100">Chargers ({site.chargers.length})</h2>
        {site.chargers.length === 0 ? (
          <div className="rounded-lg border-2 border-dashed border-gray-300 dark:border-slate-700 p-10 text-center text-gray-400 dark:text-slate-500">
            <p className="text-3xl">🔌</p>
            <p className="mt-2 font-medium">No chargers registered</p>
            <button onClick={() => setShowAddCharger(true)} className="mt-3 text-sm text-brand-600 hover:underline">Register your first charger →</button>
          </div>
        ) : site.chargers.length > 4 ? (
          <div className="overflow-hidden rounded-xl border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900">
            <div className="hidden grid-cols-[1.6fr_1fr_1.8fr_0.8fr] gap-3 border-b border-gray-300 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/60 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-slate-400 md:grid">
              <span>Charger</span>
              <span className="inline-flex items-center gap-1">
                Status
                <span className="group relative inline-flex">
                  <span
                    className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-gray-300 dark:border-slate-600 text-[10px] font-bold text-gray-500 dark:text-slate-400"
                    aria-label="Status definition: online means fresh heartbeat signals are being received"
                  >
                    ?
                  </span>
                  <span className="pointer-events-none absolute left-1/2 top-full z-20 mt-1 hidden w-64 -translate-x-1/2 rounded-md bg-gray-900 px-2 py-1.5 text-[11px] normal-case font-medium leading-snug text-white shadow-lg group-hover:block group-focus-within:block">
                    Online means the charger is actively sending fresh heartbeat signals to the server. If heartbeats stop for about 17+ minutes, it is marked offline.
                  </span>
                </span>
              </span>
              <span>Connectors</span>
              <span className="text-right">Action</span>
            </div>
            <div className="divide-y divide-gray-100 dark:divide-slate-800">
              {site.chargers.map((charger) => <ChargerListRow key={charger.id} charger={charger} uptime={chargerUptime[charger.id]} />)}
            </div>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {site.chargers.map((charger) => <ChargerCard key={charger.id} charger={charger} uptime={chargerUptime[charger.id]} />)}
          </div>
        )}
      </div>

      {/* ── Audit trail ── */}
      <div className="rounded-xl border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
        <h2 className="mb-3 text-sm font-semibold text-gray-700 dark:text-slate-300">Audit trail</h2>
        <div className="space-y-2">
          {auditEvents.length === 0 && <p className="text-xs text-gray-500 dark:text-slate-400">No audit events yet.</p>}
          {auditEvents.slice(0, 20).map((e) => (
            <div key={e.id} className="rounded-md border border-gray-300 dark:border-slate-700 p-2">
              <p className="text-xs text-gray-500 dark:text-slate-400">{new Date(e.createdAt).toLocaleString()} · {e.actor}</p>
              <p className="text-xs font-medium text-gray-800 dark:text-slate-200">{e.action}</p>
              <p className="text-xs text-gray-600 dark:text-slate-400">{e.detail}</p>
            </div>
          ))}
        </div>
      </div>

      {showAddCharger && (
        <AddChargerDialog
          siteId={site.id}
          onAdd={async (body) => {
            const token = await getToken();
            const result = await createApiClient(token).createCharger(body);
            await load();
            return result;
          }}
          onClose={() => setShowAddCharger(false)}
        />
      )}
    </div>
  );
}

function SiteKpiTile({ label, value, live }: { label: string; value: string; live?: boolean }) {
  return (
    <div className="rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
      <div className="flex items-center gap-1.5">
        <p className="truncate text-[11px] font-medium uppercase tracking-wide text-gray-500 dark:text-slate-400">{label}</p>
        {live && <span className="inline-block h-1.5 w-1.5 rounded-full bg-green-500" title="Live" />}
      </div>
      <p className="mt-1 truncate text-[clamp(1.05rem,1.8vw,1.6rem)] font-semibold leading-tight text-gray-900 dark:text-slate-100">{value}</p>
    </div>
  );
}

function ChargerListRow({ charger, uptime }: { charger: SiteDetailType['chargers'][number]; uptime?: ChargerUptime }) {
  return (
    <div className="grid gap-3 px-4 py-3 md:grid-cols-[1.6fr_1fr_1.8fr_0.8fr] md:items-center">
      <div>
        <Link to={`/chargers/${shortId(charger.id)}`} className="font-mono text-sm font-semibold text-gray-900 dark:text-slate-100 hover:text-brand-700 hover:underline">
          {charger.ocppId}
        </Link>
        <p className="text-xs text-gray-500 dark:text-slate-400">{charger.vendor} {charger.model} · S/N {charger.serialNumber}</p>
        {charger.lastHeartbeat && (
          <p className="text-xs text-gray-400 dark:text-slate-500">Heartbeat: {formatDate(charger.lastHeartbeat)}</p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadge status={charger.status} type="charger" />
        {uptime && (
          <span className={uptime.uptimePercent7d >= 99 ? 'text-xs font-semibold text-green-700' : uptime.uptimePercent7d >= 95 ? 'text-xs font-semibold text-amber-700' : 'text-xs font-semibold text-red-700'}>
            {uptime.uptimePercent7d.toFixed(2)}% 7d
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {charger.connectors.map((c) => (
          <div key={c.id} className="flex items-center gap-1 rounded-md border border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/60 px-2 py-0.5">
            <span className="text-xs text-gray-500 dark:text-slate-400">#{c.connectorId}</span>
            <StatusBadge status={c.status} type="connector" />
          </div>
        ))}
      </div>

      <div className="md:text-right">
        <Link to={`/chargers/${shortId(charger.id)}`} className="inline-block rounded-md border border-gray-300 dark:border-slate-700 px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-slate-400 bg-white dark:bg-slate-800/60 hover:bg-gray-50 dark:hover:bg-slate-700">View Detail →</Link>
      </div>
    </div>
  );
}

function ChargerCard({ charger, uptime }: { charger: SiteDetailType['chargers'][number]; uptime?: ChargerUptime }) {
  return (
    <div className="rounded-xl border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 shadow-sm">
      <div className="flex items-start justify-between">
        <div>
          <Link to={`/chargers/${shortId(charger.id)}`} className="font-semibold text-gray-900 dark:text-slate-100 font-mono hover:text-brand-700 hover:underline">
            {charger.ocppId}
          </Link>
          <p className="text-xs text-gray-500 dark:text-slate-400">{charger.vendor} {charger.model}</p>
        </div>
        <StatusBadge status={charger.status} type="charger" />
      </div>

      <p className="mt-1 text-xs text-gray-400 dark:text-slate-500">S/N: {charger.serialNumber}</p>

      {charger.lastHeartbeat && (
        <p className="mt-1 text-xs text-gray-400 dark:text-slate-500">Last heartbeat: {formatDate(charger.lastHeartbeat)}</p>
      )}

      <div className="mt-3 flex flex-wrap gap-1.5">
        {charger.connectors.map((c) => (
          <div key={c.id} className="flex items-center gap-1 rounded-md border border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/60 px-2 py-0.5">
            <span className="text-xs text-gray-500 dark:text-slate-400">#{c.connectorId}</span>
            <StatusBadge status={c.status} type="connector" />
          </div>
        ))}
      </div>

      {uptime && (
        <div className="mt-3 rounded-md border border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/60 px-2 py-1.5 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-gray-500 dark:text-slate-400">Uptime 7d</span>
            <span className={uptime.uptimePercent7d >= 99 ? 'text-green-700 font-semibold' : uptime.uptimePercent7d >= 95 ? 'text-amber-700 font-semibold' : 'text-red-700 font-semibold'}>{uptime.uptimePercent7d.toFixed(2)}%</span>
          </div>
        </div>
      )}

      <Link to={`/chargers/${shortId(charger.id)}`} className="mt-3 block rounded-md border border-gray-300 dark:border-slate-700 px-3 py-1.5 text-center text-xs font-medium text-gray-600 dark:text-slate-400 bg-white dark:bg-slate-800/60 hover:bg-gray-50 dark:hover:bg-slate-700">View Detail →</Link>
    </div>
  );
}
