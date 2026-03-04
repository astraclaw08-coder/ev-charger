import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { createApiClient, type SiteListItem } from '../api/client';
import { useToken } from '../auth/TokenContext';

export default function Sites() {
  const getToken = useToken();
  const [sites, setSites] = useState<SiteListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let mounted = true;
    async function load() {
      try {
        const token = await getToken();
        const data = await createApiClient(token).getSites();
        if (!mounted) return;
        setSites(data);
      } catch (err: unknown) {
        if (!mounted) return;
        setError(err instanceof Error ? err.message : 'Failed to load sites');
      } finally {
        if (mounted) setLoading(false);
      }
    }
    load();
    return () => {
      mounted = false;
    };
  }, [getToken]);

  if (loading) return <div className="flex h-64 items-center justify-center text-gray-400">Loading sites…</div>;
  if (error) return <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700">{error}</div>;

  return (
    <div>
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Sites</h1>
        <p className="mt-1 text-sm text-gray-500">All charging sites and their fleet status</p>
      </div>

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
