import { useEffect, useMemo, useState } from 'react';

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
import { Link } from 'react-router-dom';
import { createApiClient, type SiteListItem } from '../api/client';
import { useToken } from '../auth/TokenContext';
import { shortId } from '../lib/shortId';

export default function Sites() {
  const getToken = useToken();
  const [sites, setSites] = useState<SiteListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [totalConnectors, setTotalConnectors] = useState(0);
  const [totalChargers, setTotalChargers] = useState(0);
  const [showAddSiteModal, setShowAddSiteModal] = useState(false);
  const [createLoading, setCreateLoading] = useState(false);
  const [createMsg, setCreateMsg] = useState('');
  const [form, setForm] = useState<CreateSiteForm>(EMPTY_FORM);
  const [query, setQuery] = useState('');

  async function loadSites() {
    try {
      const token = await getToken();
      const client = createApiClient(token);
      const data = await client.getSites();
      setSites(data);
      const connectors = data.reduce((sum, site) => sum + (site.connectorCount ?? 0), 0);
      const chargers = data.reduce((sum, site) => sum + (site.chargerCount ?? 0), 0);
      setTotalConnectors(connectors);
      setTotalChargers(chargers);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load sites');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadSites();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getToken]);

  const filteredSites = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sites;
    return sites.filter((site) =>
      site.name.toLowerCase().includes(q)
      || site.address.toLowerCase().includes(q)
      || (site.organizationName ?? '').toLowerCase().includes(q)
      || (site.portfolioName ?? '').toLowerCase().includes(q),
    );
  }, [sites, query]);

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
      await loadSites();
    } catch (err: unknown) {
      setCreateMsg(err instanceof Error ? err.message : 'Failed to create site');
    } finally {
      setCreateLoading(false);
    }
  }

  if (loading) return <div className="flex h-64 items-center justify-center text-gray-400 dark:text-slate-500">Loading sites…</div>;
  if (error) return <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700">{error}</div>;

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-slate-400">
            <Link to="/overview" className="hover:text-gray-700 dark:hover:text-slate-200 dark:text-slate-300">Overview</Link>
            <span>/</span>
            <span className="text-gray-900 dark:text-slate-100">Sites</span>
          </div>
          <h1 className="mt-1 text-2xl font-bold text-gray-900 dark:text-slate-100">Sites</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">All charging sites and their fleet status</p>
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

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {[
          { label: 'Total Sites', value: sites.length },
          { label: 'Total Chargers', value: totalChargers },
          { label: 'Total Connectors', value: totalConnectors },
        ].map(({ label, value }) => (
          <div key={label} className="rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2.5">
            <p className="truncate text-[10px] font-medium uppercase tracking-wide text-gray-500 dark:text-slate-400">{label}</p>
            <p className="mt-1 truncate text-lg font-semibold leading-tight text-gray-900 dark:text-slate-100">{value}</p>
          </div>
        ))}
      </div>

      {createMsg && !showAddSiteModal && (
        <p className="mt-2 text-xs text-gray-500 dark:text-slate-400">{createMsg}</p>
      )}

      <div className="mt-4">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search site by name, address, org, or portfolio"
          className="w-full max-w-md rounded-md border border-gray-300 dark:border-slate-600 px-3 py-2 text-sm"
        />
      </div>

      {filteredSites.length === 0 ? (
        <div className="mt-12 text-center text-gray-400 dark:text-slate-500">
          <p className="text-4xl">📍</p>
          <p className="mt-2 font-medium">No matching sites</p>
        </div>
      ) : filteredSites.length > 4 ? (
        <div className="mt-6 overflow-hidden rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900">
          <div className="hidden grid-cols-[1.8fr_1fr_1fr_1fr] gap-3 border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/60 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-slate-400 md:grid">
            <span>Site</span>
            <span>Chargers</span>
            <span className="inline-flex items-center gap-1">
              Status
              <span className="group relative inline-flex">
                <span
                  className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-gray-300 dark:border-slate-600 text-[10px] font-bold text-gray-500 dark:text-slate-400"
                  aria-label="Status definition: online means fresh heartbeat signals are being received"
                >
                  ?
                </span>
                <span className="pointer-events-none absolute left-1/2 top-full z-20 mt-1 hidden w-64 -translate-x-1/2 rounded-md bg-gray-900 px-2 py-1.5 text-[11px] normal-case font-medium leading-snug text-white shadow-lg group-hover:block group-focus-within:block">
                  Online means the charger is actively sending fresh heartbeat signals to the server. If heartbeats stop for about 17+ minutes, it is marked offline.
                </span>
              </span>
            </span>
            <span className="text-right">Action</span>
          </div>
          <div className="divide-y divide-gray-100 dark:divide-slate-800">
            {filteredSites.map((site) => (
              <SiteListRow key={site.id} site={site} />
            ))}
          </div>
        </div>
      ) : (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filteredSites.map((site) => (
            <SiteCard key={site.id} site={site} />
          ))}
        </div>
      )}

      {showAddSiteModal && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4" onClick={() => setShowAddSiteModal(false)}>
          <div className="w-full max-w-lg rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-slate-100">Add Site</h2>
            <p className="mt-1 text-xs text-gray-500 dark:text-slate-400">Owner/Operator action — create a new charging site.</p>
            <form className="mt-4 space-y-3" onSubmit={handleCreateSite}>
              <input
                className="w-full rounded-md border border-gray-300 dark:border-slate-600 px-3 py-2 text-sm"
                placeholder="Site name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
              <input
                className="w-full rounded-md border border-gray-300 dark:border-slate-600 px-3 py-2 text-sm"
                placeholder="Address"
                value={form.address}
                onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
              />
              <div className="grid grid-cols-2 gap-3">
                <input
                  className="w-full rounded-md border border-gray-300 dark:border-slate-600 px-3 py-2 text-sm"
                  placeholder="Latitude"
                  value={form.lat}
                  onChange={(e) => setForm((f) => ({ ...f, lat: e.target.value }))}
                />
                <input
                  className="w-full rounded-md border border-gray-300 dark:border-slate-600 px-3 py-2 text-sm"
                  placeholder="Longitude"
                  value={form.lng}
                  onChange={(e) => setForm((f) => ({ ...f, lng: e.target.value }))}
                />
              </div>

              {createMsg && <p className="text-xs text-gray-500 dark:text-slate-400">{createMsg}</p>}

              <div className="mt-2 flex justify-end gap-2">
                <button
                  type="button"
                  className="rounded-md border border-gray-300 dark:border-slate-600 px-3 py-2 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 dark:bg-slate-800/60"
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

function SiteListRow({ site }: { site: SiteListItem }) {
  const total = site.chargerCount;
  const online = site.statusSummary.online;
  const offline = site.statusSummary.offline + site.statusSummary.faulted;
  return (
    <div className="grid gap-3 px-4 py-3 md:grid-cols-[1.8fr_1fr_1fr_1fr] md:items-center">
      <div>
        <Link to={`/sites/${shortId(site.id)}`} className="font-semibold text-gray-900 dark:text-slate-100 hover:text-brand-700 hover:underline">
          {site.name}
        </Link>
        <p className="text-xs text-gray-500 dark:text-slate-400">{site.address}</p>
      </div>
      <div className="text-sm text-gray-700 dark:text-slate-300">{total}</div>
      <div className="flex flex-wrap gap-2 text-xs">
        <span className="rounded-full border border-green-200 bg-green-50 px-2 py-0.5 text-green-700">Online {online}</span>
        {offline > 0 && <span className="rounded-full border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/60 px-2 py-0.5 text-gray-600 dark:text-slate-400">Offline {offline}</span>}
      </div>
      <div className="md:text-right">
        <Link to={`/sites/${shortId(site.id)}`} className="inline-block rounded-md border border-gray-200 dark:border-slate-700 px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800 dark:bg-slate-800/60">
          View Site →
        </Link>
      </div>
    </div>
  );
}

function SiteCard({ site }: { site: SiteListItem }) {
  const total = site.chargerCount;
  const online = site.statusSummary.online;
  const offline = site.statusSummary.offline + site.statusSummary.faulted;

  return (
    <div className="rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 shadow-sm transition hover:shadow-md">
      <div className="flex items-start justify-between">
        <div className="min-w-0">
          <Link to={`/sites/${shortId(site.id)}`} className="block truncate font-semibold text-gray-900 dark:text-slate-100 hover:text-brand-700 hover:underline">
            {site.name}
          </Link>
          <p className="mt-0.5 truncate text-xs text-gray-500 dark:text-slate-400">{site.address}</p>
        </div>
        <span className="ml-2 shrink-0 text-2xl">🔌</span>
      </div>

      <div className="mt-4 flex gap-3">
        <Stat label="Total" value={total} color="text-gray-700 dark:text-slate-300" />
        <Stat label="Online" value={online} color="text-green-700" />
        {offline > 0 && <Stat label="Offline" value={offline} color="text-gray-500 dark:text-slate-400" />}
      </div>

      <div className="mt-4 flex gap-2">
        <Link
          to={`/sites/${shortId(site.id)}`}
          className="flex-1 rounded-md bg-brand-600 px-3 py-1.5 text-center text-xs font-medium text-white hover:bg-brand-700"
        >
          View Site
        </Link>
        <Link
          to={`/sites/${shortId(site.id)}/analytics`}
          className="flex-1 rounded-md border border-gray-200 dark:border-slate-700 px-3 py-1.5 text-center text-xs font-medium text-gray-600 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800 dark:bg-slate-800/60"
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
      <p className="mt-0.5 text-xs text-gray-400 dark:text-slate-500">{label}</p>
    </div>
  );
}
