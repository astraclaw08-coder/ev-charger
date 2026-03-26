/**
 * SiteRoleAssignment — stackable per-site role management.
 * Moved here from SiteDetail so it lives in Settings for fleet-wide management.
 */
import { useEffect, useState } from 'react';
import { createApiClient, type SiteListItem } from '../api/client';
import { useToken } from '../auth/TokenContext';

type RoleName = 'owner' | 'operator' | 'customer-service' | 'nre' | 'analyst';
type RoleAssignment = { id: string; email: string; roles: RoleName[]; createdAt: string };

function rolesKey(siteId: string) { return `ev-portal:site:roles:${siteId}`; }

function loadRoles(siteId: string): RoleAssignment[] {
  try {
    const raw = localStorage.getItem(rolesKey(siteId));
    if (!raw) return [];
    const x = JSON.parse(raw) as RoleAssignment[];
    return Array.isArray(x) ? x : [];
  } catch { return []; }
}

export default function SiteRoleAssignment() {
  const getToken = useToken();
  const [sites, setSites] = useState<SiteListItem[]>([]);
  const [selectedSiteId, setSelectedSiteId] = useState<string>('');
  const [assignments, setAssignments] = useState<RoleAssignment[]>([]);
  const [emailInput, setEmailInput] = useState('');
  const [roleDraft, setRoleDraft] = useState<RoleName>('operator');
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    getToken().then((token) => {
      const api = createApiClient(token);
      api.getSites()
        .then((data) => {
          setSites(data);
          if (data.length > 0) {
            setSelectedSiteId(data[0].id);
            setAssignments(loadRoles(data[0].id));
          }
        })
        .catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to load sites'));
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function selectSite(id: string) {
    setSelectedSiteId(id);
    setAssignments(loadRoles(id));
    setEmailInput('');
  }

  function assignRole() {
    const email = emailInput.trim().toLowerCase();
    if (!email || !selectedSiteId) return;
    const existing = assignments.find((a) => a.email === email);
    let next: RoleAssignment[];
    if (existing) {
      const merged = Array.from(new Set([...existing.roles, roleDraft])) as RoleName[];
      next = assignments.map((a) => a.email === email ? { ...a, roles: merged } : a);
    } else {
      next = [{ id: crypto.randomUUID(), email, roles: [roleDraft], createdAt: new Date().toISOString() }, ...assignments];
    }
    setAssignments(next);
    localStorage.setItem(rolesKey(selectedSiteId), JSON.stringify(next.slice(0, 200)));
    setEmailInput('');
  }

  function removeAssignment(id: string) {
    const next = assignments.filter((a) => a.id !== id);
    setAssignments(next);
    if (selectedSiteId) localStorage.setItem(rolesKey(selectedSiteId), JSON.stringify(next));
  }

  if (loadError) {
    return <p className="text-xs text-red-600">{loadError}</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label className="block text-xs text-gray-500 dark:text-slate-400 mb-1">Site</label>
          <select
            className="rounded-md border border-gray-300 dark:border-slate-600 px-2 py-2 text-sm"
            value={selectedSiteId}
            onChange={(e) => selectSite(e.target.value)}
          >
            {sites.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 dark:text-slate-400 mb-1">Email</label>
          <input
            className="rounded-md border border-gray-300 dark:border-slate-600 px-2 py-2 text-sm min-w-48"
            placeholder="user@example.com"
            value={emailInput}
            onChange={(e) => setEmailInput(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 dark:text-slate-400 mb-1">Role</label>
          <select
            className="rounded-md border border-gray-300 dark:border-slate-600 px-2 py-2 text-sm"
            value={roleDraft}
            onChange={(e) => setRoleDraft(e.target.value as RoleName)}
          >
            <option value="owner">owner</option>
            <option value="operator">operator</option>
            <option value="customer-service">customer-service</option>
            <option value="nre">nre</option>
            <option value="analyst">analyst</option>
          </select>
        </div>
        <button
          type="button"
          className="rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800/60 px-3 py-2 text-xs font-medium text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700"
          onClick={assignRole}
        >
          Assign role
        </button>
      </div>

      <div className="space-y-2">
        {assignments.length === 0 ? (
          <p className="text-xs text-gray-500 dark:text-slate-400">No role assignments for this site.</p>
        ) : (
          assignments.map((a) => (
            <div key={a.id} className="flex items-center justify-between rounded-md border border-gray-300 dark:border-slate-700 px-3 py-2">
              <div>
                <p className="text-sm font-medium text-gray-900 dark:text-slate-100">{a.email}</p>
                <p className="text-xs text-gray-500 dark:text-slate-400">{a.roles.join(', ')}</p>
              </div>
              <button
                type="button"
                className="rounded-md border border-red-300 bg-red-50 dark:bg-red-900/20 px-2 py-1 text-xs text-red-700 dark:text-red-400 hover:bg-red-100"
                onClick={() => removeAssignment(a.id)}
              >
                Remove
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
