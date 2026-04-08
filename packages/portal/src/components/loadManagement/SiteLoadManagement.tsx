/**
 * SiteLoadManagement — full load management controls scoped to a single site.
 * Moved from the main LoadManagement page to live as a subtab in SiteDetail.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  createApiClient,
  type ChargerListItem,
  type MergedScheduleSlot,
  type SmartChargingGroup,
  type SmartChargingProfile,
  type SmartChargingState,
  type StackedProfileInfo,
} from '../../api/client';
import { useToken } from '../../auth/TokenContext';
import StatusBadge from '../StatusBadge';

type Scope = 'CHARGER' | 'GROUP' | 'SITE';
const DEFAULT_PRIORITY = 10;

/* ─── UTC / local helpers ───────────────────────────────────────────────── */

function utcHourToLocal(utcHour: number): number {
  const d = new Date();
  d.setUTCHours(utcHour, 0, 0, 0);
  return d.getHours();
}

function formatLocalHour(utcHour: number): string {
  const local = utcHourToLocal(utcHour);
  const suffix = local >= 12 ? 'PM' : 'AM';
  const h12 = local === 0 ? 12 : local > 12 ? local - 12 : local;
  return `${h12}${suffix}`;
}

/* ─── Schedule Timeline Bar ─────────────────────────────────────────────── */

function ScheduleTimeline({ slots, maxKw }: { slots: MergedScheduleSlot[]; maxKw: number }) {
  if (slots.length === 0) return null;
  const ceil = Math.max(maxKw, ...slots.map((s) => s.effectiveLimitKw));
  const localSlots = slots
    .map((s) => ({ ...s, localHour: utcHourToLocal(s.hour) }))
    .sort((a, b) => a.localHour - b.localHour);
  return (
    <div className="flex items-end gap-px h-10 w-full">
      {localSlots.map((s) => {
        const pct = ceil > 0 ? (s.effectiveLimitKw / ceil) * 100 : 0;
        return (
          <div
            key={s.hour}
            className="flex-1 rounded-t bg-brand-500 dark:bg-brand-400 relative group"
            style={{ height: `${pct}%`, minHeight: '2px' }}
            title={`${formatLocalHour(s.hour)} — ${s.effectiveLimitKw} kW`}
          >
            <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 hidden group-hover:block bg-gray-900 dark:bg-slate-100 text-white dark:text-slate-900 text-[10px] rounded px-1.5 py-0.5 whitespace-nowrap z-10">
              {formatLocalHour(s.hour)} — {s.effectiveLimitKw} kW
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ─── Profile status label ──────────────────────────────────────────────── */

function profileStatusLabel(state: SmartChargingState | undefined): { label: string; color: string } {
  if (!state) return { label: '⏳ Not pushed yet', color: 'text-gray-400 dark:text-slate-500' };
  switch (state.status) {
    case 'APPLIED':
    case 'FALLBACK_APPLIED':
      return {
        label: state.lastAppliedAt ? `✅ Applied ${new Date(state.lastAppliedAt).toLocaleString()}` : '✅ Applied',
        color: 'text-green-600 dark:text-green-400',
      };
    case 'PENDING_OFFLINE':
      return { label: '⏳ Pending — charger offline', color: 'text-amber-600 dark:text-amber-400' };
    case 'ERROR':
      return {
        label: `❌ Failed${state.lastError ? `: ${state.lastError}` : ''}`,
        color: 'text-red-600 dark:text-red-400',
      };
    default:
      return { label: state.status ?? '—', color: 'text-gray-500 dark:text-slate-400' };
  }
}

/* ─── Scope pill ────────────────────────────────────────────────────────── */

const SCOPE_LABELS: Record<Scope, string> = { CHARGER: 'Charger', GROUP: 'Group', SITE: 'Site' };

function ScopePill({ scope }: { scope: Scope }) {
  const colors: Record<Scope, string> = {
    CHARGER: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-700',
    GROUP: 'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-900/30 dark:text-purple-300 dark:border-purple-700',
    SITE: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700',
  };
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${colors[scope]}`}>
      {SCOPE_LABELS[scope]}
    </span>
  );
}

/* ─── Active Limits (charger-grouped, expandable) ───────────────────────── */

function ActiveLimitsSection({
  profiles, profileById, states, chargers, groups, onPush, token,
  utcTimeToLocal, to12h,
}: {
  profiles: SmartChargingProfile[];
  profileById: Record<string, SmartChargingProfile>;
  states: SmartChargingState[];
  chargers: ChargerListItem[];
  groups: SmartChargingGroup[];
  onPush: (chargerId: string) => void;
  token: string | null;
  utcTimeToLocal: (t: string) => { time: string; dayShift: number };
  to12h: (t: string) => string;
}) {
  const [expandedCharger, setExpandedCharger] = useState<string | null>(null);
  const [previewData, setPreviewData] = useState<Record<string, { stacked: StackedProfileInfo[]; merged: MergedScheduleSlot[] }>>({});

  const chargerProfileMap = new Map<string, { charger: ChargerListItem; profileEntries: Array<{ profile: SmartChargingProfile; scope: Scope; state: SmartChargingState | undefined }> }>();

  for (const p of profiles.filter((p) => p.enabled)) {
    let targetChargerIds: string[] = [];
    const scope: Scope = p.scope as Scope;

    if (p.scope === 'CHARGER' && p.chargerId) {
      targetChargerIds = [p.chargerId];
    } else if (p.scope === 'GROUP' && p.chargerGroupId) {
      const g = groups.find((x) => x.id === p.chargerGroupId);
      targetChargerIds = (g?.chargers ?? []).map((c) => c.id);
    } else if (p.scope === 'SITE' && p.siteId) {
      targetChargerIds = chargers.filter((c) => c.siteId === p.siteId).map((c) => c.id);
    }

    for (const cId of targetChargerIds) {
      if (!chargerProfileMap.has(cId)) {
        const c = chargers.find((x) => x.id === cId);
        if (!c) continue;
        chargerProfileMap.set(cId, { charger: c, profileEntries: [] });
      }
      const state = states.find((s) => s.chargerId === cId && s.sourceProfileId === p.id);
      chargerProfileMap.get(cId)!.profileEntries.push({ profile: p, scope, state });
    }
  }

  const chargerRows = Array.from(chargerProfileMap.values());
  if (chargerRows.length === 0) return null;

  const fetchPreview = useCallback(async (chargerId: string) => {
    if (!token || previewData[chargerId]) return;
    try {
      const api = createApiClient(token);
      const data = await api.getStackingPreview(chargerId);
      if (data.stackedProfiles && data.mergedSchedule) {
        setPreviewData((prev) => ({ ...prev, [chargerId]: { stacked: data.stackedProfiles!, merged: data.mergedSchedule! } }));
      }
    } catch { /* best effort */ }
  }, [token, previewData]);

  useEffect(() => {
    if (!token) return;
    for (const { charger: c } of chargerRows) {
      if (!previewData[c.id]) fetchPreview(c.id);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, chargerRows.length]);

  return (
    <div className="rounded-xl border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-sm">
      <div className="border-b border-gray-300 dark:border-slate-700 px-5 py-4">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-300">Active Limits</h2>
        <p className="mt-0.5 text-xs text-gray-500 dark:text-slate-400">Per-charger view of all stacked load profiles and their OCPP push status.</p>
      </div>
      <div className="divide-y divide-gray-100 dark:divide-slate-800">
        {chargerRows.map(({ charger: c, profileEntries }) => {
          const isExpanded = expandedCharger === c.id;
          const appliedCount = profileEntries.filter((e) => e.state?.status === 'APPLIED' || e.state?.status === 'FALLBACK_APPLIED').length;
          const preview = previewData[c.id];

          let effectiveNow: number | null = null;
          if (preview?.merged && preview.merged.length > 0) {
            const nowUtcHour = new Date().getUTCHours();
            const slot = preview.merged.find((s) => s.hour === nowUtcHour);
            if (slot) effectiveNow = slot.effectiveLimitKw;
          }
          if (effectiveNow == null) {
            for (const e of profileEntries) {
              const def = e.profile.defaultLimitKw;
              if (def != null && (effectiveNow == null || def < effectiveNow)) effectiveNow = def;
              const sched = Array.isArray(e.profile.schedule) ? e.profile.schedule : [];
              for (const w of sched) {
                const wLim = (w as any).limitKw;
                if (wLim != null && (effectiveNow == null || wLim < effectiveNow)) effectiveNow = wLim;
              }
            }
          }

          return (
            <div key={c.id}>
              <button
                type="button"
                className="w-full flex items-center justify-between px-5 py-3 hover:bg-gray-50 dark:hover:bg-slate-800 text-left"
                onClick={() => {
                  const next = isExpanded ? null : c.id;
                  setExpandedCharger(next);
                  if (next) fetchPreview(next);
                }}
              >
                <div className="flex items-center gap-3">
                  <span className={`h-2 w-2 rounded-full ${c.status === 'ONLINE' ? 'bg-green-500' : 'bg-gray-300 dark:bg-slate-600'}`} />
                  <div>
                    <p className="text-sm font-semibold text-gray-900 dark:text-slate-100">{c.ocppId}</p>
                    <p className="text-xs text-gray-500 dark:text-slate-400">
                      {profileEntries.length} profile{profileEntries.length !== 1 ? 's' : ''} · {appliedCount} applied
                      {effectiveNow != null ? ` · Effective now: ${effectiveNow} kW` : ''}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={(e) => { e.stopPropagation(); onPush(c.id); }}
                    className="rounded-md border border-brand-200 dark:border-brand-700 px-2 py-1 text-xs font-medium text-brand-700 dark:text-brand-300 hover:bg-brand-50 dark:hover:bg-brand-900/20"
                  >
                    Re-push all
                  </button>
                  <span className="text-xs text-gray-400">{isExpanded ? '▲' : '▼'}</span>
                </div>
              </button>

              {isExpanded && (
                <div className="bg-white dark:bg-slate-800/40 px-5 pb-4 border-t border-gray-100 dark:border-slate-700">
                  <table className="w-full text-sm mt-1">
                    <thead>
                      <tr className="text-left text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-slate-500">
                        <th className="py-2 pr-3">Profile</th>
                        <th className="py-2 pr-3">Scope</th>
                        <th className="py-2 pr-3">Stack Level</th>
                        <th className="py-2 pr-3">Schedule</th>
                        <th className="py-2">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-slate-700">
                      {profileEntries.map((e) => {
                        const schedule = Array.isArray(e.profile.schedule) ? e.profile.schedule : [];
                        const windowSummary = schedule.map((w: any) => {
                          const days = (w.daysOfWeek ?? []).length === 7 ? 'Daily' : `${(w.daysOfWeek ?? []).length} days/wk`;
                          const localStart = w.startTime ? utcTimeToLocal(w.startTime).time : w.startTime;
                          const localEnd = w.endTime ? utcTimeToLocal(w.endTime).time : w.endTime;
                          return `${to12h(localStart)}–${to12h(localEnd)} ${days} @ ${w.limitKw} kW`;
                        }).join('; ') || (e.profile.defaultLimitKw != null ? `${e.profile.defaultLimitKw} kW always` : '—');
                        const { label, color } = profileStatusLabel(e.state);
                        const stackLevel = e.state?.ocppStackLevel ?? (e.scope === 'CHARGER' ? 50 : e.scope === 'GROUP' ? 30 : 10) + e.profile.priority;

                        return (
                          <tr key={e.profile.id}>
                            <td className="py-2 pr-3">
                              <p className="text-xs font-medium text-gray-700 dark:text-slate-300">{e.profile.name}</p>
                              <p className="text-[11px] text-gray-400 dark:text-slate-500">Priority: {e.profile.priority}</p>
                            </td>
                            <td className="py-2 pr-3"><ScopePill scope={e.scope} /></td>
                            <td className="py-2 pr-3 text-xs text-gray-600 dark:text-slate-300 font-mono">{stackLevel}</td>
                            <td className="py-2 pr-3 text-xs text-gray-600 dark:text-slate-300">{windowSummary}</td>
                            <td className="py-2"><p className={`text-xs font-medium ${color}`}>{label}</p></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>

                  {preview?.merged && preview.merged.length > 0 && (
                    <div className="mt-3">
                      <p className="text-xs font-medium text-gray-600 dark:text-slate-400 mb-1">Effective schedule (24h) — charger enforces lowest limit</p>
                      <ScheduleTimeline slots={preview.merged} maxKw={preview.merged.reduce((m, s) => Math.max(m, s.effectiveLimitKw), 0)} />
                      <div className="flex justify-between text-[10px] text-gray-400 dark:text-slate-500 mt-0.5">
                        <span>12 AM</span><span>6 AM</span><span>12 PM</span><span>6 PM</span><span>12 AM</span>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─── Main Component ────────────────────────────────────────────────────── */

export default function SiteLoadManagement({ siteId }: { siteId: string }) {
  const getToken = useToken();
  const [currentToken, setCurrentToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [chargers, setChargers] = useState<ChargerListItem[]>([]);
  const [groups, setGroups] = useState<SmartChargingGroup[]>([]);
  const [profiles, setProfiles] = useState<SmartChargingProfile[]>([]);
  const [states, setStates] = useState<SmartChargingState[]>([]);

  // Create profile form
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({
    name: '',
    scope: 'SITE' as Scope,
    chargerGroupId: '',
    chargerId: '',
    defaultLimitKw: '50',
    enabled: true,
    useTimeWindow: false,
    windowDays: [1] as number[],
    windowStart: '10:00',
    windowEnd: '12:00',
    validFrom: new Date().toISOString().slice(0, 10),
    validTo: '',
    windowLimitKw: '6',
  });
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');

  // Edit profile modal
  type ProfileForm = typeof form;
  const [editingProfile, setEditingProfile] = useState<SmartChargingProfile | null>(null);
  const [editForm, setEditForm] = useState<ProfileForm | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editMsg, setEditMsg] = useState('');

  // Group state
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [groupForm, setGroupForm] = useState({ name: '' });
  const [groupMsg, setGroupMsg] = useState('');
  const [groupAssignSelection, setGroupAssignSelection] = useState<Record<string, string>>({});
  const [showDetailedMatrix, setShowDetailedMatrix] = useState(false);
  const [editingGroup, setEditingGroup] = useState<SmartChargingGroup | null>(null);

  /* ─── Helpers ──────────────────────────────────────────────────────────── */

  function to12h(time24: string): string {
    const [hStr, mStr] = time24.split(':');
    let h = parseInt(hStr, 10);
    const ampm = h >= 12 ? 'PM' : 'AM';
    if (h === 0) h = 12;
    else if (h > 12) h -= 12;
    return `${h}:${mStr} ${ampm}`;
  }

  function localTimeToUtc(timeHHMM: string): { time: string; dayShift: -1 | 0 | 1 } {
    const [h, m] = timeHHMM.split(':').map((x) => Number(x));
    const local = new Date();
    local.setHours(h, m, 0, 0);
    const uh = local.getUTCHours();
    const um = local.getUTCMinutes();
    const localDay = local.getDay();
    const utcDay = local.getUTCDay();
    const dayShift: -1 | 0 | 1 = utcDay === localDay ? 0 : (utcDay > localDay || (localDay === 6 && utcDay === 0) ? 1 : -1);
    return { time: `${String(uh).padStart(2, '0')}:${String(um).padStart(2, '0')}`, dayShift };
  }

  function utcTimeToLocal(timeHHMM: string): { time: string; dayShift: -1 | 0 | 1 } {
    const [h, m] = timeHHMM.split(':').map((x) => Number(x));
    const utc = new Date();
    utc.setUTCHours(h, m, 0, 0);
    const lh = utc.getHours();
    const lm = utc.getMinutes();
    const utcDay = utc.getUTCDay();
    const localDay = utc.getDay();
    const dayShift: -1 | 0 | 1 = localDay === utcDay ? 0 : (localDay > utcDay || (utcDay === 6 && localDay === 0) ? 1 : -1);
    return { time: `${String(lh).padStart(2, '0')}:${String(lm).padStart(2, '0')}`, dayShift };
  }

  function toUtcSchedule(days: number[], startLocal: string, endLocal: string, limitKw: number) {
    const start = localTimeToUtc(startLocal);
    const end = localTimeToUtc(endLocal);
    const shiftedDays = days.map((d) => (d + start.dayShift + 7) % 7);
    return [{ id: 'win-1', daysOfWeek: shiftedDays, startTime: start.time, endTime: end.time, limitKw }];
  }

  function fromUtcSchedule(firstWindow: { daysOfWeek?: number[]; startTime?: string; endTime?: string; limitKw?: number } | null) {
    if (!firstWindow) return { days: [1], start: '10:00', end: '12:00' };
    const localStart = firstWindow.startTime ? utcTimeToLocal(firstWindow.startTime) : { time: '10:00', dayShift: 0 as const };
    const localEnd = firstWindow.endTime ? utcTimeToLocal(firstWindow.endTime) : { time: '12:00', dayShift: 0 as const };
    const days = (firstWindow.daysOfWeek ?? [1]).map((d) => (d - localStart.dayShift + 7) % 7);
    return { days, start: localStart.time, end: localEnd.time };
  }

  function formatSchedule(schedule: unknown): string {
    if (!Array.isArray(schedule) || schedule.length === 0) return 'No time windows';
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return schedule
      .map((w) => {
        const win = w as { daysOfWeek?: number[]; startTime?: string; endTime?: string; limitKw?: number };
        const localStart = win.startTime ? utcTimeToLocal(win.startTime).time : '--:--';
        const localEnd = win.endTime ? utcTimeToLocal(win.endTime).time : '--:--';
        const startDayShift = win.startTime ? utcTimeToLocal(win.startTime).dayShift : 0;
        const rawDays = Array.isArray(win.daysOfWeek) ? win.daysOfWeek : [];
        const localDays = rawDays.length > 0 ? rawDays.map((d) => (d - startDayShift + 7) % 7) : [];
        const days = localDays.length > 0 ? localDays.map((d) => dayNames[d] ?? `D${d}`).join(',') : 'All days';
        return `${days} ${to12h(localStart)}-${to12h(localEnd)} @ ${win.limitKw ?? '?'}kW`;
      })
      .join(' · ');
  }

  function profileTargetText(profile: SmartChargingProfile | undefined, chargerOcppId?: string): string {
    if (!profile) return 'Unknown target';
    if (profile.scope === 'CHARGER') {
      if (profile.chargerId) {
        const c = chargers.find((x) => x.id === profile.chargerId);
        return `Charger: ${c?.ocppId ?? profile.chargerId}${chargerOcppId && c?.ocppId === chargerOcppId ? ' (this charger)' : ''}`;
      }
      return 'Charger-scoped';
    }
    if (profile.scope === 'GROUP') {
      const g = profile.chargerGroupId ? groups.find((x) => x.id === profile.chargerGroupId) : null;
      return `Group: ${g?.name ?? profile.chargerGroupId ?? 'Unknown group'}`;
    }
    return 'Site-scoped';
  }

  /* ─── Data Loading ─────────────────────────────────────────────────────── */

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const token = await getToken();
      setCurrentToken(token);
      const api = createApiClient(token);
      const [chargerRows, groupRows, profileRows, stateRows] = await Promise.all([
        api.getChargers().catch(() => [] as ChargerListItem[]),
        api.listSmartChargingGroups(),
        api.listSmartChargingProfiles(),
        api.listSmartChargingStates(),
      ]);
      // Filter to this site
      const siteChargers = chargerRows.filter((c) => c.siteId === siteId);
      const siteChargerIds = new Set(siteChargers.map((c) => c.id));
      const siteGroups = groupRows.filter((g) => g.siteId === siteId);
      const siteGroupIds = new Set(siteGroups.map((g) => g.id));
      const siteProfiles = profileRows.filter((p) =>
        (p.scope === 'SITE' && p.siteId === siteId) ||
        (p.scope === 'GROUP' && p.chargerGroupId && siteGroupIds.has(p.chargerGroupId)) ||
        (p.scope === 'CHARGER' && p.chargerId && siteChargerIds.has(p.chargerId))
      );
      const siteStates = stateRows.filter((s) => siteChargerIds.has(s.chargerId));

      setChargers(siteChargers);
      setGroups(siteGroups);
      setProfiles(siteProfiles);
      setStates(siteStates);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [getToken, siteId]);

  useEffect(() => { load(); }, [load]);

  /* ─── Handlers ─────────────────────────────────────────────────────────── */

  function openEdit(p: SmartChargingProfile) {
    const firstWindow = Array.isArray(p.schedule) && p.schedule.length > 0
      ? (p.schedule[0] as { startTime?: string; endTime?: string; daysOfWeek?: number[]; limitKw?: number })
      : null;
    const localWindow = fromUtcSchedule(firstWindow);
    setEditForm({
      name: p.name,
      scope: p.scope as Scope,
      chargerGroupId: p.chargerGroupId ?? '',
      chargerId: p.chargerId ?? '',
      defaultLimitKw: p.defaultLimitKw != null ? String(p.defaultLimitKw) : '50',
      enabled: p.enabled,
      useTimeWindow: firstWindow != null,
      windowDays: localWindow.days,
      windowStart: localWindow.start,
      windowEnd: localWindow.end,
      validFrom: p.validFrom ? new Date(p.validFrom).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
      validTo: p.validTo ? new Date(p.validTo).toISOString().slice(0, 10) : '',
      windowLimitKw: firstWindow?.limitKw != null ? String(firstWindow.limitKw) : '6',
    });
    setEditingProfile(p);
    setEditMsg('');
  }

  async function handleSaveEdit() {
    if (!editingProfile || !editForm) return;
    setEditSaving(true);
    setEditMsg('');
    try {
      const token = await getToken();
      const api = createApiClient(token);

      const targetChanged =
        editForm.scope !== editingProfile.scope ||
        editForm.chargerId !== (editingProfile.chargerId ?? '') ||
        editForm.chargerGroupId !== (editingProfile.chargerGroupId ?? '');

      const schedule = editForm.useTimeWindow && editForm.windowDays.length > 0
        ? toUtcSchedule(editForm.windowDays, editForm.windowStart, editForm.windowEnd, Number(editForm.windowLimitKw || editForm.defaultLimitKw))
        : null;

      if (targetChanged) {
        await api.deleteSmartChargingProfile(editingProfile.id);
        await api.createSmartChargingProfile({
          name: editForm.name.trim(),
          scope: editForm.scope,
          defaultLimitKw: Number(editForm.defaultLimitKw),
          priority: DEFAULT_PRIORITY,
          enabled: editForm.enabled,
          ...(editForm.scope === 'SITE' ? { siteId } : {}),
          ...(editForm.scope === 'GROUP' && editForm.chargerGroupId ? { chargerGroupId: editForm.chargerGroupId } : {}),
          ...(editForm.scope === 'CHARGER' && editForm.chargerId ? { chargerId: editForm.chargerId } : {}),
          ...(schedule ? { schedule } : {}),
          ...(editForm.useTimeWindow && editForm.validFrom ? { validFrom: new Date(editForm.validFrom).toISOString() } : {}),
          ...(editForm.useTimeWindow && editForm.validTo ? { validTo: new Date(editForm.validTo + 'T23:59:59').toISOString() } : {}),
        });
      } else {
        await api.updateSmartChargingProfile(editingProfile.id, {
          name: editForm.name.trim(),
          enabled: editForm.enabled,
          priority: DEFAULT_PRIORITY,
          defaultLimitKw: Number(editForm.defaultLimitKw),
          schedule: schedule ?? [],
          validFrom: editForm.useTimeWindow && editForm.validFrom ? new Date(editForm.validFrom).toISOString() : null,
          validTo: editForm.useTimeWindow && editForm.validTo ? new Date(editForm.validTo + 'T23:59:59').toISOString() : null,
        });
      }

      setEditingProfile(null);
      setEditForm(null);
      await load();
    } catch (e) {
      setEditMsg(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setEditSaving(false);
    }
  }

  async function handleSaveProfile() {
    setSaving(true);
    setSaveMsg('');
    try {
      const token = await getToken();
      const api = createApiClient(token);
      const schedule = form.useTimeWindow && form.windowDays.length > 0
        ? toUtcSchedule(form.windowDays, form.windowStart, form.windowEnd, Number(form.windowLimitKw || form.defaultLimitKw))
        : undefined;

      await api.createSmartChargingProfile({
        name: form.name.trim(),
        scope: form.scope,
        defaultLimitKw: Number(form.defaultLimitKw),
        priority: DEFAULT_PRIORITY,
        enabled: form.enabled,
        ...(form.scope === 'SITE' ? { siteId } : {}),
        ...(form.scope === 'GROUP' && form.chargerGroupId ? { chargerGroupId: form.chargerGroupId } : {}),
        ...(form.scope === 'CHARGER' && form.chargerId ? { chargerId: form.chargerId } : {}),
        ...(schedule ? { schedule } : {}),
        ...(form.useTimeWindow && form.validFrom ? { validFrom: new Date(form.validFrom).toISOString() } : {}),
        ...(form.useTimeWindow && form.validTo ? { validTo: new Date(form.validTo + 'T23:59:59').toISOString() } : {}),
      });
      setSaveMsg('Profile created.');
      setShowCreate(false);
      setForm({ name: '', scope: 'SITE', chargerGroupId: '', chargerId: '', defaultLimitKw: '50', enabled: true, useTimeWindow: false, windowDays: [1], windowStart: '10:00', windowEnd: '12:00', validFrom: new Date().toISOString().slice(0, 10), validTo: '', windowLimitKw: '6' });
      await load();
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleProfile(profile: SmartChargingProfile) {
    const token = await getToken();
    await createApiClient(token).updateSmartChargingProfile(profile.id, { enabled: !profile.enabled });
    await load();
  }

  async function handleDeleteProfile(id: string) {
    if (!window.confirm('Delete this profile?')) return;
    const token = await getToken();
    await createApiClient(token).deleteSmartChargingProfile(id);
    await load();
  }

  async function handlePush(chargerId: string) {
    const token = await getToken();
    await createApiClient(token).reconcileSmartChargingForCharger(chargerId);
    await load();
  }

  async function handleCreateGroup() {
    setGroupMsg('');
    try {
      const token = await getToken();
      await createApiClient(token).createSmartChargingGroup({
        name: groupForm.name.trim(),
        siteId,
      });
      setGroupForm({ name: '' });
      setShowCreateGroup(false);
      setGroupMsg('Group created.');
      await load();
    } catch (e) {
      setGroupMsg(e instanceof Error ? e.message : 'Failed to create group');
    }
  }

  async function handleAssignCharger(groupId: string) {
    const chargerId = groupAssignSelection[groupId];
    if (!chargerId) return;
    const token = await getToken();
    await createApiClient(token).assignChargerToSmartGroup(groupId, chargerId);
    setGroupAssignSelection((m) => ({ ...m, [groupId]: '' }));
    await load();
  }

  async function handleUnassignCharger(groupId: string, chargerId: string) {
    const token = await getToken();
    await createApiClient(token).unassignChargerFromSmartGroup(groupId, chargerId);
    await load();
  }

  async function handleDeleteGroup(groupId: string) {
    if (!window.confirm('Delete this group?')) return;
    const token = await getToken();
    await createApiClient(token).deleteSmartChargingGroup(groupId);
    if (editingGroup?.id === groupId) setEditingGroup(null);
    await load();
  }

  /* ─── Render ───────────────────────────────────────────────────────────── */

  if (loading) return <div className="flex h-32 items-center justify-center text-gray-400 dark:text-slate-500 text-sm">Loading load management…</div>;
  if (error) return <div className="rounded-lg bg-red-50 dark:bg-red-900/20 p-4 text-sm text-red-700 dark:text-red-400">{error}</div>;

  const stateByChargerId = Object.fromEntries(states.map((s) => [s.chargerId, s]));
  const profileById = Object.fromEntries(profiles.map((p) => [p.id, p]));

  return (
    <>
    <div className="space-y-6">
      {/* Active Limits */}
      <ActiveLimitsSection
        profiles={profiles}
        profileById={profileById}
        states={states}
        chargers={chargers}
        groups={groups}
        onPush={handlePush}
        token={currentToken}
        utcTimeToLocal={utcTimeToLocal}
        to12h={to12h}
      />

      {/* Two-column: profiles + groups */}
      <div className="grid gap-6 lg:grid-cols-2">

        {/* Load profiles */}
        <div className="rounded-xl border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-sm">
          <div className="flex items-center justify-between border-b border-gray-300 dark:border-slate-700 px-5 py-4">
            <div>
              <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-300">Load Profiles</h2>
              <p className="mt-0.5 text-xs text-gray-500 dark:text-slate-400">Set kW limits scoped to a charger, group, or this site.</p>
            </div>
            <button onClick={() => setShowCreate((v) => !v)} className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700">
              + New Profile
            </button>
          </div>

          {showCreate && (
            <div className="border-b border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/60 px-5 py-4">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-slate-400">Create Profile</p>
              <div className="grid gap-2 md:grid-cols-2">
                <label className="text-xs text-gray-700 dark:text-slate-300">Name
                  <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className="mt-1 block w-full rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5 text-sm" placeholder="e.g. Site Night Cap" />
                </label>
                <label className="text-xs text-gray-700 dark:text-slate-300">Scope
                  <select value={form.scope} onChange={(e) => setForm((f) => ({ ...f, scope: e.target.value as Scope }))} className="mt-1 block w-full rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5 text-sm">
                    <option value="SITE">Site</option>
                    <option value="GROUP">Group</option>
                    <option value="CHARGER">Charger</option>
                  </select>
                </label>
                {form.scope === 'GROUP' && (
                  <label className="text-xs text-gray-700 dark:text-slate-300 md:col-span-2">Charger Group
                    <select value={form.chargerGroupId} onChange={(e) => setForm((f) => ({ ...f, chargerGroupId: e.target.value }))} className="mt-1 block w-full rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5 text-sm">
                      <option value="">Select group…</option>
                      {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                    </select>
                  </label>
                )}
                {form.scope === 'CHARGER' && (
                  <label className="text-xs text-gray-700 dark:text-slate-300 md:col-span-2">Charger
                    <select value={form.chargerId} onChange={(e) => setForm((f) => ({ ...f, chargerId: e.target.value }))} className="mt-1 block w-full rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5 text-sm">
                      <option value="">Select charger…</option>
                      {chargers.map((c) => <option key={c.id} value={c.id}>{c.ocppId}</option>)}
                    </select>
                  </label>
                )}
                <label className="text-xs text-gray-700 dark:text-slate-300">{form.useTimeWindow ? 'Default cap outside window (kW)' : 'Power cap (kW)'}
                  <input type="number" min="1" value={form.defaultLimitKw} onChange={(e) => setForm((f) => ({ ...f, defaultLimitKw: e.target.value }))} className="mt-1 block w-full rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5 text-sm" />
                </label>

                <label className="col-span-2 flex items-center gap-2 text-xs text-gray-700 dark:text-slate-300">
                  <input type="checkbox" checked={form.enabled} onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))} />
                  Enable immediately
                </label>

                {/* Time Window */}
                <div className="col-span-2 border-t border-gray-100 dark:border-slate-800 pt-3">
                  <label className="flex items-center gap-2 text-xs font-medium text-gray-700 dark:text-slate-300 cursor-pointer">
                    <input type="checkbox" checked={form.useTimeWindow} onChange={(e) => setForm((f) => ({ ...f, useTimeWindow: e.target.checked }))} />
                    Restrict to time window
                  </label>
                </div>

                {form.useTimeWindow && (
                  <>
                    <div className="col-span-2">
                      <p className="mb-1.5 text-xs text-gray-500 dark:text-slate-400">Days of week</p>
                      <div className="flex flex-wrap gap-2">
                        {[['Sun', 0], ['Mon', 1], ['Tue', 2], ['Wed', 3], ['Thu', 4], ['Fri', 5], ['Sat', 6]].map(([label, day]) => (
                          <label key={day} className="flex items-center gap-1 text-xs text-gray-700 dark:text-slate-300 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={form.windowDays.includes(day as number)}
                              onChange={(e) => setForm((f) => ({
                                ...f,
                                windowDays: e.target.checked
                                  ? [...f.windowDays, day as number].sort()
                                  : f.windowDays.filter((d) => d !== day),
                              }))}
                            />
                            {label}
                          </label>
                        ))}
                      </div>
                    </div>
                    <label className="text-xs text-gray-700 dark:text-slate-300">Window cap (kW)
                      <input type="number" min="1" value={form.windowLimitKw} onChange={(e) => setForm((f) => ({ ...f, windowLimitKw: e.target.value }))} className="mt-1 block w-full rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5 text-sm" />
                    </label>
                    <label className="text-xs text-gray-700 dark:text-slate-300">Start time (Local)
                      <input type="time" value={form.windowStart} onChange={(e) => setForm((f) => ({ ...f, windowStart: e.target.value }))} className="mt-1 block w-full rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5 text-sm" />
                    </label>
                    <label className="text-xs text-gray-700 dark:text-slate-300">End time (Local)
                      <input type="time" value={form.windowEnd} onChange={(e) => setForm((f) => ({ ...f, windowEnd: e.target.value }))} className="mt-1 block w-full rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5 text-sm" />
                    </label>
                    <label className="text-xs text-gray-700 dark:text-slate-300">Valid from
                      <input type="date" value={form.validFrom} onChange={(e) => setForm((f) => ({ ...f, validFrom: e.target.value }))} className="mt-1 block w-full rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5 text-sm" />
                    </label>
                    <label className="text-xs text-gray-700 dark:text-slate-300">Valid to (optional)
                      <input type="date" value={form.validTo} onChange={(e) => setForm((f) => ({ ...f, validTo: e.target.value }))} className="mt-1 block w-full rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5 text-sm" placeholder="Leave blank for no end date" />
                    </label>
                    <p className="col-span-2 text-[11px] text-gray-400 dark:text-slate-500">
                      Times are entered in your computer's local timezone and automatically converted for OCPP.
                    </p>
                  </>
                )}
              </div>
              <div className="mt-3 flex gap-2">
                <button onClick={handleSaveProfile} disabled={saving || !form.name.trim()} className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 hover:bg-brand-700">
                  {saving ? 'Saving…' : 'Create Profile'}
                </button>
                <button onClick={() => setShowCreate(false)} className="rounded-md border border-gray-300 dark:border-slate-600 px-3 py-1.5 text-xs text-gray-600 dark:text-slate-400 bg-white dark:bg-slate-800/60 hover:bg-gray-50 dark:hover:bg-slate-700">Cancel</button>
              </div>
              {saveMsg && <p className="mt-2 text-xs text-gray-600 dark:text-slate-400">{saveMsg}</p>}
            </div>
          )}

          <div className="divide-y divide-gray-50 dark:divide-slate-800">
            {profiles.length === 0 && (
              <p className="px-5 py-8 text-center text-sm text-gray-400 dark:text-slate-500">No load profiles yet. Create one to start restricting power.</p>
            )}
            {profiles.map((p) => (
              <div key={p.id} className="flex items-start justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-gray-900 dark:text-slate-100 text-sm truncate">{p.name}</span>
                    <ScopePill scope={p.scope as Scope} />
                    {!p.enabled && <span className="rounded-full border border-gray-300 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/60 px-2 py-0.5 text-[11px] text-gray-500 dark:text-slate-400">disabled</span>}
                  </div>
                  <p className="mt-0.5 text-xs text-gray-500 dark:text-slate-400">
                    {p.defaultLimitKw != null ? `${p.defaultLimitKw} kW` : 'no limit set'}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button onClick={() => openEdit(p)} className="rounded-md border border-brand-200 dark:border-brand-700 px-2 py-1 text-xs font-medium text-brand-700 dark:text-brand-300 hover:bg-brand-50 dark:hover:bg-brand-900/20">Edit</button>
                  <button onClick={() => handleToggleProfile(p)} className={`rounded-md border px-2 py-1 text-xs font-medium ${p.enabled ? 'border-amber-200 dark:border-amber-700 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20' : 'border-green-200 dark:border-green-700 text-green-700 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/20'}`}>
                    {p.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button onClick={() => handleDeleteProfile(p.id)} className="rounded-md border border-red-200 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50">Delete</button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Charger groups */}
        <div className="rounded-xl border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-sm">
          <div className="flex items-center justify-between border-b border-gray-300 dark:border-slate-700 px-5 py-4">
            <div>
              <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-300">Charger Groups</h2>
              <p className="mt-0.5 text-xs text-gray-500 dark:text-slate-400">Assign chargers to groups for shared load budgets.</p>
            </div>
            <button onClick={() => setShowCreateGroup((v) => !v)} className="rounded-md border border-gray-300 dark:border-slate-700 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-slate-300 bg-white dark:bg-slate-800/60 hover:bg-gray-50 dark:hover:bg-slate-700">
              + New Group
            </button>
          </div>

          {showCreateGroup && (
            <div className="border-b border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/60 px-5 py-4">
              <div className="grid gap-2">
                <label className="text-xs text-gray-700 dark:text-slate-300">Group name
                  <input value={groupForm.name} onChange={(e) => setGroupForm((f) => ({ ...f, name: e.target.value }))} className="mt-1 block w-full rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5 text-sm" placeholder="e.g. Garage Level 2" />
                </label>
              </div>
              <div className="mt-3 flex gap-2">
                <button onClick={handleCreateGroup} disabled={!groupForm.name.trim()} className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 hover:bg-brand-700">Create Group</button>
                <button onClick={() => setShowCreateGroup(false)} className="rounded-md border border-gray-300 dark:border-slate-600 px-3 py-1.5 text-xs text-gray-600 dark:text-slate-400 bg-white dark:bg-slate-800/60 hover:bg-gray-50 dark:hover:bg-slate-700">Cancel</button>
              </div>
              {groupMsg && <p className="mt-2 text-xs text-gray-600 dark:text-slate-400">{groupMsg}</p>}
            </div>
          )}

          <div className="divide-y divide-gray-50 dark:divide-slate-800">
            {groups.length === 0 && (
              <p className="px-5 py-8 text-center text-sm text-gray-400 dark:text-slate-500">No groups yet. Create a group to manage chargers as a unit.</p>
            )}
            {groups.map((g) => {
              const groupChargers = chargers.filter((c) => (c as unknown as { groupId?: string }).groupId === g.id);
              return (
                <div key={g.id} className="px-5 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <p className="font-medium text-gray-900 dark:text-slate-100 text-sm">{g.name}</p>
                      <p className="mt-0.5 text-xs text-gray-500 dark:text-slate-400">{groupChargers.length} charger(s)</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button onClick={() => setEditingGroup(g)} className="rounded-md border border-brand-200 dark:border-brand-700 px-2 py-1 text-xs font-medium text-brand-700 dark:text-brand-300 hover:bg-brand-50 dark:hover:bg-brand-900/20">Edit</button>
                      <button onClick={() => handleDeleteGroup(g.id)} className="rounded-md border border-red-200 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50">Delete</button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Detailed charger matrix */}
      <div className="rounded-xl border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-sm">
        <div className="flex items-center justify-between border-b border-gray-300 dark:border-slate-700 px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-300">Detailed Charger Matrix</h2>
            <p className="mt-0.5 text-xs text-gray-500 dark:text-slate-400">Per-charger resolution details for this site.</p>
          </div>
          <button onClick={() => setShowDetailedMatrix((v) => !v)} className="rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1 text-xs text-gray-700 dark:text-slate-300 bg-white dark:bg-slate-800/60 hover:bg-gray-50 dark:hover:bg-slate-700">
            {showDetailedMatrix ? 'Hide details' : 'Show details'}
          </button>
        </div>
        {showDetailedMatrix && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/60 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-slate-400">
                <th className="px-5 py-3">Charger</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3">Effective Limit</th>
                <th className="px-5 py-3">Source</th>
                <th className="px-5 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 dark:divide-slate-800">
              {chargers.map((c) => {
                const state = stateByChargerId[c.id];
                return (
                  <tr key={c.id} className="bg-white dark:bg-slate-800/60 hover:bg-gray-50 dark:hover:bg-slate-700">
                    <td className="px-5 py-3 font-mono text-xs font-semibold text-gray-800 dark:text-slate-200">{c.ocppId}</td>
                    <td className="px-5 py-3"><StatusBadge status={c.status} type="charger" /></td>
                    <td className="px-5 py-3 font-semibold text-gray-900 dark:text-slate-100">
                      {state ? `${state.effectiveLimitKw} kW` : <span className="text-gray-400 dark:text-slate-500">—</span>}
                    </td>
                    <td className="px-5 py-3">
                      {state?.sourceScope ? (
                        <div className="space-y-0.5">
                          <div className="flex items-center gap-1.5">
                            <ScopePill scope={state.sourceScope as Scope} />
                            {state.sourceProfile && <span className="text-xs text-gray-600 dark:text-slate-400 font-medium">{state.sourceProfile.name}</span>}
                          </div>
                          {state.sourceProfile && (
                            <>
                              <p className="text-[11px] text-gray-500 dark:text-slate-400">{profileTargetText(profileById[state.sourceProfile.id], c.ocppId)}</p>
                              <p className="text-[11px] text-gray-400 dark:text-slate-500">{formatSchedule(profileById[state.sourceProfile.id]?.schedule)}</p>
                            </>
                          )}
                        </div>
                      ) : <span className="text-xs text-gray-400 dark:text-slate-500">no profile</span>}
                    </td>
                    <td className="px-5 py-3">
                      <button onClick={() => handlePush(c.id)} className="rounded-md border border-brand-200 dark:border-brand-700 px-2 py-1 text-xs font-medium text-brand-700 dark:text-brand-300 hover:bg-brand-50 dark:hover:bg-brand-900/20">
                        Push
                      </button>
                    </td>
                  </tr>
                );
              })}
              {chargers.length === 0 && (
                <tr><td colSpan={5} className="px-5 py-8 text-center text-sm text-gray-400 dark:text-slate-500">No chargers found at this site.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        )}
      </div>
    </div>

    {/* Edit Group Modal */}
    {editingGroup && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={(e) => { if (e.target === e.currentTarget) setEditingGroup(null); }}>
        <div className="w-full max-w-lg rounded-xl border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl">
          <div className="flex items-center justify-between border-b border-gray-300 dark:border-slate-700 px-5 py-4">
            <div>
              <h2 className="text-sm font-semibold text-gray-900 dark:text-slate-100">Edit Group</h2>
              <p className="mt-0.5 text-xs text-gray-500 dark:text-slate-400">{editingGroup.name}</p>
            </div>
            <button onClick={() => setEditingGroup(null)} className="rounded-md p-1 text-gray-400 dark:text-slate-500 hover:bg-gray-100 dark:hover:bg-slate-800 hover:text-gray-600">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
          <div className="max-h-[70vh] overflow-y-auto px-5 py-4 space-y-3">
            <div className="flex items-center gap-2">
              <select
                value={groupAssignSelection[editingGroup.id] ?? ''}
                onChange={(e) => setGroupAssignSelection((m) => ({ ...m, [editingGroup.id]: e.target.value }))}
                className="block min-w-[240px] rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5 text-sm"
              >
                <option value="">Add charger to this group…</option>
                {chargers
                  .filter((c) => (c as unknown as { groupId?: string }).groupId !== editingGroup.id)
                  .map((c) => <option key={c.id} value={c.id}>{c.ocppId}</option>)}
              </select>
              <button
                onClick={() => handleAssignCharger(editingGroup.id)}
                disabled={!groupAssignSelection[editingGroup.id]}
                className="rounded-md border border-brand-200 dark:border-brand-700 px-3 py-1.5 text-xs font-medium text-brand-700 dark:text-brand-300 hover:bg-brand-50 dark:hover:bg-brand-900/20 disabled:opacity-50"
              >
                Add
              </button>
            </div>
            <div className="space-y-2">
              {chargers.filter((c) => (c as unknown as { groupId?: string }).groupId === editingGroup.id).length === 0 ? (
                <p className="text-xs text-gray-500 dark:text-slate-400">No chargers in this group yet.</p>
              ) : chargers
                .filter((c) => (c as unknown as { groupId?: string }).groupId === editingGroup.id)
                .map((c) => (
                  <div key={c.id} className="flex items-center justify-between rounded-md border border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/60 px-3 py-2 text-xs">
                    <span className="font-mono text-gray-700 dark:text-slate-300">{c.ocppId}</span>
                    <button onClick={() => handleUnassignCharger(editingGroup.id, c.id)} className="rounded border border-red-200 px-2 py-0.5 text-red-600 hover:bg-red-50">Remove</button>
                  </div>
                ))}
            </div>
          </div>
          <div className="flex justify-end border-t border-gray-300 dark:border-slate-700 px-5 py-3">
            <button onClick={() => setEditingGroup(null)} className="rounded-md border border-gray-300 dark:border-slate-600 px-3 py-1.5 text-xs text-gray-600 dark:text-slate-400 bg-white dark:bg-slate-800/60 hover:bg-gray-50 dark:hover:bg-slate-700">Done</button>
          </div>
        </div>
      </div>
    )}

    {/* Edit Profile Modal */}
    {editingProfile && editForm && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={(e) => { if (e.target === e.currentTarget) { setEditingProfile(null); setEditForm(null); } }}>
        <div className="w-full max-w-lg rounded-xl border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl">
          <div className="flex items-center justify-between border-b border-gray-300 dark:border-slate-700 px-5 py-4">
            <div>
              <h2 className="text-sm font-semibold text-gray-900 dark:text-slate-100">Edit Load Profile</h2>
              <p className="mt-0.5 text-xs text-gray-500 dark:text-slate-400 font-mono truncate">{editingProfile.name}</p>
            </div>
            <button onClick={() => { setEditingProfile(null); setEditForm(null); }} className="rounded-md p-1 text-gray-400 dark:text-slate-500 hover:bg-gray-100 dark:hover:bg-slate-800 hover:text-gray-600">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>

          <div className="max-h-[70vh] overflow-y-auto px-5 py-4">
            <div className="grid gap-3 md:grid-cols-2">
              <label className="text-xs text-gray-700 dark:text-slate-300 md:col-span-2">Name
                <input value={editForm.name} onChange={(e) => setEditForm((f) => f && ({ ...f, name: e.target.value }))} className="mt-1 block w-full rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5 text-sm" />
              </label>

              <label className="text-xs text-gray-700 dark:text-slate-300">Scope
                <select value={editForm.scope} onChange={(e) => setEditForm((f) => f && ({ ...f, scope: e.target.value as Scope, chargerGroupId: '', chargerId: '' }))} className="mt-1 block w-full rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5 text-sm">
                  <option value="SITE">Site</option>
                  <option value="GROUP">Group</option>
                  <option value="CHARGER">Charger</option>
                </select>
              </label>

              {editForm.scope === 'GROUP' && (
                <label className="text-xs text-gray-700 dark:text-slate-300">Charger Group
                  <select value={editForm.chargerGroupId} onChange={(e) => setEditForm((f) => f && ({ ...f, chargerGroupId: e.target.value }))} className="mt-1 block w-full rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5 text-sm">
                    <option value="">Select group…</option>
                    {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select>
                </label>
              )}
              {editForm.scope === 'CHARGER' && (
                <label className="text-xs text-gray-700 dark:text-slate-300">Charger
                  <select value={editForm.chargerId} onChange={(e) => setEditForm((f) => f && ({ ...f, chargerId: e.target.value }))} className="mt-1 block w-full rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5 text-sm">
                    <option value="">Select charger…</option>
                    {chargers.map((c) => <option key={c.id} value={c.id}>{c.ocppId}</option>)}
                  </select>
                </label>
              )}

              <label className="text-xs text-gray-700 dark:text-slate-300">{editForm.useTimeWindow ? 'Default cap outside window (kW)' : 'Power cap (kW)'}
                <input type="number" min="1" value={editForm.defaultLimitKw} onChange={(e) => setEditForm((f) => f && ({ ...f, defaultLimitKw: e.target.value }))} className="mt-1 block w-full rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5 text-sm" />
              </label>

              <label className="col-span-2 flex items-center gap-2 text-xs text-gray-700 dark:text-slate-300">
                <input type="checkbox" checked={editForm.enabled} onChange={(e) => setEditForm((f) => f && ({ ...f, enabled: e.target.checked }))} />
                Enabled
              </label>

              <div className="col-span-2 border-t border-gray-100 dark:border-slate-800 pt-3">
                <label className="flex items-center gap-2 text-xs font-medium text-gray-700 dark:text-slate-300 cursor-pointer">
                  <input type="checkbox" checked={editForm.useTimeWindow} onChange={(e) => setEditForm((f) => f && ({ ...f, useTimeWindow: e.target.checked }))} />
                  Restrict to time window
                </label>
              </div>

              {editForm.useTimeWindow && (
                <>
                  <div className="col-span-2">
                    <p className="mb-1.5 text-xs text-gray-500 dark:text-slate-400">Days of week</p>
                    <div className="flex flex-wrap gap-2">
                      {([['Sun', 0], ['Mon', 1], ['Tue', 2], ['Wed', 3], ['Thu', 4], ['Fri', 5], ['Sat', 6]] as [string, number][]).map(([label, day]) => (
                        <label key={day} className="flex items-center gap-1 text-xs text-gray-700 dark:text-slate-300 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={editForm.windowDays.includes(day)}
                            onChange={(e) => setEditForm((f) => f && ({
                              ...f,
                              windowDays: e.target.checked
                                ? [...f.windowDays, day].sort()
                                : f.windowDays.filter((d) => d !== day),
                            }))}
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                  </div>
                  <label className="text-xs text-gray-700 dark:text-slate-300">Window cap (kW)
                    <input type="number" min="1" value={editForm.windowLimitKw} onChange={(e) => setEditForm((f) => f && ({ ...f, windowLimitKw: e.target.value }))} className="mt-1 block w-full rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5 text-sm" />
                  </label>
                  <label className="text-xs text-gray-700 dark:text-slate-300">Start time (Local)
                    <input type="time" value={editForm.windowStart} onChange={(e) => setEditForm((f) => f && ({ ...f, windowStart: e.target.value }))} className="mt-1 block w-full rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5 text-sm" />
                  </label>
                  <label className="text-xs text-gray-700 dark:text-slate-300">End time (Local)
                    <input type="time" value={editForm.windowEnd} onChange={(e) => setEditForm((f) => f && ({ ...f, windowEnd: e.target.value }))} className="mt-1 block w-full rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5 text-sm" />
                  </label>
                  <label className="text-xs text-gray-700 dark:text-slate-300">Valid from
                    <input type="date" value={editForm.validFrom} onChange={(e) => setEditForm((f) => f && ({ ...f, validFrom: e.target.value }))} className="mt-1 block w-full rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5 text-sm" />
                  </label>
                  <label className="text-xs text-gray-700 dark:text-slate-300">Valid to (optional)
                    <input type="date" value={editForm.validTo} onChange={(e) => setEditForm((f) => f && ({ ...f, validTo: e.target.value }))} className="mt-1 block w-full rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5 text-sm" />
                  </label>
                  <p className="col-span-2 text-[11px] text-gray-400 dark:text-slate-500">Times are local and auto-converted when saving.</p>
                </>
              )}
            </div>

            {editingProfile && editForm && (editForm.scope !== editingProfile.scope ||
              editForm.chargerId !== (editingProfile.chargerId ?? '') ||
              editForm.chargerGroupId !== (editingProfile.chargerGroupId ?? '')) && (
              <div className="mt-3 rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                Changing the scope or target will delete this profile and create a new one. Push state will be reset.
              </div>
            )}

            {editMsg && <p className="mt-2 text-xs text-red-600">{editMsg}</p>}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-gray-300 dark:border-slate-700 px-5 py-3">
            <button onClick={() => { setEditingProfile(null); setEditForm(null); }} className="rounded-md border border-gray-300 dark:border-slate-600 px-3 py-1.5 text-xs text-gray-600 dark:text-slate-400 bg-white dark:bg-slate-800/60 hover:bg-gray-50 dark:hover:bg-slate-700">Cancel</button>
            <button onClick={handleSaveEdit} disabled={editSaving || !editForm.name.trim()} className="rounded-md bg-brand-600 px-4 py-1.5 text-xs font-medium text-white disabled:opacity-50 hover:bg-brand-700">
              {editSaving ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
