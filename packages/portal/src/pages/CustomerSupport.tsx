import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { createApiClient, type SessionRecord, type SiteListItem, type SiteDetail } from '../api/client';
import { useToken } from '../auth/TokenContext';

type CaseNote = {
  id: string;
  sessionId: string;
  text: string;
  createdAt: string;
};

type SupportAudit = {
  id: string;
  sessionId: string;
  action: 'refund-approved' | 'refund-denied' | 'investigate-payment';
  reason: string;
  createdAt: string;
};

function notesKey(chargerId: string) {
  return `ev-portal:support:notes:${chargerId}`;
}
function auditKey(chargerId: string) {
  return `ev-portal:support:audit:${chargerId}`;
}

function loadNotes(chargerId: string): CaseNote[] {
  try {
    const raw = localStorage.getItem(notesKey(chargerId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as CaseNote[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveNotes(chargerId: string, notes: CaseNote[]) {
  localStorage.setItem(notesKey(chargerId), JSON.stringify(notes.slice(0, 200)));
}

function loadAudit(chargerId: string): SupportAudit[] {
  try {
    const raw = localStorage.getItem(auditKey(chargerId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SupportAudit[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveAudit(chargerId: string, items: SupportAudit[]) {
  localStorage.setItem(auditKey(chargerId), JSON.stringify(items.slice(0, 300)));
}

export default function CustomerSupport() {
  const getToken = useToken();
  const [sites, setSites] = useState<SiteListItem[]>([]);
  const [site, setSite] = useState<SiteDetail | null>(null);
  const [selectedChargerId, setSelectedChargerId] = useState('');
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [notes, setNotes] = useState<CaseNote[]>([]);
  const [audit, setAudit] = useState<SupportAudit[]>([]);
  const [query, setQuery] = useState('');
  const [noteText, setNoteText] = useState('');
  const [triageReason, setTriageReason] = useState('Charge interruption with partial session completion');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    async function bootstrap() {
      try {
        const token = await getToken();
        const api = createApiClient(token);
        const siteList = await api.getSites();
        setSites(siteList);
        if (!siteList.length) return;

        const siteDetail = await api.getSite(siteList[0].id);
        setSite(siteDetail);
        if (!siteDetail.chargers.length) return;

        const firstCharger = siteDetail.chargers[0].id;
        setSelectedChargerId(firstCharger);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to load support workspace');
      } finally {
        setLoading(false);
      }
    }
    bootstrap();
  }, [getToken]);

  useEffect(() => {
    async function loadSessions() {
      if (!selectedChargerId) return;
      try {
        const token = await getToken();
        const api = createApiClient(token);
        const list = await api.getChargerSessions(selectedChargerId);
        setSessions(list);
        setNotes(loadNotes(selectedChargerId));
        setAudit(loadAudit(selectedChargerId));
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to load session timeline');
      }
    }
    loadSessions();
  }, [selectedChargerId, getToken]);

  const filteredSessions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => {
      const email = s.user?.email?.toLowerCase() ?? '';
      const name = s.user?.name?.toLowerCase() ?? '';
      return (
        s.id.toLowerCase().includes(q) ||
        s.idTag.toLowerCase().includes(q) ||
        email.includes(q) ||
        name.includes(q)
      );
    });
  }, [sessions, query]);

  const noteCountBySession = useMemo(() => {
    const map = new Map<string, number>();
    for (const n of notes) map.set(n.sessionId, (map.get(n.sessionId) ?? 0) + 1);
    return map;
  }, [notes]);

  if (loading) return <div className="text-sm text-gray-500">Loading customer support workspace…</div>;
  if (error) return <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700">{error}</div>;

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <Link to="/" className="hover:text-gray-700">Dashboard</Link>
          <span>/</span>
          <span className="text-gray-900">Customer Support</span>
        </div>
        <h1 className="mt-1 text-2xl font-bold text-gray-900">Customer Support Console</h1>
        <p className="text-sm text-gray-500">Customer lookup + timeline + payment/refund triage + support audit history</p>
      </div>

      <div className="grid gap-4 rounded-xl border border-gray-200 bg-white p-4 md:grid-cols-3">
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-500">Site</label>
          <select
            className="w-full rounded-md border border-gray-300 px-2 py-2 text-sm"
            value={site?.id ?? ''}
            onChange={async (e) => {
              const id = e.target.value;
              const token = await getToken();
              const detail = await createApiClient(token).getSite(id);
              setSite(detail);
              const next = detail.chargers[0]?.id ?? '';
              setSelectedChargerId(next);
            }}
          >
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-500">Charger</label>
          <select
            className="w-full rounded-md border border-gray-300 px-2 py-2 text-sm"
            value={selectedChargerId}
            onChange={(e) => setSelectedChargerId(e.target.value)}
          >
            {site?.chargers.map((c) => (
              <option key={c.id} value={c.id}>{c.ocppId} · {c.model}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-500">Customer lookup</label>
          <input
            className="w-full rounded-md border border-gray-300 px-2 py-2 text-sm"
            placeholder="email, name, idTag, session id"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2 rounded-xl border border-gray-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-gray-700">Session timeline + payment triage</h2>
          <div className="space-y-3">
            {filteredSessions.length === 0 && <p className="text-sm text-gray-500">No sessions found for this query.</p>}
            {filteredSessions.map((s) => (
              <div key={s.id} className="rounded-lg border border-gray-200 p-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-gray-900">{s.user?.email ?? s.idTag}</p>
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700">{s.status}</span>
                </div>
                <p className="mt-1 text-xs text-gray-500">Session {s.id} · Connector {s.connector.connectorId}</p>
                <p className="mt-1 text-xs text-gray-500">
                  {new Date(s.startedAt).toLocaleString()} → {s.stoppedAt ? new Date(s.stoppedAt).toLocaleString() : 'Active'}
                </p>
                <p className="mt-1 text-xs text-gray-600">
                  Energy: {s.kwhDelivered ?? 0} kWh · Payment: {s.payment?.status ?? s.amountLabel ?? 'N/A'}
                  {(s.effectiveAmountCents ?? s.estimatedAmountCents ?? s.payment?.amountCents) != null ? ` · $${(((s.effectiveAmountCents ?? s.estimatedAmountCents ?? s.payment?.amountCents) as number) / 100).toFixed(2)}` : ''}
                  {s.amountState === 'PENDING' ? ' · Estimated while settlement is pending' : ''}
                  {s.payment && ['CAPTURED', 'AUTHORIZED'].includes(String(s.payment.status)) ? ' · Refund eligible' : ''}
                </p>
                <p className="mt-1 text-xs text-brand-700">Case notes: {noteCountBySession.get(s.id) ?? 0}</p>

                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="rounded-md border border-green-300 bg-green-50 px-2 py-1 text-xs text-green-700 hover:bg-green-100"
                    onClick={() => {
                      if (!selectedChargerId) return;
                      const canRefund = !!s.payment && ['CAPTURED', 'AUTHORIZED'].includes(String(s.payment.status));
                      if (!canRefund) {
                        window.alert('Refund unavailable: payment must be CAPTURED or AUTHORIZED.');
                        return;
                      }
                      const ok = window.confirm(`Issue refund for session ${s.id}?`);
                      if (!ok) return;

                      const record: SupportAudit = {
                        id: crypto.randomUUID(),
                        sessionId: s.id,
                        action: 'refund-approved',
                        reason: triageReason,
                        createdAt: new Date().toISOString(),
                      };
                      const next = [record, ...audit];
                      setAudit(next);
                      saveAudit(selectedChargerId, next);
                    }}
                  >Issue refund</button>
                  <button
                    type="button"
                    className="rounded-md border border-red-300 bg-red-50 px-2 py-1 text-xs text-red-700 hover:bg-red-100"
                    onClick={() => {
                      if (!selectedChargerId) return;
                      const record: SupportAudit = {
                        id: crypto.randomUUID(),
                        sessionId: s.id,
                        action: 'refund-denied',
                        reason: triageReason,
                        createdAt: new Date().toISOString(),
                      };
                      const next = [record, ...audit];
                      setAudit(next);
                      saveAudit(selectedChargerId, next);
                    }}
                  >Deny refund</button>
                  <button
                    type="button"
                    className="rounded-md border border-yellow-300 bg-yellow-50 px-2 py-1 text-xs text-yellow-800 hover:bg-yellow-100"
                    onClick={() => {
                      if (!selectedChargerId) return;
                      const record: SupportAudit = {
                        id: crypto.randomUUID(),
                        sessionId: s.id,
                        action: 'investigate-payment',
                        reason: triageReason,
                        createdAt: new Date().toISOString(),
                      };
                      const next = [record, ...audit];
                      setAudit(next);
                      saveAudit(selectedChargerId, next);
                    }}
                  >Flag for payment investigation</button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <h2 className="mb-3 text-sm font-semibold text-gray-700">Case notes</h2>
            <textarea
              className="h-24 w-full rounded-md border border-gray-300 p-2 text-sm"
              placeholder="Write a support note..."
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
            />
            <button
              type="button"
              className="mt-2 rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700"
              onClick={() => {
                const target = filteredSessions[0]?.id;
                if (!selectedChargerId || !target || !noteText.trim()) return;
                const next: CaseNote[] = [
                  {
                    id: crypto.randomUUID(),
                    sessionId: target,
                    text: noteText.trim(),
                    createdAt: new Date().toISOString(),
                  },
                  ...notes,
                ];
                setNotes(next);
                saveNotes(selectedChargerId, next);
                setNoteText('');
              }}
            >
              Add note to top filtered session
            </button>
            <div className="mt-2">
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-500">Triage reason</label>
              <input
                className="w-full rounded-md border border-gray-300 px-2 py-2 text-sm"
                value={triageReason}
                onChange={(e) => setTriageReason(e.target.value)}
              />
            </div>
          </div>

          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <h2 className="mb-3 text-sm font-semibold text-gray-700">Support action audit history</h2>
            <div className="space-y-2">
              {audit.length === 0 && <p className="text-xs text-gray-500">No support actions recorded yet.</p>}
              {audit.slice(0, 12).map((a) => (
                <div key={a.id} className="rounded-md border border-gray-200 p-2">
                  <p className="text-xs text-gray-500">{new Date(a.createdAt).toLocaleString()} · session {a.sessionId}</p>
                  <p className="text-xs font-medium text-gray-800">{a.action}</p>
                  <p className="text-xs text-gray-600">{a.reason}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
