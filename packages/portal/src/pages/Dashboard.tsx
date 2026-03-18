import { useState, useEffect } from 'react';
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { createApiClient, type DailyEntry, type SiteListItem } from '../api/client';
import DashboardSitesMap, { type DashboardSiteMapItem } from '../components/DashboardSitesMap';
import { useToken } from '../auth/TokenContext';
import { usePortalScope } from '../context/PortalScopeContext';
import { usePortalTheme } from '../theme/ThemeContext';

export default function Dashboard() {
  const { theme } = usePortalTheme();
  const isDark = theme === 'dark';
  const chartColors = {
    grid: isDark ? '#334155' : '#e2e8f0',
    tick: isDark ? '#94a3b8' : '#64748b',
    tooltip: isDark
      ? { backgroundColor: '#1e293b', border: '1px solid #334155', color: '#f1f5f9' }
      : { backgroundColor: '#ffffff', border: '1px solid #e2e8f0', color: '#1e293b' },
  };
  const getToken = useToken();
  const [sites, setSites] = useState<SiteListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [fleetUptime, setFleetUptime] = useState<{ uptime24h: number; uptime7d: number; uptime30d: number } | null>(null);
  const [fleetKpis, setFleetKpis] = useState<{ totalSites: number; totalConnectors: number; totalKwh: number; totalRevenue: number; activeSessions: number; utilizationRatePct: number } | null>(null);
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


  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center text-gray-400 dark:text-slate-500">Loading sites…</div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700">{error}</div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-slate-100">Overview</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">Executive + operational snapshot for daily CPO decision-making across your portfolio.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-slate-400">Portfolio scope</p>
            <select
              value={siteId}
              onChange={(e) => setSiteId(e.target.value)}
              className="mt-1 rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5 text-sm"
            >
              <option value="">All sites</option>
              {sites.map((site) => (
                <option key={site.id} value={site.id}>{site.name}</option>
              ))}
            </select>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-slate-400">KPI time period</p>
            <select
              value={rangePreset}
              onChange={(e) => setRangePreset(e.target.value as '7d' | '30d' | '60d')}
              className="mt-1 rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5 text-sm"
            >
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
              <option value="60d">Last 60 days</option>
            </select>
          </div>
        </div>
      </div>

      {fleetKpis && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <KpiTile label={`Total kWh (${rangePreset})`} value={`${fleetKpis.totalKwh.toFixed(1)}`} />
          <KpiTile label={`Total Revenue (${rangePreset})`} value={`$${fleetKpis.totalRevenue.toFixed(2)}`} />
          <KpiTile label="Total Sites" value={`${fleetKpis.totalSites}`} />
          <KpiTile label="Total Connectors" value={`${fleetKpis.totalConnectors}`} live />
          <KpiTile label="Active Sessions" value={`${fleetKpis.activeSessions}`} live />
          <KpiTile label={`Utilization Rate (${rangePreset})`} value={`${fleetKpis.utilizationRatePct.toFixed(2)}%`} />
        </div>
      )}

      {fleetStatus && (
        <div className="mt-3 rounded-xl border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-semibold text-gray-700 dark:text-slate-300">Connector Statuses</p>
            <p className="text-xs text-gray-500 dark:text-slate-400">
              Chargers: <span className="font-semibold text-gray-900 dark:text-slate-100">{fleetStatus.totalChargers}</span>
              {' · '}
              Connectors: <span className="font-semibold text-gray-900 dark:text-slate-100">{fleetStatus.totalConnectors}</span>
            </p>
          </div>

          <div className="mt-2 text-sm text-gray-700 dark:text-slate-300">
            <span className="font-medium text-emerald-600 dark:text-emerald-400">🟢 Available {fleetStatus.available}</span>
            <span className="mx-2 text-gray-300 dark:text-slate-600">·</span>
            <span className="font-medium text-amber-600 dark:text-amber-400">🟡 Charging {fleetStatus.charging}</span>
            <span className="mx-2 text-gray-300 dark:text-slate-600">·</span>
            <span className="font-medium text-red-600 dark:text-red-400">🔴 Faulted {fleetStatus.faulted}</span>
            <span className="mx-2 text-gray-300 dark:text-slate-600">·</span>
            <span className="font-semibold text-gray-700 dark:text-slate-300">⚫ Offline {fleetStatus.offline}</span>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            {fleetStatus.byStatus
              .filter((entry) => !['AVAILABLE', 'PREPARING', 'CHARGING', 'FINISHING', 'SUSPENDED_EV', 'SUSPENDED_EVSE', 'FAULTED', 'UNAVAILABLE', 'OFFLINE'].includes(entry.status))
              .map((entry) => (
                <span key={entry.status} className="rounded-full border border-gray-300 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/60 px-2.5 py-1 text-xs text-gray-700 dark:text-slate-300">
                  {entry.status}: {entry.count}
                </span>
              ))}
          </div>
        </div>
      )}

      {fleetStatus && (
        <div className="mt-3 rounded-xl border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-gray-700 dark:text-slate-300">Needs action now</p>
            <a href="/operations" className="text-xs font-medium text-brand-700 hover:underline">Open Operations</a>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <ActionTile label="Faulted connectors" value={fleetStatus.faulted} tone="red" />
            <ActionTile label="Offline connectors" value={fleetStatus.offline} tone="slate" />
            <ActionTile label="Active sessions" value={fleetKpis?.activeSessions ?? 0} tone="blue" />
          </div>
        </div>
      )}

      <DashboardSitesMap sites={siteMapItems} />

      <div className="mt-4 rounded-xl border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
        <p className="text-sm font-semibold">
          <span className="text-blue-600">Energy (kWh)</span>
          <span className="text-gray-400 dark:text-slate-500"> | </span>
          <span className="text-emerald-600">Revenue ($)</span>
          <span className="text-gray-400 dark:text-slate-500"> | </span>
          <span className="text-amber-500">Transactions</span>
          <span className="ml-1 text-xs font-normal text-gray-400 dark:text-slate-500">({rangePreset})</span>
        </p>

        <div className="mt-3 h-64">
          {loading ? (
            <div className="h-full animate-pulse rounded-lg bg-gray-100 dark:bg-slate-800" />
          ) : fleetTrend.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-gray-400 dark:text-slate-500">No trend data for selected range.</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={fleetTrend} margin={{ top: 8, right: 16, left: 4, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: chartColors.tick }} />
                <YAxis yAxisId="left" tick={{ fontSize: 11, fill: chartColors.tick }} />
                <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11, fill: chartColors.tick }} />
                <Tooltip contentStyle={chartColors.tooltip} />
                <Bar yAxisId="left" dataKey="kwhDelivered" name="Energy (kWh)" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                <Line yAxisId="right" type="monotone" dataKey="revenueUsd" name="Revenue ($)" stroke="#10b981" strokeWidth={2} dot={false} />
                <Line yAxisId="left" type="monotone" dataKey="sessions" name="Transactions" stroke="#f59e0b" strokeWidth={2} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {fleetUptime && (
        <div className="mt-4 rounded-xl border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
          <p className="text-sm font-semibold text-gray-700 dark:text-slate-300">Fleet uptime summary (OCA v1.1)</p>
          <div className="mt-2 grid gap-3 sm:grid-cols-3">
            <div><p className="text-xs text-gray-500 dark:text-slate-400">24h</p><p className="text-lg font-semibold text-gray-900 dark:text-slate-100">{fleetUptime.uptime24h.toFixed(2)}%</p></div>
            <div><p className="text-xs text-gray-500 dark:text-slate-400">7d</p><p className="text-lg font-semibold text-gray-900 dark:text-slate-100">{fleetUptime.uptime7d.toFixed(2)}%</p></div>
            <div><p className="text-xs text-gray-500 dark:text-slate-400">30d</p><p className="text-lg font-semibold text-gray-900 dark:text-slate-100">{fleetUptime.uptime30d.toFixed(2)}%</p></div>
          </div>
        </div>
      )}

    </div>
  );
}

function KpiTile({ label, value, live }: { label: string; value: string; live?: boolean }) {
  return (
    <div className="rounded-xl border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
      <div className="flex items-center gap-1.5">
        <p className="truncate text-[11px] leading-tight text-gray-500 dark:text-slate-400">{label}</p>
        {live && <span className="inline-block h-1.5 w-1.5 rounded-full bg-green-500" title="Live" />}
      </div>
      <p className="mt-1 truncate text-[clamp(1rem,1.6vw,1.25rem)] font-semibold leading-tight text-gray-900 dark:text-slate-100">{value}</p>
    </div>
  );
}

function ActionTile({ label, value, tone }: { label: string; value: number; tone: 'red' | 'slate' | 'blue' }) {
  const toneClass = tone === 'red'
    ? 'text-red-700 bg-red-50 border-red-200'
    : tone === 'slate'
      ? 'text-slate-700 bg-slate-100 border-slate-300'
      : 'text-brand-700 bg-brand-50 border-brand-200';

  return (
    <div className={`rounded-lg border p-3 ${toneClass}`}>
      <p className="text-xs font-medium">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
    </div>
  );
}

