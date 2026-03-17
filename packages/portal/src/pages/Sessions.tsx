import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { createApiClient, type EnrichedTransaction } from '../api/client';
import { useToken } from '../auth/TokenContext';
import { usePortalScope } from '../context/PortalScopeContext';

export default function Sessions() {
  const getToken = useToken();
  const { siteId, setSiteId, rangePreset, setRangePreset } = usePortalScope();
  const [rows, setRows] = useState<EnrichedTransaction[]>([]);
  const [siteOptions, setSiteOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [query, setQuery] = useState('');

  useEffect(() => {
    async function load() {
      try {
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
          // Fallback path: derive session feed directly from charger sessions so it aligns with Overview/Analytics data sources.
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
                  durationMinutes,
                  energyKwh: session.kwhDelivered ?? 0,
                  revenueUsd: fallbackAmountCents / 100,
                  payment: session.payment,
                  effectiveAmountCents: session.effectiveAmountCents,
                  estimatedAmountCents: session.estimatedAmountCents,
                  amountState: session.amountState,
                  amountLabel: session.amountLabel,
                  isAmountFinal: session.isAmountFinal,
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
    load();
  }, [getToken, siteId, rangePreset]);

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

  if (loading) return <div className="text-sm text-gray-500 dark:text-slate-400">Loading sessions…</div>;
  if (error) return <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700">{error}</div>;

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-slate-400">
          <Link to="/overview" className="hover:text-gray-700 dark:hover:text-slate-200 dark:text-slate-300">Overview</Link>
          <span>/</span>
          <span className="text-gray-900 dark:text-slate-100">Sessions</span>
        </div>
        <h1 className="mt-1 text-2xl font-bold text-gray-900 dark:text-slate-100">Sessions</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">Commercial and reliability view of charging session outcomes.</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Tile label="Sessions" value={totals.count.toLocaleString()} />
        <Tile label="Energy (kWh)" value={totals.energy.toFixed(2)} />
        <Tile label="Revenue" value={`$${totals.revenue.toFixed(2)}`} />
      </div>

      <div className="rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm font-semibold text-gray-700 dark:text-slate-300">Session feed</p>
          <div className="flex flex-wrap gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by site, charger, idTag, tx id, or status"
              className="min-w-[280px] rounded-md border border-gray-300 dark:border-slate-600 px-3 py-1.5 text-sm"
            />
            <select
              value={siteId}
              onChange={(e) => setSiteId(e.target.value)}
              className="rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5 text-sm"
            >
              <option value="">All sites</option>
              {siteOptions.map((site) => (
                <option key={site.id} value={site.id}>{site.name}</option>
              ))}
            </select>
            <select
              value={rangePreset}
              onChange={(e) => setRangePreset(e.target.value as '7d' | '30d' | '60d')}
              className="rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5 text-sm"
            >
              <option value="7d">Last 7d</option>
              <option value="30d">Last 30d</option>
              <option value="60d">Last 60d</option>
            </select>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1.5 text-sm"
            >
              <option value="ALL">All statuses</option>
              {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-gray-500 dark:text-slate-400">
              <tr>
                <th className="pb-2">Started</th>
                <th className="pb-2">Transaction ID</th>
                <th className="pb-2">Site</th>
                <th className="pb-2">Charger</th>
                <th className="pb-2">Status</th>
                <th className="pb-2">Energy</th>
                <th className="pb-2">Revenue</th>
                <th className="pb-2">Payment</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr key={row.id} className="border-t border-gray-200 dark:border-slate-700">
                  <td className="py-2 text-gray-500 dark:text-slate-400">{new Date(row.startedAt).toLocaleString()}</td>
                  <td className="py-2 font-mono text-gray-700 dark:text-slate-300">{row.transactionId ?? '—'}</td>
                  <td className="py-2 text-gray-700 dark:text-slate-300">{row.site.name}</td>
                  <td className="py-2 font-medium text-gray-800 dark:text-slate-200">{row.charger.ocppId}</td>
                  <td className="py-2"><span className="rounded-full bg-gray-100 dark:bg-slate-800 px-2 py-0.5 text-xs font-medium text-gray-700 dark:text-slate-300">{row.status}</span></td>
                  <td className="py-2 text-gray-700 dark:text-slate-300">{row.energyKwh.toFixed(2)} kWh</td>
                  <td className="py-2 text-gray-700 dark:text-slate-300">${row.revenueUsd.toFixed(2)}</td>
                  <td className="py-2 text-gray-500 dark:text-slate-400">{row.payment?.status ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
      <p className="text-xs text-gray-500 dark:text-slate-400">{label}</p>
      <p className="mt-1 text-xl font-semibold text-gray-900 dark:text-slate-100">{value}</p>
    </div>
  );
}
