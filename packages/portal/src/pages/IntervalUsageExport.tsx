import { useCallback, useEffect, useMemo, useState } from 'react';
import { createApiClient } from '../api/client';
import type { SiteListItem, SavedReport, IntervalUsageReportConfig, IntervalUsagePreviewRow } from '../api/client';
import { useToken } from '../auth/TokenContext';

// ─── Helpers ────────────────────────────────────────────────────────────────

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoISO(days: number) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return iso; }
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function IntervalUsageExport() {
  const { token } = useToken();
  const api = useMemo(() => createApiClient(token), [token]);

  // ── Filter state
  const [sites, setSites] = useState<SiteListItem[]>([]);
  const [siteId, setSiteId] = useState('');
  const [chargerIds, setChargerIds] = useState<string[]>([]);
  const [dateRangeType, setDateRangeType] = useState<'relative' | 'fixed'>('relative');
  const [relativeDays, setRelativeDays] = useState(7);
  const [startDate, setStartDate] = useState(daysAgoISO(7));
  const [endDate, setEndDate] = useState(todayISO());
  const [intervalMinutes, setIntervalMinutes] = useState(15);

  // ── Preview state
  const [previewRows, setPreviewRows] = useState<IntervalUsagePreviewRow[]>([]);
  const [previewTotal, setPreviewTotal] = useState(0);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');

  // ── Export state
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');

  // ── Saved reports state
  const [savedReports, setSavedReports] = useState<SavedReport[]>([]);
  const [saveName, setSaveName] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const [editingReportId, setEditingReportId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');

  // ── Charger list for selected site
  const selectedSite = sites.find((s) => s.id === siteId);

  // Derive effective date range
  const effectiveStartDate = dateRangeType === 'relative' ? daysAgoISO(relativeDays) : startDate;
  const effectiveEndDate = dateRangeType === 'relative' ? todayISO() : endDate;

  // ── Load sites + saved reports on mount
  useEffect(() => {
    api.getSites().then(setSites).catch(() => {});
    api.getSavedReports().then(setSavedReports).catch(() => {});
  }, [api]);

  // ── Preview
  const loadPreview = useCallback(async () => {
    setPreviewLoading(true);
    setPreviewError('');
    try {
      const result = await api.getIntervalUsagePreview({
        siteId: siteId || undefined,
        chargerIds: chargerIds.length > 0 ? chargerIds : undefined,
        startDate: effectiveStartDate,
        endDate: effectiveEndDate,
        limit: 50,
      });
      setPreviewRows(result.rows);
      setPreviewTotal(result.total);
    } catch (err: any) {
      setPreviewError(err?.message ?? 'Failed to load preview');
    } finally {
      setPreviewLoading(false);
    }
  }, [api, siteId, chargerIds, effectiveStartDate, effectiveEndDate]);

  // ── Export CSV
  const handleExport = useCallback(async () => {
    setExporting(true);
    setExportError('');
    try {
      await api.exportIntervalUsageCsv({
        siteId: siteId || undefined,
        chargerIds: chargerIds.length > 0 ? chargerIds : undefined,
        startDate: effectiveStartDate,
        endDate: effectiveEndDate,
        intervalMinutes,
      });
    } catch (err: any) {
      setExportError(err?.message ?? 'Export failed');
    } finally {
      setExporting(false);
    }
  }, [api, siteId, chargerIds, effectiveStartDate, effectiveEndDate, intervalMinutes]);

  // ── Build config from current filters
  const buildConfig = useCallback((): IntervalUsageReportConfig => ({
    siteId: siteId || undefined,
    chargerIds: chargerIds.length > 0 ? chargerIds : undefined,
    dateRangeType,
    relativeDays: dateRangeType === 'relative' ? relativeDays : undefined,
    startDate: dateRangeType === 'fixed' ? startDate : undefined,
    endDate: dateRangeType === 'fixed' ? endDate : undefined,
    intervalMinutes,
  }), [siteId, chargerIds, dateRangeType, relativeDays, startDate, endDate, intervalMinutes]);

  // ── Load config into filters
  const loadConfig = useCallback((config: IntervalUsageReportConfig) => {
    setSiteId(config.siteId ?? '');
    setChargerIds(config.chargerIds ?? []);
    setDateRangeType(config.dateRangeType ?? 'relative');
    setRelativeDays(config.relativeDays ?? 7);
    if (config.startDate) setStartDate(config.startDate);
    if (config.endDate) setEndDate(config.endDate);
    setIntervalMinutes(config.intervalMinutes ?? 15);
  }, []);

  // ── Save report
  const handleSave = useCallback(async () => {
    if (!saveName.trim()) { setSaveError('Name is required'); return; }
    setSaving(true);
    setSaveError('');
    try {
      const report = await api.createSavedReport({ name: saveName.trim(), config: buildConfig() });
      setSavedReports((prev) => [report, ...prev]);
      setSaveName('');
    } catch (err: any) {
      setSaveError(err?.message ?? 'Failed to save');
    } finally {
      setSaving(false);
    }
  }, [api, saveName, buildConfig]);

  // ── Update report
  const handleUpdate = useCallback(async (id: string) => {
    setSaveError('');
    try {
      const updated = await api.updateSavedReport(id, {
        name: editingName.trim() || undefined,
        config: buildConfig(),
      });
      setSavedReports((prev) => prev.map((r) => r.id === id ? updated : r));
      setEditingReportId(null);
      setEditingName('');
    } catch (err: any) {
      setSaveError(err?.message ?? 'Failed to update');
    }
  }, [api, editingName, buildConfig]);

  // ── Delete report
  const handleDelete = useCallback(async (id: string) => {
    try {
      await api.deleteSavedReport(id);
      setSavedReports((prev) => prev.filter((r) => r.id !== id));
    } catch { /* ignore */ }
  }, [api]);

  // ── Charger options from selected site
  const [siteChargers, setSiteChargers] = useState<Array<{ id: string; ocppId: string }>>([]);
  useEffect(() => {
    if (!siteId) { setSiteChargers([]); setChargerIds([]); return; }
    api.getSite(siteId).then((site) => {
      setSiteChargers((site as any).chargers?.map((c: any) => ({ id: c.id, ocppId: c.ocppId })) ?? []);
    }).catch(() => setSiteChargers([]));
  }, [api, siteId]);

  // ── Toggle charger selection
  const toggleCharger = (id: string) => {
    setChargerIds((prev) => prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]);
  };

  // ─── Styles ──────────────────────────────────────────────────────────────
  const inputCls = 'rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-gray-900 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 focus:outline-none';
  const btnPrimary = 'rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors';
  const btnSecondary = 'rounded-md border border-gray-300 dark:border-slate-600 px-4 py-2 text-sm font-medium text-gray-700 dark:text-slate-200 hover:bg-gray-50 dark:hover:bg-slate-700 disabled:opacity-50 transition-colors';
  const btnDanger = 'text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 text-xs';
  const labelCls = 'block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1';
  const cardCls = 'rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-4';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Interval Usage Export</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">
          Export 15/30/60-minute interval energy usage data as CSV. Save report configurations for future use.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* ── Left: Filters + Export ──────────────────────────────────── */}
        <div className="lg:col-span-2 space-y-4">
          <div className={cardCls}>
            <h2 className="text-base font-semibold text-gray-900 dark:text-white mb-4">Report Filters</h2>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Site */}
              <div>
                <label className={labelCls}>Site</label>
                <select value={siteId} onChange={(e) => setSiteId(e.target.value)} className={`${inputCls} w-full`}>
                  <option value="">All Sites</option>
                  {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>

              {/* Interval */}
              <div>
                <label className={labelCls}>Interval</label>
                <select value={intervalMinutes} onChange={(e) => setIntervalMinutes(Number(e.target.value))} className={`${inputCls} w-full`}>
                  <option value={15}>15 minutes</option>
                  <option value={30}>30 minutes</option>
                  <option value={60}>1 hour</option>
                </select>
              </div>

              {/* Date range type */}
              <div>
                <label className={labelCls}>Date Range</label>
                <select value={dateRangeType} onChange={(e) => setDateRangeType(e.target.value as 'relative' | 'fixed')} className={`${inputCls} w-full`}>
                  <option value="relative">Relative</option>
                  <option value="fixed">Custom Range</option>
                </select>
              </div>

              {/* Relative days or custom range */}
              {dateRangeType === 'relative' ? (
                <div>
                  <label className={labelCls}>Period</label>
                  <select value={relativeDays} onChange={(e) => setRelativeDays(Number(e.target.value))} className={`${inputCls} w-full`}>
                    <option value={7}>Last 7 days</option>
                    <option value={14}>Last 14 days</option>
                    <option value={30}>Last 30 days</option>
                    <option value={60}>Last 60 days</option>
                    <option value={90}>Last 90 days</option>
                  </select>
                </div>
              ) : (
                <>
                  <div>
                    <label className={labelCls}>Start Date</label>
                    <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className={`${inputCls} w-full`} />
                  </div>
                  <div>
                    <label className={labelCls}>End Date</label>
                    <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className={`${inputCls} w-full`} />
                  </div>
                </>
              )}
            </div>

            {/* Charger multi-select (visible when site selected) */}
            {siteId && siteChargers.length > 0 && (
              <div className="mt-4">
                <label className={labelCls}>Chargers {chargerIds.length > 0 ? `(${chargerIds.length} selected)` : '(all)'}</label>
                <div className="max-h-40 overflow-y-auto rounded-md border border-gray-200 dark:border-slate-600 p-2 space-y-1">
                  {siteChargers.map((c) => (
                    <label key={c.id} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-700 rounded px-2 py-1">
                      <input
                        type="checkbox"
                        checked={chargerIds.includes(c.id)}
                        onChange={() => toggleCharger(c.id)}
                        className="rounded border-gray-300 dark:border-slate-500"
                      />
                      <span className="text-gray-800 dark:text-slate-200 font-mono text-xs">{c.ocppId}</span>
                    </label>
                  ))}
                </div>
                {chargerIds.length > 0 && (
                  <button onClick={() => setChargerIds([])} className="mt-1 text-xs text-blue-600 dark:text-blue-400 hover:underline">
                    Clear selection (use all chargers)
                  </button>
                )}
              </div>
            )}

            {/* Action buttons */}
            <div className="mt-5 flex flex-wrap gap-3">
              <button onClick={loadPreview} disabled={previewLoading} className={btnSecondary}>
                {previewLoading ? 'Loading...' : 'Preview Data'}
              </button>
              <button onClick={handleExport} disabled={exporting} className={btnPrimary}>
                {exporting ? 'Exporting...' : 'Export CSV'}
              </button>
            </div>
            {exportError && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{exportError}</p>}
          </div>

          {/* ── Preview Table ──────────────────────────────────────────── */}
          {(previewRows.length > 0 || previewError) && (
            <div className={cardCls}>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-base font-semibold text-gray-900 dark:text-white">
                  Preview {previewTotal > 0 && <span className="text-sm font-normal text-gray-500 dark:text-slate-400">({previewTotal.toLocaleString()} total rows)</span>}
                </h2>
              </div>
              {previewError ? (
                <p className="text-sm text-red-600 dark:text-red-400">{previewError}</p>
              ) : (
                <div className="overflow-x-auto -mx-4 px-4">
                  <table className="min-w-full text-xs">
                    <thead>
                      <tr className="border-b border-gray-200 dark:border-slate-600 text-left text-gray-500 dark:text-slate-400">
                        <th className="pb-2 pr-3 font-medium">Interval Start</th>
                        <th className="pb-2 pr-3 font-medium">Site</th>
                        <th className="pb-2 pr-3 font-medium">Charger</th>
                        <th className="pb-2 pr-3 font-medium">Conn</th>
                        <th className="pb-2 pr-3 font-medium text-right">kWh</th>
                        <th className="pb-2 pr-3 font-medium text-right">Avg kW</th>
                        <th className="pb-2 pr-3 font-medium text-right">Max kW</th>
                        <th className="pb-2 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody className="text-gray-700 dark:text-slate-300">
                      {previewRows.map((row, i) => (
                        <tr key={i} className="border-b border-gray-100 dark:border-slate-700/50">
                          <td className="py-1.5 pr-3 whitespace-nowrap">{formatDate(row.intervalStart)}</td>
                          <td className="py-1.5 pr-3 whitespace-nowrap">{row.siteName}</td>
                          <td className="py-1.5 pr-3 font-mono">{row.chargerOcppId}</td>
                          <td className="py-1.5 pr-3 text-center">{row.connectorId}</td>
                          <td className="py-1.5 pr-3 text-right tabular-nums">{row.energyKwh.toFixed(4)}</td>
                          <td className="py-1.5 pr-3 text-right tabular-nums">{row.avgPowerKw.toFixed(2)}</td>
                          <td className="py-1.5 pr-3 text-right tabular-nums">{row.maxPowerKw?.toFixed(2) ?? '-'}</td>
                          <td className="py-1.5">{row.portStatus || '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {previewTotal > 50 && (
                    <p className="mt-2 text-xs text-gray-400 dark:text-slate-500">
                      Showing first 50 of {previewTotal.toLocaleString()} rows. Export CSV for full dataset.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Right: Saved Reports ────────────────────────────────────── */}
        <div className="space-y-4">
          <div className={cardCls}>
            <h2 className="text-base font-semibold text-gray-900 dark:text-white mb-3">Saved Reports</h2>

            {/* Save current */}
            <div className="flex gap-2 mb-4">
              <input
                type="text"
                placeholder="Report name..."
                value={saveName}
                onChange={(e) => { setSaveName(e.target.value); setSaveError(''); }}
                className={`${inputCls} flex-1 min-w-0`}
                onKeyDown={(e) => e.key === 'Enter' && handleSave()}
              />
              <button onClick={handleSave} disabled={saving || !saveName.trim()} className={btnPrimary}>
                {saving ? '...' : 'Save'}
              </button>
            </div>
            {saveError && <p className="text-xs text-red-600 dark:text-red-400 mb-3">{saveError}</p>}

            {/* Report list */}
            {savedReports.length === 0 ? (
              <p className="text-sm text-gray-400 dark:text-slate-500">No saved reports yet. Configure filters and save for quick re-use.</p>
            ) : (
              <div className="space-y-2">
                {savedReports.map((report) => (
                  <div
                    key={report.id}
                    className="group rounded-md border border-gray-100 dark:border-slate-700 hover:border-blue-300 dark:hover:border-blue-600 p-3 transition-colors"
                  >
                    {editingReportId === report.id ? (
                      <div className="space-y-2">
                        <input
                          type="text"
                          value={editingName}
                          onChange={(e) => setEditingName(e.target.value)}
                          className={`${inputCls} w-full`}
                          autoFocus
                        />
                        <div className="flex gap-2">
                          <button onClick={() => handleUpdate(report.id)} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">
                            Save Changes
                          </button>
                          <button onClick={() => setEditingReportId(null)} className="text-xs text-gray-500 hover:underline">Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-start justify-between">
                          <button
                            onClick={() => loadConfig(report.config)}
                            className="text-sm font-medium text-gray-900 dark:text-white hover:text-blue-600 dark:hover:text-blue-400 text-left"
                          >
                            {report.name}
                          </button>
                          <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              onClick={() => { setEditingReportId(report.id); setEditingName(report.name); }}
                              className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-slate-300"
                            >
                              Edit
                            </button>
                            <button onClick={() => handleDelete(report.id)} className={btnDanger}>
                              Delete
                            </button>
                          </div>
                        </div>
                        <p className="text-xs text-gray-400 dark:text-slate-500 mt-1">
                          {report.config.dateRangeType === 'relative'
                            ? `Last ${report.config.relativeDays}d`
                            : `${report.config.startDate} to ${report.config.endDate}`}
                          {' / '}
                          {report.config.intervalMinutes}m intervals
                          {report.config.siteId && ` / ${sites.find((s) => s.id === report.config.siteId)?.name ?? 'Site'}`}
                          {report.config.chargerIds?.length ? ` / ${report.config.chargerIds.length} charger(s)` : ''}
                        </p>
                        <div className="flex gap-2 mt-2">
                          <button
                            onClick={() => { loadConfig(report.config); setTimeout(loadPreview, 100); }}
                            className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                          >
                            Load & Preview
                          </button>
                          <button
                            onClick={() => {
                              loadConfig(report.config);
                              // Trigger export after state settles
                              setTimeout(() => {
                                const cfg = report.config;
                                const sd = cfg.dateRangeType === 'relative' ? daysAgoISO(cfg.relativeDays ?? 7) : (cfg.startDate ?? daysAgoISO(7));
                                const ed = cfg.dateRangeType === 'relative' ? todayISO() : (cfg.endDate ?? todayISO());
                                api.exportIntervalUsageCsv({
                                  siteId: cfg.siteId,
                                  chargerIds: cfg.chargerIds,
                                  startDate: sd,
                                  endDate: ed,
                                  intervalMinutes: cfg.intervalMinutes,
                                }).catch(() => {});
                              }, 100);
                            }}
                            className="text-xs text-green-600 dark:text-green-400 hover:underline"
                          >
                            Export CSV
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
