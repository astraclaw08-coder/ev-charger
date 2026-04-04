import { useEffect, useMemo, useState } from 'react';
import { Modal } from '../components/Modal';
import { createApiClient, type EnrichedTransaction } from '../api/client';
import { useToken } from '../auth/TokenContext';
import { usePortalScope } from '../context/PortalScopeContext';
import { PageHeader, StatCard, FilterBar, ErrorState, EmptyState } from '../components/ui';
import { StatCardSkeleton, TableSkeleton } from '../components/ui/LoadingState';
import { exportToCsv, type CsvColumn } from '../lib/csvExport';

const SESSION_CSV_COLUMNS: CsvColumn<EnrichedTransaction>[] = [
  { header: 'Started', accessor: (r) => r.startedAt },
  { header: 'Stopped', accessor: (r) => r.stoppedAt ?? '' },
  { header: 'Transaction ID', accessor: (r) => r.transactionId ?? '' },
  { header: 'Site', accessor: (r) => r.site.name },
  { header: 'Charger', accessor: (r) => r.charger.ocppId },
  { header: 'Status', accessor: (r) => r.status },
  { header: 'Energy (kWh)', accessor: (r) => r.energyKwh?.toFixed(4) ?? '0' },
  { header: 'Revenue (USD)', accessor: (r) => r.revenueUsd?.toFixed(2) ?? '0' },
  { header: 'idTag', accessor: (r) => r.idTag },
  { header: 'Duration (min)', accessor: (r) => r.durationMinutes ?? '' },
];

export default function Sessions() {
  const getToken = useToken();
  const { siteId, setSiteId, rangePreset, setRangePreset } = usePortalScope();
  const [rows, setRows] = useState<EnrichedTransaction[]>([]);
  const [siteOptions, setSiteOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [query, setQuery] = useState('');
  const [selectedReceipt, setSelectedReceipt] = useState<EnrichedTransaction | null>(null);

  async function load() {
    try {
      setError('');
      const token = await getToken();
      const api = createApiClient(token);
      const days = rangePreset === '7d' ? 7 : rangePreset === '30d' ? 30 : 60;
      const now = new Date();
      const startDate = new Date(now.getTime() - (days * 24 * 60 * 60 * 1000));
      const start = startDate.toISOString().slice(0, 10);
      const end = now.toISOString().slice(0, 10);
      const [sites, data] = await Promise.all([
        api.getSites(),
        api.getEnrichedTransactions({
          limit: 100,
          offset: 0,
          siteId: siteId || undefined,
          startDate: start,
          endDate: end,
        }),
      ]);

      setSiteOptions(sites.map((s) => ({ id: s.id, name: s.name })));

      if (data.transactions.length > 0) {
        setRows(data.transactions);
      } else {
        // Fallback path: derive session feed directly from charger sessions
        const chargers = await api.getChargers();
        const scopedChargers = siteId ? chargers.filter((c) => c.site.id === siteId) : chargers;
        const startMs = new Date(`${start}T00:00:00.000Z`).getTime();
        const endMs = new Date(`${end}T23:59:59.999Z`).getTime();

        const sessionGroups = await Promise.all(
          scopedChargers.map(async (charger) => {
            const sessions = await api.getChargerSessions(charger.id).catch(() => []);
            return sessions.map((session) => {
              const startedMs = new Date(session.startedAt).getTime();
              const stoppedMs = session.stoppedAt ? new Date(session.stoppedAt).getTime() : Date.now();
              const durationMinutes = Math.max(0, Math.round((stoppedMs - startedMs) / 60000));
              const fallbackAmountCents =
                session.effectiveAmountCents
                ?? session.estimatedAmountCents
                ?? session.payment?.amountCents
                ?? 0;

              return {
                id: session.id,
                sessionId: session.id,
                transactionId: session.transactionId,
                idTag: session.idTag,
                status: session.status,
                startedAt: session.startedAt,
                stoppedAt: session.stoppedAt,
                plugInAt: session.plugInAt ?? session.startedAt,
                plugOutAt: session.plugOutAt ?? session.stoppedAt,
                durationMinutes,
                energyKwh: session.kwhDelivered ?? 0,
                revenueUsd: fallbackAmountCents / 100,
                payment: session.payment,
                effectiveAmountCents: session.effectiveAmountCents,
                estimatedAmountCents: session.estimatedAmountCents,
                amountState: session.amountState,
                amountLabel: session.amountLabel,
                isAmountFinal: session.isAmountFinal,
                billingBreakdown: session.billingBreakdown,
                meterStart: null,
                meterStop: null,
                site: {
                  id: charger.site.id,
                  name: charger.site.name,
                  organizationName: null,
                  portfolioName: null,
                },
                charger: {
                  id: charger.id,
                  ocppId: charger.ocppId,
                  serialNumber: charger.serialNumber,
                  model: charger.model,
                  vendor: charger.vendor,
                },
                sourceVersion: 'fallback:charger-sessions',
              } as EnrichedTransaction;
            });
          }),
        );

        const merged = sessionGroups
          .flat()
          .filter((row) => {
            const startedMs = new Date(row.startedAt).getTime();
            return Number.isFinite(startedMs) && startedMs >= startMs && startedMs <= endMs;
          })
          .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
          .slice(0, 100);

        setRows(merged);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load sessions');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { setLoading(true); load(); }, [getToken, siteId, rangePreset]);

  const statuses = useMemo(() => Array.from(new Set(rows.map((r) => r.status))).sort(), [rows]);
  const filtered = useMemo(() => {
    const byStatus = statusFilter === 'ALL' ? rows : rows.filter((r) => r.status === statusFilter);
    const q = query.trim().toLowerCase();
    if (!q) return byStatus;

    return byStatus.filter((r) =>
      r.site.name.toLowerCase().includes(q)
      || r.charger.ocppId.toLowerCase().includes(q)
      || r.idTag.toLowerCase().includes(q)
      || String(r.transactionId ?? '').includes(q)
      || r.status.toLowerCase().includes(q),
    );
  }, [rows, statusFilter, query]);

  const totals = useMemo(() => ({
    count: filtered.length,
    energy: filtered.reduce((sum, r) => sum + (r.energyKwh ?? 0), 0),
    revenue: filtered.reduce((sum, r) => sum + (r.revenueUsd ?? 0), 0),
  }), [filtered]);

  if (loading) {
    return (
      <div className="space-y-4">
        <PageHeader title="Sessions" breadcrumbs={[{ label: 'Overview', href: '/overview' }, { label: 'Sessions' }]} />
        <div className="grid gap-3 sm:grid-cols-3"><StatCardSkeleton /><StatCardSkeleton /><StatCardSkeleton /></div>
        <TableSkeleton rows={6} columns={8} />
      </div>
    );
  }

  if (error) return <ErrorState message={error} onRetry={() => { setLoading(true); load(); }} />;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Sessions"
        breadcrumbs={[{ label: 'Overview', href: '/overview' }, { label: 'Sessions' }]}
        description="Commercial and reliability view of charging session outcomes."
        actions={
          <button
            type="button"
            onClick={() => exportToCsv(filtered, SESSION_CSV_COLUMNS, `sessions-${new Date().toISOString().slice(0, 10)}.csv`)}
            disabled={filtered.length === 0}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title="Export visible sessions as CSV"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5"><path fillRule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clipRule="evenodd" /></svg>
            Export CSV
          </button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Sessions" value={totals.count.toLocaleString()} icon={
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5"><rect x="4" y="3.5" width="16" height="17" rx="2" /><path strokeLinecap="round" d="M8 8h8M8 12h8M8 16h5" /></svg>
        } />
        <StatCard label="Energy (kWh)" value={totals.energy.toFixed(2)} icon={
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5"><path strokeLinecap="round" strokeLinejoin="round" d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" /></svg>
        } />
        <StatCard label="Revenue" value={`$${totals.revenue.toFixed(2)}`} icon={
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5"><path strokeLinecap="round" strokeLinejoin="round" d="M12 2v20m5-17H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H7" /></svg>
        } />
      </div>

      <div className="rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5">
        <FilterBar
          searchValue={query}
          onSearchChange={setQuery}
          searchPlaceholder="Search by site, charger, idTag, tx id, or status…"
          filters={[
            {
              id: 'site', label: 'Site', value: siteId, onChange: setSiteId,
              options: [{ value: '', label: 'All sites' }, ...siteOptions.map((s) => ({ value: s.id, label: s.name }))],
            },
            {
              id: 'range', label: 'Range', value: rangePreset,
              onChange: (v) => setRangePreset(v as '7d' | '30d' | '60d'),
              options: [{ value: '7d', label: 'Last 7d' }, { value: '30d', label: 'Last 30d' }, { value: '60d', label: 'Last 60d' }],
            },
            {
              id: 'status', label: 'Status', value: statusFilter,
              onChange: setStatusFilter,
              options: [{ value: 'ALL', label: 'All statuses' }, ...statuses.map((s) => ({ value: s, label: s }))],
            },
          ]}
        />

        {filtered.length === 0 ? (
          <EmptyState
            title="No sessions found"
            description="Try adjusting your filters or time range."
            icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-8 w-8"><rect x="4" y="3.5" width="16" height="17" rx="2" /><path strokeLinecap="round" d="M8 8h8M8 12h8M8 16h5" /></svg>}
          />
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-gray-500 dark:text-slate-400 border-b border-gray-200 dark:border-slate-700">
                <tr>
                  <th className="pb-3 font-medium">Started</th>
                  <th className="pb-3 font-medium">Tx ID</th>
                  <th className="pb-3 font-medium">Site</th>
                  <th className="pb-3 font-medium">Charger</th>
                  <th className="pb-3 font-medium">Status</th>
                  <th className="pb-3 font-medium">Energy</th>
                  <th className="pb-3 font-medium">Revenue</th>
                  <th className="pb-3 font-medium text-right">Receipt</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => {
                  const isActive = row.status === 'ACTIVE';
                  return (
                    <tr key={row.id} className={`hoverable stagger-item border-t border-gray-100 dark:border-slate-800 ${isActive ? 'bg-brand-50/30 dark:bg-brand-500/5' : ''}`}>
                      <td className="py-3 text-xs font-mono tabular-nums text-gray-500 dark:text-slate-400">{new Date(row.startedAt).toLocaleString()}</td>
                      <td className="py-3 font-mono text-gray-700 dark:text-slate-300">{row.transactionId ?? '—'}</td>
                      <td className="py-3 text-gray-700 dark:text-slate-300">{row.site.name}</td>
                      <td className="py-3 font-medium font-mono text-brand-600 dark:text-brand-400">{row.charger.ocppId}</td>
                      <td className="py-3">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          isActive
                            ? 'bg-brand-100 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300'
                            : row.status === 'COMPLETED'
                              ? 'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-400'
                              : row.status === 'FAULTED'
                                ? 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-400'
                                : 'bg-gray-100 text-gray-600 dark:bg-slate-700 dark:text-slate-400'
                        }`}>{row.status}</span>
                      </td>
                      <td className="py-3 font-mono tabular-nums text-gray-700 dark:text-slate-300">{row.energyKwh.toFixed(2)} kWh</td>
                      <td className="py-3 font-mono tabular-nums text-gray-700 dark:text-slate-300">${row.revenueUsd.toFixed(2)}</td>
                      <td className="py-3 text-right">
                        <button
                          type="button"
                          onClick={() => setSelectedReceipt(row)}
                          className="inline-flex items-center gap-1 rounded-lg border border-gray-200 dark:border-slate-600 px-2.5 py-1 text-xs font-medium text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors"
                          title="View receipt"
                        >
                          🧾 Receipt
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ReceiptModal row={selectedReceipt} onClose={() => setSelectedReceipt(null)} />
    </div>
  );
}

// ── Receipt Modal (extracted inline) ──────────────────────────────────────────
function ReceiptModal({ row, onClose }: { row: EnrichedTransaction | null; onClose: () => void }) {
  if (!row) return null;

  const breakdown = row.billingBreakdown;
  const energySegments = breakdown?.energy.segments ?? [];
  const rawIdleSegments = breakdown?.idle.segments ?? [];
  const idleSegments = rawIdleSegments.filter((seg) => (seg.minutes ?? 0) > 0);
  const totals = breakdown?.totals;
  const energySubtotal = totals?.energyUsd ?? breakdown?.energy.totalUsd ?? 0;
  const idleSubtotal = totals?.idleUsd ?? breakdown?.idle.totalUsd ?? 0;
  const activationFee = totals?.activationUsd ?? breakdown?.activation.totalUsd ?? 0;
  const displayTotal = Number(energySubtotal.toFixed(2)) + Number(idleSubtotal.toFixed(2)) + Number(activationFee.toFixed(2));
  const total = breakdown ? displayTotal : (totals?.grossUsd ?? breakdown?.grossTotalUsd ?? row.revenueUsd ?? totals?.netUsd ?? 0);
  const idleStartLabel = rawIdleSegments.length > 0 ? toTime(rawIdleSegments[0].startedAt) : null;
  const idleEndLabel = rawIdleSegments.length > 0 ? toTime(rawIdleSegments[rawIdleSegments.length - 1].endedAt) : null;
  const idleSubtotalLabel = idleStartLabel && idleEndLabel
    ? `${idleStartLabel} to ${idleEndLabel} Subtotal`
    : 'Idle Subtotal';

  return (
    <Modal open={!!row} onClose={onClose} title="Session Receipt" maxWidth="max-w-2xl">
      <div className="mb-4 space-y-1 text-sm text-gray-600 dark:text-slate-300">
        <p className="text-base font-semibold text-gray-900 dark:text-slate-100">{row.site.name}</p>
        <p>Charger: <span className="font-mono">{row.charger.serialNumber || row.charger.ocppId}</span></p>
        <p>Transaction: <span className="font-mono">#{row.transactionId ?? '—'}</span></p>
      </div>

      <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-slate-700">
        <div className="border-b border-gray-200 dark:border-slate-700 px-4 py-2 text-center text-sm font-semibold text-gray-800 dark:text-slate-100">Session Detail</div>
        <div className="px-4 py-2 text-sm">
          <ReceiptLine label="Plug in" value={new Date(row.plugInAt ?? row.startedAt).toLocaleString()} />
          <ReceiptLine label="Plug out" value={(row.plugOutAt ?? row.stoppedAt) ? new Date((row.plugOutAt ?? row.stoppedAt) as string).toLocaleString() : '—'} />

          {energySegments.map((seg, idx) => (
            <ReceiptLine
              key={`${seg.startedAt}-${idx}`}
              label={`${toTime(seg.startedAt)} to ${toTime(seg.endedAt)} @ $${seg.pricePerKwhUsd.toFixed(2)}/kWh × ${seg.kwh.toFixed(3)} kWh`}
              value={`$${seg.energyAmountUsd.toFixed(2)}`}
            />
          ))}

          <ReceiptLine label="Energy Subtotal" value={`$${energySubtotal.toFixed(2)}`} emphasizeValue />

          {idleSegments.map((seg, idx) => (
            <ReceiptLine
              key={`${seg.startedAt}-${seg.endedAt}-${idx}`}
              label={`${toTime(seg.startedAt)} to ${toTime(seg.endedAt)} × $${seg.idleFeePerMinUsd.toFixed(2)}/min (10 min grace)`}
              value={`$${seg.amountUsd.toFixed(2)}`}
            />
          ))}

          <ReceiptLine label={idleSubtotalLabel} value={`$${idleSubtotal.toFixed(2)}`} emphasizeValue />
          <ReceiptLine label="Activation fee" value={`$${activationFee.toFixed(2)}`} emphasizeValue />
          <ReceiptLine label="Total" value={`$${total.toFixed(2)}`} emphasize />
          <ReceiptLine label="Payment" value={row.payment?.status ?? '—'} />
          <div className="pt-3 text-center text-sm font-medium text-gray-500 dark:text-slate-400">Thank you for charging with us!</div>
        </div>
      </div>
    </Modal>
  );
}

function ReceiptLine({ label, value, emphasize, emphasizeValue }: { label: string; value: string; emphasize?: boolean; emphasizeValue?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-gray-100 dark:border-slate-700/50 py-2 text-xs">
      <span className={`text-gray-600 dark:text-slate-400 ${emphasize ? 'font-semibold text-sm text-gray-900 dark:text-slate-100' : ''}`}>{label}</span>
      <span className={`text-right font-mono tabular-nums ${emphasize ? 'font-bold text-sm text-gray-900 dark:text-slate-100' : emphasizeValue ? 'font-semibold text-gray-800 dark:text-slate-200' : 'text-gray-700 dark:text-slate-300'} min-w-[88px]`}>{value}</span>
    </div>
  );
}

function toTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
