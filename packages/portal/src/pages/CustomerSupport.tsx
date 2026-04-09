import React, { useCallback, useEffect, useState } from 'react';
import { createApiClient, type SupportDriverSummary, type SupportDriverDetail, type SupportDriverSession, type SupportDriverSessionsResponse, type SupportDriverPaymentCard } from '../api/client';
import { useToken } from '../auth/TokenContext';

// ── Tab type ─────────────────────────────────────────────────────────────
type Tab = 'profile' | 'sessions' | 'ocpp' | 'payment' | 'activity';

// ── Helpers ──────────────────────────────────────────────────────────────
function fmtDate(d: string | null) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    ACTIVE: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
    COMPLETED: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
    FAULTED: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
    STOPPED: 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] ?? 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300'}`}>
      {status}
    </span>
  );
}

// ── Main Component ───────────────────────────────────────────────────────
export default function CustomerSupport() {
  const getToken = useToken();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SupportDriverSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [searched, setSearched] = useState(false);

  // Selected driver
  const [driver, setDriver] = useState<SupportDriverDetail | null>(null);
  const [loadingDriver, setLoadingDriver] = useState(false);
  const [tab, setTab] = useState<Tab>('profile');

  // Profile editing
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');

  // Sessions tab
  const [sessionsData, setSessionsData] = useState<SupportDriverSessionsResponse | null>(null);
  const [sessionsPage, setSessionsPage] = useState(1);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [sessionFilter, setSessionFilter] = useState<{ status: string; from: string; to: string }>({ status: '', from: '', to: '' });

  // Payment tab
  const [cards, setCards] = useState<SupportDriverPaymentCard[]>([]);
  const [loadingCards, setLoadingCards] = useState(false);
  const [cardsError, setCardsError] = useState('');

  // ── Search ────────────────────────────────────────────────────────────
  const handleSearch = useCallback(async () => {
    if (!query.trim()) return;
    setSearching(true);
    setSearchError('');
    setSearched(true);
    setDriver(null);
    try {
      const token = await getToken();
      const api = createApiClient(token);
      const res = await api.supportDriverLookup(query.trim());
      setResults(res);
    } catch (e: any) {
      setSearchError(e?.message ?? 'Search failed');
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, [query, getToken]);

  // ── Load driver detail ────────────────────────────────────────────────
  const selectDriver = useCallback(async (id: string) => {
    setLoadingDriver(true);
    setTab('profile');
    setEditing(false);
    setSaveMsg('');
    try {
      const token = await getToken();
      const api = createApiClient(token);
      const d = await api.supportDriverDetail(id);
      setDriver(d);
      setEditForm({
        name: d.name ?? '',
        phone: d.phone ?? '',
        homeAddress: d.homeAddress ?? '',
        homeCity: d.homeCity ?? '',
        homeState: d.homeState ?? '',
        homeZipCode: d.homeZipCode ?? '',
        idTag: d.idTag ?? '',
      });
    } catch {
      setDriver(null);
    } finally {
      setLoadingDriver(false);
    }
  }, [getToken]);

  // ── Load sessions ─────────────────────────────────────────────────────
  const loadSessions = useCallback(async (page = 1) => {
    if (!driver) return;
    setLoadingSessions(true);
    try {
      const token = await getToken();
      const api = createApiClient(token);
      const res = await api.supportDriverSessions(driver.id, {
        page,
        limit: 15,
        status: sessionFilter.status || undefined,
        from: sessionFilter.from || undefined,
        to: sessionFilter.to || undefined,
      });
      setSessionsData(res);
      setSessionsPage(page);
    } catch {
      setSessionsData(null);
    } finally {
      setLoadingSessions(false);
    }
  }, [driver, getToken, sessionFilter]);

  // ── Load payment methods ──────────────────────────────────────────────
  const loadCards = useCallback(async () => {
    if (!driver) return;
    setLoadingCards(true);
    setCardsError('');
    try {
      const token = await getToken();
      const api = createApiClient(token);
      const res = await api.supportDriverPaymentMethods(driver.id);
      setCards(res.cards);
    } catch (e: any) {
      setCardsError(e?.message ?? 'Failed to load payment methods');
      setCards([]);
    } finally {
      setLoadingCards(false);
    }
  }, [driver, getToken]);

  // Tab data loading
  useEffect(() => {
    if (tab === 'sessions' && driver) loadSessions(1);
    if (tab === 'payment' && driver) loadCards();
  }, [tab, driver?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Save profile ──────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (!driver) return;
    setSaving(true);
    setSaveMsg('');
    try {
      const token = await getToken();
      const api = createApiClient(token);
      const updated = await api.supportDriverUpdate(driver.id, editForm as any);
      setDriver(updated);
      setEditing(false);
      setSaveMsg('Profile updated.');
      setTimeout(() => setSaveMsg(''), 3000);
    } catch (e: any) {
      setSaveMsg(`Error: ${e?.message ?? 'Save failed'}`);
    } finally {
      setSaving(false);
    }
  }, [driver, editForm, getToken]);

  // ── Render ────────────────────────────────────────────────────────────
  const tabs: { key: Tab; label: string }[] = [
    { key: 'profile', label: 'Profile' },
    { key: 'sessions', label: 'Sessions' },
    { key: 'ocpp', label: 'OCPP IDs' },
    { key: 'payment', label: 'Payment' },
    { key: 'activity', label: 'Activity' },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-[var(--color-text-primary,#111)]">Customer Support</h1>
        <p className="text-sm text-[var(--color-text-secondary,#6b7280)] mt-1">
          Look up a driver by email or phone number to manage their account.
        </p>
      </div>

      {/* Search */}
      <div className="flex gap-3 items-center">
        <div className="relative flex-1 max-w-lg">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="Enter driver email or phone number..."
            className="w-full px-4 py-2.5 rounded-lg border border-[var(--color-border,#d1d5db)] bg-[var(--color-bg-primary,#fff)] text-[var(--color-text-primary,#111)] placeholder-[var(--color-text-tertiary,#9ca3af)] focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition"
          />
        </div>
        <button
          onClick={handleSearch}
          disabled={searching || !query.trim()}
          className="px-5 py-2.5 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          {searching ? 'Searching...' : 'Search'}
        </button>
      </div>

      {searchError && (
        <div className="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 text-sm">
          {searchError}
        </div>
      )}

      {/* Search Results */}
      {searched && !searching && results.length === 0 && !searchError && (
        <div className="p-8 text-center text-[var(--color-text-secondary,#6b7280)] bg-[var(--color-bg-secondary,#f9fafb)] rounded-lg">
          No drivers found for "{query}".
        </div>
      )}

      {results.length > 0 && !driver && (
        <div className="border border-[var(--color-border,#e5e7eb)] rounded-lg overflow-hidden">
          <div className="px-4 py-3 bg-[var(--color-bg-secondary,#f9fafb)] border-b border-[var(--color-border,#e5e7eb)]">
            <span className="text-sm font-medium text-[var(--color-text-secondary,#6b7280)]">{results.length} result{results.length !== 1 ? 's' : ''}</span>
          </div>
          {results.map((r) => (
            <button
              key={r.id}
              onClick={() => selectDriver(r.id)}
              className="w-full flex items-center justify-between px-4 py-3 hover:bg-[var(--color-bg-secondary,#f9fafb)] transition border-b border-[var(--color-border,#e5e7eb)] last:border-b-0 text-left"
            >
              <div>
                <div className="font-medium text-[var(--color-text-primary,#111)]">{r.name ?? 'Unnamed'}</div>
                <div className="text-sm text-[var(--color-text-secondary,#6b7280)]">{r.email} {r.phone ? `· ${r.phone}` : ''}</div>
              </div>
              <div className="text-right">
                <div className="text-xs text-[var(--color-text-tertiary,#9ca3af)]">idTag: {r.idTag}</div>
                <div className="text-xs text-[var(--color-text-tertiary,#9ca3af)]">{r.sessionCount} sessions · Joined {fmtDate(r.createdAt)}</div>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Driver Detail */}
      {loadingDriver && (
        <div className="flex items-center justify-center py-12 text-[var(--color-text-secondary,#6b7280)]">Loading driver...</div>
      )}

      {driver && !loadingDriver && (
        <div className="border border-[var(--color-border,#e5e7eb)] rounded-lg overflow-hidden">
          {/* Driver header */}
          <div className="px-5 py-4 bg-[var(--color-bg-secondary,#f9fafb)] border-b border-[var(--color-border,#e5e7eb)] flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-[var(--color-text-primary,#111)]">{driver.name ?? 'Unnamed Driver'}</h2>
              <p className="text-sm text-[var(--color-text-secondary,#6b7280)]">{driver.email} {driver.phone ? `· ${driver.phone}` : ''}</p>
            </div>
            <button
              onClick={() => { setDriver(null); setEditing(false); }}
              className="text-sm text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
            >
              ← Back to results
            </button>
          </div>

          {/* Tabs */}
          <div className="flex border-b border-[var(--color-border,#e5e7eb)]">
            {tabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`px-5 py-3 text-sm font-medium transition border-b-2 ${tab === t.key
                  ? 'border-blue-600 text-blue-600 dark:text-blue-400 dark:border-blue-400'
                  : 'border-transparent text-[var(--color-text-secondary,#6b7280)] hover:text-[var(--color-text-primary,#111)] hover:border-gray-300'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="p-5">
            {tab === 'profile' && <ProfileTab driver={driver} editing={editing} setEditing={setEditing} editForm={editForm} setEditForm={setEditForm} saving={saving} onSave={handleSave} saveMsg={saveMsg} />}
            {tab === 'sessions' && <SessionsTab data={sessionsData} loading={loadingSessions} page={sessionsPage} onPageChange={loadSessions} filter={sessionFilter} setFilter={setSessionFilter} onApplyFilter={() => loadSessions(1)} />}
            {tab === 'ocpp' && <OcppTab driver={driver} editForm={editForm} setEditForm={setEditForm} saving={saving} onSave={handleSave} saveMsg={saveMsg} />}
            {tab === 'payment' && <PaymentTab cards={cards} loading={loadingCards} error={cardsError} />}
            {tab === 'activity' && <ActivityTab driver={driver} />}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Profile Tab ──────────────────────────────────────────────────────────
function ProfileTab({ driver, editing, setEditing, editForm, setEditForm, saving, onSave, saveMsg }: {
  driver: SupportDriverDetail; editing: boolean; setEditing: (v: boolean) => void;
  editForm: Record<string, string>; setEditForm: (v: Record<string, string>) => void;
  saving: boolean; onSave: () => void; saveMsg: string;
}) {
  const fields: { key: string; label: string; readonly?: boolean }[] = [
    { key: 'email', label: 'Email', readonly: true },
    { key: 'name', label: 'Name' },
    { key: 'phone', label: 'Phone' },
    { key: 'homeAddress', label: 'Street Address' },
    { key: 'homeCity', label: 'City' },
    { key: 'homeState', label: 'State' },
    { key: 'homeZipCode', label: 'Zip Code' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-[var(--color-text-primary,#111)]">Driver Profile</h3>
        {!editing && (
          <button onClick={() => setEditing(true)} className="text-sm text-blue-600 hover:text-blue-800 dark:text-blue-400">
            Edit
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {fields.map((f) => (
          <div key={f.key}>
            <label className="block text-xs font-medium text-[var(--color-text-secondary,#6b7280)] mb-1">{f.label}</label>
            {editing && !f.readonly ? (
              <input
                value={editForm[f.key] ?? ''}
                onChange={(e) => setEditForm({ ...editForm, [f.key]: e.target.value })}
                className="w-full px-3 py-2 rounded-md border border-[var(--color-border,#d1d5db)] bg-[var(--color-bg-primary,#fff)] text-[var(--color-text-primary,#111)] text-sm focus:ring-2 focus:ring-blue-500/40"
              />
            ) : (
              <div className="text-sm text-[var(--color-text-primary,#111)]">
                {(driver as any)[f.key] || <span className="text-[var(--color-text-tertiary,#9ca3af)]">—</span>}
              </div>
            )}
          </div>
        ))}
      </div>

      {editing && (
        <div className="flex gap-3 pt-2">
          <button onClick={onSave} disabled={saving} className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50 transition">
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
          <button onClick={() => setEditing(false)} className="px-4 py-2 text-sm text-[var(--color-text-secondary,#6b7280)] hover:text-[var(--color-text-primary,#111)] transition">
            Cancel
          </button>
        </div>
      )}

      {saveMsg && (
        <p className={`text-sm ${saveMsg.startsWith('Error') ? 'text-red-600' : 'text-green-600'}`}>{saveMsg}</p>
      )}

      <div className="pt-4 border-t border-[var(--color-border,#e5e7eb)]">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
          <div>
            <div className="text-2xl font-bold text-[var(--color-text-primary,#111)]">{driver.sessionCount}</div>
            <div className="text-xs text-[var(--color-text-secondary,#6b7280)]">Total Sessions</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-[var(--color-text-primary,#111)]">{driver.paymentCount}</div>
            <div className="text-xs text-[var(--color-text-secondary,#6b7280)]">Payments</div>
          </div>
          <div>
            <div className="text-sm font-medium text-[var(--color-text-primary,#111)]">{fmtDate(driver.createdAt)}</div>
            <div className="text-xs text-[var(--color-text-secondary,#6b7280)]">Joined</div>
          </div>
          <div>
            <div className="text-sm font-medium text-[var(--color-text-primary,#111)]">{driver.paymentProfile ? 'Connected' : 'None'}</div>
            <div className="text-xs text-[var(--color-text-secondary,#6b7280)]">Stripe</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Sessions Tab ─────────────────────────────────────────────────────────
function SessionsTab({ data, loading, page, onPageChange, filter, setFilter, onApplyFilter }: {
  data: SupportDriverSessionsResponse | null; loading: boolean; page: number;
  onPageChange: (p: number) => void; filter: { status: string; from: string; to: string };
  setFilter: (f: { status: string; from: string; to: string }) => void; onApplyFilter: () => void;
}) {
  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-end">
        <div>
          <label className="block text-xs text-[var(--color-text-secondary,#6b7280)] mb-1">Status</label>
          <select
            value={filter.status}
            onChange={(e) => setFilter({ ...filter, status: e.target.value })}
            className="px-3 py-2 rounded-md border border-[var(--color-border,#d1d5db)] bg-[var(--color-bg-primary,#fff)] text-sm text-[var(--color-text-primary,#111)]"
          >
            <option value="">All</option>
            <option value="ACTIVE">Active</option>
            <option value="COMPLETED">Completed</option>
            <option value="STOPPED">Stopped</option>
            <option value="FAULTED">Faulted</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-[var(--color-text-secondary,#6b7280)] mb-1">From</label>
          <input type="date" value={filter.from} onChange={(e) => setFilter({ ...filter, from: e.target.value })} className="px-3 py-2 rounded-md border border-[var(--color-border,#d1d5db)] bg-[var(--color-bg-primary,#fff)] text-sm text-[var(--color-text-primary,#111)]" />
        </div>
        <div>
          <label className="block text-xs text-[var(--color-text-secondary,#6b7280)] mb-1">To</label>
          <input type="date" value={filter.to} onChange={(e) => setFilter({ ...filter, to: e.target.value })} className="px-3 py-2 rounded-md border border-[var(--color-border,#d1d5db)] bg-[var(--color-bg-primary,#fff)] text-sm text-[var(--color-text-primary,#111)]" />
        </div>
        <button onClick={onApplyFilter} className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition">
          Apply
        </button>
      </div>

      {loading && <div className="py-8 text-center text-[var(--color-text-secondary,#6b7280)]">Loading sessions...</div>}

      {!loading && data && data.sessions.length === 0 && (
        <div className="py-8 text-center text-[var(--color-text-secondary,#6b7280)]">No sessions found.</div>
      )}

      {!loading && data && data.sessions.length > 0 && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border,#e5e7eb)]">
                  <th className="text-left py-2 px-3 text-xs font-medium text-[var(--color-text-secondary,#6b7280)]">Date</th>
                  <th className="text-left py-2 px-3 text-xs font-medium text-[var(--color-text-secondary,#6b7280)]">Status</th>
                  <th className="text-left py-2 px-3 text-xs font-medium text-[var(--color-text-secondary,#6b7280)]">Site</th>
                  <th className="text-left py-2 px-3 text-xs font-medium text-[var(--color-text-secondary,#6b7280)]">Charger</th>
                  <th className="text-right py-2 px-3 text-xs font-medium text-[var(--color-text-secondary,#6b7280)]">Energy</th>
                  <th className="text-right py-2 px-3 text-xs font-medium text-[var(--color-text-secondary,#6b7280)]">Cost</th>
                </tr>
              </thead>
              <tbody>
                {data.sessions.map((s) => (
                  <tr key={s.id} className="border-b border-[var(--color-border,#e5e7eb)] hover:bg-[var(--color-bg-secondary,#f9fafb)]">
                    <td className="py-2.5 px-3 text-[var(--color-text-primary,#111)]">{fmtDate(s.startedAt)}</td>
                    <td className="py-2.5 px-3"><StatusBadge status={s.status} /></td>
                    <td className="py-2.5 px-3 text-[var(--color-text-primary,#111)]">{s.siteName ?? '—'}</td>
                    <td className="py-2.5 px-3 text-[var(--color-text-secondary,#6b7280)] text-xs">{s.chargerOcppId ?? '—'}</td>
                    <td className="py-2.5 px-3 text-right text-[var(--color-text-primary,#111)]">{s.energyKwh != null ? `${s.energyKwh.toFixed(2)} kWh` : '—'}</td>
                    <td className="py-2.5 px-3 text-right text-[var(--color-text-primary,#111)]">{s.costUsd != null ? `$${s.costUsd.toFixed(2)}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between pt-2">
            <span className="text-xs text-[var(--color-text-secondary,#6b7280)]">
              Page {data.page} of {data.pages} · {data.total} total
            </span>
            <div className="flex gap-2">
              <button disabled={page <= 1} onClick={() => onPageChange(page - 1)} className="px-3 py-1 text-sm rounded border border-[var(--color-border,#d1d5db)] disabled:opacity-40 hover:bg-[var(--color-bg-secondary,#f9fafb)] transition">
                Previous
              </button>
              <button disabled={page >= data.pages} onClick={() => onPageChange(page + 1)} className="px-3 py-1 text-sm rounded border border-[var(--color-border,#d1d5db)] disabled:opacity-40 hover:bg-[var(--color-bg-secondary,#f9fafb)] transition">
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── OCPP IDs Tab ─────────────────────────────────────────────────────────
function OcppTab({ driver, editForm, setEditForm, saving, onSave, saveMsg }: {
  driver: SupportDriverDetail; editForm: Record<string, string>; setEditForm: (v: Record<string, string>) => void;
  saving: boolean; onSave: () => void; saveMsg: string;
}) {
  const [editingIdTag, setEditingIdTag] = useState(false);

  return (
    <div className="space-y-4">
      <h3 className="font-semibold text-[var(--color-text-primary,#111)]">OCPP Identifiers</h3>

      <div className="p-4 rounded-lg bg-[var(--color-bg-secondary,#f9fafb)] border border-[var(--color-border,#e5e7eb)]">
        <div className="flex items-center justify-between">
          <div>
            <label className="block text-xs font-medium text-[var(--color-text-secondary,#6b7280)] mb-1">idTag</label>
            {editingIdTag ? (
              <input
                value={editForm.idTag ?? ''}
                onChange={(e) => setEditForm({ ...editForm, idTag: e.target.value })}
                maxLength={20}
                className="px-3 py-2 rounded-md border border-[var(--color-border,#d1d5db)] bg-[var(--color-bg-primary,#fff)] text-sm text-[var(--color-text-primary,#111)] w-64 focus:ring-2 focus:ring-blue-500/40"
              />
            ) : (
              <span className="text-sm text-[var(--color-text-primary,#111)]">{driver.idTag}</span>
            )}
          </div>
          {!editingIdTag ? (
            <button onClick={() => setEditingIdTag(true)} className="text-sm text-blue-600 hover:text-blue-800 dark:text-blue-400">Edit</button>
          ) : (
            <div className="flex gap-2">
              <button onClick={() => { onSave(); setEditingIdTag(false); }} disabled={saving} className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50">
                {saving ? 'Saving...' : 'Save'}
              </button>
              <button onClick={() => setEditingIdTag(false)} className="px-3 py-1.5 text-sm text-[var(--color-text-secondary,#6b7280)]">Cancel</button>
            </div>
          )}
        </div>
        <p className="text-xs text-[var(--color-text-tertiary,#9ca3af)] mt-2">Max 20 characters. Used for OCPP authorization.</p>
      </div>

      {saveMsg && <p className={`text-sm ${saveMsg.startsWith('Error') ? 'text-red-600' : 'text-green-600'}`}>{saveMsg}</p>}

      <div className="p-4 rounded-lg bg-[var(--color-bg-secondary,#f9fafb)] border border-[var(--color-border,#e5e7eb)]">
        <label className="block text-xs font-medium text-[var(--color-text-secondary,#6b7280)] mb-1">Internal User ID</label>
        <span className="text-sm text-[var(--color-text-secondary,#6b7280)]">{driver.id}</span>
      </div>
    </div>
  );
}

// ── Payment Tab ──────────────────────────────────────────────────────────
function PaymentTab({ cards, loading, error }: {
  cards: SupportDriverPaymentCard[]; loading: boolean; error: string;
}) {
  if (loading) return <div className="py-8 text-center text-[var(--color-text-secondary,#6b7280)]">Loading payment methods...</div>;
  if (error) return <div className="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 text-sm">{error}</div>;

  return (
    <div className="space-y-4">
      <h3 className="font-semibold text-[var(--color-text-primary,#111)]">Payment Methods on File</h3>

      {cards.length === 0 && (
        <div className="py-8 text-center text-[var(--color-text-secondary,#6b7280)]">No payment methods found.</div>
      )}

      {cards.map((c) => (
        <div key={c.id} className="flex items-center gap-4 p-4 rounded-lg bg-[var(--color-bg-secondary,#f9fafb)] border border-[var(--color-border,#e5e7eb)]">
          <div className="w-12 h-8 rounded bg-gradient-to-br from-gray-700 to-gray-900 flex items-center justify-center text-white text-xs font-bold uppercase">
            {c.brand.slice(0, 4)}
          </div>
          <div className="flex-1">
            <div className="text-sm font-medium text-[var(--color-text-primary,#111)] capitalize">{c.brand} •••• {c.last4}</div>
            <div className="text-xs text-[var(--color-text-secondary,#6b7280)]">Expires {String(c.expMonth).padStart(2, '0')}/{c.expYear}</div>
          </div>
        </div>
      ))}

      <p className="text-xs text-[var(--color-text-tertiary,#9ca3af)]">
        Only redacted card details are shown. Full card numbers are never accessible.
      </p>
    </div>
  );
}

// ── Activity Tab ─────────────────────────────────────────────────────────
function ActivityTab({ driver }: { driver: SupportDriverDetail }) {
  return (
    <div className="space-y-4">
      <h3 className="font-semibold text-[var(--color-text-primary,#111)]">Account Activity</h3>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="p-4 rounded-lg bg-[var(--color-bg-secondary,#f9fafb)] border border-[var(--color-border,#e5e7eb)]">
          <label className="block text-xs font-medium text-[var(--color-text-secondary,#6b7280)] mb-1">Account Created</label>
          <div className="text-sm text-[var(--color-text-primary,#111)]">{fmtDate(driver.createdAt)}</div>
        </div>
        <div className="p-4 rounded-lg bg-[var(--color-bg-secondary,#f9fafb)] border border-[var(--color-border,#e5e7eb)]">
          <label className="block text-xs font-medium text-[var(--color-text-secondary,#6b7280)] mb-1">Total Sessions</label>
          <div className="text-sm text-[var(--color-text-primary,#111)]">{driver.sessionCount}</div>
        </div>
        <div className="p-4 rounded-lg bg-[var(--color-bg-secondary,#f9fafb)] border border-[var(--color-border,#e5e7eb)]">
          <label className="block text-xs font-medium text-[var(--color-text-secondary,#6b7280)] mb-1">Total Payments</label>
          <div className="text-sm text-[var(--color-text-primary,#111)]">{driver.paymentCount}</div>
        </div>
        <div className="p-4 rounded-lg bg-[var(--color-bg-secondary,#f9fafb)] border border-[var(--color-border,#e5e7eb)]">
          <label className="block text-xs font-medium text-[var(--color-text-secondary,#6b7280)] mb-1">Stripe Connected</label>
          <div className="text-sm text-[var(--color-text-primary,#111)]">{driver.paymentProfile ? '✅ Yes' : '❌ No'}</div>
        </div>
      </div>

      <div className="p-4 rounded-lg bg-[var(--color-bg-secondary,#f9fafb)] border border-[var(--color-border,#e5e7eb)]">
        <label className="block text-xs font-medium text-[var(--color-text-secondary,#6b7280)] mb-1">Auth Provider ID</label>
        <div className="text-sm text-[var(--color-text-secondary,#6b7280)]">{driver.clerkId}</div>
      </div>
    </div>
  );
}
