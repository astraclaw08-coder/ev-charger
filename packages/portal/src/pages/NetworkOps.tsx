import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { createApiClient, type ChargerListItem, type SiteListItem, type SiteDetail } from '../api/client';
import { useToken } from '../auth/TokenContext';

type Incident = { id: string; chargerId: string; title: string; createdAt: string; severity: 'low'|'medium'|'high' };
type FirmwareRollout = { id: string; chargerId: string; version: string; status: 'queued'|'rolling'|'done'; createdAt: string };

type RetryEvent = { id: string; chargerId: string; connectorId?: number; command: 'RemoteStartTransaction'|'Reset'|'ChangeAvailability'; status: 'queued'|'sent'|'ack'; createdAt: string };

function incidentsKey(siteId: string){ return `ev-portal:network:incidents:${siteId}`; }
function fwKey(siteId: string){ return `ev-portal:network:fw:${siteId}`; }
function retryKey(siteId: string){ return `ev-portal:network:retry:${siteId}`; }

function load<T>(k: string): T[] { try { const raw=localStorage.getItem(k); if(!raw) return []; const p=JSON.parse(raw) as T[]; return Array.isArray(p)?p:[];} catch { return []; } }
function save<T>(k: string, v: T[]) { localStorage.setItem(k, JSON.stringify(v.slice(0,200))); }

export default function NetworkOps() {
  const getToken = useToken();
  const [sites, setSites] = useState<SiteListItem[]>([]);
  const [allChargers, setAllChargers] = useState<ChargerListItem[]>([]);
  const [site, setSite] = useState<SiteDetail | null>(null);
  const [selectedSiteId, setSelectedSiteId] = useState('');
  const [selectedChargerId, setSelectedChargerId] = useState('');
  const [selectedConnectorId, setSelectedConnectorId] = useState<number>(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [firmware, setFirmware] = useState<FirmwareRollout[]>([]);
  const [retryEvents, setRetryEvents] = useState<RetryEvent[]>([]);

  useEffect(() => {
    async function bootstrap() {
      try {
        const token = await getToken();
        const api = createApiClient(token);
        const [siteList, chargers] = await Promise.all([api.getSites(), api.getChargers()]);
        setSites(siteList);
        setAllChargers(chargers);
        if (!siteList.length) return;

        const firstWithChargers = siteList.find((s) => s.chargerCount > 0) ?? siteList[0];
        setSelectedSiteId(firstWithChargers.id);
        const detail = await api.getSite(firstWithChargers.id);
        setSite(detail);

        const effectiveChargers = detail.chargers.length
          ? detail.chargers
          : chargers.filter((c) => c.site.id === detail.id);
        const chargerId = effectiveChargers[0]?.id ?? '';
        setSelectedChargerId(chargerId);
        setSelectedConnectorId(effectiveChargers[0]?.connectors?.[0]?.connectorId ?? 1);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to load network ops workspace');
      } finally {
        setLoading(false);
      }
    }
    bootstrap();
  }, [getToken]);

  useEffect(() => {
    if (!site) return;
    setIncidents(load<Incident>(incidentsKey(site.id)));
    setFirmware(load<FirmwareRollout>(fwKey(site.id)));
    setRetryEvents(load<RetryEvent>(retryKey(site.id)));
  }, [site]);

  const effectiveSiteChargers = useMemo(() => {
    const activeSiteId = selectedSiteId || site?.id;
    if (!activeSiteId) return [] as SiteDetail['chargers'];

    if (site && site.id === activeSiteId && site.chargers.length) return site.chargers;
    return allChargers
      .filter((c) => c.site.id === activeSiteId)
      .map((c) => ({
        id: c.id,
        ocppId: c.ocppId,
        serialNumber: c.serialNumber,
        model: c.model,
        vendor: c.vendor,
        status: c.status,
        lastHeartbeat: c.lastHeartbeat,
        siteId: c.site.id,
        connectors: c.connectors,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      }));
  }, [site, allChargers, selectedSiteId]);

  const chargerStatusSummary = useMemo(() => {
    if (!effectiveSiteChargers.length) return { online: 0, degraded: 0, offline: 0, faulted: 0 };
    return {
      online: effectiveSiteChargers.filter((c) => c.status === 'ONLINE').length,
      degraded: effectiveSiteChargers.filter((c) => c.status === 'DEGRADED').length,
      offline: effectiveSiteChargers.filter((c) => c.status === 'OFFLINE').length,
      faulted: effectiveSiteChargers.filter((c) => c.status === 'FAULTED').length,
    };
  }, [effectiveSiteChargers]);

  if (loading) return <div className="text-sm text-gray-500">Loading network ops workspace…</div>;
  if (error) return <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700">{error}</div>;

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <Link to="/" className="hover:text-gray-700">Dashboard</Link>
          <span>/</span>
          <span className="text-gray-900">Network Ops</span>
        </div>
        <h1 className="mt-1 text-2xl font-bold text-gray-900">Network Reliability Console</h1>
        <p className="text-sm text-gray-500">Health/alerts, offline triage, remote retry panel, firmware rollout, incident timeline</p>
      </div>

      <div className="grid gap-4 rounded-xl border border-gray-200 bg-white p-4 md:grid-cols-3">
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-500">Site</label>
          <select className="w-full rounded-md border border-gray-300 px-2 py-2 text-sm" value={selectedSiteId || site?.id || ''} onChange={async (e)=>{
            const nextSiteId = e.target.value;
            setSelectedSiteId(nextSiteId);

            try {
              const token=await getToken();
              const api= createApiClient(token);
              const detail=await api.getSite(nextSiteId);
              setSite(detail);
              const fallback = detail.chargers.length ? detail.chargers : allChargers.filter((c)=>c.site.id===detail.id);
              setSelectedChargerId(fallback[0]?.id ?? '');
              setSelectedConnectorId(fallback[0]?.connectors?.[0]?.connectorId ?? 1);
            } catch (err) {
              const fallback = allChargers.filter((c)=>c.site.id===nextSiteId);
              setSelectedChargerId(fallback[0]?.id ?? '');
              setSelectedConnectorId(fallback[0]?.connectors?.[0]?.connectorId ?? 1);
            }
          }}>
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-500">Charger</label>
          <select className="w-full rounded-md border border-gray-300 px-2 py-2 text-sm" value={selectedChargerId} onChange={(e)=>{ const cid=e.target.value; setSelectedChargerId(cid); const ch=effectiveSiteChargers.find(c=>c.id===cid); setSelectedConnectorId(ch?.connectors?.[0]?.connectorId ?? 1); }}>
            {effectiveSiteChargers.map((c)=><option key={c.id} value={c.id}>{c.ocppId} · {c.status}</option>)}
          </select>
        </div>
        <div className="grid grid-cols-4 gap-2 text-center">
          <MiniCard label="Online" value={chargerStatusSummary.online} tone="green" />
          <MiniCard label="Degraded" value={chargerStatusSummary.degraded} tone="amber" />
          <MiniCard label="Offline" value={chargerStatusSummary.offline} tone="yellow" />
          <MiniCard label="Faulted" value={chargerStatusSummary.faulted} tone="red" />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-xl border border-gray-200 bg-white p-4 lg:col-span-2">
          <h2 className="mb-3 text-sm font-semibold text-gray-700">Charger health + offline triage</h2>
          <div className="space-y-2">
            {effectiveSiteChargers.map((c) => (
              <div key={c.id} className="rounded-md border border-gray-200 p-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-gray-900">{c.ocppId}</p>
                  <span className={`rounded-full px-2 py-0.5 text-xs ${c.status==='ONLINE'?'bg-green-100 text-green-700':c.status==='DEGRADED'?'bg-amber-100 text-amber-700':c.status==='OFFLINE'?'bg-yellow-100 text-yellow-700':'bg-red-100 text-red-700'}`}>{c.status}</span>
                </div>
                <p className="mt-1 text-xs text-gray-500">Last heartbeat: {c.lastHeartbeat ? new Date(c.lastHeartbeat).toLocaleString() : 'never'}</p>
                {c.status === 'DEGRADED' && (
                  <p className="mt-1 text-xs text-amber-700">Pending offline confirmation (heartbeat stale/disconnect window).</p>
                )}
                {c.status === 'OFFLINE' && (
                  <p className="mt-1 text-xs text-yellow-700">Confirmed unreachable after heartbeat timeout window.</p>
                )}
                <div className="mt-2 flex flex-wrap gap-2">
                  <button className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-50" onClick={()=>{
                    if(!site) return;
                    const incident: Incident={id:crypto.randomUUID(), chargerId:c.id, title:`Offline triage opened for ${c.ocppId}`, severity:c.status==='FAULTED'?'high':'medium', createdAt:new Date().toISOString()};
                    const next=[incident,...incidents]; setIncidents(next); save(incidentsKey(site.id),next);
                  }}>Open triage ticket</button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <h2 className="mb-2 text-sm font-semibold text-gray-700">Remote retry panel</h2>
            <div className="space-y-2">
              <div>
                <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-gray-500">Target connector (for ChangeAvailability)</label>
                <select
                  className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-xs"
                  value={selectedConnectorId}
                  onChange={(e)=>setSelectedConnectorId(Number(e.target.value))}
                  disabled={!effectiveSiteChargers.find(c=>c.id===selectedChargerId)}
                >
                  {(effectiveSiteChargers.find(c=>c.id===selectedChargerId)?.connectors ?? []).map((cn)=>(
                    <option key={cn.id} value={cn.connectorId}>Connector #{cn.connectorId} · {cn.status}</option>
                  ))}
                </select>
              </div>
              {(['RemoteStartTransaction','Reset','ChangeAvailability'] as const).map((cmd)=>(
                <button key={cmd} className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-gray-700 hover:bg-gray-50" onClick={()=>{
                  if(!site || !selectedChargerId) return;

                  if (cmd === 'Reset') {
                    const ok = window.confirm('Confirm charger reset? This may interrupt active charging sessions.');
                    if (!ok) return;
                  }

                  const ev: RetryEvent = { id: crypto.randomUUID(), chargerId:selectedChargerId, connectorId: cmd==='ChangeAvailability' ? selectedConnectorId : undefined, command:cmd, status:'queued', createdAt:new Date().toISOString() };
                  const next=[ev,...retryEvents]; setRetryEvents(next); save(retryKey(site.id), next);
                  setTimeout(()=>{ setRetryEvents((curr)=>{ const up=curr.map((x)=>x.id===ev.id?{...x,status:'ack' as const}:x); save(retryKey(site.id),up); return up; }); }, 600);
                }}>{cmd}</button>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <h2 className="mb-2 text-sm font-semibold text-gray-700">Firmware rollout status</h2>
            <button className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700" onClick={()=>{
              if(!site || !selectedChargerId) return;
              const job: FirmwareRollout={id:crypto.randomUUID(), chargerId:selectedChargerId, version:'fw-2026.03.1', status:'rolling', createdAt:new Date().toISOString()};
              const next=[job,...firmware]; setFirmware(next); save(fwKey(site.id),next);
              setTimeout(()=>{ setFirmware((curr)=>{ const up=curr.map((x)=>x.id===job.id?{...x,status:'done' as const}:x); save(fwKey(site.id),up); return up; }); }, 900);
            }}>Start rollout</button>
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-gray-700">Retry history</h2>
          <div className="space-y-2">
            {retryEvents.length===0 && <p className="text-xs text-gray-500">No retry commands sent.</p>}
            {retryEvents.slice(0,10).map((r)=><div key={r.id} className="rounded-md border border-gray-200 p-2 text-xs">
              <p className="text-gray-800">{r.command}{r.command==='ChangeAvailability' && r.connectorId ? ` · connector #${r.connectorId}` : ''}</p><p className="text-gray-500">{new Date(r.createdAt).toLocaleString()} · {r.status}</p>
            </div>)}
          </div>
        </div>

        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-gray-700">Incident timeline drilldown</h2>
          <div className="space-y-2">
            {incidents.length===0 && <p className="text-xs text-gray-500">No incidents yet.</p>}
            {incidents.slice(0,12).map((i)=><div key={i.id} className="rounded-md border border-gray-200 p-2 text-xs">
              <p className="font-medium text-gray-800">{i.title}</p>
              <p className="text-gray-500">{new Date(i.createdAt).toLocaleString()} · severity {i.severity}</p>
            </div>)}
          </div>
        </div>
      </div>
    </div>
  );
}

function MiniCard({label, value, tone}:{label:string; value:number; tone:'green'|'amber'|'yellow'|'red'}) {
  const cls = tone==='green'
    ? 'bg-green-50 text-green-700 border-green-200'
    : tone==='amber'
      ? 'bg-amber-50 text-amber-700 border-amber-200'
      : tone==='yellow'
        ? 'bg-yellow-50 text-yellow-700 border-yellow-200'
        : 'bg-red-50 text-red-700 border-red-200';
  return <div className={`rounded-md border p-2 ${cls}`}><p className="text-xs">{label}</p><p className="text-lg font-semibold">{value}</p></div>;
}
