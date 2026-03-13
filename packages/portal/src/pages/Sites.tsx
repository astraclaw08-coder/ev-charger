import { useEffect, useState } from 'react';

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

export default function Sites() {
  const getToken = useToken();
  const [sites, setSites] = useState<SiteListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [totalConnectors, setTotalConnectors] = useState(0);
  const [showAddSiteModal, setShowAddSiteModal] = useState(false);
  const [createLoading, setCreateLoading] = useState(false);
  const [createMsg, setCreateMsg] = useState('');
  const [form, setForm] = useState<CreateSiteForm>(EMPTY_FORM);

  async function loadSites() {
    try {
      const token = await getToken();
      const client = createApiClient(token);
      const data = await client.getSites();
      setSites(data);
      const connectors = data.reduce((sum, site) => sum + (site.connectorCount ?? 0), 0);
      setTotalConnectors(connectors);
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

  if (loading) return <div className="flex h-64 items-center justify-center text-gray-400">Loading sites…</div>;
  if (error) return <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700">{error}</div>;

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Sites</h1>
          <p className="mt-1 text-sm text-gray-500">All charging sites and their fleet status</p>
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

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
          <p className="text-xs uppercase tracking-wide text-gray-500">Total Sites</p>
          <p className="mt-1 text-2xl font-semibold text-gray-900">{sites.length}</p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
          <p className="text-xs uppercase tracking-wide text-gray-500">Total Connectors</p>
          <p className="mt-1 text-2xl font-semibold text-gray-900">{totalConnectors}</p>
        </div>
      </div>

      {createMsg && !showAddSiteModal && (
        <p className="mt-2 text-xs text-gray-500">{createMsg}</p>
      )}

      {sites.length === 0 ? (
        <div className="mt-12 text-center text-gray-400">
          <p className="text-4xl">📍</p>
          <p className="mt-2 font-medium">No sites yet</p>
        </div>
      ) : sites.length > 4 ? (
        <div className="mt-6 overflow-hidden rounded-xl border border-gray-200 bg-white">
          <div className="hidden grid-cols-[1.8fr_1fr_1fr_1fr] gap-3 border-b border-gray-200 bg-gray-50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-gray-500 md:grid">
            <span>Site</span>
            <span>Chargers</span>
            <span>Status</span>
            <span className="text-right">Action</span>
          </div>
          <div className="divide-y divide-gray-100">
            {sites.map((site) => (
              <SiteListRow key={site.id} site={site} />
            ))}
          </div>
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

function SiteListRow({ site }: { site: SiteListItem }) {
  const total = site.chargerCount;
  const { online, offline, faulted } = site.statusSummary;
  return (
    <div className="grid gap-3 px-4 py-3 md:grid-cols-[1.8fr_1fr_1fr_1fr] md:items-center">
      <div>
        <p className="font-semibold text-gray-900">{site.name}</p>
        <p className="text-xs text-gray-500">{site.address}</p>
      </div>
      <div className="text-sm text-gray-700">{total}</div>
      <div className="flex flex-wrap gap-2 text-xs">
        <span className="rounded-full border border-green-200 bg-green-50 px-2 py-0.5 text-green-700">Online {online}</span>
        {faulted > 0 && <span className="rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-red-700">Faulted {faulted}</span>}
        {offline > 0 && <span className="rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-gray-600">Offline {offline}</span>}
      </div>
      <div className="md:text-right">
        <Link to={`/sites/${site.id}`} className="inline-block rounded-md border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50">
          View Site →
        </Link>
      </div>
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
