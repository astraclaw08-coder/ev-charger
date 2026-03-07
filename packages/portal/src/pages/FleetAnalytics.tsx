import React, { useEffect, useMemo, useState } from 'react';
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { createApiClient, type Analytics, type ChargerInfo, type SiteListItem } from '../api/client';
import { useToken } from '../auth/TokenContext';

type TimeFilter = '7d' | '30d' | '60d' | 'custom';
type AnalystRole = 'owner' | 'operator' | 'analyst';

type DailyMerged = { date: string; sessions: number; kwhDelivered: number; revenueCents: number };

export default function FleetAnalytics() {
  const getToken = useToken();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [sites, setSites] = useState<SiteListItem[]>([]);
  const [analyticsBySite, setAnalyticsBySite] = useState<Record<string, Analytics>>({});
  const [chargersBySite, setChargersBySite] = useState<Record<string, ChargerInfo[]>>({});

  const [timeFilter, setTimeFilter] = useState<TimeFilter>('30d');
  const [roleScope, setRoleScope] = useState<AnalystRole>('owner');
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
        const analyticsRows = await Promise.all(
          siteRows.map((s) =>
            api
              .getAnalytics(
                s.id,
                timeFilter === 'custom' && startDate && endDate
                  ? { startDate, endDate }
                  : { periodDays },
              )
              .then((a) => [s.id, a] as const),
          ),
        );
        setAnalyticsBySite(Object.fromEntries(analyticsRows));

        const details = await Promise.all(siteRows.map((s) => api.getSite(s.id).then((d) => [s.id, d.chargers] as const)));
        setChargersBySite(Object.fromEntries(details));
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
    return sites.filter((s) => {
      const orgOk = orgFilter === 'all' || (s.organizationName ?? '') === orgFilter;
      const portfolioOk = portfolioFilter === 'all' || (s.portfolioName ?? '') === portfolioFilter;
      const siteOk = siteFilter === 'all' || s.id === siteFilter;
      return orgOk && portfolioOk && siteOk;
    });
  }, [sites, orgFilter, portfolioFilter, siteFilter]);

  const selectedSiteIds = useMemo(() => filteredSites.map((s) => s.id), [filteredSites]);

  const merged = useMemo(() => {
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
  }, [selectedSiteIds, analyticsBySite]);

  const summary = useMemo(() => {
    const sessionsCount = merged.reduce((sum, d) => sum + d.sessions, 0);
    const kwhDelivered = merged.reduce((sum, d) => sum + d.kwhDelivered, 0);
    const revenueUsd = merged.reduce((sum, d) => sum + d.revenueCents, 0) / 100;

    const uptimeRows = selectedSiteIds
      .map((siteId) => analyticsBySite[siteId]?.uptimePct)
      .filter((v): v is number => typeof v === 'number');
    const uptimePct = uptimeRows.length ? uptimeRows.reduce((a, b) => a + b, 0) / uptimeRows.length : 0;

    return { sessionsCount, kwhDelivered, revenueUsd, uptimePct };
  }, [merged, selectedSiteIds, analyticsBySite]);

  const chartData = useMemo(
    () =>
      merged.map((d) => ({
        ...d,
        label: d.date.slice(5),
        revenueUsd: d.revenueCents / 100,
      })),
    [merged],
  );

  const scopedSummary = useMemo(() => {
    if (roleScope === 'owner' || roleScope === 'operator') return summary;
    return { ...summary, revenueUsd: Number.NaN };
  }, [summary, roleScope]);

  const chargerOptions = useMemo(() => {
    if (siteFilter === 'all') return [] as ChargerInfo[];
    return chargersBySite[siteFilter] ?? [];
  }, [siteFilter, chargersBySite]);

  const orgOptions = useMemo(() => Array.from(new Set(sites.map((s) => s.organizationName ?? '').filter(Boolean))).sort(), [sites]);
  const portfolioOptions = useMemo(() => Array.from(new Set(sites.map((s) => s.portfolioName ?? '').filter(Boolean))).sort(), [sites]);

  if (loading) return <div className="flex h-64 items-center justify-center text-gray-400">Loading analytics…</div>;
  if (error) return <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700">{error}</div>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Fleet Analytics</h1>
        <p className="text-sm text-gray-500">Fleet-wide analytics with site and charger filters.</p>
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-gray-200 bg-white p-4">
        <label className="text-xs font-medium uppercase tracking-wide text-gray-500">Range</label>
        <select value={timeFilter} onChange={(e) => setTimeFilter(e.target.value as TimeFilter)} className="rounded-md border border-gray-300 px-2 py-1 text-sm">
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
          <option value="60d">Last 60 days</option>
          <option value="custom">Custom</option>
        </select>

        {timeFilter === 'custom' && (
          <>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="rounded-md border border-gray-300 px-2 py-1 text-sm" />
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="rounded-md border border-gray-300 px-2 py-1 text-sm" />
            {!startDate || !endDate ? <span className="text-xs text-amber-700">Pick start & end date to apply custom range.</span> : null}
          </>
        )}

        <label className="ml-2 text-xs font-medium uppercase tracking-wide text-gray-500">Organization</label>
        <select value={orgFilter} onChange={(e) => setOrgFilter(e.target.value)} className="rounded-md border border-gray-300 px-2 py-1 text-sm">
          <option value="all">All Organizations</option>
          {orgOptions.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>

        <label className="ml-2 text-xs font-medium uppercase tracking-wide text-gray-500">Portfolio</label>
        <select value={portfolioFilter} onChange={(e) => setPortfolioFilter(e.target.value)} className="rounded-md border border-gray-300 px-2 py-1 text-sm">
          <option value="all">All Portfolios</option>
          {portfolioOptions.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>

        <label className="ml-2 text-xs font-medium uppercase tracking-wide text-gray-500">Site</label>
        <select value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)} className="rounded-md border border-gray-300 px-2 py-1 text-sm">
          <option value="all">All Sites</option>
          {filteredSites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>

        <label className="ml-2 text-xs font-medium uppercase tracking-wide text-gray-500">Charger</label>
        <select value={chargerFilter} onChange={(e) => setChargerFilter(e.target.value)} disabled={siteFilter === 'all'} className="rounded-md border border-gray-300 px-2 py-1 text-sm disabled:opacity-50">
          <option value="all">All Chargers</option>
          {chargerOptions.map((c) => <option key={c.id} value={c.id}>{c.ocppId}</option>)}
        </select>

        <label className="ml-2 text-xs font-medium uppercase tracking-wide text-gray-500">Role scope</label>
        <select value={roleScope} onChange={(e) => setRoleScope(e.target.value as AnalystRole)} className="rounded-md border border-gray-300 px-2 py-1 text-sm">
          <option value="analyst">Analyst (no revenue access)</option>
          <option value="operator">Operator</option>
          <option value="owner">Owner</option>
        </select>
      </div>

      {siteFilter !== 'all' && chargerFilter !== 'all' && (
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800">
          Charger-level filtering is best-effort in this version because analytics daily aggregates are site-scoped. Site scope is fully enforced.
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile label="Transactions" value={scopedSummary.sessionsCount.toString()} />
        <KpiTile label="Total kWh" value={scopedSummary.kwhDelivered.toFixed(1)} />
        <KpiTile label="Total Revenue" value={Number.isNaN(scopedSummary.revenueUsd) ? 'Restricted' : `$${scopedSummary.revenueUsd.toFixed(2)}`} />
        <KpiTile label="Uptime" value={`${scopedSummary.uptimePct.toFixed(2)}%`} />
      </div>

      <ChartCard title="Sessions per Day">
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={chartData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
            <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} />
            <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
            <Tooltip formatter={(v: number) => [v, 'Sessions']} labelFormatter={(l) => `Date: ${l}`} />
            <Line type="monotone" dataKey="sessions" stroke="#16a34a" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="kWh Delivered per Day">
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={chartData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
            <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip formatter={(v: number) => [`${v} kWh`, 'Energy']} labelFormatter={(l) => `Date: ${l}`} />
            <Area type="monotone" dataKey="kwhDelivered" stroke="#2563eb" fill="#dbeafe" strokeWidth={2} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      {roleScope !== 'analyst' ? (
        <ChartCard title="Revenue per Day (USD)">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={chartData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
              <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `$${v}`} />
              <Tooltip formatter={(v: number) => [`$${v.toFixed(2)}`, 'Revenue']} labelFormatter={(l) => `Date: ${l}`} />
              <Bar dataKey="revenueUsd" fill="#16a34a" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      ) : (
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800">
          Revenue chart hidden for analyst role scope.
        </div>
      )}
    </div>
  );
}

function KpiTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-gray-900">{value}</p>
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <h3 className="mb-4 text-sm font-semibold text-gray-700">{title}</h3>
      {children}
    </div>
  );
}
