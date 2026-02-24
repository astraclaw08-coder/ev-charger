import { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { createApiClient, type SiteDetail as SiteDetailType } from '../api/client';
import { useToken } from '../auth/TokenContext';
import ChargerMap from '../components/ChargerMap';
import StatusBadge from '../components/StatusBadge';
import AddChargerDialog from '../components/AddChargerDialog';
import { formatDate } from '../lib/utils';

export default function SiteDetail() {
  const { id } = useParams<{ id: string }>();
  const getToken = useToken();
  const [site, setSite] = useState<SiteDetailType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showAddCharger, setShowAddCharger] = useState(false);

  const load = useCallback(async () => {
    try {
      const token = await getToken();
      const data = await createApiClient(token).getSite(id!);
      setSite(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load site');
    } finally {
      setLoading(false);
    }
  }, [id, getToken]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return <div className="flex h-64 items-center justify-center text-gray-400">Loading…</div>;
  }
  if (error || !site) {
    return <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700">{error || 'Site not found'}</div>;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <Link to="/" className="hover:text-gray-700">Dashboard</Link>
            <span>/</span>
            <span className="text-gray-900">{site.name}</span>
          </div>
          <h1 className="mt-1 text-2xl font-bold text-gray-900">{site.name}</h1>
          <p className="text-sm text-gray-500">{site.address}</p>
        </div>
        <div className="flex gap-2">
          <Link
            to={`/sites/${site.id}/analytics`}
            className="rounded-md border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
          >
            Analytics
          </Link>
          <button
            onClick={() => setShowAddCharger(true)}
            className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            + Add Charger
          </button>
        </div>
      </div>

      {/* Map */}
      <ChargerMap
        lat={site.lat}
        lng={site.lng}
        siteName={site.name}
        chargers={site.chargers}
      />

      {/* Connector status grid */}
      <div>
        <h2 className="mb-3 text-lg font-semibold text-gray-900">
          Chargers ({site.chargers.length})
        </h2>

        {site.chargers.length === 0 ? (
          <div className="rounded-lg border-2 border-dashed border-gray-200 p-10 text-center text-gray-400">
            <p className="text-3xl">🔌</p>
            <p className="mt-2 font-medium">No chargers registered</p>
            <button
              onClick={() => setShowAddCharger(true)}
              className="mt-3 text-sm text-brand-600 hover:underline"
            >
              Register your first charger →
            </button>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {site.chargers.map((charger) => (
              <ChargerCard key={charger.id} charger={charger} />
            ))}
          </div>
        )}
      </div>

      {/* Add Charger Dialog */}
      {showAddCharger && (
        <AddChargerDialog
          siteId={site.id}
          onAdd={async (body) => {
            const token = await getToken();
            const result = await createApiClient(token).createCharger(body);
            await load(); // refresh the site
            return result;
          }}
          onClose={() => setShowAddCharger(false)}
        />
      )}
    </div>
  );
}

function ChargerCard({ charger }: { charger: SiteDetailType['chargers'][number] }) {
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
        <p className="mt-1 text-xs text-gray-400">
          Last heartbeat: {formatDate(charger.lastHeartbeat)}
        </p>
      )}

      {/* Connector grid */}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {charger.connectors.map((c) => (
          <div
            key={c.id}
            className="flex items-center gap-1 rounded-md border border-gray-100 bg-gray-50 px-2 py-0.5"
          >
            <span className="text-xs text-gray-500">#{c.connectorId}</span>
            <StatusBadge status={c.status} type="connector" />
          </div>
        ))}
      </div>

      <Link
        to={`/chargers/${charger.id}`}
        className="mt-3 block rounded-md border border-gray-200 px-3 py-1.5 text-center text-xs font-medium text-gray-600 hover:bg-gray-50"
      >
        View Detail →
      </Link>
    </div>
  );
}
