import { useEffect, useState } from 'react';
import { createApiClient, type AdminUser } from '../api/client';
import { useToken } from '../auth/TokenContext';
import { cn } from '../lib/utils';

// Must match shared RBAC_ROLES. Only super_admin should assign admin-class roles.
const ASSIGNABLE_ROLES = [
  'super_admin',
  'admin',
  'owner',
  'operator',
  'customer_service',
  'network_reliability_engineer',
  'data_analyst',
] as const;

const ROLE_LABELS: Record<string, string> = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  owner: 'Owner',
  operator: 'Operator',
  customer_service: 'Customer Service',
  network_reliability_engineer: 'Network Reliability Engineer',
  data_analyst: 'Data Analyst',
};

const ROLE_DESCRIPTIONS: Record<string, string> = {
  super_admin: 'Highest privilege. Full platform access and only role allowed to grant/revoke admin-class roles.',
  admin: 'Full admin access across all sites. Can manage operations and users, but cannot grant/revoke admin-class roles.',
  owner: 'Full access within org. Users, sites, billing, RBAC.',
  operator: 'Day-to-day ops. Sites, chargers, sessions.',
  customer_service: 'Read access + session refunds.',
  network_reliability_engineer: 'Charger control + incident management.',
  data_analyst: 'Read-only analytics + data export.',
};

/** Given a user's realm roles, return their single RBAC role (if any). */
function getUserRole(user: AdminUser): string | null {
  const all = new Set(ASSIGNABLE_ROLES as readonly string[]);
  all.add('super_admin');
  return user.realmRoles?.find((r) => all.has(r)) ?? null;
}

interface EditForm {
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  roleReason: string;
}

export default function UserManagement() {
  const getToken = useToken();

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [search, setSearch] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);

  // Edit modal state
  const [editingUser, setEditingUser] = useState<AdminUser | null>(null);
  const [editForm, setEditForm] = useState<EditForm>({ email: '', firstName: '', lastName: '', role: '', roleReason: '' });
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

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

  function openEdit(user: AdminUser) {
    setEditingUser(user);
    setEditForm({
      email: user.email ?? '',
      firstName: user.firstName ?? '',
      lastName: user.lastName ?? '',
      role: getUserRole(user) ?? '',
      roleReason: '',
    });
    setEditError(null);
  }

  function closeEdit() {
    setEditingUser(null);
    setEditError(null);
  }

  async function handleSave() {
    if (!editingUser) return;
    setEditSaving(true);
    setEditError(null);

    try {
      const token = await getToken();
      const api = createApiClient(token);

      // Update user attributes
      const updates: { email?: string; firstName?: string; lastName?: string } = {};
      if (editForm.email !== (editingUser.email ?? '')) updates.email = editForm.email;
      if (editForm.firstName !== (editingUser.firstName ?? '')) updates.firstName = editForm.firstName;
      if (editForm.lastName !== (editingUser.lastName ?? '')) updates.lastName = editForm.lastName;

      if (Object.keys(updates).length > 0) {
        await api.updateAdminUser(editingUser.id, updates);
      }

      // Single-role assignment (API handles swap internally)
      const currentRole = getUserRole(editingUser);
      if (editForm.role && editForm.role !== currentRole) {
        const reason = editForm.roleReason.trim() || 'Updated via admin portal';
        await api.addAdminUserRole(editingUser.id, editForm.role, reason);
      }

      await refresh();
      closeEdit();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setEditSaving(false);
    }
  }

  async function handleDeactivate() {
    if (!editingUser || !confirm(`${editingUser.enabled ? 'Deactivate' : 'Reactivate'} ${editingUser.email ?? editingUser.username}?`)) return;
    setEditSaving(true);
    try {
      const token = await getToken();
      const api = createApiClient(token);
      if (editingUser.enabled) {
        await api.deactivateAdminUser(editingUser.id, { revokeSessions: true, reason: 'Admin deactivation' });
      } else {
        await api.reactivateAdminUser(editingUser.id, 'Admin reactivation');
      }
      await refresh();
      closeEdit();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setEditSaving(false);
    }
  }

  async function handleDelete() {
    if (!editingUser) return;
    const name = editingUser.email ?? editingUser.username ?? editingUser.id;
    if (!confirm(`Permanently delete user "${name}"? This cannot be undone.`)) return;
    if (!confirm(`Are you sure? This will remove all data for "${name}".`)) return;
    setEditSaving(true);
    try {
      const token = await getToken();
      const api = createApiClient(token);
      await api.deleteAdminUser(editingUser.id, 'Admin deletion');
      await refresh();
      closeEdit();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setEditSaving(false);
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
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50 dark:divide-slate-800">
            {users.map((u) => {
              const role = getUserRole(u);
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
                    <span className="rounded-full border border-gray-200 dark:border-slate-700 px-2 py-0.5 text-xs text-gray-700 dark:text-slate-300">
                      {role ? (ROLE_LABELS[role] ?? role) : 'No role'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={cn('text-xs font-semibold', u.enabled ? 'text-green-600 dark:text-green-400' : 'text-slate-500 dark:text-slate-400')}>
                      {u.enabled ? 'Active' : 'Disabled'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <button
                      className="rounded-md border border-gray-300 dark:border-slate-600 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700 transition-colors"
                      onClick={() => openEdit(u)}
                    >
                      Edit
                    </button>
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

      {/* ── Edit User Modal ───────────────────────────────────────────────── */}
      {editingUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={closeEdit}>
          <div className="w-full max-w-md rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div className="flex items-center justify-between border-b border-gray-100 dark:border-slate-800 px-6 py-4">
              <h3 className="text-base font-semibold text-gray-900 dark:text-slate-100">Edit User</h3>
              <button className="text-gray-400 hover:text-gray-600 dark:hover:text-slate-300 text-lg" onClick={closeEdit}>✕</button>
            </div>

            {/* Body */}
            <div className="space-y-4 px-6 py-5">
              {editError && (
                <div className="rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-3 py-2 text-xs text-red-700 dark:text-red-400">{editError}</div>
              )}

              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-slate-300 mb-1">Email</label>
                <input
                  className="w-full rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-gray-900 dark:text-slate-100"
                  value={editForm.email}
                  onChange={(e) => setEditForm((f) => ({ ...f, email: e.target.value }))}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-700 dark:text-slate-300 mb-1">First Name</label>
                  <input
                    className="w-full rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-gray-900 dark:text-slate-100"
                    value={editForm.firstName}
                    onChange={(e) => setEditForm((f) => ({ ...f, firstName: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 dark:text-slate-300 mb-1">Last Name</label>
                  <input
                    className="w-full rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-gray-900 dark:text-slate-100"
                    value={editForm.lastName}
                    onChange={(e) => setEditForm((f) => ({ ...f, lastName: e.target.value }))}
                  />
                </div>
              </div>

              {/* Single-role selection */}
              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-slate-300 mb-2">Role</label>
                <div className="space-y-1.5">
                  {ASSIGNABLE_ROLES.map((role) => (
                    <label
                      key={role}
                      className={cn(
                        'flex items-start gap-3 rounded-lg border px-3 py-2.5 cursor-pointer transition-colors',
                        editForm.role === role
                          ? 'border-blue-400 bg-blue-50/50 dark:border-blue-600 dark:bg-blue-900/20'
                          : 'border-gray-200 dark:border-slate-700 hover:border-gray-300 dark:hover:border-slate-600',
                      )}
                    >
                      <input
                        type="radio"
                        name="user-role"
                        value={role}
                        checked={editForm.role === role}
                        onChange={() => setEditForm((f) => ({ ...f, role }))}
                        className="mt-0.5 accent-blue-600"
                      />
                      <div className="min-w-0">
                        <p className={cn(
                          'text-sm font-medium',
                          editForm.role === role
                            ? 'text-blue-700 dark:text-blue-300'
                            : 'text-gray-900 dark:text-slate-100',
                        )}>
                          {ROLE_LABELS[role]}
                        </p>
                        <p className="text-xs text-gray-500 dark:text-slate-400 mt-0.5">{ROLE_DESCRIPTIONS[role]}</p>
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              {/* Reason — only show if role changed */}
              {editForm.role !== getUserRole(editingUser) && editForm.role && (
                <div>
                  <label className="block text-xs font-medium text-gray-700 dark:text-slate-300 mb-1">Reason for role change</label>
                  <input
                    className="w-full rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-gray-900 dark:text-slate-100 placeholder-gray-400 dark:placeholder-slate-500"
                    placeholder="Required"
                    value={editForm.roleReason}
                    onChange={(e) => setEditForm((f) => ({ ...f, roleReason: e.target.value }))}
                  />
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="border-t border-gray-100 dark:border-slate-800 px-6 py-4">
              <div className="flex items-center justify-between">
                <div className="flex gap-2">
                  <button
                    className={cn(
                      'rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
                      editingUser.enabled
                        ? 'border-amber-300 dark:border-amber-700 text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20'
                        : 'border-green-300 dark:border-green-700 text-green-600 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/20',
                    )}
                    disabled={editSaving}
                    onClick={handleDeactivate}
                  >
                    {editingUser.enabled ? 'Deactivate' : 'Reactivate'}
                  </button>
                  <button
                    className="rounded-md border border-red-300 dark:border-red-700 px-3 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                    disabled={editSaving}
                    onClick={handleDelete}
                  >
                    Delete
                  </button>
                </div>
                <div className="flex gap-2">
                  <button
                    className="rounded-md border border-gray-300 dark:border-slate-600 px-4 py-1.5 text-xs font-medium text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700 transition-colors"
                    disabled={editSaving}
                    onClick={closeEdit}
                  >
                    Cancel
                  </button>
                  <button
                    className="rounded-md bg-blue-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
                    disabled={editSaving}
                    onClick={handleSave}
                  >
                    {editSaving ? 'Saving…' : 'Save Changes'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
