import { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { buildChargerQrRedirectUrl, createApiClient, type ChargerStatus, type SessionRecord, type ChargerUptime } from '../api/client';
import { useToken } from '../auth/TokenContext';
import StatusBadge from '../components/StatusBadge';
import { formatDate, formatDuration } from '../lib/utils';
import { shortId } from '../lib/shortId';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import QRCode from 'qrcode';

type RangePreset = '7d' | '30d' | '60d';

function rangeDays(preset: RangePreset) {
  if (preset === '7d') return 7;
  if (preset === '30d') return 30;
  return 60;
}

function ChargerKpiTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-slate-400">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-gray-900 dark:text-slate-100">{value}</p>
    </div>
  );
}

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
  const [resolvedChargerId, setResolvedChargerId] = useState<string | null>(null);
  const [rangePreset, setRangePreset] = useState<RangePreset>('30d');
  const [showEditCharger, setShowEditCharger] = useState(false);
  const [chargerMeta, setChargerMeta] = useState<{ serialNumber: string; model: string; vendor: string } | null>(null);
  const [qrLink, setQrLink] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [qrBusy, setQrBusy] = useState(false);
  const [qrMsg, setQrMsg] = useState('');
  const [showQrModal, setShowQrModal] = useState(false);

  const load = useCallback(async () => {
    try {
      const token = await getToken();
      const client = createApiClient(token);

      const chargers = await client.getChargers().catch(() => []);
      const foundByRoute = chargers.find((c) => c.id === id || c.id.startsWith(id ?? '') || c.ocppId === id);
      const targetId = foundByRoute?.id ?? id;

      const [chargerStatus, recentSessions, uptimeData] = await Promise.all([
        client.getChargerStatus(targetId!),
        client.getChargerSessions(targetId!),
        client.getChargerUptime(targetId!).catch(() => null),
      ]);

      setStatus(chargerStatus);
      const found = foundByRoute ?? chargers.find((c) => c.id === targetId || c.ocppId === chargerStatus.ocppId);
      setResolvedChargerId(found?.id ?? targetId ?? null);
      setChargerSite(found ? { id: found.site.id, name: found.site.name } : null);
      setChargerMeta(found ? { serialNumber: found.serialNumber, model: found.model, vendor: found.vendor } : null);
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
    const targetId = resolvedChargerId ?? id;
    if (!targetId) {
      setRemoteStartMsg('Unable to resolve charger id for remote start');
      return;
    }
    setRemoteStartLoading(true);
    try {
      const token = await getToken();
      const result = await createApiClient(token).remoteStartCharger(targetId, { connectorId, idTag });
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
    const targetId = resolvedChargerId ?? id;
    if (!targetId) {
      setResetMsg('Unable to resolve charger id for reset');
      return;
    }
    setResetLoading(true);
    try {
      const token = await getToken();
      const result = await createApiClient(token).resetCharger(targetId, type);
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
    const targetId = resolvedChargerId ?? id;
    if (!targetId) {
      setHeartbeatMsg('Unable to resolve charger id for heartbeat');
      return;
    }
    setHeartbeatLoading(true);
    try {
      const token = await getToken();
      const result = await createApiClient(token).triggerHeartbeat(targetId);
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
    const targetId = resolvedChargerId ?? id;
    if (!targetId) {
      setConfigMsg('Unable to resolve charger id for configuration request');
      return;
    }
    setConfigLoading(true);
    try {
      const token = await getToken();
      const result = await createApiClient(token).getChargerConfiguration(targetId);
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

  async function handleGenerateQr() {
    setQrMsg('');
    const targetId = resolvedChargerId ?? id;
    if (!targetId) {
      setQrMsg('Unable to resolve charger id for QR link');
      return;
    }

    const link = buildChargerQrRedirectUrl(targetId);
    setQrBusy(true);
    try {
      const dataUrl = await QRCode.toDataURL(link, { width: 512, margin: 1 });
      setQrLink(link);
      setQrDataUrl(dataUrl);
      setQrMsg('QR generated. Scan to open app or store fallback.');
    } catch (err: unknown) {
      setQrMsg(err instanceof Error ? err.message : 'Failed to generate QR code');
    } finally {
      setQrBusy(false);
    }
  }

  async function handleCopyQrLink() {
    if (!qrLink) return;
    try {
      await navigator.clipboard.writeText(qrLink);
      setQrMsg('QR link copied.');
    } catch {
      setQrMsg('Clipboard unavailable in this browser context.');
    }
  }

  function handleDownloadQr() {
    if (!qrDataUrl) return;
    const targetId = resolvedChargerId ?? id ?? 'charger';
    const a = document.createElement('a');
    a.href = qrDataUrl;
    a.download = `${targetId}-smart-qr.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  if (loading) {
    return <div className="flex h-64 items-center justify-center text-gray-400 dark:text-slate-500">Loading charger…</div>;
  }
  if (error || !status) {
    return <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700">{error || 'Charger not found'}</div>;
  }

  const days = rangeDays(rangePreset);
  const rangeStartMs = Date.now() - (days * 24 * 60 * 60 * 1000);
  const rangeSessions = sessions.filter((s) => new Date(s.startedAt).getTime() >= rangeStartMs);
  const totalKwh = rangeSessions.reduce((sum, s) => sum + (s.kwhDelivered ?? 0), 0);
  const totalRevenueUsd = rangeSessions.reduce((sum, s) => {
    const cents = s.effectiveAmountCents ?? s.estimatedAmountCents ?? s.payment?.amountCents ?? 0;
    return sum + (cents / 100);
  }, 0);
  const rangeEndMs = Date.now();
  const activeChargingSeconds = rangeSessions.reduce((sum, s) => {
    const startMs = Math.max(new Date(s.startedAt).getTime(), rangeStartMs);
    const stopMs = s.stoppedAt ? new Date(s.stoppedAt).getTime() : rangeEndMs;
    if (!Number.isFinite(startMs) || !Number.isFinite(stopMs) || stopMs <= startMs) return sum;
    return sum + Math.max(0, Math.floor((stopMs - startMs) / 1000));
  }, 0);
  const utilizationPct = status.connectors.length > 0
    ? (activeChargingSeconds / (days * 24 * 60 * 60 * status.connectors.length)) * 100
    : 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-slate-400">
              <Link to="/overview" className="hover:text-gray-700 dark:hover:text-slate-200 dark:text-slate-300">Overview</Link>
              <span>/</span>
              <Link to="/sites" className="hover:text-gray-700 dark:hover:text-slate-200 dark:text-slate-300">Sites</Link>
              <span>/</span>
              {chargerSite ? (
                <Link to={`/sites/${shortId(chargerSite.id)}`} className="hover:text-gray-700 dark:hover:text-slate-200 dark:text-slate-300">{chargerSite.name}</Link>
              ) : (
                <span>Site</span>
              )}
              <span>/</span>
              <span className="text-gray-900 dark:text-slate-100 font-mono">{status.ocppId}</span>
            </div>
            <div className="mt-1 flex items-center gap-3">
              <h1 className="text-2xl font-bold font-mono text-gray-900 dark:text-slate-100">{status.ocppId}</h1>
              <StatusBadge status={status.status} type="charger" />

            </div>
            {status.lastHeartbeat && (
              <p className="text-sm text-gray-500 dark:text-slate-400">
                Last heartbeat: {formatDate(status.lastHeartbeat)}
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-end gap-2 self-end">
            <select
              value={rangePreset}
              onChange={(e) => setRangePreset(e.target.value as RangePreset)}
              className="rounded-md border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-2 text-sm font-medium text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 dark:bg-slate-800/60"
            >
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
              <option value="60d">Last 60 days</option>
            </select>
            <button
              onClick={() => setShowEditCharger((v) => !v)}
              className="rounded-md border border-gray-300 dark:border-slate-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 dark:bg-slate-800/60"
            >
              Edit Charger
            </button>
            <button
              onClick={() => setShowQrModal(true)}
              className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-gray-300 dark:border-slate-700 text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 dark:bg-slate-800/60"
              title="Smart QR deep link"
              aria-label="Open Smart QR deep link"
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3z" />
                <path d="M14 14h3v3h-3zM18 18h3v3h-3zM14 20h2M20 14h1" />
              </svg>
            </button>
          </div>
        </div>

        {showEditCharger && (
          <div className="mt-3 rounded-xl border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
            <h2 className="mb-3 text-sm font-semibold text-gray-700 dark:text-slate-300">Charger details</h2>
            <div className="grid gap-3 md:grid-cols-3">
              <label className="text-sm text-gray-700 dark:text-slate-300">OCPP ID
                <input disabled value={status.ocppId} className="mt-1 w-full rounded-md border border-gray-300 dark:border-slate-600 bg-gray-50 dark:bg-slate-800/60 px-2 py-1.5 text-sm text-gray-600 dark:text-slate-400" />
              </label>
              <label className="text-sm text-gray-700 dark:text-slate-300">Serial Number
                <input disabled value={chargerMeta?.serialNumber ?? '—'} className="mt-1 w-full rounded-md border border-gray-300 dark:border-slate-600 bg-gray-50 dark:bg-slate-800/60 px-2 py-1.5 text-sm text-gray-600 dark:text-slate-400" />
              </label>
              <label className="text-sm text-gray-700 dark:text-slate-300">Model / Vendor
                <input disabled value={`${chargerMeta?.model ?? '—'} / ${chargerMeta?.vendor ?? '—'}`} className="mt-1 w-full rounded-md border border-gray-300 dark:border-slate-600 bg-gray-50 dark:bg-slate-800/60 px-2 py-1.5 text-sm text-gray-600 dark:text-slate-400" />
              </label>
            </div>
          </div>
        )}

        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <ChargerKpiTile label={`Total kWh (${rangePreset})`} value={`${totalKwh.toFixed(2)} kWh`} />
          <ChargerKpiTile label={`Total Revenue (${rangePreset})`} value={`$${totalRevenueUsd.toFixed(2)}`} />
          <ChargerKpiTile label={`Utilization (${rangePreset})`} value={`${utilizationPct.toFixed(2)}%`} />
        </div>

        <div className="mt-4">
          <div className="rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-slate-400">Charger Controls</p>

            <div className="grid gap-2 lg:grid-cols-3">
              <select
                value={connectorId}
                onChange={(e) => setConnectorId(Number(e.target.value))}
                className="h-10 rounded-md border border-gray-300 dark:border-slate-600 px-2 text-sm"
              >
                {status.connectors.map((c) => (
                  <option key={c.connectorId} value={c.connectorId}>Connector #{c.connectorId}</option>
                ))}
              </select>
              <input
                value={idTag}
                onChange={(e) => setIdTag(e.target.value)}
                placeholder="idTag"
                className="h-10 rounded-md border border-gray-300 dark:border-slate-600 px-2 text-sm"
              />
              <button
                onClick={handleRemoteStart}
                disabled={remoteStartLoading || !idTag.trim()}
                className="h-10 w-full rounded-md bg-brand-600 px-3 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
              >
                {remoteStartLoading ? 'Starting…' : 'Remote Start'}
              </button>
            </div>

            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <button
                onClick={() => handleReset('Soft')}
                disabled={resetLoading}
                className="inline-flex h-10 w-full items-center justify-center whitespace-nowrap rounded-md border border-gray-300 dark:border-slate-700 px-3 text-sm font-medium text-gray-600 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800 dark:bg-slate-800/60 disabled:opacity-50"
              >
                Soft Reset
              </button>
              <button
                onClick={() => handleReset('Hard')}
                disabled={resetLoading}
                className="inline-flex h-10 w-full items-center justify-center whitespace-nowrap rounded-md border border-red-200 px-3 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
              >
                Hard Reset
              </button>
              <button
                onClick={handleTriggerHeartbeat}
                disabled={heartbeatLoading}
                className="inline-flex h-10 w-full items-center justify-center whitespace-nowrap rounded-md border border-brand-200 px-3 text-sm font-medium text-brand-700 hover:bg-brand-50 disabled:opacity-50"
              >
                {heartbeatLoading ? 'Triggering…' : 'Trigger Heartbeat'}
              </button>
              <button
                onClick={handleGetConfiguration}
                disabled={configLoading}
                className="inline-flex h-10 w-full items-center justify-center whitespace-nowrap rounded-md border border-gray-300 dark:border-slate-600 px-3 text-sm font-medium text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 dark:bg-slate-800/60 disabled:opacity-50"
              >
                {configLoading ? 'Fetching…' : 'Get Configuration'}
              </button>
            </div>

            {(remoteStartMsg || resetMsg || heartbeatMsg || configMsg) && (
              <div className="mt-3 rounded-md border border-gray-300 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/60 p-2.5 text-xs text-gray-600 dark:text-slate-300">
                <p className="mb-1 font-semibold uppercase tracking-wide text-[10px] text-gray-500 dark:text-slate-400">OCPP request responses</p>
                <div className="space-y-1">
                  {remoteStartMsg && <p><span className="font-medium">Remote Start:</span> {remoteStartMsg}</p>}
                  {resetMsg && <p><span className="font-medium">Reset:</span> {resetMsg}</p>}
                  {heartbeatMsg && <p><span className="font-medium">Trigger Heartbeat:</span> {heartbeatMsg}</p>}
                  {configMsg && <p><span className="font-medium">Get Configuration:</span> {configMsg}</p>}
                </div>
              </div>
            )}

            <div className="mt-4 border-t border-gray-100 dark:border-slate-800 pt-3">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-slate-400">Connector States</p>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {status.connectors.map((c) => (
                  <div key={c.connectorId} className="rounded-md border border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/60 p-2.5">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-medium text-gray-700 dark:text-slate-300">Connector #{c.connectorId}</p>
                      <StatusBadge status={c.status} type="connector" />
                    </div>
                    {c.activeSession && (
                      <div className="mt-2 rounded-md bg-green-50 px-2 py-1.5 text-[11px] text-green-700">
                        <p className="font-medium">Active Session</p>
                        <p>Tag: {c.activeSession.idTag}</p>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>



      {showQrModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setShowQrModal(false)}>
          <div className="w-full max-w-2xl rounded-xl border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-800 dark:text-slate-200">Smart QR Deep Link</h2>
              <button onClick={() => setShowQrModal(false)} className="rounded-md border border-gray-300 dark:border-slate-700 px-2 py-1 text-xs text-gray-600 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800 dark:bg-slate-800/60">Close</button>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <button
                onClick={handleGenerateQr}
                disabled={qrBusy}
                className="inline-flex h-10 w-full items-center justify-center whitespace-nowrap rounded-md bg-brand-600 px-3 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
              >
                {qrBusy ? 'Generating…' : 'Generate'}
              </button>
              <button
                onClick={handleCopyQrLink}
                disabled={!qrLink}
                className="inline-flex h-10 w-full items-center justify-center whitespace-nowrap rounded-md border border-gray-300 dark:border-slate-600 px-3 text-sm font-medium text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 dark:bg-slate-800/60 disabled:opacity-50"
              >
                Copy Link
              </button>
              <button
                onClick={handleDownloadQr}
                disabled={!qrDataUrl}
                className="inline-flex h-10 w-full items-center justify-center whitespace-nowrap rounded-md border border-gray-300 dark:border-slate-600 px-3 text-sm font-medium text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 dark:bg-slate-800/60 disabled:opacity-50"
              >
                Download QR
              </button>
            </div>
            {qrDataUrl && (
              <div className="mt-3 flex justify-center rounded-md border border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/60 p-3">
                <img src={qrDataUrl} alt="Smart charger QR code" className="h-52 w-52 rounded" />
              </div>
            )}
            {qrLink && <p className="mt-2 break-all text-[11px] text-gray-500 dark:text-slate-400">{qrLink}</p>}
            {qrMsg && <p className="mt-2 text-xs text-gray-500 dark:text-slate-400">{qrMsg}</p>}
          </div>
        </div>
      )}

      {uptime && (
        <div className="rounded-xl border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 shadow-sm">
          <h2 className="mb-4 text-sm font-semibold text-gray-700 dark:text-slate-300">Uptime Monitoring (OCA v1.1)</h2>
          <div className="grid gap-3 sm:grid-cols-3 mb-4">
            <div><p className="text-xs text-gray-500 dark:text-slate-400">24h</p><p className={`text-lg font-semibold ${uptime.uptimePercent24h >= 99 ? 'text-green-700' : uptime.uptimePercent24h >= 95 ? 'text-amber-700' : 'text-red-700'}`}>{uptime.uptimePercent24h.toFixed(2)}%</p></div>
            <div><p className="text-xs text-gray-500 dark:text-slate-400">7d</p><p className={`text-lg font-semibold ${uptime.uptimePercent7d >= 99 ? 'text-green-700' : uptime.uptimePercent7d >= 95 ? 'text-amber-700' : 'text-red-700'}`}>{uptime.uptimePercent7d.toFixed(2)}%</p></div>
            <div><p className="text-xs text-gray-500 dark:text-slate-400">30d</p><p className={`text-lg font-semibold ${uptime.uptimePercent30d >= 99 ? 'text-green-700' : uptime.uptimePercent30d >= 95 ? 'text-amber-700' : 'text-red-700'}`}>{uptime.uptimePercent30d.toFixed(2)}%</p></div>
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

      {/* Session log */}
      <div className="rounded-xl border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-sm">
        <div className="border-b border-gray-300 dark:border-slate-700 px-5 py-4">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-300">Recent Sessions</h2>
        </div>

        {sessions.length === 0 ? (
          <div className="p-10 text-center text-sm text-gray-400 dark:text-slate-500">No sessions yet</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/60 text-left text-xs font-medium text-gray-500 dark:text-slate-400">
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
              <tbody className="divide-y divide-gray-50 dark:divide-slate-800">
                {sessions.map((s) => (
                  <tr key={s.id} className="hover:bg-gray-50 dark:hover:bg-slate-800 dark:bg-slate-800/60">
                    <td className="px-5 py-3 font-mono text-xs text-gray-700 dark:text-slate-300">
                      {s.transactionId ?? '—'}
                    </td>
                    <td className="px-5 py-3 font-mono text-xs text-gray-500 dark:text-slate-400">
                      #{s.connector.connectorId}
                    </td>
                    <td className="px-5 py-3 text-gray-700 dark:text-slate-300">
                      {s.user?.name ?? s.user?.email ?? s.idTag}
                    </td>
                    <td className="px-5 py-3 text-gray-500 dark:text-slate-400 text-xs">
                      {formatDate(s.startedAt)}
                    </td>
                    <td className="px-5 py-3 text-gray-500 dark:text-slate-400">
                      {formatDuration(s.startedAt, s.stoppedAt)}
                    </td>
                    <td className="px-5 py-3 text-gray-700 dark:text-slate-300">
                      {s.kwhDelivered != null ? `${s.kwhDelivered.toFixed(2)} kWh` : '—'}
                    </td>
                    <td className="px-5 py-3">
                      <StatusBadge
                        status={s.status}
                        type="charger"
                      />
                    </td>
                    <td className="px-5 py-3 text-gray-500 dark:text-slate-400 text-xs">
                      {(() => {
                        const amountCents = s.effectiveAmountCents ?? s.estimatedAmountCents ?? s.payment?.amountCents ?? null;
                        const amountText = amountCents != null ? `$${(amountCents / 100).toFixed(2)}` : '—';
                        const label = s.amountState === 'FINAL' ? 'final' : s.amountState === 'PENDING' ? 'est.' : null;
                        const statusText = s.payment?.status ?? s.amountLabel ?? 'N/A';
                        return `${statusText}${amountCents != null ? ` · ${amountText}` : ''}${label ? ` (${label})` : ''}`;
                      })()}
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
