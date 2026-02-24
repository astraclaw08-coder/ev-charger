import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { createApiClient, type SiteListItem } from '../api/client';
import { useToken } from '../auth/TokenContext';

export default function Dashboard() {
  const getToken = useToken();
  const [sites, setSites] = useState<SiteListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    async function load() {
      try {
        const token = await getToken();
        const data = await createApiClient(token).getSites();
        setSites(data);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to load sites');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [getToken]);

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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
          <p className="mt-1 text-sm text-gray-500">All your charging sites</p>
        </div>
      </div>

      {sites.length === 0 ? (
        <div className="mt-12 text-center text-gray-400">
          <p className="text-4xl">📍</p>
          <p className="mt-2 font-medium">No sites yet</p>
          <p className="text-sm">Use the API to create your first site, then register chargers.</p>
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

      {/* Status bar */}
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
