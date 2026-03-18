import React, { useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
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
import { createApiClient, type Analytics as AnalyticsType } from '../api/client';
import { useToken } from '../auth/TokenContext';
import { usePortalTheme } from '../theme/ThemeContext';

type TimeFilter = '7d' | '14d' | '30d';
type AnalystRole = 'owner' | 'operator' | 'analyst';

type SavedView = {
  name: string;
  filter: TimeFilter;
};

type ExportJob = {
  id: string;
  createdAt: string;
  role: AnalystRole;
  filter: TimeFilter;
  status: 'queued' | 'complete';
};

function getSavedViewsKey(siteId: string) {
  return `ev-portal:analytics:saved-views:${siteId}`;
}
function getExportQueueKey(siteId: string) {
  return `ev-portal:analytics:export-queue:${siteId}`;
}

function loadSavedViews(siteId: string): SavedView[] {
  try {
    const raw = localStorage.getItem(getSavedViewsKey(siteId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SavedView[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function loadExportQueue(siteId: string): ExportJob[] {
  try {
    const raw = localStorage.getItem(getExportQueueKey(siteId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ExportJob[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistSavedViews(siteId: string, views: SavedView[]) {
  localStorage.setItem(getSavedViewsKey(siteId), JSON.stringify(views.slice(0, 8)));
}

function persistExportQueue(siteId: string, jobs: ExportJob[]) {
  localStorage.setItem(getExportQueueKey(siteId), JSON.stringify(jobs.slice(0, 20)));
}

export default function Analytics() {
  const { id } = useParams<{ id: string }>();
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
  const [data, setData] = useState<AnalyticsType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [timeFilter, setTimeFilter] = useState<TimeFilter>('30d');
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [viewName, setViewName] = useState('');

  const [roleScope, setRoleScope] = useState<AnalystRole>('owner');
  const [exportQueue, setExportQueue] = useState<ExportJob[]>([]);
  const [resolvedSiteId, setResolvedSiteId] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const token = await getToken();
        const client = createApiClient(token);
        const sites = await client.getSites().catch(() => []);
        const matchedSite = sites.find((s) => s.id === id || s.id.startsWith(id ?? ''));
        const siteId = matchedSite?.id ?? id!;
        const result = await client.getAnalytics(siteId);
        setData(result);
        setResolvedSiteId(siteId);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to load analytics');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [id, getToken]);

  useEffect(() => {
    if (!resolvedSiteId) return;
    setSavedViews(loadSavedViews(resolvedSiteId));
    setExportQueue(loadExportQueue(resolvedSiteId));
  }, [resolvedSiteId]);

  const visibleDaily = useMemo(() => {
    if (!data) return [];
    const take = timeFilter === '7d' ? 7 : timeFilter === '14d' ? 14 : 30;
    return data.daily.slice(-take);
  }, [data, timeFilter]);

  const chartData = useMemo(
    () =>
      visibleDaily.map((d) => ({
        ...d,
        label: d.date.slice(5),
        revenueUsd: d.revenueCents / 100,
      })),
    [visibleDaily],
  );

  const summary = useMemo(() => {
    const sessionsCount = visibleDaily.reduce((sum, d) => sum + d.sessions, 0);
    const kwhDelivered = visibleDaily.reduce((sum, d) => sum + d.kwhDelivered, 0);
    const revenueUsd = visibleDaily.reduce((sum, d) => sum + d.revenueCents, 0) / 100;
    return { sessionsCount, kwhDelivered, revenueUsd };
  }, [visibleDaily]);

  const scopedSummary = useMemo(() => {
    if (roleScope === 'owner' || roleScope === 'operator') return summary;
    return {
      sessionsCount: summary.sessionsCount,
      kwhDelivered: summary.kwhDelivered,
      revenueUsd: Number.NaN,
    };
  }, [summary, roleScope]);

  if (loading) {
    return <div className="flex h-64 items-center justify-center text-gray-400 dark:text-slate-500">Loading analytics…</div>;
  }
  if (error || !data) {
    return <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700">{error || 'Failed to load'}</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-slate-400">
          <Link to="/overview" className="hover:text-gray-700 dark:hover:text-slate-200 dark:text-slate-300">Overview</Link>
          <span>/</span>
          <Link to={`/sites/${resolvedSiteId ?? id}`} className="hover:text-gray-700 dark:hover:text-slate-200 dark:text-slate-300">{data.siteName}</Link>
          <span>/</span>
          <span className="text-gray-900 dark:text-slate-100">Analytics</span>
        </div>
        <h1 className="mt-1 text-2xl font-bold text-gray-900 dark:text-slate-100">Analytics — {data.siteName}</h1>
        <p className="text-sm text-gray-500 dark:text-slate-400">Trend filters + saved views + export queue controls</p>
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
        <label className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-slate-400">Range</label>
        <select
          value={timeFilter}
          onChange={(e) => setTimeFilter(e.target.value as TimeFilter)}
          className="rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1 text-sm"
        >
          <option value="7d">Last 7 days</option>
          <option value="14d">Last 14 days</option>
          <option value="30d">Last 30 days</option>
        </select>

        <label className="ml-2 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-slate-400">Role scope</label>
        <select
          value={roleScope}
          onChange={(e) => setRoleScope(e.target.value as AnalystRole)}
          className="rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1 text-sm"
        >
          <option value="analyst">Analyst (no revenue access)</option>
          <option value="operator">Operator</option>
          <option value="owner">Owner</option>
        </select>

        <div className="ml-auto flex items-center gap-2">
          <input
            value={viewName}
            onChange={(e) => setViewName(e.target.value)}
            placeholder="Save current view"
            className="rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1 text-sm"
          />
          <button
            type="button"
            onClick={() => {
              if (!resolvedSiteId || !viewName.trim()) return;
              const next = [{ name: viewName.trim(), filter: timeFilter }, ...savedViews.filter((v) => v.name !== viewName.trim())];
              setSavedViews(next);
              persistSavedViews(resolvedSiteId, next);
              setViewName('');
            }}
            className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700"
          >
            Save view
          </button>
          <button
            type="button"
            onClick={() => {
              if (!resolvedSiteId) return;
              const job: ExportJob = {
                id: crypto.randomUUID(),
                createdAt: new Date().toISOString(),
                role: roleScope,
                filter: timeFilter,
                status: 'queued',
              };
              const next = [job, ...exportQueue];
              setExportQueue(next);
              persistExportQueue(resolvedSiteId, next);
              setTimeout(() => {
                setExportQueue((current) => {
                  const updated = current.map((j) => (j.id === job.id ? { ...j, status: 'complete' as const } : j));
                  persistExportQueue(resolvedSiteId, updated);
                  return updated;
                });
              }, 800);
            }}
            className="rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 dark:bg-slate-800/60"
          >
            Queue export
          </button>
        </div>

        {savedViews.length > 0 && (
          <div className="mt-2 flex w-full flex-wrap gap-2">
            {savedViews.map((view) => (
              <button
                key={view.name}
                type="button"
                onClick={() => setTimeFilter(view.filter)}
                className="rounded-full border border-gray-300 dark:border-slate-600 px-3 py-1 text-xs text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 dark:bg-slate-800/60"
                title={`Apply ${view.filter} filter`}
              >
                {view.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard label="Sessions" value={scopedSummary.sessionsCount.toString()} icon="⚡" />
        <SummaryCard label="kWh Delivered" value={scopedSummary.kwhDelivered.toFixed(1)} icon="🔋" />
        <SummaryCard
          label="Revenue"
          value={Number.isNaN(scopedSummary.revenueUsd) ? 'Restricted' : `$${scopedSummary.revenueUsd.toFixed(2)}`}
          icon="💵"
        />
        <SummaryCard label="Utilization" value={`${Math.max(data.utilizationRatePct, data.sessionsCount > 0 ? 0.01 : 0).toFixed(2)}%`} icon="📶" />
      </div>

      <div className="rounded-xl border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
        <h3 className="mb-2 text-sm font-semibold text-gray-700 dark:text-slate-300">Export/report queue</h3>
        {exportQueue.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-slate-400">No exports queued yet.</p>
        ) : (
          <div className="space-y-2">
            {exportQueue.slice(0, 8).map((job) => (
              <div key={job.id} className="flex items-center justify-between rounded-md border border-gray-300 dark:border-slate-700 px-3 py-2">
                <p className="text-xs text-gray-600 dark:text-slate-400">
                  {new Date(job.createdAt).toLocaleString()} · {job.filter} · {job.role}
                </p>
                <span className={`rounded-full px-2 py-0.5 text-xs ${job.status === 'complete' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}`}>
                  {job.status}
                </span>
              </div>
            ))}
          </div>
        )}
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

      {roleScope !== 'analyst' ? (
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
      ) : (
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800">
          Revenue chart hidden for analyst role scope.
        </div>
      )}
    </div>
  );
}

function SummaryCard({ label, value, icon }: { label: string; value: string; icon: string }) {
  return (
    <div className="rounded-xl border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 shadow-sm">
      <div className="flex items-center gap-3">
        <span className="text-2xl">{icon}</span>
        <div>
          <p className="text-2xl font-bold text-gray-900 dark:text-slate-100">{value}</p>
          <p className="text-xs text-gray-500 dark:text-slate-400">{label}</p>
        </div>
      </div>
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
