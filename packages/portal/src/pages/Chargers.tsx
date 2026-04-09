import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { createApiClient, type ChargerListItem } from '../api/client';
import { useToken } from '../auth/TokenContext';
import { usePortalScope } from '../context/PortalScopeContext';
import StatusBadge from '../components/StatusBadge';
import { PageHeader, StatCard, FilterBar, ErrorState, EmptyState, Pagination } from '../components/ui';
import { StatCardSkeleton, TableSkeleton } from '../components/ui/LoadingState';
import { exportToCsv, type CsvColumn } from '../lib/csvExport';
import usePagination from '../hooks/usePagination';

const CHARGER_CSV_COLUMNS: CsvColumn<ChargerListItem>[] = [
  { header: 'OCPP ID', accessor: (r) => r.ocppId },
  { header: 'Status', accessor: (r) => r.status },
  { header: 'Site', accessor: (r) => r.site.name },
  { header: 'Vendor', accessor: (r) => r.vendor },
  { header: 'Model', accessor: (r) => r.model },
  { header: 'Serial', accessor: (r) => r.serialNumber },
  { header: 'Connectors', accessor: (r) => r.connectors.length },
  { header: 'Last Heartbeat', accessor: (r) => r.lastHeartbeat ?? '' },
];

export default function Chargers() {
  const getToken = useToken();
  const { siteId, setSiteId } = usePortalScope();
  const [rows, setRows] = useState<ChargerListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ONLINE' | 'OFFLINE' | 'FAULTED'>('ALL');
  const [query, setQuery] = useState('');

  async function load() {
    try {
      setError('');
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

  useEffect(() => { load(); }, [getToken]);

  // Sort: faulted first, then offline, then online — attention-priority
  const sorted = useMemo(() => {
    const priority: Record<string, number> = { FAULTED: 0, OFFLINE: 1, ONLINE: 2 };
    return [...rows].sort((a, b) => (priority[a.status] ?? 9) - (priority[b.status] ?? 9));
  }, [rows]);

  const filtered = useMemo(() => {
    const bySite = siteId ? sorted.filter((r) => r.site.id === siteId) : sorted;
    const byStatus = statusFilter === 'ALL' ? bySite : bySite.filter((r) => r.status === statusFilter);

    const q = query.trim().toLowerCase();
    if (!q) return byStatus;

    return byStatus.filter((r) =>
      r.ocppId.toLowerCase().includes(q)
      || r.serialNumber.toLowerCase().includes(q)
      || `${r.vendor} ${r.model}`.toLowerCase().includes(q)
      || r.site.name.toLowerCase().includes(q),
    );
  }, [sorted, statusFilter, siteId, query]);

  const { pageItems, paginationProps } = usePagination(filtered);

  const summary = useMemo(() => ({
    total: rows.length,
    online: rows.filter((r) => r.status === 'ONLINE').length,
    offline: rows.filter((r) => r.status === 'OFFLINE').length,
    faulted: rows.filter((r) => r.status === 'FAULTED').length,
  }), [rows]);

  const siteOptions = useMemo(() =>
    Array.from(new Map(rows.map((r) => [r.site.id, r.site.name])).entries()).map(([id, name]) => ({ value: id, label: name })),
  [rows]);

  if (loading) {
    return (
      <div className="space-y-4">
        <PageHeader title="Chargers" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCardSkeleton /><StatCardSkeleton /><StatCardSkeleton /><StatCardSkeleton />
        </div>
        <TableSkeleton rows={6} columns={6} />
      </div>
    );
  }

  if (error) return <ErrorState message={error} onRetry={() => { setLoading(true); load(); }} />;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Chargers"
        description="Fleet-wide charger inventory, status, and direct drill-down."
        actions={
          <button
            type="button"
            onClick={() => exportToCsv(filtered, CHARGER_CSV_COLUMNS, `chargers-${new Date().toISOString().slice(0, 10)}.csv`)}
            disabled={filtered.length === 0}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title="Export visible chargers as CSV"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5"><path fillRule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clipRule="evenodd" /></svg>
            Export CSV
          </button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total" value={summary.total} />
        <StatCard label="Online" value={summary.online} icon={<span className="h-2.5 w-2.5 rounded-full bg-green-500" />} />
        <StatCard label="Offline" value={summary.offline} icon={<span className="h-2.5 w-2.5 rounded-full bg-gray-400" />} />
        <StatCard
          label="Faulted"
          value={summary.faulted}
          className={summary.faulted > 0 ? '!border-red-200 dark:!border-red-500/20' : ''}
          icon={summary.faulted > 0
            ? <span className="relative flex h-2.5 w-2.5"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" /><span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" /></span>
            : <span className="h-2.5 w-2.5 rounded-full bg-red-500" />
          }
        />
      </div>

      <div className="rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5">
        <FilterBar
          searchValue={query}
          onSearchChange={setQuery}
          searchPlaceholder="Search charger, serial, model, or site…"
          filters={[
            {
              id: 'site',
              label: 'Site',
              value: siteId,
              onChange: setSiteId,
              options: [{ value: '', label: 'All sites' }, ...siteOptions],
            },
            {
              id: 'status',
              label: 'Status',
              value: statusFilter,
              onChange: (v) => setStatusFilter(v as typeof statusFilter),
              options: [
                { value: 'ALL', label: 'All statuses' },
                { value: 'ONLINE', label: 'Online' },
                { value: 'OFFLINE', label: 'Offline' },
                { value: 'FAULTED', label: 'Faulted' },
              ],
            },
          ]}
        />

        {filtered.length === 0 ? (
          <EmptyState
            title="No chargers found"
            description={query || statusFilter !== 'ALL' ? 'Try adjusting your filters.' : 'No chargers registered yet.'}
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-8 w-8">
                <path strokeLinecap="round" strokeLinejoin="round" d="M7 5.5A2.5 2.5 0 0 1 9.5 3h3A2.5 2.5 0 0 1 15 5.5V7h1a2 2 0 0 1 2 2v3.2a2 2 0 0 1-.6 1.4l-1.4 1.4V19a2 2 0 0 1-2 2h-6a2 2 0 0 1-2-2V5.5Z" />
              </svg>
            }
          />
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-gray-500 dark:text-slate-400 border-b border-gray-200 dark:border-slate-700">
                <tr>
                  <th className="pb-3 font-medium">OCPP ID</th>
                  <th className="pb-3 font-medium">Status</th>
                  <th className="pb-3 font-medium">Site</th>
                  <th className="pb-3 font-medium">Model</th>
                  <th className="pb-3 font-medium">Connectors</th>
                  <th className="pb-3 font-medium">Last Heartbeat</th>
                </tr>
              </thead>
              <tbody>
                {pageItems.map((row) => (
                  <tr key={row.id} className="hoverable stagger-item border-t border-gray-100 dark:border-slate-800">
                    <td className="py-3 font-medium">
                      <Link to={`/chargers/${row.id}`} className="text-brand-600 dark:text-brand-400 hover:underline">{row.ocppId}</Link>
                    </td>
                    <td className="py-3"><StatusBadge status={row.status} /></td>
                    <td className="py-3 text-gray-700 dark:text-slate-300">{row.site.name}</td>
                    <td className="py-3 text-gray-600 dark:text-slate-400">{row.vendor} {row.model}</td>
                    <td className="py-3 text-gray-700 dark:text-slate-300">{row.connectors.length}</td>
                    <td className="py-3 text-xs text-gray-500 dark:text-slate-400 tabular-nums">{row.lastHeartbeat ? new Date(row.lastHeartbeat).toLocaleString() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <Pagination {...paginationProps} />
      </div>
    </div>
  );
}
