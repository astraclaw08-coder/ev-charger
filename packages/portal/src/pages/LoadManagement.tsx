import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  createApiClient,
  type ChargerListItem,
  type SiteListItem,
  type SmartChargingGroup,
  type SmartChargingProfile,
  type SmartChargingState,
} from '../api/client';
import { useToken } from '../auth/TokenContext';
import StatusBadge from '../components/StatusBadge';

type Scope = 'CHARGER' | 'GROUP' | 'SITE';
const DEFAULT_PRIORITY = 10;

const SCOPE_LABELS: Record<Scope, string> = {
  CHARGER: 'Charger',
  GROUP: 'Group',
  SITE: 'Site',
};

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

export default function LoadManagement() {
  const getToken = useToken();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [sites, setSites] = useState<SiteListItem[]>([]);
  const [chargers, setChargers] = useState<ChargerListItem[]>([]);
  const [groups, setGroups] = useState<SmartChargingGroup[]>([]);
  const [profiles, setProfiles] = useState<SmartChargingProfile[]>([]);
  const [states, setStates] = useState<SmartChargingState[]>([]);

  // Create profile form
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({
    name: '',
    scope: 'SITE' as Scope,
    siteId: '',
    chargerGroupId: '',
    chargerId: '',
    defaultLimitKw: '50',
    enabled: true,
    // Time window (LOCAL time in UI)
    useTimeWindow: false,
    windowDays: [1] as number[], // Mon default
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

  function openEdit(p: SmartChargingProfile) {
    const firstWindow = Array.isArray(p.schedule) && p.schedule.length > 0
      ? (p.schedule[0] as { startTime?: string; endTime?: string; daysOfWeek?: number[]; limitKw?: number })
      : null;
    const localWindow = fromUtcSchedule(firstWindow);
    setEditForm({
      name: p.name,
      scope: p.scope as Scope,
      siteId: p.siteId ?? '',
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
        editForm.siteId !== (editingProfile.siteId ?? '') ||
        editForm.chargerGroupId !== (editingProfile.chargerGroupId ?? '');

      const schedule = editForm.useTimeWindow && editForm.windowDays.length > 0
        ? toUtcSchedule(editForm.windowDays, editForm.windowStart, editForm.windowEnd, Number(editForm.windowLimitKw || editForm.defaultLimitKw))
        : null;

      if (targetChanged) {
        // Delete old + recreate with new target
        await api.deleteSmartChargingProfile(editingProfile.id);
        await api.createSmartChargingProfile({
          name: editForm.name.trim(),
          scope: editForm.scope,
          defaultLimitKw: Number(editForm.defaultLimitKw),
          priority: DEFAULT_PRIORITY,
          enabled: editForm.enabled,
          ...(editForm.scope === 'SITE' && editForm.siteId ? { siteId: editForm.siteId } : {}),
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

  // Create group form
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [groupForm, setGroupForm] = useState({ name: '', siteId: '' });
  const [groupMsg, setGroupMsg] = useState('');
  const [groupAssignSelection, setGroupAssignSelection] = useState<Record<string, string>>({});
  const [showDetailedMatrix, setShowDetailedMatrix] = useState(false);
  const [editingGroup, setEditingGroup] = useState<SmartChargingGroup | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const token = await getToken();
      const api = createApiClient(token);
      const [siteRows, chargerRows, groupRows, profileRows, stateRows] = await Promise.all([
        api.getSites(),
        api.getChargers().catch(() => [] as ChargerListItem[]),
        api.listSmartChargingGroups(),
        api.listSmartChargingProfiles(),
        api.listSmartChargingStates(),
      ]);
      setSites(siteRows);
      setChargers(chargerRows);
      setGroups(groupRows);
      setProfiles(profileRows);
      setStates(stateRows);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => { load(); }, [load]);

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
        ...(form.scope === 'SITE' && form.siteId ? { siteId: form.siteId } : {}),
        ...(form.scope === 'GROUP' && form.chargerGroupId ? { chargerGroupId: form.chargerGroupId } : {}),
        ...(form.scope === 'CHARGER' && form.chargerId ? { chargerId: form.chargerId } : {}),
        ...(schedule ? { schedule } : {}),
        ...(form.useTimeWindow && form.validFrom ? { validFrom: new Date(form.validFrom).toISOString() } : {}),
        ...(form.useTimeWindow && form.validTo ? { validTo: new Date(form.validTo + 'T23:59:59').toISOString() } : {}),
      });
      setSaveMsg('Profile created.');
      setShowCreate(false);
      setForm({ name: '', scope: 'SITE', siteId: '', chargerGroupId: '', chargerId: '', defaultLimitKw: '50', enabled: true, useTimeWindow: false, windowDays: [1], windowStart: '10:00', windowEnd: '12:00', validFrom: new Date().toISOString().slice(0, 10), validTo: '', windowLimitKw: '6' });
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
        ...(groupForm.siteId ? { siteId: groupForm.siteId } : {}),
      });
      setGroupForm({ name: '', siteId: '' });
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

  if (loading) return <div className="flex h-64 items-center justify-center text-gray-400 dark:text-slate-500">Loading load management…</div>;
  if (error) return <div className="rounded-lg bg-red-50 dark:bg-red-900/20 p-4 text-sm text-red-700 dark:text-red-400">{error}</div>;

  const stateByChargerId = Object.fromEntries(states.map((s) => [s.chargerId, s]));
  const profileById = Object.fromEntries(profiles.map((p) => [p.id, p]));

  function formatSchedule(schedule: unknown): string {
    if (!Array.isArray(schedule) || schedule.length === 0) return 'No time windows';
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return schedule
      .map((w) => {
        const win = w as { daysOfWeek?: number[]; startTime?: string; endTime?: string; limitKw?: number };
        const days = Array.isArray(win.daysOfWeek) && win.daysOfWeek.length > 0
          ? win.daysOfWeek.map((d) => dayNames[d] ?? `D${d}`).join(',')
          : 'All days';
        return `${days} ${win.startTime ?? '--:--'}-${win.endTime ?? '--:--'} @ ${win.limitKw ?? '?'}kW`;
      })
      .join(' · ');
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

  function configuredCapText(profile: SmartChargingProfile | undefined): string {
    if (!profile) return 'Unknown';
    const schedule = profile.schedule;
    if (Array.isArray(schedule) && schedule.length > 0) {
      const first = schedule[0] as { limitKw?: number; startTime?: string; endTime?: string; daysOfWeek?: number[] };
      if (first?.limitKw != null) {
        const local = fromUtcSchedule(first);
        const allDays = Array.isArray(first.daysOfWeek) && first.daysOfWeek.length === 7;
        const dayText = allDays ? 'daily' : 'scheduled';
        return `${first.limitKw} kW ${dayText} ${local.start}–${local.end} (local)`;
      }
    }
    if (profile.defaultLimitKw != null) return `${profile.defaultLimitKw} kW always`;
    return 'No cap';
  }

  function appliedToDisplay(state: SmartChargingState): { title: string; detail: string } {
    const profile = state.sourceProfileId ? profileById[state.sourceProfileId] : undefined;
    if (!profile) return { title: state.charger.ocppId, detail: '' };

    if (profile.scope === 'CHARGER') {
      const c = profile.chargerId ? chargers.find((x) => x.id === profile.chargerId) : null;
      const site = c?.site?.name ?? 'Unknown site';
      return { title: `Charger ${c?.ocppId ?? state.charger.ocppId}`, detail: site };
    }

    if (profile.scope === 'GROUP') {
      const g = profile.chargerGroupId ? groups.find((x) => x.id === profile.chargerGroupId) : null;
      const members = chargers.filter((c) => (c as unknown as { groupId?: string }).groupId === profile.chargerGroupId);
      const siteName = g?.siteId && sites.find((s) => s.id === g.siteId) ? sites.find((s) => s.id === g.siteId)!.name : 'Unknown site';
      return {
        title: `Group ${g?.name ?? profile.chargerGroupId ?? 'Unknown'}`,
        detail: `${members.length} charger(s) · ${siteName}`,
      };
    }

    const s = profile.siteId ? sites.find((x) => x.id === profile.siteId) : null;
    return { title: `Site ${s?.name ?? profile.siteId ?? 'Unknown site'}`, detail: '' };
  }

  function limitDisplay(profile: SmartChargingProfile | undefined): { title: string; detail: string } {
    if (!profile) return { title: '—', detail: '' };
    const schedule = profile.schedule;
    if (Array.isArray(schedule) && schedule.length > 0) {
      const first = schedule[0] as { limitKw?: number; startTime?: string; endTime?: string; daysOfWeek?: number[] };
      const local = fromUtcSchedule(first);
      const allDays = Array.isArray(first.daysOfWeek) && first.daysOfWeek.length === 7;
      return {
        title: `${first.limitKw ?? profile.defaultLimitKw ?? '?'} kW`,
        detail: `${local.start} - ${local.end} (${allDays ? 'daily' : 'scheduled'})`,
      };
    }
    if (profile.defaultLimitKw != null) return { title: `${profile.defaultLimitKw} kW`, detail: 'always' };
    return { title: 'No limit', detail: '' };
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
    if (profile.scope === 'SITE') {
      const s = profile.siteId ? sites.find((x) => x.id === profile.siteId) : null;
      return `Site: ${s?.name ?? profile.siteId ?? 'Unknown site'}`;
    }
    return 'Unknown target';
  }

  return (
    <>
    <div className="space-y-6">
      {/* Breadcrumb + header */}
      <div>
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-slate-400">
          <Link to="/overview" className="hover:text-gray-700 dark:hover:text-slate-200 dark:text-slate-300">Overview</Link>
          <span>/</span>
          <span className="text-gray-900 dark:text-slate-100">Load Management</span>
        </div>
        <h1 className="mt-1 text-2xl font-bold text-gray-900 dark:text-slate-100">Load Management</h1>
        <p className="text-sm text-gray-500 dark:text-slate-400">Control power limits per charger, group, or site using OCPP smart charging profiles.</p>
      </div>

      <div className="rounded-xl border border-brand-200 bg-brand-50 px-5 py-4 dark:border-brand-500/30 dark:bg-brand-500/10">
        <h2 className="text-sm font-semibold text-brand-800 dark:text-brand-200">Recommended flow</h2>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs text-brand-800 dark:text-brand-100/90">
          <li>Create a <strong>charger group</strong> for a site and assign chargers to it.</li>
          <li>Create one <strong>group-scoped load profile</strong> with default cap + optional time window cap.</li>
          <li>Use <strong>Re-push</strong> to apply immediately, then verify in Active Limits.</li>
        </ol>
      </div>

      {/* Active Limits — derived from all enabled profiles with charger/group/site assignments */}
      {(() => {
        // Build rows from profiles: each enabled profile assigned to a target gets a row
        const activeRows = profiles.filter((p) => p.enabled && (p.chargerId || p.chargerGroupId || p.siteId)).map((p) => {
          // Determine target charger IDs for this profile
          let targetChargerIds: string[] = [];
          let targetLabel = '';
          let targetDetail = '';

          if (p.scope === 'CHARGER' && p.chargerId) {
            targetChargerIds = [p.chargerId];
            const c = chargers.find((x) => x.id === p.chargerId);
            targetLabel = c?.ocppId ?? p.chargerId;
            targetDetail = c ? `${c.status}` : '';
          } else if (p.scope === 'GROUP' && p.chargerGroupId) {
            const g = groups.find((x) => x.id === p.chargerGroupId);
            targetLabel = g?.name ?? p.chargerGroupId;
            targetChargerIds = g?.chargerIds ?? [];
            targetDetail = `${targetChargerIds.length} charger${targetChargerIds.length !== 1 ? 's' : ''}`;
          } else if (p.scope === 'SITE' && p.siteId) {
            const s = sites.find((x) => x.id === p.siteId);
            targetLabel = s?.name ?? p.siteId;
            const siteChargers = chargers.filter((c) => c.siteId === p.siteId);
            targetChargerIds = siteChargers.map((c) => c.id);
            targetDetail = `${targetChargerIds.length} charger${targetChargerIds.length !== 1 ? 's' : ''}`;
          }

          // Find matching state(s) — check if this profile is the current source for any target charger
          const matchingStates = states.filter((s) => targetChargerIds.includes(s.chargerId));
          const isCurrentSource = matchingStates.some((s) => s.sourceProfileId === p.id);
          const activeState = matchingStates.find((s) => s.sourceProfileId === p.id);

          // Determine schedule description
          const schedule = Array.isArray(p.schedule) ? p.schedule : [];
          const windowSummary = schedule.map((w: any) => {
            const days = (w.daysOfWeek ?? []).length === 7 ? 'Daily' : `${(w.daysOfWeek ?? []).length} days/wk`;
            return `${w.startTime}–${w.endTime} ${days} @ ${w.limitKw} kW`;
          }).join('; ') || (p.defaultLimitKw != null ? `${p.defaultLimitKw} kW always` : 'No schedule');

          // Determine status
          let statusLabel = '';
          let statusColor = '';
          // Status reflects whether the charger has confirmed acceptance of this profile.
          // The schedule column already shows when the limit takes effect.
          if (isCurrentSource && activeState) {
            switch (activeState.status) {
              case 'APPLIED':
              case 'FALLBACK_APPLIED':
                statusLabel = activeState.lastAppliedAt ? `✅ Applied ${new Date(activeState.lastAppliedAt).toLocaleString()}` : '✅ Applied';
                statusColor = 'text-green-600 dark:text-green-400';
                break;
              case 'PENDING_OFFLINE':
                statusLabel = '⏳ Pending — charger offline';
                statusColor = 'text-amber-600 dark:text-amber-400';
                break;
              case 'ERROR':
                statusLabel = `❌ Failed${activeState.lastError ? `: ${activeState.lastError}` : ''}`;
                statusColor = 'text-red-600 dark:text-red-400';
                break;
              default:
                statusLabel = activeState.status ?? '—';
                statusColor = 'text-gray-500 dark:text-slate-400';
            }
          } else if (matchingStates.length > 0 && matchingStates.some((s) => s.status === 'APPLIED' || s.status === 'FALLBACK_APPLIED')) {
            // Charger is online and has an applied state, but from a different (higher-priority) profile.
            // This profile was still sent to the charger as part of the reconcile — it's applied.
            const lastApplied = matchingStates.find((s) => s.lastAppliedAt)?.lastAppliedAt;
            statusLabel = lastApplied ? `✅ Applied ${new Date(lastApplied).toLocaleString()}` : '✅ Applied';
            statusColor = 'text-green-600 dark:text-green-400';
          } else {
            statusLabel = '⏳ Pending — charger offline';
            statusColor = 'text-amber-600 dark:text-amber-400';
          }

          return { profile: p, targetLabel, targetDetail, windowSummary, statusLabel, statusColor, targetChargerIds };
        });

        if (activeRows.length === 0) return null;

        return (
        <div className="rounded-xl border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-sm">
          <div className="border-b border-gray-300 dark:border-slate-700 px-5 py-4">
            <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-300">Active Limits</h2>
            <p className="mt-0.5 text-xs text-gray-500 dark:text-slate-400">All load profiles assigned to chargers, groups, or sites — showing current and scheduled limits.</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/60 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-slate-400">
                  <th className="px-5 py-3">Target</th>
                  <th className="px-5 py-3">Profile</th>
                  <th className="px-5 py-3">Schedule</th>
                  <th className="px-5 py-3">Status</th>
                  <th className="px-5 py-3">Push</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-slate-800">
                {activeRows.map((row) => (
                  <tr key={row.profile.id} className="bg-white dark:bg-slate-800/60 hover:bg-gray-50 dark:hover:bg-slate-700">
                    <td className="px-5 py-3">
                      <p className="text-sm font-semibold text-gray-900 dark:text-slate-100">{row.targetLabel}</p>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <ScopePill scope={row.profile.scope as Scope} />
                        {row.targetDetail && <span className="text-xs text-gray-500 dark:text-slate-400">{row.targetDetail}</span>}
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      <p className="text-xs font-medium text-gray-700 dark:text-slate-300">{row.profile.name}</p>
                      <p className="text-xs text-gray-400 dark:text-slate-500">Priority: {row.profile.priority}</p>
                    </td>
                    <td className="px-5 py-3">
                      <p className="text-xs text-gray-600 dark:text-slate-300">{row.windowSummary}</p>
                    </td>
                    <td className="px-5 py-3">
                      <p className={`text-xs font-medium ${row.statusColor}`}>{row.statusLabel}</p>
                    </td>
                    <td className="px-5 py-3">
                      {row.targetChargerIds.length > 0 && (
                        <button onClick={() => handlePush(row.targetChargerIds[0])} className="rounded-md border border-brand-200 dark:border-brand-700 px-2 py-1 text-xs font-medium text-brand-700 dark:text-brand-300 hover:bg-brand-50 dark:hover:bg-brand-900/20">
                          Re-push
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        );
      })()}

      {/* Two-column layout: profiles + groups */}
      <div className="grid gap-6 lg:grid-cols-2">

        {/* Load profiles */}
        <div className="rounded-xl border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-sm">
          <div className="flex items-center justify-between border-b border-gray-300 dark:border-slate-700 px-5 py-4">
            <div>
              <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-300">Load Profiles</h2>
              <p className="mt-0.5 text-xs text-gray-500 dark:text-slate-400">Set kW limits scoped to a charger, group, or entire site.</p>
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
                {form.scope === 'SITE' && (
                  <label className="text-xs text-gray-700 dark:text-slate-300 md:col-span-2">Site
                    <select value={form.siteId} onChange={(e) => setForm((f) => ({ ...f, siteId: e.target.value }))} className="mt-1 block w-full rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5 text-sm">
                      <option value="">Select site…</option>
                      {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </label>
                )}
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
                      {chargers.map((c) => <option key={c.id} value={c.id}>{c.ocppId} — {c.site.name}</option>)}
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
                    <ScopePill scope={p.scope} />
                    {!p.enabled && <span className="rounded-full border border-gray-300 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/60 px-2 py-0.5 text-[11px] text-gray-500 dark:text-slate-400">disabled</span>}
                  </div>
                  <p className="mt-0.5 text-xs text-gray-500 dark:text-slate-400">
                    {p.defaultLimitKw != null ? `${p.defaultLimitKw} kW` : 'no limit set'}
                    {p.siteId && sites.find((s) => s.id === p.siteId) ? ` · ${sites.find((s) => s.id === p.siteId)!.name}` : ''}
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
              <div className="grid gap-2 md:grid-cols-2">
                <label className="text-xs text-gray-700 dark:text-slate-300">Group name
                  <input value={groupForm.name} onChange={(e) => setGroupForm((f) => ({ ...f, name: e.target.value }))} className="mt-1 block w-full rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5 text-sm" placeholder="e.g. Garage Level 2" />
                </label>
                <label className="text-xs text-gray-700 dark:text-slate-300">Site (optional)
                  <select value={groupForm.siteId} onChange={(e) => setGroupForm((f) => ({ ...f, siteId: e.target.value }))} className="mt-1 block w-full rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5 text-sm">
                    <option value="">Any</option>
                    {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
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
              const siteName = g.siteId && sites.find((s) => s.id === g.siteId) ? sites.find((s) => s.id === g.siteId)!.name : 'Unscoped';
              return (
                <div key={g.id} className="px-5 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <p className="font-medium text-gray-900 dark:text-slate-100 text-sm">{g.name}</p>
                      <p className="mt-0.5 text-xs text-gray-500 dark:text-slate-400">{groupChargers.length} charger(s) · {siteName}</p>
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

      {/* Optional detailed matrix */}
      <div className="rounded-xl border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-sm">
        <div className="flex items-center justify-between border-b border-gray-300 dark:border-slate-700 px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-300">Detailed Charger Matrix</h2>
            <p className="mt-0.5 text-xs text-gray-500 dark:text-slate-400">Optional deep view of per-charger resolution details.</p>
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
                <th className="px-5 py-3">Site</th>
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
                    <td className="px-5 py-3 text-xs text-gray-500 dark:text-slate-400">{c.site.name}</td>
                    <td className="px-5 py-3"><StatusBadge status={c.status} type="charger" /></td>
                    <td className="px-5 py-3 font-semibold text-gray-900 dark:text-slate-100">
                      {state ? `${state.effectiveLimitKw} kW` : <span className="text-gray-400 dark:text-slate-500">—</span>}
                    </td>
                    <td className="px-5 py-3">
                      {state?.sourceScope ? (
                        <div className="space-y-0.5">
                          <div className="flex items-center gap-1.5">
                            <ScopePill scope={state.sourceScope} />
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
                <tr><td colSpan={6} className="px-5 py-8 text-center text-sm text-gray-400 dark:text-slate-500">No chargers found.</td></tr>
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
            <button onClick={() => setEditingGroup(null)} className="rounded-md p-1 text-gray-400 dark:text-slate-500 hover:bg-gray-100 dark:hover:bg-slate-800 dark:bg-slate-800 hover:text-gray-600 dark:text-slate-400">
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
                  .filter((c) => (!editingGroup.siteId || c.site.id === editingGroup.siteId) && (c as unknown as { groupId?: string }).groupId !== editingGroup.id)
                  .map((c) => <option key={c.id} value={c.id}>{c.ocppId} — {c.site.name}</option>)}
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
            <button onClick={() => { setEditingProfile(null); setEditForm(null); }} className="rounded-md p-1 text-gray-400 dark:text-slate-500 hover:bg-gray-100 dark:hover:bg-slate-800 dark:bg-slate-800 hover:text-gray-600 dark:text-slate-400">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>

          <div className="max-h-[70vh] overflow-y-auto px-5 py-4">
            <div className="grid gap-3 md:grid-cols-2">
              <label className="text-xs text-gray-700 dark:text-slate-300 md:col-span-2">Name
                <input value={editForm.name} onChange={(e) => setEditForm((f) => f && ({ ...f, name: e.target.value }))} className="mt-1 block w-full rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5 text-sm" />
              </label>

              <label className="text-xs text-gray-700 dark:text-slate-300">Scope
                <select value={editForm.scope} onChange={(e) => setEditForm((f) => f && ({ ...f, scope: e.target.value as Scope, siteId: '', chargerGroupId: '', chargerId: '' }))} className="mt-1 block w-full rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5 text-sm">
                  <option value="SITE">Site</option>
                  <option value="GROUP">Group</option>
                  <option value="CHARGER">Charger</option>
                </select>
              </label>

              {editForm.scope === 'SITE' && (
                <label className="text-xs text-gray-700 dark:text-slate-300">Site
                  <select value={editForm.siteId} onChange={(e) => setEditForm((f) => f && ({ ...f, siteId: e.target.value }))} className="mt-1 block w-full rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5 text-sm">
                    <option value="">Select site…</option>
                    {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </label>
              )}
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
                    {chargers.map((c) => <option key={c.id} value={c.id}>{c.ocppId} — {c.site.name}</option>)}
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

              {/* Time window */}
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

            {(editForm.scope !== editingProfile.scope ||
              editForm.chargerId !== (editingProfile.chargerId ?? '') ||
              editForm.siteId !== (editingProfile.siteId ?? '') ||
              editForm.chargerGroupId !== (editingProfile.chargerGroupId ?? '')) && (
              <div className="mt-3 rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                ⚠ Changing the scope or target will delete this profile and create a new one. Push state will be reset.
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
