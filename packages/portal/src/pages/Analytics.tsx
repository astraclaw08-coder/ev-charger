import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { createApiClient, type Analytics as AnalyticsType } from '../api/client';
import { useToken } from '../auth/TokenContext';

export default function Analytics() {
  const { id } = useParams<{ id: string }>();
  const getToken = useToken();
  const [data, setData] = useState<AnalyticsType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    async function load() {
      try {
        const token = await getToken();
        const result = await createApiClient(token).getAnalytics(id!);
        setData(result);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to load analytics');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [id, getToken]);

  if (loading) {
    return <div className="flex h-64 items-center justify-center text-gray-400">Loading analytics…</div>;
  }
  if (error || !data) {
    return <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700">{error || 'Failed to load'}</div>;
  }

  // Format daily entries for Recharts — short date label
  const chartData = data.daily.map((d) => ({
    ...d,
    label: d.date.slice(5), // "MM-DD"
    revenueUsd: d.revenueCents / 100,
  }));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <Link to="/" className="hover:text-gray-700">Dashboard</Link>
          <span>/</span>
          <Link to={`/sites/${id}`} className="hover:text-gray-700">{data.siteName}</Link>
          <span>/</span>
          <span className="text-gray-900">Analytics</span>
        </div>
        <h1 className="mt-1 text-2xl font-bold text-gray-900">Analytics — {data.siteName}</h1>
        <p className="text-sm text-gray-500">Last 30 days</p>
      </div>

      {/* Summary cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard label="Sessions" value={data.sessionsCount.toString()} icon="⚡" />
        <SummaryCard label="kWh Delivered" value={data.kwhDelivered.toFixed(1)} icon="🔋" />
        <SummaryCard label="Revenue" value={`$${data.revenueUsd.toFixed(2)}`} icon="💵" />
        <SummaryCard label="Uptime" value={`${data.uptimePct}%`} icon="📶" />
      </div>

      {/* Sessions / day chart */}
      <ChartCard title="Sessions per Day">
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={chartData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} />
            <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
            <Tooltip
              formatter={(v: number) => [v, 'Sessions']}
              labelFormatter={(l) => `Date: ${l}`}
            />
            <Line
              type="monotone"
              dataKey="sessions"
              stroke="#16a34a"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* kWh / day chart */}
      <ChartCard title="kWh Delivered per Day">
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={chartData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip
              formatter={(v: number) => [`${v} kWh`, 'Energy']}
              labelFormatter={(l) => `Date: ${l}`}
            />
            <Area
              type="monotone"
              dataKey="kwhDelivered"
              stroke="#2563eb"
              fill="#dbeafe"
              strokeWidth={2}
            />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* Revenue / day chart */}
      <ChartCard title="Revenue per Day (USD)">
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={chartData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} />
            <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `$${v}`} />
            <Tooltip
              formatter={(v: number) => [`$${v.toFixed(2)}`, 'Revenue']}
              labelFormatter={(l) => `Date: ${l}`}
            />
            <Bar dataKey="revenueUsd" fill="#16a34a" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  );
}

function SummaryCard({ label, value, icon }: { label: string; value: string; icon: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex items-center gap-3">
        <span className="text-2xl">{icon}</span>
        <div>
          <p className="text-2xl font-bold text-gray-900">{value}</p>
          <p className="text-xs text-gray-500">{label}</p>
        </div>
      </div>
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

// React import needed for JSX in the same file
import React from 'react';
