import { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { createApiClient, type SiteDetail as SiteDetailType, type ChargerUptime, type SiteUptime } from '../api/client';
import { useToken } from '../auth/TokenContext';
import ChargerMap from '../components/ChargerMap';
import StatusBadge from '../components/StatusBadge';
import AddChargerDialog from '../components/AddChargerDialog';
import { formatDate } from '../lib/utils';

type RoleName = 'owner' | 'operator' | 'customer-service' | 'nre' | 'analyst';
type RoleAssignment = { id: string; email: string; roles: RoleName[]; createdAt: string };
type TariffConfig = { pricePerKwhUsd: number; idleFeePerMinUsd: number; gracePeriodMin: number };
type SiteAuditEvent = { id: string; action: string; actor: string; detail: string; createdAt: string };

function tariffKey(siteId: string) { return `ev-portal:site:tariff:${siteId}`; }
function rolesKey(siteId: string) { return `ev-portal:site:roles:${siteId}`; }
function auditKey(siteId: string) { return `ev-portal:site:audit:${siteId}`; }

function loadTariff(siteId: string): TariffConfig {
  try { const raw = localStorage.getItem(tariffKey(siteId)); if (raw) return JSON.parse(raw) as TariffConfig; } catch {}
  return { pricePerKwhUsd: 0.35, idleFeePerMinUsd: 0.08, gracePeriodMin: 10 };
}
function loadRoles(siteId: string): RoleAssignment[] {
  try { const raw = localStorage.getItem(rolesKey(siteId)); if (!raw) return []; const x = JSON.parse(raw) as RoleAssignment[]; return Array.isArray(x) ? x : []; } catch { return []; }
}
function loadAudit(siteId: string): SiteAuditEvent[] {
  try { const raw = localStorage.getItem(auditKey(siteId)); if (!raw) return []; const x = JSON.parse(raw) as SiteAuditEvent[]; return Array.isArray(x) ? x : []; } catch { return []; }
}

export default function SiteDetail() {
  const { id } = useParams<{ id: string }>();
  const getToken = useToken();
  const [site, setSite] = useState<SiteDetailType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showAddCharger, setShowAddCharger] = useState(false);
  const [chargerUptime, setChargerUptime] = useState<Record<string, ChargerUptime>>({});
  const [siteUptime, setSiteUptime] = useState<SiteUptime | null>(null);

  const [tariff, setTariff] = useState<TariffConfig>({ pricePerKwhUsd: 0.35, idleFeePerMinUsd: 0.08, gracePeriodMin: 10 });
  const [assignments, setAssignments] = useState<RoleAssignment[]>([]);
  const [auditEvents, setAuditEvents] = useState<SiteAuditEvent[]>([]);
  const [emailInput, setEmailInput] = useState('');
  const [roleDraft, setRoleDraft] = useState<RoleName[]>(['operator']);

  const load = useCallback(async () => {
    try {
      const token = await getToken();
      const client = createApiClient(token);
      const data = await client.getSite(id!);
      setSite(data);
      setTariff(loadTariff(data.id));
      setAssignments(loadRoles(data.id));
      setAuditEvents(loadAudit(data.id));

      const [siteUp, perCharger] = await Promise.all([
        client.getSiteUptime(data.id).catch(() => null),
        Promise.all(data.chargers.map((c) => client.getChargerUptime(c.id).catch(() => null))),
      ]);
      if (siteUp) setSiteUptime(siteUp);
      const map: Record<string, ChargerUptime> = {};
      perCharger.forEach((u) => { if (u) map[u.chargerId] = u; });
      setChargerUptime(map);
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

  const pushAudit = (action: string, detail: string) => {
    const next: SiteAuditEvent[] = [{
      id: crypto.randomUUID(), action, actor: 'operator-admin', detail, createdAt: new Date().toISOString(),
    }, ...auditEvents];
    setAuditEvents(next);
    localStorage.setItem(auditKey(site.id), JSON.stringify(next.slice(0, 250)));
  };

  return (
    <div className="space-y-6">
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
          <Link to={`/sites/${site.id}/analytics`} className="rounded-md border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50">Analytics</Link>
          <button onClick={() => setShowAddCharger(true)} className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">+ Add Charger</button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-gray-700">Pricing / tariff controls</h2>
          <div className="space-y-2 text-sm">
            <label className="block">Price per kWh (USD)
              <input type="number" step="0.01" className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1.5" value={tariff.pricePerKwhUsd} onChange={(e)=>setTariff({...tariff, pricePerKwhUsd:Number(e.target.value)})} />
            </label>
            <label className="block">Idle fee per min (USD)
              <input type="number" step="0.01" className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1.5" value={tariff.idleFeePerMinUsd} onChange={(e)=>setTariff({...tariff, idleFeePerMinUsd:Number(e.target.value)})} />
            </label>
            <label className="block">Grace period (minutes)
              <input type="number" className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1.5" value={tariff.gracePeriodMin} onChange={(e)=>setTariff({...tariff, gracePeriodMin:Number(e.target.value)})} />
            </label>
            <button
              type="button"
              className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700"
              onClick={()=>{
                localStorage.setItem(tariffKey(site.id), JSON.stringify(tariff));
                pushAudit('tariff.updated', `price=$${tariff.pricePerKwhUsd}/kWh, idle=$${tariff.idleFeePerMinUsd}/min, grace=${tariff.gracePeriodMin}m`);
              }}
            >Save tariff</button>
          </div>
        </div>

        <div className="rounded-xl border border-gray-200 bg-white p-4 lg:col-span-2">
          <h2 className="mb-3 text-sm font-semibold text-gray-700">Stackable role assignments</h2>
          <div className="flex flex-wrap items-end gap-2">
            <input className="min-w-56 flex-1 rounded-md border border-gray-300 px-2 py-2 text-sm" placeholder="user email" value={emailInput} onChange={(e)=>setEmailInput(e.target.value)} />
            <select className="rounded-md border border-gray-300 px-2 py-2 text-sm" onChange={(e)=>setRoleDraft([e.target.value as RoleName])} value={roleDraft[0]}>
              <option value="owner">owner</option><option value="operator">operator</option><option value="customer-service">customer-service</option><option value="nre">nre</option><option value="analyst">analyst</option>
            </select>
            <button
              type="button"
              className="rounded-md border border-gray-300 bg-white px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50"
              onClick={()=>{
                const email=emailInput.trim().toLowerCase(); if(!email) return;
                const existing=assignments.find(a=>a.email===email);
                let next: RoleAssignment[];
                if(existing){
                  const merged=Array.from(new Set([...existing.roles, ...roleDraft]));
                  next=assignments.map(a=>a.email===email?{...a,roles:merged}:a);
                  pushAudit('rbac.role.granted', `${email} +${roleDraft.join(',')}`);
                } else {
                  next=[{id:crypto.randomUUID(), email, roles:roleDraft, createdAt:new Date().toISOString()}, ...assignments];
                  pushAudit('rbac.user.added', `${email} roles=${roleDraft.join(',')}`);
                }
                setAssignments(next);
                localStorage.setItem(rolesKey(site.id), JSON.stringify(next.slice(0,200)));
                setEmailInput('');
              }}
            >Assign role</button>
          </div>
          <div className="mt-3 space-y-2">
            {assignments.length===0 && <p className="text-xs text-gray-500">No role assignments yet.</p>}
            {assignments.map((a)=>(
              <div key={a.id} className="flex items-center justify-between rounded-md border border-gray-200 px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-gray-900">{a.email}</p>
                  <p className="text-xs text-gray-500">{a.roles.join(', ')}</p>
                </div>
                <button type="button" className="rounded-md border border-red-300 bg-red-50 px-2 py-1 text-xs text-red-700 hover:bg-red-100" onClick={()=>{
                  const next=assignments.filter(x=>x.id!==a.id); setAssignments(next); localStorage.setItem(rolesKey(site.id), JSON.stringify(next));
                  pushAudit('rbac.user.removed', a.email);
                }}>Remove</button>
              </div>
            ))}
          </div>
        </div>
      </div>


      {siteUptime && (
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold text-gray-700">Site uptime summary (OCA v1.1)</h2>
          <div className="grid gap-3 sm:grid-cols-4 text-sm">
            <div><p className="text-gray-500">24h</p><p className="font-semibold text-gray-900">{siteUptime.uptimePercent24h.toFixed(2)}%</p></div>
            <div><p className="text-gray-500">7d</p><p className="font-semibold text-gray-900">{siteUptime.uptimePercent7d.toFixed(2)}%</p></div>
            <div><p className="text-gray-500">30d</p><p className="font-semibold text-gray-900">{siteUptime.uptimePercent30d.toFixed(2)}%</p></div>
            <div><p className="text-gray-500">Degraded</p><p className="font-semibold text-amber-700">{siteUptime.degradedChargers}</p></div>
          </div>
        </div>
      )}

      <ChargerMap lat={site.lat} lng={site.lng} siteName={site.name} chargers={site.chargers} />

      <div>
        <h2 className="mb-3 text-lg font-semibold text-gray-900">Chargers ({site.chargers.length})</h2>
        {site.chargers.length === 0 ? (
          <div className="rounded-lg border-2 border-dashed border-gray-200 p-10 text-center text-gray-400">
            <p className="text-3xl">🔌</p>
            <p className="mt-2 font-medium">No chargers registered</p>
            <button onClick={() => setShowAddCharger(true)} className="mt-3 text-sm text-brand-600 hover:underline">Register your first charger →</button>
          </div>
        ) : site.chargers.length > 4 ? (
          <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
            <div className="hidden grid-cols-[1.6fr_1fr_1.8fr_0.8fr] gap-3 border-b border-gray-200 bg-gray-50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-gray-500 md:grid">
              <span>Charger</span>
              <span>Status</span>
              <span>Connectors</span>
              <span className="text-right">Action</span>
            </div>
            <div className="divide-y divide-gray-100">
              {site.chargers.map((charger) => (
                <ChargerListRow key={charger.id} charger={charger} uptime={chargerUptime[charger.id]} />
              ))}
            </div>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{site.chargers.map((charger) => (<ChargerCard key={charger.id} charger={charger} uptime={chargerUptime[charger.id]} />))}</div>
        )}
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-gray-700">Audit trail view</h2>
        <div className="space-y-2">
          {auditEvents.length === 0 && <p className="text-xs text-gray-500">No audit events yet.</p>}
          {auditEvents.slice(0, 20).map((e) => (
            <div key={e.id} className="rounded-md border border-gray-200 p-2">
              <p className="text-xs text-gray-500">{new Date(e.createdAt).toLocaleString()} · {e.actor}</p>
              <p className="text-xs font-medium text-gray-800">{e.action}</p>
              <p className="text-xs text-gray-600">{e.detail}</p>
            </div>
          ))}
        </div>
      </div>

      {showAddCharger && (
        <AddChargerDialog
          siteId={site.id}
          onAdd={async (body) => {
            const token = await getToken();
            const result = await createApiClient(token).createCharger(body);
            await load();
            return result;
          }}
          onClose={() => setShowAddCharger(false)}
        />
      )}
    </div>
  );
}

function ChargerListRow({ charger, uptime }: { charger: SiteDetailType['chargers'][number]; uptime?: ChargerUptime }) {
  return (
    <div className="grid gap-3 px-4 py-3 md:grid-cols-[1.6fr_1fr_1.8fr_0.8fr] md:items-center">
      <div>
        <p className="font-mono text-sm font-semibold text-gray-900">{charger.ocppId}</p>
        <p className="text-xs text-gray-500">{charger.vendor} {charger.model} · S/N {charger.serialNumber}</p>
        {charger.lastHeartbeat && (
          <p className="text-xs text-gray-400">Heartbeat: {formatDate(charger.lastHeartbeat)}</p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadge status={charger.status} type="charger" />
        {uptime && (
          <span className={uptime.uptimePercent7d >= 99 ? 'text-xs font-semibold text-green-700' : uptime.uptimePercent7d >= 95 ? 'text-xs font-semibold text-amber-700' : 'text-xs font-semibold text-red-700'}>
            {uptime.uptimePercent7d.toFixed(2)}% 7d
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {charger.connectors.map((c) => (
          <div key={c.id} className="flex items-center gap-1 rounded-md border border-gray-100 bg-gray-50 px-2 py-0.5">
            <span className="text-xs text-gray-500">#{c.connectorId}</span>
            <StatusBadge status={c.status} type="connector" />
          </div>
        ))}
      </div>

      <div className="md:text-right">
        <Link to={`/chargers/${charger.id}`} className="inline-block rounded-md border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50">View Detail →</Link>
      </div>
    </div>
  );
}

function ChargerCard({ charger, uptime }: { charger: SiteDetailType['chargers'][number]; uptime?: ChargerUptime }) {
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
        <p className="mt-1 text-xs text-gray-400">Last heartbeat: {formatDate(charger.lastHeartbeat)}</p>
      )}

      <div className="mt-3 flex flex-wrap gap-1.5">
        {charger.connectors.map((c) => (
          <div key={c.id} className="flex items-center gap-1 rounded-md border border-gray-100 bg-gray-50 px-2 py-0.5">
            <span className="text-xs text-gray-500">#{c.connectorId}</span>
            <StatusBadge status={c.status} type="connector" />
          </div>
        ))}
      </div>

      {uptime && (
        <div className="mt-3 rounded-md border border-gray-100 bg-gray-50 px-2 py-1.5 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-gray-500">Uptime 7d</span>
            <span className={uptime.uptimePercent7d >= 99 ? 'text-green-700 font-semibold' : uptime.uptimePercent7d >= 95 ? 'text-amber-700 font-semibold' : 'text-red-700 font-semibold'}>{uptime.uptimePercent7d.toFixed(2)}%</span>
          </div>
        </div>
      )}

      <Link to={`/chargers/${charger.id}`} className="mt-3 block rounded-md border border-gray-200 px-3 py-1.5 text-center text-xs font-medium text-gray-600 hover:bg-gray-50">View Detail →</Link>
    </div>
  );
}
