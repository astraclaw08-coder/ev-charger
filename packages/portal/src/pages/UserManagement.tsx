import { useEffect, useMemo, useState } from 'react';
import { createApiClient, type AdminAuditEvent, type AdminUser } from '../api/client';
import { useToken } from '../auth/TokenContext';

const ROLES = ['owner', 'operator', 'customer_support', 'network_reliability', 'analyst'];

export default function UserManagement() {
  const getToken = useToken();

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [audit, setAudit] = useState<AdminAuditEvent[]>([]);
  const [search, setSearch] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newFirstName, setNewFirstName] = useState('');
  const [newLastName, setNewLastName] = useState('');
  const [roleDraftByUser, setRoleDraftByUser] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  const trimmedEmail = useMemo(() => newEmail.trim(), [newEmail]);

  async function refresh() {
    const token = await getToken();
    const api = createApiClient(token);
    const [u, a] = await Promise.allSettled([
      api.listAdminUsers({ search: search || undefined, max: 100 }),
      api.listAdminAudit(30),
    ]);

    if (u.status === 'fulfilled') {
      setUsers(Array.isArray(u.value) ? u.value : []);
      setLoadError(null);
    } else {
      setUsers([]);
      setLoadError(u.reason instanceof Error ? u.reason.message : 'Failed to load users');
    }

    if (a.status === 'fulfilled') {
      setAudit(Array.isArray(a.value) ? a.value : []);
    } else {
      setAudit([]);
    }
  }

  useEffect(() => {
    refresh().catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to load users'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run(action: (api: ReturnType<typeof createApiClient>) => Promise<unknown>, okMsg: string) {
    try {
      const token = await getToken();
      const api = createApiClient(token);
      await action(api);
      await refresh();
      window.alert(okMsg);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Action failed');
    }
  }

  function roleForUser(userId: string) {
    return roleDraftByUser[userId] ?? 'operator';
  }

  function setRoleForUser(userId: string, role: string) {
    setRoleDraftByUser((prev) => ({ ...prev, [userId]: role }));
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">User Management</h1>
        <p className="text-sm text-gray-500">Keycloak-backed admin workflows + audit trail</p>
      </div>

      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-gray-700">Invite / Create user</h2>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-4">
          <input className="rounded border px-3 py-2 text-sm" placeholder="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
          <input className="rounded border px-3 py-2 text-sm" placeholder="first name" value={newFirstName} onChange={(e) => setNewFirstName(e.target.value)} />
          <input className="rounded border px-3 py-2 text-sm" placeholder="last name" value={newLastName} onChange={(e) => setNewLastName(e.target.value)} />
          <button
            className="rounded bg-brand-600 px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
            disabled={!trimmedEmail}
            onClick={() => run((api) => api.createAdminUser({ email: trimmedEmail, firstName: newFirstName, lastName: newLastName, sendInvite: true }), 'User invited')}
          >
            Invite user
          </button>
        </div>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <div className="mb-3 flex items-center gap-2">
          <h2 className="text-sm font-semibold text-gray-700">Users</h2>
          <input className="rounded border px-2 py-1 text-sm" placeholder="search" value={search} onChange={(e) => setSearch(e.target.value)} />
          <button className="rounded border px-2 py-1 text-xs" onClick={() => refresh().catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to refresh users'))}>Refresh</button>
        </div>
        {loadError && <p className="mb-2 text-xs text-red-600">{loadError}</p>}
        <div className="space-y-3">
          {users.map((u) => {
            const selectedRole = roleForUser(u.id);
            const hasRole = !!u.realmRoles?.includes(selectedRole);
            return (
              <div key={u.id} className="rounded border border-gray-100 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium text-gray-900">{u.email ?? u.username ?? u.id}</p>
                    <p className="text-xs text-gray-500">{u.firstName} {u.lastName} · {u.enabled ? 'Active' : 'Disabled'}</p>
                    <p className="text-xs text-gray-500">roles: {(u.realmRoles?.length ? u.realmRoles.join(', ') : 'none')}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      className="rounded border px-2 py-1 text-xs"
                      onClick={() => {
                        if (confirm('Trigger password reset email and revoke active sessions?')) {
                          run((api) => api.triggerPasswordReset(u.id, { revokeSessions: true, reason: 'Admin-triggered credential reset' }), 'Reset sent');
                        }
                      }}
                    >
                      Reset credential
                    </button>
                    <button
                      className="rounded border px-2 py-1 text-xs"
                      onClick={() => {
                        if (confirm('Revoke all active sessions for this user?')) {
                          run((api) => api.revokeAdminUserSessions(u.id, 'Manual admin session revocation'), 'Sessions revoked');
                        }
                      }}
                    >
                      Revoke sessions
                    </button>
                    {u.enabled ? (
                      <button
                        className="rounded border border-red-300 px-2 py-1 text-xs text-red-700"
                        onClick={() => {
                          if (confirm('Deactivate this user and revoke active sessions?')) {
                            run((api) => api.deactivateAdminUser(u.id, { revokeSessions: true, reason: 'Admin deactivation' }), 'User deactivated');
                          }
                        }}
                      >
                        Deactivate
                      </button>
                    ) : (
                      <button
                        className="rounded border border-green-300 px-2 py-1 text-xs text-green-700"
                        onClick={() => {
                          if (confirm('Reactivate this user?')) {
                            run((api) => api.reactivateAdminUser(u.id, 'Admin reactivation'), 'User reactivated');
                          }
                        }}
                      >
                        Reactivate
                      </button>
                    )}
                    <select className="rounded border px-2 py-1 text-xs" value={selectedRole} onChange={(e) => setRoleForUser(u.id, e.target.value)}>
                      {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                    <button
                      className="rounded border px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={hasRole}
                      onClick={() => run((api) => api.addAdminUserRole(u.id, selectedRole, 'Admin role grant'), 'Role granted')}
                    >
                      + role
                    </button>
                    <button
                      className="rounded border px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={!hasRole}
                      onClick={() => {
                        if (selectedRole === 'owner' && !confirm('Remove OWNER role? This is a privileged action.')) return;
                        run(
                          (api) => api.removeAdminUserRole(u.id, selectedRole, {
                            reason: 'Admin role removal',
                            confirmPrivilegedRoleRemoval: selectedRole === 'owner',
                          }),
                          'Role removed',
                        );
                      }}
                    >
                      - role
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-gray-700">Audit trail</h2>
        <div className="space-y-2">
          {audit.map((a) => (
            <div key={a.id} className="rounded border border-gray-100 p-2 text-xs text-gray-600">
              <div>{new Date(a.createdAt).toLocaleString()} · <span className="font-medium">{a.action}</span></div>
              <div>operator={a.operatorId} target={a.targetEmail ?? a.targetUserId ?? 'n/a'}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
