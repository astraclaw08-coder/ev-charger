import { useEffect, useMemo, useState } from 'react';
import { createApiClient, type AdminAuditEvent, type AdminUser } from '../api/client';
import { useToken } from '../auth/TokenContext';
import { cn } from '../lib/utils';

const ROLES = ['owner', 'operator', 'customer_support', 'network_reliability', 'analyst'];

export default function UserManagement() {
  const getToken = useToken();

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [search, setSearch] = useState('');
  const [roleDraftByUser, setRoleDraftByUser] = useState<Record<string, string>>({});
  const [roleReasonByUser, setRoleReasonByUser] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  async function refresh() {
    try {
      const token = await getToken();
      const api = createApiClient(token);
      const u = await api.listAdminUsers({ search: search || undefined, max: 100 });
      setUsers(Array.isArray(u) ? u : []);
      setLoadError(null);
    } catch (err) {
      setUsers([]);
      setLoadError(err instanceof Error ? err.message : 'Failed to load users');
    }
  }

  useEffect(() => {
    refresh().catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to load users'));
  }, []);

  async function run(action: (api: ReturnType<typeof createApiClient>) => Promise<unknown>, okMsg: string) {
    try {
      const token = await getToken();
      await action(createApiClient(token));
      await refresh();
      window.alert(okMsg);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Action failed');
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <input
          className="flex-1 rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-gray-900 dark:text-slate-100 placeholder-gray-400 dark:placeholder-slate-500"
          placeholder="Search by name or email…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button
          className="rounded-md border border-gray-300 dark:border-slate-600 px-3 py-2 text-xs font-medium text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700"
          onClick={() => refresh()}
        >
          Refresh
        </button>
      </div>

      {loadError && (
        <div className="rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-700 dark:text-red-400">
          {loadError}
          <p className="mt-1 text-xs text-red-500 dark:text-red-500">Check that Keycloak admin client has manage-users permissions.</p>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 dark:border-slate-800 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-slate-400">
              <th className="px-4 py-3">User</th>
              <th className="px-4 py-3">Organization</th>
              <th className="px-4 py-3">Roles</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50 dark:divide-slate-800">
            {users.map((u) => {
              const selectedRole = roleDraftByUser[u.id] ?? 'operator';
              const hasRole = !!u.realmRoles?.includes(selectedRole);
              const roleReason = roleReasonByUser[u.id] ?? '';
              return (
                <tr key={u.id} className="hover:bg-gray-50 dark:hover:bg-slate-800/40">
                  <td className="px-4 py-3">
                    <p className="font-medium text-gray-900 dark:text-slate-100">{u.email ?? u.username ?? u.id}</p>
                    <p className="text-xs text-gray-500 dark:text-slate-400">{u.firstName} {u.lastName}</p>
                  </td>
                  <td className="px-4 py-3">
                    <p className="text-xs text-gray-700 dark:text-slate-300">{(u as any).attributes?.organization?.[0] ?? '—'}</p>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {(u.realmRoles?.length ? u.realmRoles : ['none']).map((r) => (
                        <span key={r} className="rounded-full border border-gray-200 dark:border-slate-700 px-2 py-0.5 text-xs text-gray-700 dark:text-slate-300">{r}</span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={cn('text-xs font-semibold', u.enabled ? 'text-green-600 dark:text-green-400' : 'text-slate-500 dark:text-slate-400')}>
                      {u.enabled ? 'Active' : 'Disabled'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <select className="rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1 text-xs text-gray-900 dark:text-slate-100" value={selectedRole} onChange={(e) => setRoleDraftByUser((p) => ({ ...p, [u.id]: e.target.value }))}>
                        {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                      <input
                        className="w-32 rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1 text-xs text-gray-900 dark:text-slate-100 placeholder-gray-400 dark:placeholder-slate-500"
                        placeholder="Reason"
                        value={roleReason}
                        onChange={(e) => setRoleReasonByUser((p) => ({ ...p, [u.id]: e.target.value }))}
                      />
                      <button
                        className="rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1 text-xs font-medium text-gray-700 dark:text-slate-300 disabled:opacity-50"
                        disabled={hasRole || !roleReason.trim()}
                        onClick={() => run((api) => api.addAdminUserRole(u.id, selectedRole, roleReason.trim()), 'Role granted')}
                      >
                        +
                      </button>
                      <button
                        className="rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1 text-xs font-medium text-gray-700 dark:text-slate-300 disabled:opacity-50"
                        disabled={!hasRole || !roleReason.trim()}
                        onClick={() => run((api) => api.removeAdminUserRole(u.id, selectedRole, { reason: roleReason.trim(), confirmPrivilegedRoleRemoval: selectedRole === 'owner' }), 'Role removed')}
                      >
                        −
                      </button>
                      <button
                        className="rounded-md border border-gray-300 dark:border-slate-600 px-2 py-1 text-xs text-gray-700 dark:text-slate-300"
                        onClick={() => { if (confirm('Reset credentials?')) run((api) => api.triggerPasswordReset(u.id, { revokeSessions: true, reason: 'Admin reset' }), 'Reset sent'); }}
                      >
                        Reset
                      </button>
                      {u.enabled ? (
                        <button className="rounded-md border border-red-300 dark:border-red-700 px-2 py-1 text-xs text-red-600 dark:text-red-400" onClick={() => { if (confirm('Deactivate?')) run((api) => api.deactivateAdminUser(u.id, { revokeSessions: true, reason: 'Admin deactivation' }), 'Deactivated'); }}>
                          Deactivate
                        </button>
                      ) : (
                        <button className="rounded-md border border-green-300 dark:border-green-700 px-2 py-1 text-xs text-green-600 dark:text-green-400" onClick={() => { if (confirm('Reactivate?')) run((api) => api.reactivateAdminUser(u.id, 'Admin reactivation'), 'Reactivated'); }}>
                          Reactivate
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {users.length === 0 && !loadError && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-xs text-gray-500 dark:text-slate-400">No users found.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
