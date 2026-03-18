import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  CartesianGrid,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import {
  createApiClient,
  type Analytics,
  type ChargerInfo,
  type EnrichedTransaction,
  type PortfolioSummaryResponse,
  type RebateInterval,
  type SiteListItem,
} from '../api/client';
import { useToken } from '../auth/TokenContext';
import { usePortalTheme } from '../theme/ThemeContext';

type TimeFilter = '7d' | '30d' | '60d' | 'custom';

type DailyMerged = { date: string; sessions: number; kwhDelivered: number; revenueCents: number };

const ENABLE_EVC_PLATFORM_BUSINESS_VIEWS = import.meta.env.VITE_EVC_PLATFORM_BUSINESS_VIEWS === '1';

export default function FleetAnalytics() {
  const getToken = useToken();
  const { theme } = usePortalTheme();
  const isDark = theme === 'dark';
  const chartColors = {
    grid: isDark ? '#334155' : '#e2e8f0',
    tick: isDark ? '#94a3b8' : '#64748b',
    tooltip: isDark
      ? { backgroundColor: '#1e293b', border: '1px solid #334155', color: '#f1f5f9' }
      : { backgroundColor: '#ffffff', border: '1px solid #e2e8f0', color: '#1e293b' },
  };
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [sites, setSites] = useState<SiteListItem[]>([]);
  const [analyticsBySite, setAnalyticsBySite] = useState<Record<string, Analytics>>({});
  const [chargersBySite, setChargersBySite] = useState<Record<string, ChargerInfo[]>>({});

  const [portfolioSummary, setPortfolioSummary] = useState<PortfolioSummaryResponse | null>(null);
  const [enrichedTransactions, setEnrichedTransactions] = useState<EnrichedTransaction[]>([]);
  const [rebateIntervals, setRebateIntervals] = useState<RebateInterval[]>([]);

  const [timeFilter, setTimeFilter] = useState<TimeFilter>('30d');
  const [siteFilter, setSiteFilter] = useState<'all' | string>('all');
  const [orgFilter, setOrgFilter] = useState<'all' | string>('all');
  const [portfolioFilter, setPortfolioFilter] = useState<'all' | string>('all');
  const [chargerFilter, setChargerFilter] = useState<'all' | string>('all');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  useEffect(() => {
    async function load() {
      try {
        const token = await getToken();
        const api = createApiClient(token);
        const siteRows = await api.getSites();
        setSites(siteRows);

        const periodDays = timeFilter === '7d' ? 7 : timeFilter === '60d' ? 60 : 30;
        const rangeParams = timeFilter === 'custom' && startDate && endDate
          ? { startDate, endDate }
          : { periodDays };

        const analyticsRows = await Promise.all(
          siteRows.map((s) =>
            api
              .getAnalytics(s.id, rangeParams)
              .then((a) => [s.id, a] as const),
          ),
        );
        setAnalyticsBySite(Object.fromEntries(analyticsRows));

        const details = await Promise.all(siteRows.map((s) => api.getSite(s.id).then((d) => [s.id, d.chargers] as const)));
        setChargersBySite(Object.fromEntries(details));

        if (ENABLE_EVC_PLATFORM_BUSINESS_VIEWS) {
          const readModelRange = timeFilter === 'custom' && startDate && endDate
            ? { startDate, endDate }
            : undefined;

          const [portfolioResult, txResult, rebateResult] = await Promise.allSettled([
            api.getPortfolioSummary(readModelRange),
            api.getEnrichedTransactions({ ...(readModelRange ?? {}), limit: 5000, offset: 0 }),
            api.getRebateIntervals({ ...(readModelRange ?? {}), limit: 5000, offset: 0 }),
          ]);

          setPortfolioSummary(portfolioResult.status === 'fulfilled' ? portfolioResult.value : null);
          setEnrichedTransactions(txResult.status === 'fulfilled' ? txResult.value.transactions : []);
          setRebateIntervals(rebateResult.status === 'fulfilled' ? rebateResult.value.intervals : []);
        } else {
          setPortfolioSummary(null);
          setEnrichedTransactions([]);
          setRebateIntervals([]);
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to load analytics');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [getToken, timeFilter, startDate, endDate]);

  useEffect(() => {
    setChargerFilter('all');
  }, [siteFilter]);

  const filteredSites = useMemo(() => {
    const source = portfolioSummary?.sites?.length
      ? siteRowsFromPortfolio(sites, portfolioSummary)
      : sites;

    return source.filter((s) => {
      const orgOk = orgFilter === 'all' || (s.organizationName ?? '') === orgFilter;
      const portfolioOk = portfolioFilter === 'all' || (s.portfolioName ?? '') === portfolioFilter;
      const siteOk = siteFilter === 'all' || s.id === siteFilter;
      return orgOk && portfolioOk && siteOk;
    });
  }, [sites, portfolioSummary, orgFilter, portfolioFilter, siteFilter]);

  const selectedSiteIds = useMemo(() => filteredSites.map((s) => s.id), [filteredSites]);

  const filteredTransactions = useMemo(() => {
    if (!ENABLE_EVC_PLATFORM_BUSINESS_VIEWS || enrichedTransactions.length === 0) return [] as EnrichedTransaction[];
    return enrichedTransactions.filter((tx) => {
      const siteOk = selectedSiteIds.length === 0 || selectedSiteIds.includes(tx.site.id);
      const chargerOk = chargerFilter === 'all' || tx.charger.id === chargerFilter;
      return siteOk && chargerOk;
    });
  }, [selectedSiteIds, chargerFilter, enrichedTransactions]);

  const merged = useMemo(() => {
    if (filteredTransactions.length > 0) {
      const byDate = new Map<string, DailyMerged>();
      for (const tx of filteredTransactions) {
        const date = tx.startedAt.slice(0, 10);
        const row = byDate.get(date) ?? { date, sessions: 0, kwhDelivered: 0, revenueCents: 0 };
        row.sessions += 1;
        row.kwhDelivered += tx.energyKwh ?? 0;
        row.revenueCents += Math.round((tx.revenueUsd ?? 0) * 100);
        byDate.set(date, row);
      }
      return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
    }

    const map = new Map<string, DailyMerged>();
    for (const siteId of selectedSiteIds) {
      const data = analyticsBySite[siteId];
      if (!data) continue;
      for (const d of data.daily) {
        const row = map.get(d.date) ?? { date: d.date, sessions: 0, kwhDelivered: 0, revenueCents: 0 };
        row.sessions += d.sessions;
        row.kwhDelivered += d.kwhDelivered;
        row.revenueCents += d.revenueCents;
        map.set(d.date, row);
      }
    }
    return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
  }, [selectedSiteIds, analyticsBySite, filteredTransactions]);

  const summary = useMemo(() => {
    const sessionsCount = merged.reduce((sum, d) => sum + d.sessions, 0);
    const kwhDelivered = merged.reduce((sum, d) => sum + d.kwhDelivered, 0);
    const revenueUsd = merged.reduce((sum, d) => sum + d.revenueCents, 0) / 100;

    const filteredRebates = rebateIntervals.filter((row) => {
      const siteOk = selectedSiteIds.length === 0 || selectedSiteIds.includes(row.site.id);
      const chargerOk = chargerFilter === 'all' || row.charger.id === chargerFilter;
      return siteOk && chargerOk;
    });

    const totalIntervalMinutes = filteredRebates.reduce((sum, row) => sum + (row.intervalMinutes || 0), 0);
    const weightedPower = totalIntervalMinutes > 0
      ? filteredRebates.reduce((sum, row) => sum + (row.avgPowerKw * row.intervalMinutes), 0) / totalIntervalMinutes
      : 0;

    const utilRows = selectedSiteIds
      .map((siteId) => analyticsBySite[siteId])
      .filter((v): v is Analytics => !!v);
    const totalAvailable = utilRows.reduce((s, r) => s + (r.availableConnectorSeconds || 0), 0);
    const weightedUtil = totalAvailable > 0
      ? utilRows.reduce((s, r) => s + ((r.utilizationRatePct || 0) * (r.availableConnectorSeconds || 0)), 0) / totalAvailable
      : (utilRows.length ? utilRows.reduce((s, r) => s + (r.utilizationRatePct || 0), 0) / utilRows.length : 0);
    const weightedUptime = totalAvailable > 0
      ? utilRows.reduce((s, r) => s + ((r.uptimePct || 0) * (r.availableConnectorSeconds || 0)), 0) / totalAvailable
      : (utilRows.length ? utilRows.reduce((s, r) => s + (r.uptimePct || 0), 0) / utilRows.length : 0);

    const utilizationRatePct = weightedUtil > 0
      ? weightedUtil
      : (weightedPower > 0 ? Math.min(weightedPower * 5, 100) : (sessionsCount > 0 ? 0.01 : 0));

    const filteredChargers = selectedSiteIds.flatMap((siteId) => (chargersBySite[siteId] ?? []))
      .filter((c) => chargerFilter === 'all' || c.id === chargerFilter);
    const totalChargers = filteredChargers.length;
    const totalConnectors = filteredChargers.reduce((sum, charger) => sum + (charger.connectors?.length ?? 0), 0);

    return {
      sessionsCount,
      kwhDelivered,
      revenueUsd,
      utilizationRatePct,
      uptimePct: weightedUptime,
      totalSites: selectedSiteIds.length,
      totalChargers,
      totalConnectors,
    };
  }, [merged, selectedSiteIds, analyticsBySite, rebateIntervals, chargerFilter, chargersBySite]);

  const chartData = useMemo(
    () =>
      merged.map((d) => ({
        ...d,
        label: d.date.slice(5),
        revenueUsd: d.revenueCents / 100,
      })),
    [merged],
  );

  const chargerOptions = useMemo(() => {
    if (siteFilter === 'all') return [] as ChargerInfo[];
    return chargersBySite[siteFilter] ?? [];
  }, [siteFilter, chargersBySite]);

  const orgOptions = useMemo(() => Array.from(new Set(sites.map((s) => s.organizationName ?? '').filter(Boolean))).sort(), [sites]);
  const portfolioOptions = useMemo(() => Array.from(new Set(sites.map((s) => s.portfolioName ?? '').filter(Boolean))).sort(), [sites]);

  if (loading) return <div className="flex h-64 items-center justify-center text-gray-400 dark:text-slate-500">Loading analytics…</div>;
  if (error) return <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700">{error}</div>;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-slate-400">
            <Link to="/overview" className="hover:text-gray-700 dark:hover:text-slate-200 dark:text-slate-300">Overview</Link>
            <span>/</span>
            <span className="text-gray-900 dark:text-slate-100">Analytics</span>
          </div>
          <h1 className="mt-1 text-2xl font-bold text-gray-900 dark:text-slate-100">Analytics</h1>
          <p className="text-sm text-gray-500 dark:text-slate-400">Monitor charging performance, revenue, and utilization across your network.</p>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-slate-400">DATE RANGE</label>
            <select value={timeFilter} onChange={(e) => setTimeFilter(e.target.value as TimeFilter)} className="rounded-md border border-gray-300 dark:border-slate-600 px-2 py-2 text-sm">
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
              <option value="60d">Last 60 days</option>
              <option value="custom">Custom</option>
            </select>
          </div>
          {timeFilter === 'custom' && (
            <>
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-slate-400">START</label>
                <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="rounded-md border border-gray-300 dark:border-slate-600 px-2 py-2 text-sm" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-slate-400">END</label>
                <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="rounded-md border border-gray-300 dark:border-slate-600 px-2 py-2 text-sm" />
              </div>
            </>
          )}
        </div>
      </div>

      {ENABLE_EVC_PLATFORM_BUSINESS_VIEWS && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          EVC Platform business read-models enabled (dev rollout): portfolio summary, enriched transactions, rebate intervals.
        </div>
      )}

      <div className="rounded-xl border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
        <div className="grid gap-3 md:grid-cols-4">
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-slate-400">Organization</label>
            <select value={orgFilter} onChange={(e) => setOrgFilter(e.target.value)} className="w-full rounded-md border border-gray-300 dark:border-slate-600 px-2 py-2 text-sm">
              <option value="all">All Organizations</option>
              {orgOptions.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-slate-400">Portfolio</label>
            <select value={portfolioFilter} onChange={(e) => setPortfolioFilter(e.target.value)} className="w-full rounded-md border border-gray-300 dark:border-slate-600 px-2 py-2 text-sm">
              <option value="all">All Portfolios</option>
              {portfolioOptions.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-slate-400">Sites</label>
            <select value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)} className="w-full rounded-md border border-gray-300 dark:border-slate-600 px-2 py-2 text-sm">
              <option value="all">All Sites</option>
              {filteredSites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-slate-400">Chargers</label>
            <select value={chargerFilter} onChange={(e) => setChargerFilter(e.target.value)} disabled={siteFilter === 'all'} className="w-full rounded-md border border-gray-300 dark:border-slate-600 px-2 py-2 text-sm disabled:opacity-50">
              <option value="all">All Chargers</option>
              {chargerOptions.map((c) => <option key={c.id} value={c.id}>{c.ocppId}</option>)}
            </select>
          </div>
        </div>

        {timeFilter === 'custom' && (!startDate || !endDate) ? (
          <p className="mt-3 border-t border-gray-100 dark:border-slate-800 pt-3 text-xs text-amber-700">Pick start & end date to apply custom range.</p>
        ) : null}
      </div>

      {siteFilter !== 'all' && chargerFilter !== 'all' && (
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800">
          Charger-level filtering is best-effort in this version because analytics daily aggregates are site-scoped. Site scope is fully enforced.
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        <KpiTile label="Total kWh" value={summary.kwhDelivered.toFixed(1)} />
        <KpiTile label="Total Revenue" value={`$${summary.revenueUsd.toFixed(2)}`} />
        <KpiTile label="Total Sites" value={summary.totalSites.toString()} />
        <KpiTile label="Total Chargers" value={summary.totalChargers.toString()} />
        <KpiTile label="Total Connectors" value={summary.totalConnectors.toString()} />
        <KpiTile label="Utilization" value={`${summary.utilizationRatePct.toFixed(2)}%`} />
        <KpiTile label="Uptime" value={`${summary.uptimePct.toFixed(2)}%`} />
      </div>

      <ChartCard title="Sessions per Day">
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={chartData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: chartColors.tick }} tickLine={false} />
            <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: chartColors.tick }} />
            <Tooltip contentStyle={chartColors.tooltip} formatter={(v: number) => [v, 'Sessions']} labelFormatter={(l) => `Date: ${l}`} />
            <Line type="monotone" dataKey="sessions" stroke="#16a34a" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="kWh Delivered per Day">
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={chartData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: chartColors.tick }} tickLine={false} />
            <YAxis tick={{ fontSize: 11, fill: chartColors.tick }} />
            <Tooltip contentStyle={chartColors.tooltip} formatter={(v: number) => [`${v} kWh`, 'Energy']} labelFormatter={(l) => `Date: ${l}`} />
            <Area type="monotone" dataKey="kwhDelivered" stroke="#2563eb" fill={isDark ? '#1e3a5f' : '#dbeafe'} strokeWidth={2} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Revenue per Day (USD)">
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={chartData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: chartColors.tick }} tickLine={false} />
            <YAxis tick={{ fontSize: 11, fill: chartColors.tick }} tickFormatter={(v) => `$${v}`} />
            <Tooltip contentStyle={chartColors.tooltip} formatter={(v: number) => [`$${v.toFixed(2)}`, 'Revenue']} labelFormatter={(l) => `Date: ${l}`} />
            <Bar dataKey="revenueUsd" fill="#16a34a" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* Site performance breakdown table */}
      <div className="rounded-xl border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-sm">
        <div className="border-b border-gray-300 dark:border-slate-700 px-5 py-4">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-slate-300">Site Performance Breakdown</h3>
          <p className="text-xs text-gray-500 dark:text-slate-400 mt-0.5">Revenue, energy, and utilization per site for the selected period.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/60 text-left text-xs font-medium text-gray-500 dark:text-slate-400">
                <th className="px-5 py-3">Site</th>
                <th className="px-5 py-3">Sessions</th>
                <th className="px-5 py-3">kWh</th>
                <th className="px-5 py-3">Revenue</th>
                <th className="px-5 py-3">Utilization</th>
                <th className="px-5 py-3">Uptime</th>
                <th className="px-5 py-3">Rev / kWh</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 dark:divide-slate-800">
              {filteredSites.map((site) => {
                const a = analyticsBySite[site.id];
                if (!a) return null;
                const revenueUsd = a.revenueCents / 100;
                const revPerKwh = a.kwhDelivered > 0 ? revenueUsd / a.kwhDelivered : 0;
                return (
                  <tr key={site.id} className="hover:bg-gray-50 dark:hover:bg-slate-800 dark:bg-slate-800/60">
                    <td className="px-5 py-3 font-medium text-gray-800 dark:text-slate-200">{site.name}</td>
                    <td className="px-5 py-3 text-gray-600 dark:text-slate-400">{a.sessionsCount}</td>
                    <td className="px-5 py-3 text-gray-600 dark:text-slate-400">{a.kwhDelivered.toFixed(1)}</td>
                    <td className="px-5 py-3 text-gray-600 dark:text-slate-400">${revenueUsd.toFixed(2)}</td>
                    <td className="px-5 py-3 text-gray-600 dark:text-slate-400">{a.utilizationRatePct.toFixed(1)}%</td>
                    <td className="px-5 py-3 text-gray-600 dark:text-slate-400">{a.uptimePct.toFixed(1)}%</td>
                    <td className="px-5 py-3 text-gray-600 dark:text-slate-400">${revPerKwh.toFixed(3)}</td>
                  </tr>
                );
              })}
              {filteredSites.length === 0 && (
                <tr><td colSpan={7} className="px-5 py-8 text-center text-sm text-gray-400 dark:text-slate-500">No sites in selected scope.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Sessions by day of week — recharts BarChart */}
      <ChartCard title="Average Sessions by Day of Week">
        <div className="mb-3 flex items-center gap-4 text-xs text-gray-500 dark:text-slate-400">
          <span>⚡ Avg kWh / Session: <strong className="text-gray-800 dark:text-slate-200">{summary.sessionsCount > 0 ? `${(summary.kwhDelivered / summary.sessionsCount).toFixed(2)} kWh` : '—'}</strong></span>
          <span>📅 Total sessions in period: <strong className="text-gray-800 dark:text-slate-200">{summary.sessionsCount}</strong></span>
        </div>
        <DayOfWeekChart data={merged} />
      </ChartCard>
    </div>
  );
}

function DayOfWeekChart({ data }: { data: Array<{ date: string; sessions: number }> }) {
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const counts = Array(7).fill(0);
  const totals = Array(7).fill(0);
  for (const d of data) {
    const day = new Date(d.date).getDay();
    counts[day] += 1;
    totals[day] += d.sessions;
  }
  const chartData = DAYS.map((day, i) => ({
    day,
    avg: counts[i] > 0 ? +(totals[i] / counts[i]).toFixed(1) : 0,
  }));

  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={chartData} margin={{ top: 8, right: 8, left: -16, bottom: 0 }} barSize={32}>
        <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
        <XAxis dataKey="day" tick={{ fontSize: 12, fill: chartColors.tick }} tickLine={false} axisLine={{ stroke: chartColors.grid, strokeWidth: 1 }} />
        <YAxis tick={{ fontSize: 11, fill: chartColors.tick }} tickLine={false} axisLine={{ stroke: chartColors.grid, strokeWidth: 1 }} allowDecimals={false} />
        <Tooltip
          contentStyle={chartColors.tooltip}
          cursor={{ fill: isDark ? '#1e293b' : '#f3f4f6' }}
          formatter={(v: number) => [`${v}`, 'Avg Sessions']}
          labelFormatter={(l) => `${l}`}
        />
        <Bar dataKey="avg" fill="#2563eb" radius={[4, 4, 0, 0]}>
          {chartData.map((entry, i) => (
            <rect key={i} fill={entry.avg === Math.max(...chartData.map((d) => d.avg)) ? '#16a34a' : '#2563eb'} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

function siteRowsFromPortfolio(source: SiteListItem[], summary: PortfolioSummaryResponse): SiteListItem[] {
  const byId = new Map(source.map((site) => [site.id, site] as const));
  return summary.sites.map((item) => {
    const base = byId.get(item.siteId);
    if (base) {
      return {
        ...base,
        organizationName: item.organizationName,
        portfolioName: item.portfolioName,
      };
    }

    return {
      id: item.siteId,
      name: item.siteName,
      address: '—',
      lat: 0,
      lng: 0,
      organizationName: item.organizationName,
      portfolioName: item.portfolioName,
      createdAt: new Date().toISOString(),
      chargerCount: 0,
      statusSummary: { online: 0, offline: 0, faulted: 0 },
    };
  });
}

function KpiTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2.5">
      <p className="truncate text-[10px] font-medium uppercase tracking-wide text-gray-500 dark:text-slate-400">{label}</p>
      <p className="mt-1 truncate text-lg font-semibold leading-tight text-gray-900 dark:text-slate-100">{value}</p>
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 shadow-sm">
      <h3 className="mb-4 text-sm font-semibold text-gray-700 dark:text-slate-300">{title}</h3>
      {children}
    </div>
  );
}
