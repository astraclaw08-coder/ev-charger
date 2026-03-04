import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { createApiClient, type SiteListItem } from '../api/client';
import { useToken } from '../auth/TokenContext';

type CreateSiteForm = {
  name: string;
  address: string;
  lat: string;
  lng: string;
};

const EMPTY_FORM: CreateSiteForm = {
  name: '',
  address: '',
  lat: '',
  lng: '',
};

export default function Dashboard() {
  const getToken = useToken();
  const [sites, setSites] = useState<SiteListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [fleetUptime, setFleetUptime] = useState<{ uptime24h: number; uptime7d: number; uptime30d: number; degraded: number } | null>(null);
  const [fleetKpis, setFleetKpis] = useState<{ totalSites: number; totalKwh30d: number; activeSessions: number } | null>(null);
  const [fleetStatus, setFleetStatus] = useState<{
    totalChargers: number;
    totalConnectors: number;
    available: number;
    charging: number;
    faulted: number;
    offline: number;
    byStatus: Array<{ status: string; count: number }>;
  } | null>(null);
  const [showAddSiteModal, setShowAddSiteModal] = useState(false);
  const [createLoading, setCreateLoading] = useState(false);
  const [createMsg, setCreateMsg] = useState('');
  const [form, setForm] = useState<CreateSiteForm>(EMPTY_FORM);

  async function load() {
    try {
      const token = await getToken();
      const client = createApiClient(token);
      const data = await client.getSites();
      setSites(data);

      const siteUp = await Promise.all(data.map((site) => client.getSiteUptime(site.id).catch(() => null)));
      const siteAnalytics = await Promise.all(data.map((site) => client.getAnalytics(site.id).catch(() => null)));
      const siteDetails = await Promise.all(data.map((site) => client.getSite(site.id).catch(() => null)));

      const totalKwh30d = siteAnalytics.filter(Boolean).reduce((sum, a) => sum + (a?.kwhDelivered ?? 0), 0);

      const chargerIds = siteDetails
        .filter(Boolean)
        .flatMap((s) => s?.chargers.map((c) => c.id) ?? []);

      const chargerStatuses = await Promise.all(
        chargerIds.map((chargerId) => client.getChargerStatus(chargerId).catch(() => null)),
      );
      const activeSessions = chargerStatuses
        .filter(Boolean)
        .reduce((sum, ch) => sum + (ch?.connectors.filter((c) => c.activeSession).length ?? 0), 0);

      const statusCountMap = new Map<string, number>();
      let totalConnectors = 0;
      let available = 0;
      let charging = 0;
      let faulted = 0;

      chargerStatuses.filter(Boolean).forEach((ch) => {
        ch?.connectors.forEach((connector) => {
          totalConnectors += 1;
          const status = connector.status.toUpperCase();
          statusCountMap.set(status, (statusCountMap.get(status) ?? 0) + 1);

          if (status === 'AVAILABLE') available += 1;
          if (status === 'FAULTED') faulted += 1;
          if (status === 'PREPARING' || status === 'CHARGING' || status === 'FINISHING') charging += 1;
        });
      });

      const totalChargers = chargerStatuses.filter(Boolean).length;
      const offline = chargerStatuses.filter((ch) => ch?.status?.toUpperCase() === 'OFFLINE').length;

      setFleetKpis({
        totalSites: data.length,
        totalKwh30d: Math.round(totalKwh30d * 1000) / 1000,
        activeSessions,
      });
      setFleetStatus({
        totalChargers,
        totalConnectors,
        available,
        charging,
        faulted,
        offline,
        byStatus: Array.from(statusCountMap.entries())
          .map(([status, count]) => ({ status, count }))
          .sort((a, b) => b.count - a.count),
      });
      const rows = siteUp.filter(Boolean);
      if (rows.length) {
        const avg = (arr: number[]) => Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 100) / 100;
        setFleetUptime({
          uptime24h: avg(rows.map((r) => r!.uptimePercent24h)),
          uptime7d: avg(rows.map((r) => r!.uptimePercent7d)),
          uptime30d: avg(rows.map((r) => r!.uptimePercent30d)),
          degraded: rows.reduce((sum, r) => sum + (r?.degradedChargers ?? 0), 0),
        });
      } else {
        setFleetUptime(null);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load sites');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getToken]);

  async function handleCreateSite(e: React.FormEvent) {
    e.preventDefault();
    setCreateMsg('');

    const lat = Number(form.lat);
    const lng = Number(form.lng);
    if (!form.name.trim() || !form.address.trim() || Number.isNaN(lat) || Number.isNaN(lng)) {
      setCreateMsg('Please fill all fields with valid coordinates.');
      return;
    }

    setCreateLoading(true);
    try {
      const token = await getToken();
      await createApiClient(token).createSite({
        name: form.name.trim(),
        address: form.address.trim(),
        lat,
        lng,
      });
      setCreateMsg('Site created successfully.');
      setForm(EMPTY_FORM);
      setShowAddSiteModal(false);
      await load();
    } catch (err: unknown) {
      setCreateMsg(err instanceof Error ? err.message : 'Failed to create site');
    } finally {
      setCreateLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center text-gray-400">Loading sites…</div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700">{error}</div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
          <p className="mt-1 text-sm text-gray-500">All your charging sites</p>
        </div>
        <button
          onClick={() => {
            setCreateMsg('');
            setShowAddSiteModal(true);
          }}
          className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          + Add Site
        </button>
      </div>

      {createMsg && !showAddSiteModal && (
        <p className="mt-2 text-xs text-gray-500">{createMsg}</p>
      )}

      {fleetKpis && (
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <KpiTile label="Total kWh (30d)" value={`${fleetKpis.totalKwh30d.toFixed(3)} kWh`} />
          <KpiTile label="Total Sites" value={`${fleetKpis.totalSites}`} />
          <KpiTile label="Active Sessions" value={`${fleetKpis.activeSessions}`} />
        </div>
      )}

      {fleetStatus && (
        <div className="mt-3 rounded-xl border border-gray-200 bg-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-semibold text-gray-700">Fleet charger/connectors status breakdown</p>
            <p className="text-xs text-gray-500">
              Chargers: <span className="font-semibold text-gray-900">{fleetStatus.totalChargers}</span>
              {' · '}
              Connectors: <span className="font-semibold text-gray-900">{fleetStatus.totalConnectors}</span>
            </p>
          </div>

          <div className="mt-2 text-sm text-gray-700">
            <span className="font-medium text-green-700">🟢 Available {fleetStatus.available}</span>
            <span className="mx-2 text-gray-300">·</span>
            <span className="font-medium text-amber-700">🟡 Charging {fleetStatus.charging}</span>
            <span className="mx-2 text-gray-300">·</span>
            <span className="font-medium text-red-700">🔴 Faulted {fleetStatus.faulted}</span>
            <span className="mx-2 text-gray-300">·</span>
            <span className="font-medium text-gray-600">⚫ Offline {fleetStatus.offline}</span>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            {fleetStatus.byStatus.map((entry) => (
              <span key={entry.status} className="rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs text-gray-700">
                {entry.status}: {entry.count}
              </span>
            ))}
          </div>
        </div>
      )}

      {fleetUptime && (
        <div className="mt-4 rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-sm font-semibold text-gray-700">Fleet uptime summary (OCA v1.1)</p>
          <div className="mt-2 grid gap-3 sm:grid-cols-4">
            <div><p className="text-xs text-gray-500">24h</p><p className="text-lg font-semibold text-gray-900">{fleetUptime.uptime24h.toFixed(2)}%</p></div>
            <div><p className="text-xs text-gray-500">7d</p><p className="text-lg font-semibold text-gray-900">{fleetUptime.uptime7d.toFixed(2)}%</p></div>
            <div><p className="text-xs text-gray-500">30d</p><p className="text-lg font-semibold text-gray-900">{fleetUptime.uptime30d.toFixed(2)}%</p></div>
            <div><p className="text-xs text-gray-500">Degraded chargers</p><p className="text-lg font-semibold text-amber-700">{fleetUptime.degraded}</p></div>
          </div>
        </div>
      )}

      {sites.length === 0 ? (
        <div className="mt-12 text-center text-gray-400">
          <p className="text-4xl">📍</p>
          <p className="mt-2 font-medium">No sites yet</p>
          <p className="text-sm">Click + Add Site to create your first site.</p>
        </div>
      ) : (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {sites.map((site) => (
            <SiteCard key={site.id} site={site} />
          ))}
        </div>
      )}

      {showAddSiteModal && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4" onClick={() => setShowAddSiteModal(false)}>
          <div className="w-full max-w-lg rounded-xl border border-gray-200 bg-white p-5" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold text-gray-900">Add Site</h2>
            <p className="mt-1 text-xs text-gray-500">Owner/Operator action — create a new charging site.</p>
            <form className="mt-4 space-y-3" onSubmit={handleCreateSite}>
              <input
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                placeholder="Site name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
              <input
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                placeholder="Address"
                value={form.address}
                onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
              />
              <div className="grid grid-cols-2 gap-3">
                <input
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  placeholder="Latitude"
                  value={form.lat}
                  onChange={(e) => setForm((f) => ({ ...f, lat: e.target.value }))}
                />
                <input
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  placeholder="Longitude"
                  value={form.lng}
                  onChange={(e) => setForm((f) => ({ ...f, lng: e.target.value }))}
                />
              </div>

              {createMsg && <p className="text-xs text-gray-500">{createMsg}</p>}

              <div className="mt-2 flex justify-end gap-2">
                <button
                  type="button"
                  className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                  onClick={() => setShowAddSiteModal(false)}
                  disabled={createLoading}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
                  disabled={createLoading}
                >
                  {createLoading ? 'Creating…' : 'Create Site'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function KpiTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="mt-1 text-xl font-semibold text-gray-900">{value}</p>
    </div>
  );
}

function SiteCard({ site }: { site: SiteListItem }) {
  const total = site.chargerCount;
  const { online, offline, faulted } = site.statusSummary;

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm transition hover:shadow-md">
      <div className="flex items-start justify-between">
        <div className="min-w-0">
          <h3 className="truncate font-semibold text-gray-900">{site.name}</h3>
          <p className="mt-0.5 truncate text-xs text-gray-500">{site.address}</p>
        </div>
        <span className="ml-2 shrink-0 text-2xl">🔌</span>
      </div>

      <div className="mt-4 flex gap-3">
        <Stat label="Total" value={total} color="text-gray-700" />
        <Stat label="Online" value={online} color="text-green-700" />
        {faulted > 0 && <Stat label="Faulted" value={faulted} color="text-red-700" />}
        {offline > 0 && <Stat label="Offline" value={offline} color="text-gray-500" />}
      </div>

      {total > 0 && (
        <div className="mt-3 flex h-1.5 overflow-hidden rounded-full bg-gray-100">
          <div
            className="bg-green-500 transition-all"
            style={{ width: `${(online / total) * 100}%` }}
          />
          <div
            className="bg-red-400 transition-all"
            style={{ width: `${(faulted / total) * 100}%` }}
          />
        </div>
      )}

      <div className="mt-4 flex gap-2">
        <Link
          to={`/sites/${site.id}`}
          className="flex-1 rounded-md bg-brand-600 px-3 py-1.5 text-center text-xs font-medium text-white hover:bg-brand-700"
        >
          View Site
        </Link>
        <Link
          to={`/sites/${site.id}/analytics`}
          className="flex-1 rounded-md border border-gray-200 px-3 py-1.5 text-center text-xs font-medium text-gray-600 hover:bg-gray-50"
        >
          Analytics
        </Link>
      </div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="text-center">
      <p className={`text-xl font-bold leading-none ${color}`}>{value}</p>
      <p className="mt-0.5 text-xs text-gray-400">{label}</p>
    </div>
  );
}
