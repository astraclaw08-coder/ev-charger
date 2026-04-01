import { useState, useEffect } from 'react';
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
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
  const [topUtilizedSites, setTopUtilizedSites] = useState<Array<{ id: string; name: string; utilizationPct: number; chargerCount: number }>>([]);
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
        return { id: site.id, name: site.name, utilizationPct: pct, chargerCount: siteDetail?.chargers.length ?? 0 };
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

      {/* ── Hero KPIs ── */}
      {fleetKpis && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {/* Primary hero metrics — larger */}
          <StatCard
            label={`Total Revenue (${rangePreset})`}
            value={`$${fleetKpis.totalRevenue.toFixed(2)}`}
            className="sm:col-span-1 lg:row-span-2 !p-6"
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 2v20m5-17H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H7" />
              </svg>
            }
          />
          <StatCard
            label={`Energy Delivered (${rangePreset})`}
            value={`${fleetKpis.totalKwh.toFixed(1)} kWh`}
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
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

      {/* ── Connector Status Bar ── */}
      {fleetStatus && (
        <div className="rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-slate-100">Connector Status</h2>
            <p className="text-xs text-gray-500 dark:text-slate-400">
              <span className="font-mono font-medium text-gray-700 dark:text-slate-300">{fleetStatus.totalChargers}</span> chargers · <span className="font-mono font-medium text-gray-700 dark:text-slate-300">{fleetStatus.totalConnectors}</span> connectors
            </p>
          </div>

          {/* Status bar visualization */}
          {fleetStatus.totalConnectors > 0 && (
            <div className="mb-3 flex h-3 rounded-full overflow-hidden bg-gray-100 dark:bg-slate-800">
              {fleetStatus.available > 0 && (
                <div className="bg-emerald-500" style={{ width: `${(fleetStatus.available / fleetStatus.totalConnectors) * 100}%` }} title={`Available: ${fleetStatus.available}`} />
              )}
              {fleetStatus.charging > 0 && (
                <div className="bg-brand-500" style={{ width: `${(fleetStatus.charging / fleetStatus.totalConnectors) * 100}%` }} title={`Charging: ${fleetStatus.charging}`} />
              )}
              {fleetStatus.faulted > 0 && (
                <div className="bg-red-500" style={{ width: `${(fleetStatus.faulted / fleetStatus.totalConnectors) * 100}%` }} title={`Faulted: ${fleetStatus.faulted}`} />
              )}
              {fleetStatus.offline > 0 && (
                <div className="bg-gray-400 dark:bg-slate-500" style={{ width: `${(fleetStatus.offline / fleetStatus.totalConnectors) * 100}%` }} title={`Offline: ${fleetStatus.offline}`} />
              )}
            </div>
          )}

          <div className="flex flex-wrap gap-4 text-sm">
            <StatusDot color="bg-emerald-500" label="Available" count={fleetStatus.available} />
            <StatusDot color="bg-brand-500" label="Charging" count={fleetStatus.charging} />
            <StatusDot color="bg-red-500" label="Faulted" count={fleetStatus.faulted} />
            <StatusDot color="bg-gray-400 dark:bg-slate-500" label="Offline" count={fleetStatus.offline} />
          </div>

          {fleetStatus.byStatus
            .filter((entry) => !['AVAILABLE', 'PREPARING', 'CHARGING', 'FINISHING', 'SUSPENDED_EV', 'SUSPENDED_EVSE', 'FAULTED', 'UNAVAILABLE', 'OFFLINE'].includes(entry.status))
            .length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {fleetStatus.byStatus
                .filter((entry) => !['AVAILABLE', 'PREPARING', 'CHARGING', 'FINISHING', 'SUSPENDED_EV', 'SUSPENDED_EVSE', 'FAULTED', 'UNAVAILABLE', 'OFFLINE'].includes(entry.status))
                .map((entry) => (
                  <span key={entry.status} className="rounded-full border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800 px-2.5 py-1 text-xs font-medium text-gray-600 dark:text-slate-400">
                    {entry.status}: <span className="font-mono">{entry.count}</span>
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
            {topUtilizedSites.map((site, idx) => (
              <a
                key={site.id}
                href={`/sites/${site.id}`}
                className="flex items-center gap-3 rounded-lg border border-gray-100 dark:border-slate-700/50 bg-gray-50/50 dark:bg-slate-800/40 px-3 py-2.5 transition-all hover:border-brand-300 hover:bg-brand-50 dark:hover:border-brand-600/50 dark:hover:bg-brand-900/20 hover:shadow-sm"
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gray-200 dark:bg-slate-700 text-xs font-bold font-mono text-gray-600 dark:text-slate-300">{idx + 1}</span>
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-gray-900 dark:text-slate-100">{site.name}</span>
                  <span className="text-xs text-gray-500 dark:text-slate-400">{site.chargerCount} charger{site.chargerCount !== 1 ? 's' : ''}</span>
                </div>
                <span className="shrink-0 text-sm font-bold font-mono tabular-nums text-gray-900 dark:text-slate-100">{site.utilizationPct.toFixed(1)}%</span>
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

      {/* ── Fleet Trend Chart ── */}
      <div className="rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5">
        <div className="flex items-center gap-4 mb-4">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-slate-100">Fleet Trend</h2>
          <div className="flex items-center gap-3 text-xs">
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-blue-500" /> Energy (kWh)</span>
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-emerald-500" /> Revenue ($)</span>
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-amber-500" /> Transactions</span>
          </div>
        </div>

        <div className="h-64">
          {fleetTrend.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-gray-400 dark:text-slate-500">No trend data for selected range.</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={fleetTrend} margin={{ top: 8, right: 16, left: 4, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={grid} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: tick }} />
                <YAxis yAxisId="left" tick={{ fontSize: 11, fill: tick }} />
                <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11, fill: tick }} />
                <Tooltip content={<ChartTooltip formatValue={(v, name) => name === 'Revenue ($)' ? `$${v.toFixed(2)}` : name === 'Energy (kWh)' ? `${v.toFixed(1)} kWh` : String(v)} />} />
                <Bar yAxisId="left" dataKey="kwhDelivered" name="Energy (kWh)" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                <Line yAxisId="right" type="monotone" dataKey="revenueUsd" name="Revenue ($)" stroke="#10b981" strokeWidth={2} dot={false} />
                <Line yAxisId="left" type="monotone" dataKey="sessions" name="Transactions" stroke="#f59e0b" strokeWidth={2} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

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

function StatusDot({ color, label, count }: { color: string; label: string; count: number }) {
  return (
    <span className="flex items-center gap-1.5 text-gray-600 dark:text-slate-400">
      <span className={cn('h-2.5 w-2.5 rounded-full', color)} />
      {label} <span className="font-mono font-medium text-gray-900 dark:text-slate-100">{count}</span>
    </span>
  );
}

function UptimeTile({ label, value }: { label: string; value: number }) {
  const color = value >= 99 ? 'text-emerald-600 dark:text-emerald-400' : value >= 95 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400';
  return (
    <div className="rounded-lg bg-gray-50 dark:bg-slate-800/60 p-3">
      <p className="text-xs text-gray-500 dark:text-slate-400">{label}</p>
      <p className={cn('text-xl font-bold font-mono tabular-nums mt-0.5', color)}>{value.toFixed(2)}%</p>
    </div>
  );
}
