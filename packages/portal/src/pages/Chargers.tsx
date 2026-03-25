import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { createApiClient, type ChargerListItem } from '../api/client';
import { useToken } from '../auth/TokenContext';
import { usePortalScope } from '../context/PortalScopeContext';

export default function Chargers() {
  const getToken = useToken();
  const { siteId, setSiteId } = usePortalScope();
  const [rows, setRows] = useState<ChargerListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ONLINE' | 'DEGRADED' | 'OFFLINE' | 'FAULTED'>('ALL');
  const [query, setQuery] = useState('');

  useEffect(() => {
    async function load() {
      try {
        const token = await getToken();
        const api = createApiClient(token);
        const data = await api.getChargers();
        setRows(data);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to load chargers');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [getToken]);

  const filtered = useMemo(() => {
    const bySite = siteId ? rows.filter((r) => r.site.id === siteId) : rows;
    const byStatus = statusFilter === 'ALL' ? bySite : bySite.filter((r) => r.status === statusFilter);

    const q = query.trim().toLowerCase();
    if (!q) return byStatus;

    return byStatus.filter((r) =>
      r.ocppId.toLowerCase().includes(q)
      || r.serialNumber.toLowerCase().includes(q)
      || `${r.vendor} ${r.model}`.toLowerCase().includes(q)
      || r.site.name.toLowerCase().includes(q),
    );
  }, [rows, statusFilter, siteId, query]);

  const summary = useMemo(() => ({
    total: rows.length,
    online: rows.filter((r) => r.status === 'ONLINE').length,
    degraded: rows.filter((r) => r.status === 'DEGRADED').length,
    offline: rows.filter((r) => r.status === 'OFFLINE').length,
    faulted: rows.filter((r) => r.status === 'FAULTED').length,
  }), [rows]);

  if (loading) return <div className="text-sm text-gray-500 dark:text-slate-400">Loading chargers…</div>;
  if (error) return <div className="rounded-lg bg-red-50 dark:bg-red-900/20 p-4 text-sm text-red-700 dark:text-red-400">{error}</div>;

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-slate-400">
          <Link to="/overview" className="hover:text-gray-700 dark:hover:text-slate-200 dark:text-slate-300">Overview</Link>
          <span>/</span>
          <span className="text-gray-900 dark:text-slate-100">Chargers</span>
        </div>
        <h1 className="mt-1 text-2xl font-bold text-gray-900 dark:text-slate-100">Chargers</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">Fleet-wide charger inventory, status, and direct drill-down.</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label="Total" value={summary.total} />
        <Stat label="Online" value={summary.online} tone="green" />
        <Stat label="Degraded" value={summary.degraded} tone="amber" />
        <Stat label="Offline" value={summary.offline} tone="slate" />
        <Stat label="Faulted" value={summary.faulted} tone="red" />
      </div>

      <div className="rounded-xl border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm font-semibold text-gray-700 dark:text-slate-300">Fleet assets</p>
          <div className="flex flex-wrap gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search charger, serial, model, or site"
              className="min-w-[250px] rounded-md border border-gray-300 dark:border-slate-600 px-3 py-1.5 text-sm"
            />
            <select
              value={siteId}
              onChange={(e) => setSiteId(e.target.value)}
              className="rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5 text-sm"
            >
              <option value="">All sites</option>
              {Array.from(new Map(rows.map((r) => [r.site.id, r.site.name])).entries()).map(([id, name]) => (
                <option key={id} value={id}>{name}</option>
              ))}
            </select>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
              className="rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5 text-sm"
            >
              <option value="ALL">All statuses</option>
              <option value="ONLINE">Online</option>
              <option value="DEGRADED">Degraded</option>
              <option value="OFFLINE">Offline</option>
              <option value="FAULTED">Faulted</option>
            </select>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-gray-500 dark:text-slate-400">
              <tr>
                <th className="pb-2">OCPP ID</th>
                <th className="pb-2">Status</th>
                <th className="pb-2">Site</th>
                <th className="pb-2">Model</th>
                <th className="pb-2">Connectors</th>
                <th className="pb-2">Last heartbeat</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr key={row.id} className="border-t border-gray-300 dark:border-slate-700">
                  <td className="py-2 font-medium">
                    <Link to={`/chargers/${row.id}`} className="hover:text-brand-700 hover:underline">{row.ocppId}</Link>
                  </td>
                  <td className="py-2"><StatusPill status={row.status} /></td>
                  <td className="py-2 text-gray-700 dark:text-slate-300">{row.site.name}</td>
                  <td className="py-2 text-gray-700 dark:text-slate-300">{row.vendor} {row.model}</td>
                  <td className="py-2 text-gray-700 dark:text-slate-300">{row.connectors.length}</td>
                  <td className="py-2 text-gray-500 dark:text-slate-400">{row.lastHeartbeat ? new Date(row.lastHeartbeat).toLocaleString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: ChargerListItem['status'] }) {
  const cls = status === 'ONLINE'
    ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
    : status === 'DEGRADED'
      ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400'
      : status === 'OFFLINE'
        ? 'bg-slate-200 text-slate-700'
        : 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400';

  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{status}</span>;
}

function Stat({ label, value, tone = 'default' }: { label: string; value: number; tone?: 'default' | 'green' | 'amber' | 'slate' | 'red' }) {
  const toneClass = tone === 'green'
    ? 'text-green-700'
    : tone === 'amber'
      ? 'text-amber-700'
      : tone === 'slate'
        ? 'text-slate-700'
        : tone === 'red'
          ? 'text-red-700'
          : 'text-gray-900 dark:text-slate-100';

  return (
    <div className="rounded-xl border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
      <p className="text-xs text-gray-500 dark:text-slate-400">{label}</p>
      <p className={`mt-1 text-xl font-semibold ${toneClass}`}>{value}</p>
    </div>
  );
}
