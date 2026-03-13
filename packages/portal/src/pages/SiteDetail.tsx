import { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Bar, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { createApiClient, type SiteDetail as SiteDetailType, type ChargerUptime, type SiteUptime, type Analytics as SiteAnalytics, type DailyEntry } from '../api/client';
import { useToken } from '../auth/TokenContext';
import ChargerMap from '../components/ChargerMap';
import StatusBadge from '../components/StatusBadge';
import AddChargerDialog from '../components/AddChargerDialog';
import { formatDate } from '../lib/utils';

type RangePreset = '7d' | '30d' | '60d';


type TouWindow = {
  id: string;
  day: number; // 0=Sun ... 6=Sat
  start: string; // HH:mm
  end: string; // HH:mm
  pricePerKwhUsd: number;
  idleFeePerMinUsd: number;
};
type TariffConfig = {
  pricePerKwhUsd: number;
  idleFeePerMinUsd: number;
  activationFeeUsd: number;
  gracePeriodMin: number;
  mode: 'flat' | 'tou';
  windows: TouWindow[];
};
type SiteAuditEvent = { id: string; action: string; actor: string; detail: string; createdAt: string };

function auditKey(siteId: string) { return `ev-portal:site:audit:${siteId}`; }

function loadAudit(siteId: string): SiteAuditEvent[] {
  try { const raw = localStorage.getItem(auditKey(siteId)); if (!raw) return []; const x = JSON.parse(raw) as SiteAuditEvent[]; return Array.isArray(x) ? x : []; } catch { return []; }
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function timeToMinutes(v: string): number {
  const [h, m] = v.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return -1;
  return h * 60 + m;
}

function validateTouWindows(windows: TouWindow[]): string | null {
  for (const w of windows) {
    const start = timeToMinutes(w.start);
    const end = timeToMinutes(w.end);
    if (start < 0 || end < 0 || end <= start) {
      return `Invalid time range in ${DAY_NAMES[w.day]} (${w.start} - ${w.end})`;
    }
  }

  for (let day = 0; day < 7; day += 1) {
    const dayWindows = windows.filter((w) => w.day === day).sort((a, b) => timeToMinutes(a.start) - timeToMinutes(b.start));
    for (let i = 1; i < dayWindows.length; i += 1) {
      const prev = dayWindows[i - 1];
      const curr = dayWindows[i];
      if (timeToMinutes(curr.start) < timeToMinutes(prev.end)) {
        return `Overlapping windows on ${DAY_NAMES[day]} (${prev.start}-${prev.end} and ${curr.start}-${curr.end})`;
      }
    }
  }

  return null;
}

function buildPricingSummary(config: TariffConfig): string {
  const base = `Base $${config.pricePerKwhUsd.toFixed(2)}/kWh · Idle $${config.idleFeePerMinUsd.toFixed(2)}/min · Activation $${config.activationFeeUsd.toFixed(2)} · Grace ${config.gracePeriodMin}m`;
  if (config.mode !== 'tou') return `Flat pricing active. ${base}`;

  if (config.windows.length === 0) {
    return `TOU mode active with no windows configured. Falls back to base rates. ${base}`;
  }

  const now = new Date();
  const nowDay = now.getDay();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const activeWindow = config.windows
    .slice()
    .sort((a, b) => a.day - b.day || timeToMinutes(a.start) - timeToMinutes(b.start))
    .find((w) => w.day === nowDay && nowMinutes >= timeToMinutes(w.start) && nowMinutes < timeToMinutes(w.end));

  if (!activeWindow) {
    return `TOU mode active (${config.windows.length} windows). No active window right now; base rates apply. ${base}`;
  }

  return `TOU mode active (${config.windows.length} windows). Current window (${DAY_NAMES[activeWindow.day]} ${activeWindow.start}-${activeWindow.end}): $${activeWindow.pricePerKwhUsd.toFixed(2)}/kWh · Idle $${activeWindow.idleFeePerMinUsd.toFixed(2)}/min.`;
}

export default function SiteDetail() {
  const { id } = useParams<{ id: string }>();
  const getToken = useToken();
  const [site, setSite] = useState<SiteDetailType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showAddCharger, setShowAddCharger] = useState(false);
  const [showEditSite, setShowEditSite] = useState(false);
  const [editSiteForm, setEditSiteForm] = useState({ name: '', address: '', lat: '', lng: '', organizationName: '', portfolioName: '' });
  const [chargerUptime, setChargerUptime] = useState<Record<string, ChargerUptime>>({});
  const [siteUptime, setSiteUptime] = useState<SiteUptime | null>(null);
  const [siteAnalytics, setSiteAnalytics] = useState<SiteAnalytics | null>(null);
  const [rangePreset, setRangePreset] = useState<RangePreset>('30d');
  const [trend, setTrend] = useState<Array<{ date: string; label: string; sessions: number; kwhDelivered: number; revenueUsd: number }>>([]);
  const [activeSessions, setActiveSessions] = useState(0);
  const [siteUtilizationPct, setSiteUtilizationPct] = useState<number | null>(null);

  const [tariff, setTariff] = useState<TariffConfig>({ pricePerKwhUsd: 0.35, idleFeePerMinUsd: 0.08, activationFeeUsd: 0, gracePeriodMin: 10, mode: 'flat', windows: [] });
  const [tariffMsg, setTariffMsg] = useState('');

  const [auditEvents, setAuditEvents] = useState<SiteAuditEvent[]>([]);


  const load = useCallback(async () => {
    try {
      const token = await getToken();
      const client = createApiClient(token);
      const periodDays = rangePreset === '7d' ? 7 : rangePreset === '30d' ? 30 : 60;

      const data = await client.getSite(id!);
      setSite(data);
      setEditSiteForm({
        name: data.name,
        address: data.address,
        lat: String(data.lat),
        lng: String(data.lng),
        organizationName: data.organizationName ?? '',
        portfolioName: data.portfolioName ?? '',
      });
      setTariff({
        pricePerKwhUsd: Number(data.pricePerKwhUsd ?? 0.35),
        idleFeePerMinUsd: Number(data.idleFeePerMinUsd ?? 0.08),
        activationFeeUsd: Number(data.activationFeeUsd ?? 0),
        gracePeriodMin: Number(data.gracePeriodMin ?? 10),
        mode: data.pricingMode === 'tou' ? 'tou' : 'flat',
        windows: Array.isArray(data.touWindows)
          ? (data.touWindows as Array<Partial<TouWindow>>).map((w) => ({
              id: typeof w.id === 'string' && w.id.length > 0 ? w.id : crypto.randomUUID(),
              day: Number(w.day ?? 0),
              start: String(w.start ?? '09:00'),
              end: String(w.end ?? '17:00'),
              pricePerKwhUsd: Number(w.pricePerKwhUsd ?? data.pricePerKwhUsd ?? 0.35),
              idleFeePerMinUsd: Number(w.idleFeePerMinUsd ?? data.idleFeePerMinUsd ?? 0.08),
            }))
          : [],
      });
      setAuditEvents(loadAudit(data.id));

      const [siteUp, analytics, perCharger] = await Promise.all([
        client.getSiteUptime(data.id).catch(() => null),
        client.getAnalytics(data.id, { periodDays }).catch(() => null),
        Promise.all(data.chargers.map((c) => client.getChargerUptime(c.id).catch(() => null))),
      ]);

      if (siteUp) setSiteUptime(siteUp);
      setSiteAnalytics(analytics);

      // Active sessions count + utilization based on actual session seconds in selected window
      const [chargerStatuses, chargerSessions] = await Promise.all([
        Promise.all(data.chargers.map((c) => client.getChargerStatus(c.id).catch(() => null))),
        Promise.all(data.chargers.map((c) => client.getChargerSessions(c.id).catch(() => []))),
      ]);
      setActiveSessions(
        chargerStatuses.filter(Boolean).reduce((sum, ch) => sum + (ch?.connectors.filter((c) => c.activeSession).length ?? 0), 0),
      );

      const periodEndMs = Date.now();
      const periodStartMs = periodEndMs - (periodDays * 24 * 60 * 60 * 1000);
      const actualChargingSeconds = chargerSessions
        .flat()
        .reduce((sum, session) => {
          const startMs = new Date(session.startedAt).getTime();
          const stopMs = session.stoppedAt ? new Date(session.stoppedAt).getTime() : periodEndMs;
          const overlapStart = Math.max(startMs, periodStartMs);
          const overlapEnd = Math.min(stopMs, periodEndMs);
          if (!Number.isFinite(overlapStart) || !Number.isFinite(overlapEnd) || overlapEnd <= overlapStart) return sum;
          return sum + Math.floor((overlapEnd - overlapStart) / 1000);
        }, 0);
      const connectorCount = data.chargers.reduce((sum, ch) => sum + ch.connectors.length, 0);
      const totalPossibleSeconds = connectorCount > 0 ? connectorCount * periodDays * 24 * 60 * 60 : 0;
      if (totalPossibleSeconds > 0) {
        setSiteUtilizationPct(Math.round((actualChargingSeconds / totalPossibleSeconds) * 10000) / 100);
      } else if (analytics?.utilizationRatePct != null) {
        setSiteUtilizationPct(Number(analytics.utilizationRatePct));
      } else {
        setSiteUtilizationPct(null);
      }

      // Trend data from daily analytics
      const daily = new Map<string, { sessions: number; kwhDelivered: number; revenueCents: number }>();
      (analytics?.daily ?? []).forEach((d: DailyEntry) => {
        const row = daily.get(d.date) ?? { sessions: 0, kwhDelivered: 0, revenueCents: 0 };
        row.sessions += d.sessions;
        row.kwhDelivered += d.kwhDelivered;
        row.revenueCents += d.revenueCents;
        daily.set(d.date, row);
      });
      setTrend(
        Array.from(daily.entries())
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([date, row]) => ({
            date,
            label: date.slice(5),
            sessions: row.sessions,
            kwhDelivered: Math.round(row.kwhDelivered * 1000) / 1000,
            revenueUsd: Math.round(row.revenueCents) / 100,
          })),
      );

      const map: Record<string, ChargerUptime> = {};
      perCharger.forEach((u) => { if (u) map[u.chargerId] = u; });
      setChargerUptime(map);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load site');
    } finally {
      setLoading(false);
    }
  }, [id, getToken, rangePreset]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return <div className="flex h-64 items-center justify-center text-gray-400">Loading…</div>;
  }
  if (error || !site) {
    return <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700">{error || 'Site not found'}</div>;
  }

  const pushAudit = (action: string, detail: string) => {
    const next: SiteAuditEvent[] = [{
      id: crypto.randomUUID(), action, actor: 'operator-admin', detail, createdAt: new Date().toISOString(),
    }, ...auditEvents];
    setAuditEvents(next);
    localStorage.setItem(auditKey(site.id), JSON.stringify(next.slice(0, 250)));
  };

  const totalKwh = siteAnalytics?.kwhDelivered ?? 0;
  const totalRevenue = (siteAnalytics?.revenueCents ?? 0) / 100;
  const utilizationPct = siteUtilizationPct;
  const totalConnectors = site.chargers.reduce((s, c) => s + c.connectors.length, 0);

  return (
    <div className="space-y-6">

      {/* ── Header ── */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <Link to="/" className="hover:text-gray-700">Dashboard</Link>
            <span>/</span>
            <Link to="/sites" className="hover:text-gray-700">Sites</Link>
            <span>/</span>
            <span className="text-gray-900">{site.name}</span>
          </div>
          <h1 className="mt-1 text-2xl font-bold text-gray-900">{site.name}</h1>
          <p className="text-sm text-gray-500">{site.address}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={rangePreset}
            onChange={(e) => setRangePreset(e.target.value as RangePreset)}
            className="rounded-md border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="60d">Last 60 days</option>
          </select>
          <button onClick={() => setShowEditSite((v) => !v)} className="rounded-md border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">Edit Site</button>
          <Link to={`/sites/${site.id}/analytics`} className="rounded-md border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50">Analytics</Link>
          <button onClick={() => setShowAddCharger(true)} className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">+ Add Charger</button>
        </div>
      </div>

      {/* ── Edit site form ── */}
      {showEditSite && (
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-gray-700">Edit site details</h2>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-sm text-gray-700">Site name
              <input className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1.5" value={editSiteForm.name} onChange={(e) => setEditSiteForm((f) => ({ ...f, name: e.target.value }))} />
            </label>
            <label className="text-sm text-gray-700">Address
              <input className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1.5" value={editSiteForm.address} onChange={(e) => setEditSiteForm((f) => ({ ...f, address: e.target.value }))} />
            </label>
            <label className="text-sm text-gray-700">Latitude
              <input type="number" step="0.000001" className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1.5" value={editSiteForm.lat} onChange={(e) => setEditSiteForm((f) => ({ ...f, lat: e.target.value }))} />
            </label>
            <label className="text-sm text-gray-700">Longitude
              <input type="number" step="0.000001" className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1.5" value={editSiteForm.lng} onChange={(e) => setEditSiteForm((f) => ({ ...f, lng: e.target.value }))} />
            </label>
            <label className="text-sm text-gray-700">Organization
              <input className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1.5" value={editSiteForm.organizationName} onChange={(e) => setEditSiteForm((f) => ({ ...f, organizationName: e.target.value }))} />
            </label>
            <label className="text-sm text-gray-700">Portfolio
              <input className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1.5" value={editSiteForm.portfolioName} onChange={(e) => setEditSiteForm((f) => ({ ...f, portfolioName: e.target.value }))} />
            </label>
          </div>
          <div className="mt-3 flex gap-2">
            <button className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700"
              onClick={async () => {
                const token = await getToken();
                const payload = {
                  name: editSiteForm.name.trim(),
                  address: editSiteForm.address.trim(),
                  lat: Number(editSiteForm.lat),
                  lng: Number(editSiteForm.lng),
                  organizationName: editSiteForm.organizationName.trim(),
                  portfolioName: editSiteForm.portfolioName.trim(),
                };
                await createApiClient(token).updateSite(site.id, payload);
                pushAudit('site.updated', `${payload.name} @ ${payload.address} | org=${payload.organizationName || '-'} portfolio=${payload.portfolioName || '-'}`);
                setShowEditSite(false);
                await load();
              }}>Save site</button>
            <button className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50" onClick={() => setShowEditSite(false)}>Cancel</button>
          </div>
        </div>
      )}

      {/* ── KPI tiles (dashboard style) ── */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <SiteKpiTile label={`Total kWh (${rangePreset})`} value={`${totalKwh.toFixed(2)} kWh`} />
        <SiteKpiTile label={`Total Revenue (${rangePreset})`} value={`$${totalRevenue.toFixed(2)}`} />
        <SiteKpiTile label="Active Sessions" value={`${activeSessions}`} live />
        <SiteKpiTile label="Total Connectors" value={`${totalConnectors}`} live />
        <SiteKpiTile label={`Utilization (${rangePreset})`} value={utilizationPct != null ? `${utilizationPct.toFixed(2)}%` : '—'} />
      </div>

      {/* ── Tariff (full width, below tiles) ── */}
      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-700">Pricing / Tariff</h2>
          {tariffMsg && <p className="text-xs text-gray-500">{tariffMsg}</p>}
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <label className="text-sm text-gray-700">Pricing mode
            <select className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1.5" value={tariff.mode} onChange={(e) => setTariff({ ...tariff, mode: e.target.value as TariffConfig['mode'] })}>
              <option value="flat">Flat rate</option>
              <option value="tou">Time-of-Use (TOU)</option>
            </select>
          </label>
          <label className="text-sm text-gray-700">Price per kWh (USD)
            <input type="number" step="0.01" className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1.5" value={tariff.pricePerKwhUsd} onChange={(e) => setTariff({ ...tariff, pricePerKwhUsd: Number(e.target.value) })} />
          </label>
          <label className="text-sm text-gray-700">Idle fee per min (USD)
            <input type="number" step="0.01" className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1.5" value={tariff.idleFeePerMinUsd} onChange={(e) => setTariff({ ...tariff, idleFeePerMinUsd: Number(e.target.value) })} />
          </label>
          <label className="text-sm text-gray-700">Activation fee (USD)
            <input type="number" step="0.01" className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1.5" value={tariff.activationFeeUsd} onChange={(e) => setTariff({ ...tariff, activationFeeUsd: Number(e.target.value) })} />
          </label>
          <label className="text-sm text-gray-700">Grace period (min)
            <input type="number" className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1.5" value={tariff.gracePeriodMin} onChange={(e) => setTariff({ ...tariff, gracePeriodMin: Number(e.target.value) })} />
          </label>
        </div>

        {tariff.mode === 'tou' && (
          <div className="mt-4 rounded-md border border-gray-200 bg-gray-50 p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-600">TOU windows</p>
              <button type="button" className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-100"
                onClick={() => setTariff((prev) => ({ ...prev, windows: [...prev.windows, { id: crypto.randomUUID(), day: 1, start: '09:00', end: '17:00', pricePerKwhUsd: prev.pricePerKwhUsd, idleFeePerMinUsd: prev.idleFeePerMinUsd }] }))}>
                + Add window
              </button>
            </div>
            {tariff.windows.length === 0 ? (
              <p className="text-xs text-gray-500">No TOU windows yet.</p>
            ) : (
              <div className="space-y-2">
                {tariff.windows.map((w) => (
                  <div key={w.id} className="grid gap-2 rounded-md border border-gray-200 bg-white p-2 md:grid-cols-6">
                    <select className="rounded-md border border-gray-300 px-2 py-1.5 text-xs" value={w.day} onChange={(e) => setTariff((p) => ({ ...p, windows: p.windows.map((x) => x.id === w.id ? { ...x, day: Number(e.target.value) } : x) }))}>
                      {DAY_NAMES.map((name, idx) => <option key={name} value={idx}>{name}</option>)}
                    </select>
                    <input type="time" className="rounded-md border border-gray-300 px-2 py-1.5 text-xs" value={w.start} onChange={(e) => setTariff((p) => ({ ...p, windows: p.windows.map((x) => x.id === w.id ? { ...x, start: e.target.value } : x) }))} />
                    <input type="time" className="rounded-md border border-gray-300 px-2 py-1.5 text-xs" value={w.end} onChange={(e) => setTariff((p) => ({ ...p, windows: p.windows.map((x) => x.id === w.id ? { ...x, end: e.target.value } : x) }))} />
                    <input type="number" step="0.01" className="rounded-md border border-gray-300 px-2 py-1.5 text-xs" value={w.pricePerKwhUsd} onChange={(e) => setTariff((p) => ({ ...p, windows: p.windows.map((x) => x.id === w.id ? { ...x, pricePerKwhUsd: Number(e.target.value) } : x) }))} placeholder="$/kWh" />
                    <input type="number" step="0.01" className="rounded-md border border-gray-300 px-2 py-1.5 text-xs" value={w.idleFeePerMinUsd} onChange={(e) => setTariff((p) => ({ ...p, windows: p.windows.map((x) => x.id === w.id ? { ...x, idleFeePerMinUsd: Number(e.target.value) } : x) }))} placeholder="$/min" />
                    <button type="button" className="rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700 hover:bg-red-100" onClick={() => setTariff((p) => ({ ...p, windows: p.windows.filter((x) => x.id !== w.id) }))}>Remove</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="mt-4 rounded-md border border-blue-100 bg-blue-50 px-3 py-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-blue-700">Effective pricing summary</p>
          <p className="mt-1 text-xs text-blue-900">{buildPricingSummary(tariff)}</p>
        </div>

        <div className="mt-3">
          <button type="button" className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700"
            onClick={async () => {
              try {
                const overlapError = tariff.mode === 'tou' ? validateTouWindows(tariff.windows) : null;
                if (overlapError) { setTariffMsg(overlapError); return; }
                const token = await getToken();
                const updated = await createApiClient(token).updateSite(site.id, {
                  name: site.name,
                  address: site.address,
                  lat: site.lat,
                  lng: site.lng,
                  pricingMode: tariff.mode,
                  pricePerKwhUsd: tariff.pricePerKwhUsd,
                  idleFeePerMinUsd: tariff.idleFeePerMinUsd,
                  activationFeeUsd: tariff.activationFeeUsd,
                  gracePeriodMin: tariff.gracePeriodMin,
                  touWindows: tariff.mode === 'tou' ? tariff.windows : [],
                });
                setTariffMsg(`Saved. Price per kWh is now $${Number(updated.pricePerKwhUsd ?? tariff.pricePerKwhUsd).toFixed(2)} and activation fee is $${Number(updated.activationFeeUsd ?? tariff.activationFeeUsd).toFixed(2)}.`);
                pushAudit('tariff.updated', tariff.mode === 'tou'
                  ? `tou windows=${tariff.windows.length}, base=$${tariff.pricePerKwhUsd}/kWh idle=$${tariff.idleFeePerMinUsd}/min activation=$${tariff.activationFeeUsd} grace=${tariff.gracePeriodMin}m`
                  : `flat price=$${tariff.pricePerKwhUsd}/kWh, idle=$${tariff.idleFeePerMinUsd}/min, activation=$${tariff.activationFeeUsd}, grace=${tariff.gracePeriodMin}m`);
                await load();
              } catch (err) {
                setTariffMsg(`Save failed: ${err instanceof Error ? err.message : 'unknown error'}`);
              }
            }}>Save tariff</button>
        </div>
      </div>

      {/* ── Trend chart (dashboard style) ── */}
      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <p className="text-sm font-semibold">
          <span className="text-blue-600">Energy (kWh)</span>
          <span className="text-gray-400"> | </span>
          <span className="text-emerald-600">Revenue ($)</span>
          <span className="text-gray-400"> | </span>
          <span className="text-amber-500">Transactions</span>
          <span className="ml-1 text-xs font-normal text-gray-400">({rangePreset})</span>
        </p>
        <div className="mt-3 h-64">
          {trend.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-gray-400">No trend data for selected period.</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={trend} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
                <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                <YAxis yAxisId="kwh" tick={{ fontSize: 10 }} />
                <YAxis yAxisId="rev" orientation="right" tick={{ fontSize: 10 }} tickFormatter={(v: number) => `$${v}`} />
                <Tooltip formatter={(v: number, name: string) => name === 'revenueUsd' ? [`$${v.toFixed(2)}`, 'Revenue ($)'] : name === 'kwhDelivered' ? [`${v} kWh`, 'Energy (kWh)'] : [v, 'Transactions']} />
                <Bar yAxisId="kwh" dataKey="kwhDelivered" fill="#3b82f6" opacity={0.7} name="Energy (kWh)" />
                <Line yAxisId="rev" type="monotone" dataKey="revenueUsd" stroke="#10b981" dot={false} strokeWidth={2} name="Revenue ($)" />
                <Line yAxisId="kwh" type="monotone" dataKey="sessions" stroke="#f59e0b" dot={false} strokeWidth={1.5} name="Transactions" />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* ── Uptime summary ── */}
      {siteUptime && (
        <div className="grid gap-3 sm:grid-cols-5">
          <div className="rounded-lg border border-gray-200 bg-white p-3 text-center"><p className="text-xs text-gray-500">Uptime 24h</p><p className="mt-1 text-lg font-semibold text-gray-900">{siteUptime.uptimePercent24h.toFixed(1)}%</p></div>
          <div className="rounded-lg border border-gray-200 bg-white p-3 text-center"><p className="text-xs text-gray-500">Uptime 7d</p><p className="mt-1 text-lg font-semibold text-gray-900">{siteUptime.uptimePercent7d.toFixed(1)}%</p></div>
          <div className="rounded-lg border border-gray-200 bg-white p-3 text-center"><p className="text-xs text-gray-500">Uptime 30d</p><p className="mt-1 text-lg font-semibold text-gray-900">{siteUptime.uptimePercent30d.toFixed(1)}%</p></div>
          <div className="rounded-lg border border-gray-200 bg-white p-3 text-center"><p className="text-xs text-gray-500">Degraded</p><p className="mt-1 text-lg font-semibold text-amber-700">{siteUptime.degradedChargers}</p></div>
          <div className="rounded-lg border border-gray-200 bg-white p-3 text-center"><p className="text-xs text-gray-500">Total chargers</p><p className="mt-1 text-lg font-semibold text-gray-900">{site.chargers.length}</p></div>
        </div>
      )}

      {/* ── Map ── */}
      <ChargerMap lat={site.lat} lng={site.lng} siteName={site.name} chargers={site.chargers} />

      {/* ── Charger list ── */}
      <div>
        <h2 className="mb-3 text-lg font-semibold text-gray-900">Chargers ({site.chargers.length})</h2>
        {site.chargers.length === 0 ? (
          <div className="rounded-lg border-2 border-dashed border-gray-200 p-10 text-center text-gray-400">
            <p className="text-3xl">🔌</p>
            <p className="mt-2 font-medium">No chargers registered</p>
            <button onClick={() => setShowAddCharger(true)} className="mt-3 text-sm text-brand-600 hover:underline">Register your first charger →</button>
          </div>
        ) : site.chargers.length > 4 ? (
          <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
            <div className="hidden grid-cols-[1.6fr_1fr_1.8fr_0.8fr] gap-3 border-b border-gray-200 bg-gray-50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-gray-500 md:grid">
              <span>Charger</span><span>Status</span><span>Connectors</span><span className="text-right">Action</span>
            </div>
            <div className="divide-y divide-gray-100">
              {site.chargers.map((charger) => <ChargerListRow key={charger.id} charger={charger} uptime={chargerUptime[charger.id]} />)}
            </div>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {site.chargers.map((charger) => <ChargerCard key={charger.id} charger={charger} uptime={chargerUptime[charger.id]} />)}
          </div>
        )}
      </div>

      {/* ── Audit trail ── */}
      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-gray-700">Audit trail</h2>
        <div className="space-y-2">
          {auditEvents.length === 0 && <p className="text-xs text-gray-500">No audit events yet.</p>}
          {auditEvents.slice(0, 20).map((e) => (
            <div key={e.id} className="rounded-md border border-gray-200 p-2">
              <p className="text-xs text-gray-500">{new Date(e.createdAt).toLocaleString()} · {e.actor}</p>
              <p className="text-xs font-medium text-gray-800">{e.action}</p>
              <p className="text-xs text-gray-600">{e.detail}</p>
            </div>
          ))}
        </div>
      </div>

      {showAddCharger && (
        <AddChargerDialog
          siteId={site.id}
          onAdd={async (body) => {
            const token = await getToken();
            const result = await createApiClient(token).createCharger(body);
            await load();
            return result;
          }}
          onClose={() => setShowAddCharger(false)}
        />
      )}
    </div>
  );
}

function SiteKpiTile({ label, value, live }: { label: string; value: string; live?: boolean }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex items-center gap-1.5">
        <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</p>
        {live && <span className="inline-block h-1.5 w-1.5 rounded-full bg-green-500" title="Live" />}
      </div>
      <p className="mt-1 text-2xl font-semibold text-gray-900">{value}</p>
    </div>
  );
}

function ChargerListRow({ charger, uptime }: { charger: SiteDetailType['chargers'][number]; uptime?: ChargerUptime }) {
  return (
    <div className="grid gap-3 px-4 py-3 md:grid-cols-[1.6fr_1fr_1.8fr_0.8fr] md:items-center">
      <div>
        <p className="font-mono text-sm font-semibold text-gray-900">{charger.ocppId}</p>
        <p className="text-xs text-gray-500">{charger.vendor} {charger.model} · S/N {charger.serialNumber}</p>
        {charger.lastHeartbeat && (
          <p className="text-xs text-gray-400">Heartbeat: {formatDate(charger.lastHeartbeat)}</p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadge status={charger.status} type="charger" />
        {uptime && (
          <span className={uptime.uptimePercent7d >= 99 ? 'text-xs font-semibold text-green-700' : uptime.uptimePercent7d >= 95 ? 'text-xs font-semibold text-amber-700' : 'text-xs font-semibold text-red-700'}>
            {uptime.uptimePercent7d.toFixed(2)}% 7d
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {charger.connectors.map((c) => (
          <div key={c.id} className="flex items-center gap-1 rounded-md border border-gray-100 bg-gray-50 px-2 py-0.5">
            <span className="text-xs text-gray-500">#{c.connectorId}</span>
            <StatusBadge status={c.status} type="connector" />
          </div>
        ))}
      </div>

      <div className="md:text-right">
        <Link to={`/chargers/${charger.id}`} className="inline-block rounded-md border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50">View Detail →</Link>
      </div>
    </div>
  );
}

function ChargerCard({ charger, uptime }: { charger: SiteDetailType['chargers'][number]; uptime?: ChargerUptime }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between">
        <div>
          <p className="font-semibold text-gray-900 font-mono">{charger.ocppId}</p>
          <p className="text-xs text-gray-500">{charger.vendor} {charger.model}</p>
        </div>
        <StatusBadge status={charger.status} type="charger" />
      </div>

      <p className="mt-1 text-xs text-gray-400">S/N: {charger.serialNumber}</p>

      {charger.lastHeartbeat && (
        <p className="mt-1 text-xs text-gray-400">Last heartbeat: {formatDate(charger.lastHeartbeat)}</p>
      )}

      <div className="mt-3 flex flex-wrap gap-1.5">
        {charger.connectors.map((c) => (
          <div key={c.id} className="flex items-center gap-1 rounded-md border border-gray-100 bg-gray-50 px-2 py-0.5">
            <span className="text-xs text-gray-500">#{c.connectorId}</span>
            <StatusBadge status={c.status} type="connector" />
          </div>
        ))}
      </div>

      {uptime && (
        <div className="mt-3 rounded-md border border-gray-100 bg-gray-50 px-2 py-1.5 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-gray-500">Uptime 7d</span>
            <span className={uptime.uptimePercent7d >= 99 ? 'text-green-700 font-semibold' : uptime.uptimePercent7d >= 95 ? 'text-amber-700 font-semibold' : 'text-red-700 font-semibold'}>{uptime.uptimePercent7d.toFixed(2)}%</span>
          </div>
        </div>
      )}

      <Link to={`/chargers/${charger.id}`} className="mt-3 block rounded-md border border-gray-200 px-3 py-1.5 text-center text-xs font-medium text-gray-600 hover:bg-gray-50">View Detail →</Link>
    </div>
  );
}
