/**
 * LoadManagement — Cross-site overview dashboard.
 * All CRUD controls have moved to the per-site "Load Management" tab in SiteDetail.
 * This page provides a read-only bird's-eye view across all sites.
 */
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
import { PageHeader } from '../components/ui';

/* ─── KPI Card ──────────────────────────────────────────────────────────── */

function KpiCard({ label, value, detail, color }: { label: string; value: string | number; detail?: string; color?: string }) {
  return (
    <div className="rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-slate-400">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${color ?? 'text-gray-900 dark:text-slate-100'}`}>{value}</p>
      {detail && <p className="mt-0.5 text-xs text-gray-400 dark:text-slate-500">{detail}</p>}
    </div>
  );
}

/* ─── Status dot ────────────────────────────────────────────────────────── */

function StatusDot({ status }: { status: string }) {
  const colorMap: Record<string, string> = {
    APPLIED: 'bg-green-500',
    FALLBACK_APPLIED: 'bg-green-400',
    PENDING_OFFLINE: 'bg-amber-400',
    ERROR: 'bg-red-500',
  };
  return <span className={`inline-block h-2 w-2 rounded-full ${colorMap[status] ?? 'bg-gray-300 dark:bg-slate-600'}`} />;
}

/* ─── Scope pill (read-only) ────────────────────────────────────────────── */

type Scope = 'CHARGER' | 'GROUP' | 'SITE';
const SCOPE_COLORS: Record<Scope, string> = {
  CHARGER: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-700',
  GROUP: 'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-900/30 dark:text-purple-300 dark:border-purple-700',
  SITE: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700',
};

function ScopePill({ scope }: { scope: string }) {
  const s = scope as Scope;
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${SCOPE_COLORS[s] ?? 'bg-gray-50 text-gray-600 border-gray-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-600'}`}>
      {scope}
    </span>
  );
}

/* ─── Main Component ────────────────────────────────────────────────────── */

export default function LoadManagement() {
  const getToken = useToken();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [sites, setSites] = useState<SiteListItem[]>([]);
  const [chargers, setChargers] = useState<ChargerListItem[]>([]);
  const [groups, setGroups] = useState<SmartChargingGroup[]>([]);
  const [profiles, setProfiles] = useState<SmartChargingProfile[]>([]);
  const [states, setStates] = useState<SmartChargingState[]>([]);

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

  if (loading) return <div className="flex h-64 items-center justify-center text-gray-400 dark:text-slate-500">Loading load management…</div>;
  if (error) return <div className="rounded-lg bg-red-50 dark:bg-red-900/20 p-4 text-sm text-red-700 dark:text-red-400">{error}</div>;

  /* ─── Derived metrics ──────────────────────────────────────────────────── */

  const totalChargers = chargers.length;
  const totalProfiles = profiles.length;
  const enabledProfiles = profiles.filter((p) => p.enabled).length;
  const totalGroups = groups.length;

  // States aggregation
  const appliedCount = states.filter((s) => s.status === 'APPLIED' || s.status === 'FALLBACK_APPLIED').length;
  const pendingCount = states.filter((s) => s.status === 'PENDING_OFFLINE').length;
  const errorCount = states.filter((s) => s.status === 'ERROR').length;
  const managedChargerIds = new Set(states.map((s) => s.chargerId));
  const managedCount = managedChargerIds.size;
  const unmanagedCount = totalChargers - managedCount;

  // Per-site data
  const siteData = sites.map((site) => {
    const siteChargers = chargers.filter((c) => c.siteId === site.id);
    const siteChargerIds = new Set(siteChargers.map((c) => c.id));
    const siteGroupIds = new Set(groups.filter((g) => g.siteId === site.id).map((g) => g.id));
    const siteProfiles = profiles.filter((p) =>
      (p.scope === 'SITE' && p.siteId === site.id) ||
      (p.scope === 'GROUP' && p.chargerGroupId && siteGroupIds.has(p.chargerGroupId)) ||
      (p.scope === 'CHARGER' && p.chargerId && siteChargerIds.has(p.chargerId))
    );
    const siteStates = states.filter((s) => siteChargerIds.has(s.chargerId));
    const siteGroups = groups.filter((g) => g.siteId === site.id);

    const applied = siteStates.filter((s) => s.status === 'APPLIED' || s.status === 'FALLBACK_APPLIED').length;
    const errors = siteStates.filter((s) => s.status === 'ERROR').length;
    const pending = siteStates.filter((s) => s.status === 'PENDING_OFFLINE').length;

    // Effective min/max limits across chargers
    const limits = siteStates
      .filter((s) => s.effectiveLimitKw != null)
      .map((s) => s.effectiveLimitKw!);
    const minLimit = limits.length > 0 ? Math.min(...limits) : null;
    const maxLimit = limits.length > 0 ? Math.max(...limits) : null;

    return {
      site,
      chargerCount: siteChargers.length,
      onlineCount: siteChargers.filter((c) => c.status === 'ONLINE').length,
      profileCount: siteProfiles.length,
      enabledProfileCount: siteProfiles.filter((p) => p.enabled).length,
      groupCount: siteGroups.length,
      stateCount: siteStates.length,
      applied,
      errors,
      pending,
      minLimit,
      maxLimit,
    };
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Load Management"
        description="Cross-site overview of power limits and OCPP smart charging profiles."
      />

      {/* ── KPI Cards ── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Total Chargers"
          value={totalChargers}
          detail={`${managedCount} managed · ${unmanagedCount} unmanaged`}
        />
        <KpiCard
          label="Active Profiles"
          value={enabledProfiles}
          detail={`${totalProfiles} total · ${totalGroups} groups`}
        />
        <KpiCard
          label="Applied"
          value={appliedCount}
          detail={`${pendingCount} pending · ${errorCount} errors`}
          color={errorCount > 0 ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'}
        />
        <KpiCard
          label="Sites"
          value={sites.length}
          detail={`${siteData.filter((d) => d.profileCount > 0).length} with active load profiles`}
        />
      </div>

      {/* ── Site-by-Site Table ── */}
      <div className="rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-sm">
        <div className="border-b border-gray-200 dark:border-slate-700 px-5 py-4">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-slate-100">Sites Overview</h2>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-slate-400">Click a site to manage its load profiles, groups, and charger limits.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/40 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-slate-400">
                <th className="px-5 py-3">Site</th>
                <th className="px-5 py-3">Chargers</th>
                <th className="px-5 py-3">Groups</th>
                <th className="px-5 py-3">Profiles</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3">Effective Range</th>
                <th className="px-5 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 dark:divide-slate-800">
              {siteData.map((d) => (
                <tr key={d.site.id} className="hover:bg-gray-50 dark:hover:bg-slate-800/60 transition-colors">
                  <td className="px-5 py-4">
                    <p className="font-medium text-gray-900 dark:text-slate-100">{d.site.name}</p>
                    <p className="text-xs text-gray-400 dark:text-slate-500">{d.site.address || 'No address'}</p>
                  </td>
                  <td className="px-5 py-4">
                    <p className="text-gray-900 dark:text-slate-100 font-medium">{d.chargerCount}</p>
                    <p className="text-xs text-gray-400 dark:text-slate-500">{d.onlineCount} online</p>
                  </td>
                  <td className="px-5 py-4 text-gray-700 dark:text-slate-300">
                    {d.groupCount > 0 ? d.groupCount : <span className="text-gray-400 dark:text-slate-500">—</span>}
                  </td>
                  <td className="px-5 py-4">
                    {d.profileCount > 0 ? (
                      <div>
                        <p className="text-gray-900 dark:text-slate-100 font-medium">{d.enabledProfileCount} active</p>
                        <p className="text-xs text-gray-400 dark:text-slate-500">{d.profileCount} total</p>
                      </div>
                    ) : (
                      <span className="text-xs text-gray-400 dark:text-slate-500">None</span>
                    )}
                  </td>
                  <td className="px-5 py-4">
                    {d.stateCount > 0 ? (
                      <div className="flex flex-wrap items-center gap-2">
                        {d.applied > 0 && (
                          <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                            <StatusDot status="APPLIED" /> {d.applied}
                          </span>
                        )}
                        {d.pending > 0 && (
                          <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                            <StatusDot status="PENDING_OFFLINE" /> {d.pending}
                          </span>
                        )}
                        {d.errors > 0 && (
                          <span className="flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
                            <StatusDot status="ERROR" /> {d.errors}
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-gray-400 dark:text-slate-500">Not managed</span>
                    )}
                  </td>
                  <td className="px-5 py-4">
                    {d.minLimit != null ? (
                      <p className="font-mono text-sm font-semibold text-gray-900 dark:text-slate-100">
                        {d.minLimit === d.maxLimit ? `${d.minLimit} kW` : `${d.minLimit}–${d.maxLimit} kW`}
                      </p>
                    ) : (
                      <span className="text-xs text-gray-400 dark:text-slate-500">—</span>
                    )}
                  </td>
                  <td className="px-5 py-4">
                    <Link
                      to={`/sites/${d.site.id}?tab=load-management`}
                      className="rounded-md border border-brand-200 dark:border-brand-700 px-3 py-1.5 text-xs font-medium text-brand-700 dark:text-brand-300 hover:bg-brand-50 dark:hover:bg-brand-900/20 whitespace-nowrap"
                    >
                      Manage
                    </Link>
                  </td>
                </tr>
              ))}
              {siteData.length === 0 && (
                <tr><td colSpan={7} className="px-5 py-12 text-center text-sm text-gray-400 dark:text-slate-500">No sites found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── All Profiles Summary ── */}
      {profiles.length > 0 && (
        <div className="rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-sm">
          <div className="border-b border-gray-200 dark:border-slate-700 px-5 py-4">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-slate-100">All Load Profiles</h2>
            <p className="mt-0.5 text-xs text-gray-500 dark:text-slate-400">Summary of all smart charging profiles across sites.</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/40 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-slate-400">
                  <th className="px-5 py-3">Profile</th>
                  <th className="px-5 py-3">Scope</th>
                  <th className="px-5 py-3">Target</th>
                  <th className="px-5 py-3">Limit</th>
                  <th className="px-5 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-slate-800">
                {profiles.map((p) => {
                  // Resolve target name
                  let targetName = '—';
                  if (p.scope === 'SITE' && p.siteId) {
                    const s = sites.find((x) => x.id === p.siteId);
                    targetName = s?.name ?? p.siteId;
                  } else if (p.scope === 'GROUP' && p.chargerGroupId) {
                    const g = groups.find((x) => x.id === p.chargerGroupId);
                    targetName = g?.name ?? p.chargerGroupId;
                  } else if (p.scope === 'CHARGER' && p.chargerId) {
                    const c = chargers.find((x) => x.id === p.chargerId);
                    targetName = c?.ocppId ?? p.chargerId;
                  }

                  // Count states for this profile
                  const profileStates = states.filter((s) => s.sourceProfileId === p.id);
                  const applied = profileStates.filter((s) => s.status === 'APPLIED' || s.status === 'FALLBACK_APPLIED').length;
                  const errored = profileStates.filter((s) => s.status === 'ERROR').length;

                  return (
                    <tr key={p.id} className="hover:bg-gray-50 dark:hover:bg-slate-800/60">
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-gray-900 dark:text-slate-100">{p.name}</span>
                          {!p.enabled && (
                            <span className="rounded-full border border-gray-300 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/60 px-2 py-0.5 text-[11px] text-gray-500 dark:text-slate-400">disabled</span>
                          )}
                        </div>
                      </td>
                      <td className="px-5 py-3"><ScopePill scope={p.scope} /></td>
                      <td className="px-5 py-3 text-xs text-gray-600 dark:text-slate-300">{targetName}</td>
                      <td className="px-5 py-3 font-mono text-xs font-semibold text-gray-900 dark:text-slate-100">
                        {p.defaultLimitKw != null ? `${p.defaultLimitKw} kW` : '—'}
                      </td>
                      <td className="px-5 py-3">
                        {profileStates.length > 0 ? (
                          <div className="flex items-center gap-2">
                            {applied > 0 && <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400"><StatusDot status="APPLIED" /> {applied}</span>}
                            {errored > 0 && <span className="flex items-center gap-1 text-xs text-red-600 dark:text-red-400"><StatusDot status="ERROR" /> {errored}</span>}
                            {applied === 0 && errored === 0 && <span className="text-xs text-gray-400 dark:text-slate-500">Pending</span>}
                          </div>
                        ) : (
                          <span className="text-xs text-gray-400 dark:text-slate-500">Not pushed</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Chargers with errors ── */}
      {errorCount > 0 && (
        <div className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 shadow-sm">
          <div className="border-b border-red-200 dark:border-red-800 px-5 py-4">
            <h2 className="text-sm font-semibold text-red-700 dark:text-red-400">Chargers with Errors</h2>
            <p className="mt-0.5 text-xs text-red-500 dark:text-red-400/70">These chargers failed to apply their load profile. Visit the site to re-push.</p>
          </div>
          <div className="divide-y divide-red-100 dark:divide-red-800/50">
            {states.filter((s) => s.status === 'ERROR').map((s) => {
              const c = chargers.find((x) => x.id === s.chargerId);
              const site = c ? sites.find((x) => x.id === c.siteId) : null;
              return (
                <div key={s.id} className="flex items-center justify-between px-5 py-3">
                  <div>
                    <p className="text-sm font-medium text-red-800 dark:text-red-300">{c?.ocppId ?? s.chargerId}</p>
                    <p className="text-xs text-red-600 dark:text-red-400">{site?.name ?? 'Unknown site'} — {s.lastError ?? 'Unknown error'}</p>
                  </div>
                  {site && (
                    <Link
                      to={`/sites/${site.id}?tab=load-management`}
                      className="rounded-md border border-red-300 dark:border-red-700 px-3 py-1.5 text-xs font-medium text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/40 whitespace-nowrap"
                    >
                      Go to site
                    </Link>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
