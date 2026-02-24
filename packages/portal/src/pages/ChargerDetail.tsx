import { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { createApiClient, type ChargerStatus, type SessionRecord } from '../api/client';
import { useToken } from '../auth/TokenContext';
import StatusBadge from '../components/StatusBadge';
import { formatDate, formatDuration } from '../lib/utils';

export default function ChargerDetail() {
  const { id } = useParams<{ id: string }>();
  const getToken = useToken();

  const [status, setStatus] = useState<ChargerStatus | null>(null);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [resetLoading, setResetLoading] = useState(false);
  const [resetMsg, setResetMsg] = useState('');

  const load = useCallback(async () => {
    try {
      const token = await getToken();
      const client = createApiClient(token);
      const [chargerStatus, recentSessions] = await Promise.all([
        client.getChargerStatus(id!),
        client.getChargerSessions(id!),
      ]);
      setStatus(chargerStatus);
      setSessions(recentSessions);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load charger');
    } finally {
      setLoading(false);
    }
  }, [id, getToken]);

  useEffect(() => { load(); }, [load]);

  async function handleReset(type: 'Soft' | 'Hard') {
    setResetMsg('');
    setResetLoading(true);
    try {
      const token = await getToken();
      const result = await createApiClient(token).resetCharger(id!, type);
      setResetMsg(`Reset command sent — charger responded: ${result.status}`);
      // Refresh status after a short delay
      setTimeout(load, 2000);
    } catch (err: unknown) {
      setResetMsg(err instanceof Error ? err.message : 'Reset failed');
    } finally {
      setResetLoading(false);
    }
  }

  if (loading) {
    return <div className="flex h-64 items-center justify-center text-gray-400">Loading charger…</div>;
  }
  if (error || !status) {
    return <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700">{error || 'Charger not found'}</div>;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <Link to="/" className="hover:text-gray-700">Dashboard</Link>
            <span>/</span>
            <span className="text-gray-900 font-mono">{status.ocppId}</span>
          </div>
          <div className="mt-1 flex items-center gap-3">
            <h1 className="text-2xl font-bold font-mono text-gray-900">{status.ocppId}</h1>
            <StatusBadge status={status.status} type="charger" />
          </div>
          {status.lastHeartbeat && (
            <p className="text-sm text-gray-500">
              Last heartbeat: {formatDate(status.lastHeartbeat)}
            </p>
          )}
        </div>

        {/* Reset controls */}
        <div className="flex flex-col items-end gap-2">
          <div className="flex gap-2">
            <button
              onClick={() => handleReset('Soft')}
              disabled={resetLoading}
              className="rounded-md border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            >
              Soft Reset
            </button>
            <button
              onClick={() => handleReset('Hard')}
              disabled={resetLoading}
              className="rounded-md border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
            >
              Hard Reset
            </button>
          </div>
          {resetMsg && (
            <p className="text-xs text-gray-500">{resetMsg}</p>
          )}
        </div>
      </div>

      {/* Connector status grid */}
      <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <h2 className="mb-4 text-sm font-semibold text-gray-700">Connector States</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {status.connectors.map((c) => (
            <div
              key={c.connectorId}
              className="rounded-lg border border-gray-100 bg-gray-50 p-3"
            >
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-gray-700">Connector #{c.connectorId}</p>
                <StatusBadge status={c.status} type="connector" />
              </div>
              {c.activeSession && (
                <div className="mt-2 rounded-md bg-green-50 px-2 py-1.5 text-xs text-green-700">
                  <p className="font-medium">Active Session</p>
                  <p>Tag: {c.activeSession.idTag}</p>
                  <p>Started: {formatDate(c.activeSession.startedAt)}</p>
                  {c.activeSession.user && (
                    <p>{c.activeSession.user.name ?? c.activeSession.user.email}</p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Session log */}
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="border-b border-gray-200 px-5 py-4">
          <h2 className="text-sm font-semibold text-gray-700">Recent Sessions</h2>
        </div>

        {sessions.length === 0 ? (
          <div className="p-10 text-center text-sm text-gray-400">No sessions yet</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs font-medium text-gray-500">
                  <th className="px-5 py-3">Connector</th>
                  <th className="px-5 py-3">Driver</th>
                  <th className="px-5 py-3">Started</th>
                  <th className="px-5 py-3">Duration</th>
                  <th className="px-5 py-3">kWh</th>
                  <th className="px-5 py-3">Status</th>
                  <th className="px-5 py-3">Payment</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {sessions.map((s) => (
                  <tr key={s.id} className="hover:bg-gray-50">
                    <td className="px-5 py-3 font-mono text-xs text-gray-500">
                      #{s.connector.connectorId}
                    </td>
                    <td className="px-5 py-3 text-gray-700">
                      {s.user?.name ?? s.user?.email ?? s.idTag}
                    </td>
                    <td className="px-5 py-3 text-gray-500 text-xs">
                      {formatDate(s.startedAt)}
                    </td>
                    <td className="px-5 py-3 text-gray-500">
                      {formatDuration(s.startedAt, s.stoppedAt)}
                    </td>
                    <td className="px-5 py-3 text-gray-700">
                      {s.kwhDelivered != null ? `${s.kwhDelivered.toFixed(2)} kWh` : '—'}
                    </td>
                    <td className="px-5 py-3">
                      <StatusBadge
                        status={s.status}
                        type="charger"
                      />
                    </td>
                    <td className="px-5 py-3 text-gray-500 text-xs">
                      {s.payment
                        ? `${s.payment.status}${s.payment.amountCents != null ? ` · $${(s.payment.amountCents / 100).toFixed(2)}` : ''}`
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
