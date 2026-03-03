import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { createApiClient, type SiteListItem } from '../api/client';
import { useToken } from '../auth/TokenContext';

export default function AnalyticsPicker() {
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Analytics</h1>
        <p className="text-sm text-gray-600">Select a site to open analytics dashboards.</p>
      </div>

      {loading && <div className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-600">Loading sites…</div>}
      {error && <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>}

      {!loading && !error && (
        <div className="grid gap-3 md:grid-cols-2">
          {sites.map((site) => (
            <Link
              key={site.id}
              to={`/sites/${site.id}/analytics`}
              className="rounded-lg border border-gray-200 bg-white p-4 transition hover:border-brand-200 hover:shadow-sm"
            >
              <div className="text-sm font-semibold text-gray-900">{site.name}</div>
              <div className="mt-1 text-xs text-gray-600">{site.address}</div>
              <div className="mt-3 text-xs font-medium text-brand-700">Open analytics →</div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
