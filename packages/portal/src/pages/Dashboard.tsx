import React, { useState, useEffect } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { createApiClient, type DailyEntry, type SiteListItem } from '../api/client';
import DashboardSitesMap, { type DashboardSiteMapItem } from '../components/DashboardSitesMap';
import { useToken } from '../auth/TokenContext';
import { usePortalScope } from '../context/PortalScopeContext';
import { PageHeader, StatCard, ErrorState, ChartTooltip, useChartTheme } from '../components/ui';
import { PageSkeleton } from '../components/ui/LoadingState';
import { cn } from '../lib/utils';

export default function Dashboard() {
  const { grid, tick, isDark } = useChartTheme();
  const getToken = useToken();
  const [sites, setSites] = useState<SiteListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [fleetUptime, setFleetUptime] = useState<{ uptime24h: number; uptime7d: number; uptime30d: number } | null>(null);
  const [fleetKpis, setFleetKpis] = useState<{ totalSites: number; totalConnectors: number; totalKwh: number; totalRevenue: number; activeSessions: number; utilizationRatePct: number } | null>(null);
  const [topUtilizedSites, setTopUtilizedSites] = useState<Array<{ id: string; name: string; address: string; utilizationPct: number; chargerCount: number }>>([]);
  const [fleetStatus, setFleetStatus] = useState<{
    totalChargers: number;
    totalConnectors: number;
    available: number;
    charging: number;
    faulted: number;
    offline: number;
    byStatus: Array<{ status: string; count: number }>;
  } | null>(null);
  const { siteId, setSiteId, rangePreset, setRangePreset } = usePortalScope();
  const [fleetTrend, setFleetTrend] = useState<Array<{ date: string; label: string; sessions: number; kwhDelivered: number; revenueUsd: number }>>([]);
  const [siteMapItems, setSiteMapItems] = useState<DashboardSiteMapItem[]>([]);


  async function load() {
    try {
      setError('');
      const token = await getToken();
      const client = createApiClient(token);
      const allSites = await client.getSites();
      setSites(allSites);
      const data = siteId ? allSites.filter((site) => site.id === siteId) : allSites;

      const periodDays = rangePreset === '7d' ? 7 : rangePreset === '30d' ? 30 : 60;

      const siteUp = await Promise.all(data.map((site) => client.getSiteUptime(site.id).catch(() => null)));
      const [siteAnalyticsRange, siteDetails] = await Promise.all([
        Promise.all(data.map((site) => client.getAnalytics(site.id, { periodDays }).catch(() => null))),
        Promise.all(data.map((site) => client.getSite(site.id).catch(() => null))),
      ]);

      const totalKwh = siteAnalyticsRange.filter(Boolean).reduce((sum, a) => sum + (a?.kwhDelivered ?? 0), 0);
      const totalRevenue = siteAnalyticsRange.filter(Boolean).reduce((sum, a) => sum + ((a?.revenueCents ?? 0) / 100), 0);

      const chargerIds = siteDetails
        .filter(Boolean)
        .flatMap((s) => s?.chargers.map((c) => c.id) ?? []);

      const chargerStatuses = await Promise.all(
        chargerIds.map((chargerId) => client.getChargerStatus(chargerId).catch(() => null)),
      );
      const chargerSessions = await Promise.all(
        chargerIds.map((chargerId) => client.getChargerSessions(chargerId).catch(() => [])),
      );
      const activeSessions = chargerStatuses
        .filter(Boolean)
        .reduce((sum, ch) => sum + (ch?.connectors.filter((c) => c.activeSession).length ?? 0), 0);

      const statusByChargerId = new Map(
        chargerStatuses
          .filter(Boolean)
          .map((ch) => [ch!.id, ch!] as const),
      );

      const mapRows: DashboardSiteMapItem[] = siteDetails
        .filter(Boolean)
        .map((site) => {
          const totalChargers = site!.chargers.length;
          const availableChargers = site!.chargers.reduce((count, charger) => {
            const live = statusByChargerId.get(charger.id);
            const chargerStatus = String((live?.status ?? charger.status) || '').toUpperCase();
            const connectors = (live?.connectors ?? charger.connectors) || [];
            const hasAvailableConnector = connectors.some((cn) => String(cn.status || '').toUpperCase() === 'AVAILABLE');
            return count + (chargerStatus !== 'OFFLINE' && hasAvailableConnector ? 1 : 0);
          }, 0);

          const chargerTypes = Array.from(new Set(site!.chargers.map((ch) => {
            const s = `${ch.model ?? ''} ${ch.vendor ?? ''}`.toLowerCase();
            return (s.includes('dc') || s.includes('ccs') || s.includes('chademo') || s.includes('fast') || s.includes('dcfc') || s.includes('supercharger')) ? 'DCFC' : 'Level 2';
          })));

          return {
            id: site!.id,
            name: site!.name,
            address: site!.address,
            lat: site!.lat,
            lng: site!.lng,
            availableChargers,
            totalChargers,
            chargerTypes,
          };
        });
      setSiteMapItems(mapRows);

      const statusCountMap = new Map<string, number>();
      let totalConnectors = 0;
      let available = 0;
      let charging = 0;
      let faulted = 0;
      let offline = 0;

      const OFFLINE_TIMEOUT_MS = 5 * 60 * 1000;

      chargerStatuses.filter(Boolean).forEach((ch) => {
        const hbMs = ch?.lastHeartbeat ? new Date(ch.lastHeartbeat).getTime() : 0;
        const staleHeartbeat = !hbMs || (Date.now() - hbMs) > OFFLINE_TIMEOUT_MS;
        const chargerOffline = ch?.status?.toUpperCase() === 'OFFLINE' && staleHeartbeat;
        ch?.connectors.forEach((connector) => {
          totalConnectors += 1;
          const status = chargerOffline ? 'OFFLINE' : connector.status.toUpperCase();
          statusCountMap.set(status, (statusCountMap.get(status) ?? 0) + 1);

          if (status === 'AVAILABLE') available += 1;
          if (status === 'FAULTED') faulted += 1;
          if (status === 'PREPARING' || status === 'CHARGING' || status === 'FINISHING' || status === 'SUSPENDED_EV' || status === 'SUSPENDED_EVSE') charging += 1;
          if (status === 'UNAVAILABLE' || status === 'OFFLINE') offline += 1;
        });
      });

      const totalChargers = chargerStatuses.filter(Boolean).length;

      const analyticsRows = siteAnalyticsRange.filter(Boolean);
      const periodEndMs = Date.now();
      const periodStartMs = periodEndMs - (periodDays * 24 * 60 * 60 * 1000);

      const actualChargingSeconds = chargerSessions
        .flat()
        .reduce((sum, session) => {
          const startMs = new Date(session.startedAt).getTime();
          const stopMs = session.stoppedAt ? new Date(session.stoppedAt).getTime() : periodEndMs;
          const overlapStart = Math.max(startMs, periodStartMs);
          const overlapEnd = Math.min(stopMs, periodEndMs);
          if (!Number.isFinite(overlapStart) || !Number.isFinite(overlapEnd) || overlapEnd <= overlapStart) {
            return sum;
          }
          return sum + Math.floor((overlapEnd - overlapStart) / 1000);
        }, 0);

      const totalConnectorsForUtil = siteDetails
        .filter(Boolean)
        .reduce((sum, site) => sum + (site?.chargers.reduce((inner, ch) => inner + ch.connectors.length, 0) ?? 0), 0);

      const totalPossibleChargingSeconds = totalConnectorsForUtil > 0
        ? totalConnectorsForUtil * periodDays * 24 * 60 * 60
        : 0;

      const utilizationRatePct = totalPossibleChargingSeconds > 0
        ? Math.round((actualChargingSeconds / totalPossibleChargingSeconds) * 10000) / 100
        : (() => {
            const totalSessionsInRange = analyticsRows.reduce((sum, a) => sum + (a?.sessionsCount ?? 0), 0);
            return totalSessionsInRange > 0 ? 0.01 : 0;
          })();

      // ── Per-site utilization for top-5 ranking ──
      const chargerToSiteMap = new Map<string, number>();
      siteDetails.filter(Boolean).forEach((site, siteIdx) => {
        site!.chargers.forEach((ch) => { chargerToSiteMap.set(ch.id, siteIdx); });
      });

      const perSiteUtil = data.map((site, siteIdx) => {
        const siteDetail = siteDetails[siteIdx];
        const siteConnCount = siteDetail?.chargers.reduce((s, ch) => s + ch.connectors.length, 0) ?? 0;
        const sitePossibleSec = siteConnCount > 0 ? siteConnCount * periodDays * 24 * 60 * 60 : 0;

        let siteChargingSec = 0;
        chargerIds.forEach((cid, cidIdx) => {
          if (chargerToSiteMap.get(cid) !== siteIdx) return;
          const sessions = chargerSessions[cidIdx] ?? [];
          sessions.forEach((session) => {
            const startMs = new Date(session.startedAt).getTime();
            const stopMs = session.stoppedAt ? new Date(session.stoppedAt).getTime() : periodEndMs;
            const overlapStart = Math.max(startMs, periodStartMs);
            const overlapEnd = Math.min(stopMs, periodEndMs);
            if (Number.isFinite(overlapStart) && Number.isFinite(overlapEnd) && overlapEnd > overlapStart) {
              siteChargingSec += Math.floor((overlapEnd - overlapStart) / 1000);
            }
          });
        });

        const pct = sitePossibleSec > 0
          ? Math.round((siteChargingSec / sitePossibleSec) * 10000) / 100
          : 0;
        return { id: site.id, name: site.name, address: site.address, utilizationPct: pct, chargerCount: siteDetail?.chargers.length ?? 0 };
      });

      setTopUtilizedSites(
        [...perSiteUtil].sort((a, b) => b.utilizationPct - a.utilizationPct).slice(0, 5),
      );

      setFleetKpis({
        totalSites: data.length,
        totalConnectors,
        totalKwh: Math.round(totalKwh * 1000) / 1000,
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        activeSessions,
        utilizationRatePct,
      });
      setFleetStatus({
        totalChargers,
        totalConnectors,
        available,
        charging,
        faulted,
        offline,
        byStatus: Array.from(statusCountMap.entries())
          .map(([status, count]) => ({ status, count }))
          .sort((a, b) => b.count - a.count),
      });

      const mergedDaily = new Map<string, { sessions: number; kwhDelivered: number; revenueCents: number }>();
      siteAnalyticsRange.filter(Boolean).forEach((analytics) => {
        analytics?.daily.forEach((d: DailyEntry) => {
          const row = mergedDaily.get(d.date) ?? { sessions: 0, kwhDelivered: 0, revenueCents: 0 };
          row.sessions += d.sessions;
          row.kwhDelivered += d.kwhDelivered;
          row.revenueCents += d.revenueCents;
          mergedDaily.set(d.date, row);
        });
      });
      const trendRows = Array.from(mergedDaily.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, row]) => ({
          date,
          label: date.slice(5),
          sessions: row.sessions,
          kwhDelivered: Math.round(row.kwhDelivered * 1000) / 1000,
          revenueUsd: Math.round(row.revenueCents) / 100,
        }));
      setFleetTrend(trendRows);

      const rows = siteUp.filter(Boolean);
      if (rows.length) {
        const avg = (arr: number[]) => Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 100) / 100;
        setFleetUptime({
          uptime24h: avg(rows.map((r) => r!.uptimePercent24h)),
          uptime7d: avg(rows.map((r) => r!.uptimePercent7d)),
          uptime30d: avg(rows.map((r) => r!.uptimePercent30d)),
        });
      } else {
        setFleetUptime(null);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load sites');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getToken, rangePreset, siteId]);


  if (loading) return <PageSkeleton />;

  if (error) {
    return <ErrorState message={error} onRetry={() => { setLoading(true); load(); }} />;
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Overview"
        description="Executive + operational snapshot for daily CPO decision-making across your portfolio."
        actions={
          <div className="flex flex-wrap gap-2">
            <select
              value={siteId}
              onChange={(e) => setSiteId(e.target.value)}
              className="rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-gray-700 dark:text-slate-200 focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none transition-colors"
            >
              <option value="">All sites</option>
              {sites.map((site) => (
                <option key={site.id} value={site.id}>{site.name}</option>
              ))}
            </select>
            <select
              value={rangePreset}
              onChange={(e) => setRangePreset(e.target.value as '7d' | '30d' | '60d')}
              className="rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-gray-700 dark:text-slate-200 focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none transition-colors"
            >
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
              <option value="60d">Last 60 days</option>
            </select>
          </div>
        }
      />

      {/* ── Hero KPIs — single row of 6 tiles ── */}
      {fleetKpis && (
        <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
          <StatCard
            label={`Energy (${rangePreset})`}
            value={`${fleetKpis.totalKwh.toFixed(1)} kWh`}
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
              </svg>
            }
          />
          <StatCard
            label={`Revenue (${rangePreset})`}
            value={`$${fleetKpis.totalRevenue.toFixed(2)}`}
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 2v20m5-17H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H7" />
              </svg>
            }
          />
          <StatCard
            label="Active Sessions"
            value={fleetKpis.activeSessions}
            icon={
              <span className="relative flex h-3 w-3">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex h-3 w-3 rounded-full bg-green-500" />
              </span>
            }
          />
          <StatCard label="Total Sites" value={fleetKpis.totalSites} />
          <StatCard label="Total Connectors" value={fleetKpis.totalConnectors} />
          <StatCard
            label={`Utilization (${rangePreset})`}
            value={`${fleetKpis.utilizationRatePct.toFixed(1)}%`}
          />
        </div>
      )}

      {/* ── Fleet Health ── */}
      {fleetStatus && (
        <div className="rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-slate-100">Fleet Health</h2>
            <p className="text-xs text-gray-500 dark:text-slate-400">
              <span className="font-medium text-gray-700 dark:text-slate-300">{fleetStatus.totalChargers}</span> chargers · <span className="font-medium text-gray-700 dark:text-slate-300">{fleetStatus.totalConnectors}</span> connectors
            </p>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <FleetHealthTile
              label="Available"
              count={fleetStatus.available}
              total={fleetStatus.totalConnectors}
              color="emerald"
              icon={
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              }
            />
            <FleetHealthTile
              label="Charging"
              count={fleetStatus.charging}
              total={fleetStatus.totalConnectors}
              color="blue"
              icon={
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
                </svg>
              }
            />
            <FleetHealthTile
              label="Faulted"
              count={fleetStatus.faulted}
              total={fleetStatus.totalConnectors}
              color="red"
              icon={
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              }
            />
            <FleetHealthTile
              label="Offline"
              count={fleetStatus.offline}
              total={fleetStatus.totalConnectors}
              color="gray"
              icon={
                <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
                  <rect x="4" y="16" width="2.75" height="4" rx="0.8" fill="currentColor" opacity="0.95" />
                  <rect x="8.25" y="13" width="2.75" height="7" rx="0.8" fill="currentColor" opacity="0.95" />
                  <rect x="12.5" y="10" width="2.75" height="10" rx="0.8" fill="currentColor" opacity="0.95" />
                  <rect x="16.75" y="7" width="2.75" height="13" rx="0.8" fill="currentColor" opacity="0.95" />
                  <path d="M4 4L20 20" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
                </svg>
              }
            />
          </div>

          {fleetStatus.byStatus
            .filter((entry) => !['AVAILABLE', 'PREPARING', 'CHARGING', 'FINISHING', 'SUSPENDED_EV', 'SUSPENDED_EVSE', 'FAULTED', 'UNAVAILABLE', 'OFFLINE'].includes(entry.status))
            .length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {fleetStatus.byStatus
                .filter((entry) => !['AVAILABLE', 'PREPARING', 'CHARGING', 'FINISHING', 'SUSPENDED_EV', 'SUSPENDED_EVSE', 'FAULTED', 'UNAVAILABLE', 'OFFLINE'].includes(entry.status))
                .map((entry) => (
                  <span key={entry.status} className="rounded-full border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800 px-2.5 py-1 text-xs font-medium text-gray-600 dark:text-slate-400">
                    {entry.status}: <span className="font-semibold tabular-nums">{entry.count}</span>
                  </span>
                ))}
            </div>
          )}
        </div>
      )}

      {/* ── Top Utilized Sites ── */}
      {topUtilizedSites.length > 0 && (
        <div className="rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5">
          <div className="flex items-center justify-between gap-3 mb-3">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-slate-100">Top Utilized Sites ({rangePreset})</h2>
            <a href="/sites" className="text-xs font-medium text-brand-600 dark:text-brand-400 hover:underline">View all →</a>
          </div>
          <div className="space-y-2">
            {topUtilizedSites.slice(0, 3).map((site, idx) => (
              <a
                key={site.id}
                href={`/sites/${site.id}`}
                className="flex items-center gap-3 rounded-lg border border-gray-100 dark:border-slate-700/50 bg-gray-50/50 dark:bg-slate-800/40 px-3 py-2.5 transition-all hover:border-brand-300 hover:bg-brand-50 dark:hover:border-brand-600/50 dark:hover:bg-brand-900/20 hover:shadow-sm"
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gray-200 dark:bg-slate-700 text-xs font-bold text-gray-600 dark:text-slate-300">{idx + 1}</span>
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-gray-900 dark:text-slate-100">
                    {site.name}
                    <span className="ml-2 text-xs font-normal text-gray-500 dark:text-slate-400">
                      · {site.chargerCount} charger{site.chargerCount !== 1 ? 's' : ''}
                    </span>
                  </span>
                  <span className="block truncate text-xs text-gray-500 dark:text-slate-400">{site.address}</span>
                </div>
                <span className="shrink-0 text-sm font-bold tabular-nums text-gray-900 dark:text-slate-100">{site.utilizationPct.toFixed(1)}%</span>
                <div className="hidden w-28 sm:block">
                  <div className="h-2 rounded-full bg-gray-200 dark:bg-slate-700">
                    <div
                      className="h-2 rounded-full bg-emerald-500 dark:bg-emerald-400 transition-all"
                      style={{ width: `${Math.min(site.utilizationPct, 100)}%` }}
                    />
                  </div>
                </div>
              </a>
            ))}
          </div>
        </div>
      )}

      {/* ── Sites Map ── */}
      <DashboardSitesMap sites={siteMapItems} />

      {/* ── Fleet Trend Charts ── */}
      {fleetTrend.length === 0 ? (
        <div className="rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-8 text-center text-sm text-gray-400 dark:text-slate-500">No trend data for selected range.</div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          {/* Energy */}
          <div className="rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
            <div className="flex items-baseline justify-between mb-3">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-slate-400">Energy</p>
                <p className="mt-0.5 text-xl font-bold text-blue-600 dark:text-blue-400">{fleetTrend.reduce((s, d) => s + d.kwhDelivered, 0).toFixed(1)} kWh</p>
              </div>
              <span className="text-[11px] text-gray-400 dark:text-slate-500">{rangePreset}</span>
            </div>
            <div className="h-28">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={fleetTrend} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="fleetKwhGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="#3b82f6" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="label" hide tick={false} />
                  <YAxis hide tick={false} />
                  <Tooltip contentStyle={{ backgroundColor: isDark ? '#1e293b' : '#fff', border: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`, color: isDark ? '#f1f5f9' : '#1e293b', fontSize: 12, borderRadius: 8, padding: '6px 10px' }} formatter={(v: number) => [`${v.toFixed(1)} kWh`, 'Energy']} labelFormatter={(l) => l} />
                  <Area type="monotone" dataKey="kwhDelivered" stroke="#3b82f6" strokeWidth={2} fill="url(#fleetKwhGrad)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <div className="flex justify-between text-[10px] text-gray-400 dark:text-slate-500 mt-1 px-0.5">
              <span>{fleetTrend[0]?.label}</span>
              <span>{fleetTrend[fleetTrend.length - 1]?.label}</span>
            </div>
          </div>

          {/* Revenue */}
          <div className="rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
            <div className="flex items-baseline justify-between mb-3">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-slate-400">Revenue</p>
                <p className="mt-0.5 text-xl font-bold text-emerald-600 dark:text-emerald-400">${fleetTrend.reduce((s, d) => s + d.revenueUsd, 0).toFixed(2)}</p>
              </div>
              <span className="text-[11px] text-gray-400 dark:text-slate-500">{rangePreset}</span>
            </div>
            <div className="h-28">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={fleetTrend} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="fleetRevGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#10b981" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="#10b981" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="label" hide tick={false} />
                  <YAxis hide tick={false} />
                  <Tooltip contentStyle={{ backgroundColor: isDark ? '#1e293b' : '#fff', border: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`, color: isDark ? '#f1f5f9' : '#1e293b', fontSize: 12, borderRadius: 8, padding: '6px 10px' }} formatter={(v: number) => [`$${v.toFixed(2)}`, 'Revenue']} labelFormatter={(l) => l} />
                  <Area type="monotone" dataKey="revenueUsd" stroke="#10b981" strokeWidth={2} fill="url(#fleetRevGrad)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <div className="flex justify-between text-[10px] text-gray-400 dark:text-slate-500 mt-1 px-0.5">
              <span>{fleetTrend[0]?.label}</span>
              <span>{fleetTrend[fleetTrend.length - 1]?.label}</span>
            </div>
          </div>

          {/* Sessions */}
          <div className="rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
            <div className="flex items-baseline justify-between mb-3">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-slate-400">Sessions</p>
                <p className="mt-0.5 text-xl font-bold text-amber-600 dark:text-amber-400">{fleetTrend.reduce((s, d) => s + d.sessions, 0)}</p>
              </div>
              <span className="text-[11px] text-gray-400 dark:text-slate-500">{rangePreset}</span>
            </div>
            <div className="h-28">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={fleetTrend} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
                  <XAxis dataKey="label" hide tick={false} />
                  <YAxis hide tick={false} />
                  <Tooltip contentStyle={{ backgroundColor: isDark ? '#1e293b' : '#fff', border: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`, color: isDark ? '#f1f5f9' : '#1e293b', fontSize: 12, borderRadius: 8, padding: '6px 10px' }} formatter={(v: number) => [v, 'Sessions']} labelFormatter={(l) => l} cursor={{ fill: 'transparent' }} />
                  <Bar dataKey="sessions" fill="#f59e0b" opacity={0.8} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="flex justify-between text-[10px] text-gray-400 dark:text-slate-500 mt-1 px-0.5">
              <span>{fleetTrend[0]?.label}</span>
              <span>{fleetTrend[fleetTrend.length - 1]?.label}</span>
            </div>
          </div>
        </div>
      )}

      {/* ── Fleet Uptime ── */}
      {fleetUptime && (
        <div className="rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-slate-100 mb-3">Fleet Uptime (OCA v1.1)</h2>
          <div className="grid gap-4 sm:grid-cols-3">
            <UptimeTile label="24h" value={fleetUptime.uptime24h} />
            <UptimeTile label="7d" value={fleetUptime.uptime7d} />
            <UptimeTile label="30d" value={fleetUptime.uptime30d} />
          </div>
        </div>
      )}
    </div>
  );
}

const healthColorMap: Record<string, { ring: string; bg: string; text: string; bar: string }> = {
  emerald: {
    ring: 'ring-emerald-100 dark:ring-emerald-900/40',
    bg: 'bg-emerald-50 dark:bg-emerald-900/20',
    text: 'text-emerald-600 dark:text-emerald-400',
    bar: 'bg-emerald-500',
  },
  blue: {
    ring: 'ring-blue-100 dark:ring-blue-900/40',
    bg: 'bg-blue-50 dark:bg-blue-900/20',
    text: 'text-blue-600 dark:text-blue-400',
    bar: 'bg-blue-500',
  },
  red: {
    ring: 'ring-red-100 dark:ring-red-900/40',
    bg: 'bg-red-50 dark:bg-red-900/20',
    text: 'text-red-600 dark:text-red-400',
    bar: 'bg-red-500',
  },
  gray: {
    ring: 'ring-gray-100 dark:ring-slate-700/40',
    bg: 'bg-gray-50 dark:bg-slate-800/60',
    text: 'text-gray-500 dark:text-slate-400',
    bar: 'bg-gray-400 dark:bg-slate-500',
  },
};

function FleetHealthTile({ label, count, total, color, icon }: { label: string; count: number; total: number; color: string; icon: React.ReactNode }) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  const c = healthColorMap[color] ?? healthColorMap.gray;
  return (
    <div className={cn('rounded-xl p-4 ring-1', c.ring, c.bg)}>
      <div className="flex items-center gap-2 mb-2">
        <span className={cn(c.text, '[&_svg]:stroke-current [&_svg]:fill-none')}>{icon}</span>
        <span className={cn('text-xs font-medium', c.text)}>{label}</span>
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className={cn('text-2xl font-bold tabular-nums', c.text)}>{count}</span>
        <span className="text-xs text-gray-400 dark:text-slate-500">/ {total}</span>
      </div>
      <div className="mt-2 h-1.5 rounded-full bg-gray-200 dark:bg-slate-700 overflow-hidden">
        <div className={cn('h-full rounded-full transition-all', c.bar)} style={{ width: `${pct}%` }} />
      </div>
      <span className="mt-1 block text-[10px] font-medium text-gray-400 dark:text-slate-500">{pct}%</span>
    </div>
  );
}

function UptimeTile({ label, value }: { label: string; value: number }) {
  const color = value >= 99 ? 'text-emerald-600 dark:text-emerald-400' : value >= 95 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400';
  return (
    <div className="rounded-lg bg-gray-50 dark:bg-slate-800/60 p-3">
      <p className="text-xs text-gray-500 dark:text-slate-400">{label}</p>
      <p className={cn('text-xl font-bold tabular-nums mt-0.5', color)}>{value.toFixed(2)}%</p>
    </div>
  );
}
