import { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { createApiClient, type ChargerStatus, type SessionRecord, type ChargerUptime } from '../api/client';
import { useToken } from '../auth/TokenContext';
import StatusBadge from '../components/StatusBadge';
import { formatDate, formatDuration } from '../lib/utils';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

export default function ChargerDetail() {
  const { id } = useParams<{ id: string }>();
  const getToken = useToken();

  const [status, setStatus] = useState<ChargerStatus | null>(null);
  const [chargerSite, setChargerSite] = useState<{ id: string; name: string } | null>(null);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [uptime, setUptime] = useState<ChargerUptime | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [resetLoading, setResetLoading] = useState(false);
  const [resetMsg, setResetMsg] = useState('');
  const [remoteStartLoading, setRemoteStartLoading] = useState(false);
  const [remoteStartMsg, setRemoteStartMsg] = useState('');
  const [idTag, setIdTag] = useState('TESTDRIVER0001');
  const [connectorId, setConnectorId] = useState<number>(1);
  const [heartbeatLoading, setHeartbeatLoading] = useState(false);
  const [heartbeatMsg, setHeartbeatMsg] = useState('');
  const [configLoading, setConfigLoading] = useState(false);
  const [configMsg, setConfigMsg] = useState('');

  const load = useCallback(async () => {
    try {
      const token = await getToken();
      const client = createApiClient(token);
      const [chargerStatus, recentSessions, uptimeData, chargers] = await Promise.all([
        client.getChargerStatus(id!),
        client.getChargerSessions(id!),
        client.getChargerUptime(id!).catch(() => null),
        client.getChargers().catch(() => []),
      ]);
      setStatus(chargerStatus);
      const found = chargers.find((c) => c.id === id);
      setChargerSite(found ? { id: found.site.id, name: found.site.name } : null);
      setSessions(recentSessions);
      setUptime(uptimeData);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load charger');
    } finally {
      setLoading(false);
    }
  }, [id, getToken]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (status?.connectors?.length) {
      setConnectorId(status.connectors[0].connectorId);
    }
  }, [status]);

  async function handleRemoteStart() {
    setRemoteStartMsg('');
    setRemoteStartLoading(true);
    try {
      const token = await getToken();
      const result = await createApiClient(token).remoteStartCharger(id!, { connectorId, idTag });
      setRemoteStartMsg(`Remote start command sent — charger responded: ${result.status}`);
      setTimeout(load, 1500);
    } catch (err: unknown) {
      setRemoteStartMsg(err instanceof Error ? err.message : 'Remote start failed');
    } finally {
      setRemoteStartLoading(false);
    }
  }

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

  async function handleTriggerHeartbeat() {
    setHeartbeatMsg('');
    setHeartbeatLoading(true);
    try {
      const token = await getToken();
      const result = await createApiClient(token).triggerHeartbeat(id!);
      setHeartbeatMsg(`Heartbeat trigger sent — charger responded: ${result.status}`);
      setTimeout(load, 1200);
    } catch (err: unknown) {
      setHeartbeatMsg(err instanceof Error ? err.message : 'Heartbeat trigger failed');
    } finally {
      setHeartbeatLoading(false);
    }
  }

  async function handleGetConfiguration() {
    setConfigMsg('');
    setConfigLoading(true);
    try {
      const token = await getToken();
      const result = await createApiClient(token).getChargerConfiguration(id!);
      if ('error' in result && result.error) {
        setConfigMsg(`GetConfiguration failed: ${result.error}`);
      } else {
        const keyCount = result.configurationKey?.length ?? 0;
        const unknownCount = result.unknownKey?.length ?? 0;
        setConfigMsg(`GetConfiguration returned ${keyCount} key(s)${unknownCount ? `, unknown: ${unknownCount}` : ''}`);
      }
    } catch (err: unknown) {
      setConfigMsg(err instanceof Error ? err.message : 'GetConfiguration failed');
    } finally {
      setConfigLoading(false);
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
            <Link to="/sites" className="hover:text-gray-700">Sites</Link>
            <span>/</span>
            {chargerSite ? (
              <Link to={`/sites/${chargerSite.id}`} className="hover:text-gray-700">{chargerSite.name}</Link>
            ) : (
              <span>Site</span>
            )}
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

        {/* Remote start + reset controls */}
        <div className="flex min-w-[360px] flex-col items-end gap-2">
          <div className="w-full rounded-lg border border-gray-200 bg-white p-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Remote Start</p>
            <div className="grid grid-cols-3 gap-2">
              <select
                value={connectorId}
                onChange={(e) => setConnectorId(Number(e.target.value))}
                className="rounded-md border border-gray-300 px-2 py-2 text-sm"
              >
                {status.connectors.map((c) => (
                  <option key={c.connectorId} value={c.connectorId}>Connector #{c.connectorId}</option>
                ))}
              </select>
              <input
                value={idTag}
                onChange={(e) => setIdTag(e.target.value)}
                placeholder="idTag"
                className="rounded-md border border-gray-300 px-2 py-2 text-sm"
              />
              <button
                onClick={handleRemoteStart}
                disabled={remoteStartLoading || !idTag.trim()}
                className="rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
              >
                {remoteStartLoading ? 'Starting…' : 'Remote Start'}
              </button>
            </div>
            {remoteStartMsg && <p className="mt-2 text-xs text-gray-500">{remoteStartMsg}</p>}
          </div>

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
          <div className="flex gap-2">
            <button
              onClick={handleTriggerHeartbeat}
              disabled={heartbeatLoading}
              className="rounded-md border border-brand-200 px-4 py-2 text-sm font-medium text-brand-700 hover:bg-brand-50 disabled:opacity-50"
            >
              {heartbeatLoading ? 'Requesting…' : 'Request Heartbeat'}
            </button>
            <button
              onClick={handleGetConfiguration}
              disabled={configLoading}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {configLoading ? 'Fetching…' : 'Get Configuration'}
            </button>
          </div>
          {resetMsg && (
            <p className="text-xs text-gray-500">{resetMsg}</p>
          )}
          {heartbeatMsg && (
            <p className="text-xs text-gray-500">{heartbeatMsg}</p>
          )}
          {configMsg && (
            <p className="text-xs text-gray-500">{configMsg}</p>
          )}
        </div>
      </div>



      {uptime && (
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="mb-4 text-sm font-semibold text-gray-700">Uptime Monitoring (OCA v1.1)</h2>
          <div className="grid gap-3 sm:grid-cols-3 mb-4">
            <div><p className="text-xs text-gray-500">24h</p><p className={`text-lg font-semibold ${uptime.uptimePercent24h >= 99 ? 'text-green-700' : uptime.uptimePercent24h >= 95 ? 'text-amber-700' : 'text-red-700'}`}>{uptime.uptimePercent24h.toFixed(2)}%</p></div>
            <div><p className="text-xs text-gray-500">7d</p><p className={`text-lg font-semibold ${uptime.uptimePercent7d >= 99 ? 'text-green-700' : uptime.uptimePercent7d >= 95 ? 'text-amber-700' : 'text-red-700'}`}>{uptime.uptimePercent7d.toFixed(2)}%</p></div>
            <div><p className="text-xs text-gray-500">30d</p><p className={`text-lg font-semibold ${uptime.uptimePercent30d >= 99 ? 'text-green-700' : uptime.uptimePercent30d >= 95 ? 'text-amber-700' : 'text-red-700'}`}>{uptime.uptimePercent30d.toFixed(2)}%</p></div>
          </div>

          <div className="h-36">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={[
                { window: '24h', value: uptime.uptimePercent24h },
                { window: '7d', value: uptime.uptimePercent7d },
                { window: '30d', value: uptime.uptimePercent30d },
              ]}>
                <XAxis dataKey="window" />
                <YAxis domain={[0, 100]} />
                <Tooltip formatter={(v: number) => `${v.toFixed(2)}%`} />
                <Line type="monotone" dataKey="value" stroke="#10b981" strokeWidth={2} dot />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

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
                  <th className="px-5 py-3">Txn #</th>
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
                    <td className="px-5 py-3 font-mono text-xs text-gray-700">
                      {s.transactionId ?? '—'}
                    </td>
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
                        ? `${s.payment.status}${(s.effectiveAmountCents ?? s.payment.amountCents) != null ? ` · $${(((s.effectiveAmountCents ?? s.payment.amountCents) as number) / 100).toFixed(2)}` : ''}`
                        : (s.effectiveAmountCents != null ? `$${(s.effectiveAmountCents / 100).toFixed(2)}` : '—')}
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
