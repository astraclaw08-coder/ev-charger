import { useEffect, useMemo, useState } from 'react';
import { Modal } from '../components/Modal';
import { useJsApiLoader } from '@react-google-maps/api';

const GOOGLE_MAPS_LIBRARIES: ('places')[] = ['places'];

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
import AddressAutocomplete from '../components/AddressAutocomplete';

export default function Sites() {
  const getToken = useToken();
  // Ensure Google Maps JS API (with Places library) is loaded for AddressAutocomplete
  useJsApiLoader({
    id: 'portal-google-maps-loader',
    googleMapsApiKey: (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined) ?? '',
    libraries: GOOGLE_MAPS_LIBRARIES,
  });
  const [sites, setSites] = useState<SiteListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [totalConnectors, setTotalConnectors] = useState(0);
  const [totalChargers, setTotalChargers] = useState(0);
  const [showAddSiteModal, setShowAddSiteModal] = useState(false);
  const [createLoading, setCreateLoading] = useState(false);
  const [createMsg, setCreateMsg] = useState('');
  const [form, setForm] = useState<CreateSiteForm>(EMPTY_FORM);
  const [coordsAutoFilled, setCoordsAutoFilled] = useState(false);
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
      || (site.organization?.name ?? site.organizationName ?? '').toLowerCase().includes(q)
      || (site.portfolio?.name ?? site.portfolioName ?? '').toLowerCase().includes(q),
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
  if (error) return <div className="rounded-lg bg-red-50 dark:bg-red-900/20 p-4 text-sm text-red-700 dark:text-red-400">{error}</div>;

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-slate-100">Sites</h1>
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
          <div key={label} className="rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2.5">
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
        <div className="mt-6 overflow-hidden rounded-xl border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900">
          <div className="hidden grid-cols-[1.6fr_1fr_0.8fr_1fr_0.7fr] gap-3 border-b border-gray-300 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/60 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-slate-400 md:grid">
            <span>Site</span>
            <span>Organization</span>
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

      <Modal open={showAddSiteModal} onClose={() => setShowAddSiteModal(false)} title="Add Site" subtitle="Owner/Operator action — create a new charging site.">
            <form className="space-y-3" onSubmit={handleCreateSite}>
              <input
                className="w-full rounded-md border border-gray-300 dark:border-slate-600 px-3 py-2 text-sm"
                placeholder="Site name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
              <AddressAutocomplete
                value={form.address}
                className="w-full rounded-md border border-gray-300 dark:border-slate-600 px-3 py-2 text-sm"
                placeholder="Start typing an address…"
                onRawChange={(v) => {
                  setForm((f) => ({ ...f, address: v }));
                  if (coordsAutoFilled) {
                    setCoordsAutoFilled(false);
                    setForm((f) => ({ ...f, lat: '', lng: '' }));
                  }
                }}
                onChange={(address, lat, lng) => {
                  setForm((f) => ({ ...f, address, lat: String(lat), lng: String(lng) }));
                  setCoordsAutoFilled(true);
                }}
              />
              <div className="grid grid-cols-2 gap-3">
                <input
                  className="w-full rounded-md border border-gray-300 dark:border-slate-600 px-3 py-2 text-sm"
                  placeholder="Latitude"
                  value={form.lat}
                  readOnly={coordsAutoFilled}
                  onChange={(e) => setForm((f) => ({ ...f, lat: e.target.value }))}
                />
                <input
                  className="w-full rounded-md border border-gray-300 dark:border-slate-600 px-3 py-2 text-sm"
                  placeholder="Longitude"
                  value={form.lng}
                  readOnly={coordsAutoFilled}
                  onChange={(e) => setForm((f) => ({ ...f, lng: e.target.value }))}
                />
              </div>

              {createMsg && <p className="text-xs text-gray-500 dark:text-slate-400">{createMsg}</p>}

              <div className="mt-2 flex justify-end gap-2">
                <button
                  type="button"
                  className="rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-gray-700 dark:text-slate-200 hover:bg-gray-50 dark:hover:bg-slate-700"
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
      </Modal>
    </div>
  );
}

function SiteListRow({ site }: { site: SiteListItem }) {
  const total = site.chargerCount;
  const online = site.statusSummary.online;
  const offline = site.statusSummary.offline + site.statusSummary.faulted;
  return (
    <Link
      to={`/sites/${shortId(site.id)}`}
      className="grid gap-3 px-4 py-3 md:grid-cols-[1.6fr_1fr_0.8fr_1fr_0.7fr] md:items-center cursor-pointer transition-colors hover:bg-gray-50 dark:hover:bg-slate-800/60"
    >
      <div>
        <span className="font-semibold text-gray-900 dark:text-slate-100">
          {site.name}
        </span>
        <p className="text-xs text-gray-500 dark:text-slate-400">{site.address}</p>
      </div>
      <div className="min-w-0">
        {(site.organization?.name || site.organizationName) ? (
          <div>
            <span className="text-sm text-gray-700 dark:text-slate-300 truncate block">{site.organization?.name ?? site.organizationName}</span>
            {(site.portfolio?.name || site.portfolioName) && (
              <span className="text-xs text-gray-400 dark:text-slate-500 truncate block">{site.portfolio?.name ?? site.portfolioName}</span>
            )}
          </div>
        ) : (
          <span className="text-xs text-gray-400 dark:text-slate-500">—</span>
        )}
      </div>
      <div className="text-sm text-gray-700 dark:text-slate-300">{total}</div>
      <div className="flex flex-wrap gap-2 text-xs">
        <span className="rounded-full border border-green-200 bg-green-50 px-2 py-0.5 text-green-700">Online {online}</span>
        {offline > 0 && <span className="rounded-full border border-gray-300 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/60 px-2 py-0.5 text-gray-600 dark:text-slate-400">Offline {offline}</span>}
      </div>
      <div className="md:text-right">
        <span className="inline-block rounded-md border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-slate-200">
          View Site →
        </span>
      </div>
    </Link>
  );
}

function SiteCard({ site }: { site: SiteListItem }) {
  const total = site.chargerCount;
  const online = site.statusSummary.online;
  const offline = site.statusSummary.offline + site.statusSummary.faulted;

  return (
    <Link
      to={`/sites/${shortId(site.id)}`}
      className="block rounded-xl border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 shadow-sm transition hover:shadow-md hover:border-brand-300 dark:hover:border-brand-600/50 cursor-pointer"
    >
      <div className="flex items-start justify-between">
        <div className="min-w-0">
          <span className="block truncate font-semibold text-gray-900 dark:text-slate-100">
            {site.name}
          </span>
          <p className="mt-0.5 truncate text-xs text-gray-500 dark:text-slate-400">{site.address}</p>
          {(site.organization?.name || site.organizationName) && (
            <p className="mt-1 truncate text-xs text-gray-400 dark:text-slate-500">
              {site.organization?.name ?? site.organizationName}{(site.portfolio?.name || site.portfolioName) ? ` · ${(site.portfolio?.name ?? site.portfolioName)}` : ''}
            </p>
          )}
        </div>
        <span className="ml-2 shrink-0 text-2xl">🔌</span>
      </div>

      <div className="mt-4 flex gap-3">
        <Stat label="Total" value={total} color="text-gray-700 dark:text-slate-300" />
        <Stat label="Online" value={online} color="text-green-700" />
        {offline > 0 && <Stat label="Offline" value={offline} color="text-gray-500 dark:text-slate-400" />}
      </div>

      <div className="mt-4 flex gap-2">
        <span className="flex-1 rounded-md bg-brand-600 px-3 py-1.5 text-center text-xs font-medium text-white">
          View Site
        </span>
        <span
          role="button"
          onClick={(e) => { e.preventDefault(); window.location.href = `/sites/${shortId(site.id)}/analytics`; }}
          className="flex-1 rounded-md border border-gray-300 dark:border-slate-700 px-3 py-1.5 text-center text-xs font-medium text-gray-600 dark:text-slate-400 bg-white dark:bg-slate-800/60 hover:bg-gray-50 dark:hover:bg-slate-700"
        >
          Analytics
        </span>
      </div>
    </Link>
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
