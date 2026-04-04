import { useEffect, useMemo, useState } from 'react';
import { createApiClient, type AdminAuditEvent, type ChargerModelCatalogItem, type OperatorNotificationPreference, type PortalSettings } from '../api/client';
import { useToken } from '../auth/TokenContext';
import UserManagement from './UserManagement';
import { cn } from '../lib/utils';
import { usePortalTheme } from '../theme/ThemeContext';
import { usePasswordAuth } from '../auth/PasswordAuthContext';
import { TabBar } from '../components/ui';

// ─── Types ────────────────────────────────────────────────────────────────────
type OrgDraft = {
  organizationName: string;
  organizationDefaultSite: string;
  organizationPortfolio: string;
  organizationBillingAddress: string;
  supportContactEmail: string;
  supportContactPhone: string;
  profileDisplayName: string;
  profileTimezone: string;
  remittanceBankName: string;
  remittanceAccountType: string;
  remittanceEmail: string;
  routingNumber: string;
  accountNumber: string;
  reason: string;
};

const EMPTY_ORG: OrgDraft = {
  organizationName: '',
  organizationDefaultSite: '',
  organizationPortfolio: '',
  organizationBillingAddress: '',
  supportContactEmail: '',
  supportContactPhone: '',
  profileDisplayName: '',
  profileTimezone: '',
  remittanceBankName: '',
  remittanceAccountType: 'checking',
  remittanceEmail: '',
  routingNumber: '',
  accountNumber: '',
  reason: '',
};

const ADMIN_TABS = [
  { id: 'users', label: 'Users' },
  { id: 'organizations', label: 'Organizations' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'audit', label: 'Audit' },
  { id: 'api', label: 'Integrations' },
  { id: 'billing', label: 'Billing' },
  { id: 'security', label: 'Security' },
  { id: 'charger-models', label: 'Chargers' },
] as const;

type TabId = (typeof ADMIN_TABS)[number]['id'];

// ─── Theme icons ──────────────────────────────────────────────────────────────
function SunIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2.5M12 19.5V22M4.93 4.93l1.77 1.77M17.3 17.3l1.77 1.77M2 12h2.5M19.5 12H22M4.93 19.07 6.7 17.3M17.3 6.7l1.77-1.77" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9">
      <path d="M21 14.2A8.8 8.8 0 1 1 9.8 3a7.2 7.2 0 1 0 11.2 11.2Z" />
    </svg>
  );
}

// ─── Shared UI ────────────────────────────────────────────────────────────────

function SectionCard({ title, description, actions, children }: { title: string; description?: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-sm">
      <div className="flex items-center justify-between border-b border-gray-200 dark:border-slate-700 px-6 py-4">
        <div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-slate-100">{title}</h3>
          {description && <p className="mt-0.5 text-xs text-gray-500 dark:text-slate-400">{description}</p>}
        </div>
        {actions && <div>{actions}</div>}
      </div>
      <div className="px-6 py-5">{children}</div>
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="font-medium text-gray-700 dark:text-slate-300">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cn(
        'w-full rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-gray-900 dark:text-slate-100 placeholder-gray-400 dark:placeholder-slate-500 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500',
        props.className,
      )}
    />
  );
}

function PrimaryButton({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...props} className={cn('rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50', props.className)}>
      {children}
    </button>
  );
}

function SecondaryButton({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...props} className={cn('rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm font-medium text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700 disabled:opacity-50', props.className)}>
      {children}
    </button>
  );
}

// ─── Tab: Users ───────────────────────────────────────────────────────────────
function UsersTab() {
  const [showCreate, setShowCreate] = useState(false);
  const getToken = useToken();

  async function handleCreateUser(data: { email: string; firstName: string; lastName: string }) {
    try {
      const token = await getToken();
      const api = createApiClient(token);
      await api.createAdminUser({ email: data.email, firstName: data.firstName, lastName: data.lastName, sendInvite: true });
      window.alert('User created successfully.');
      setShowCreate(false);
      // UserManagement will auto-refresh on next render
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Failed to create user');
    }
  }

  return (
    <SectionCard
      title="Users"
      description="Manage user accounts, roles, organizations, and access levels."
      actions={<PrimaryButton onClick={() => setShowCreate((v) => !v)}>+ User</PrimaryButton>}
    >
      {showCreate && <UserCreateInline onSubmit={handleCreateUser} onCancel={() => setShowCreate(false)} />}
      <UserManagement />
    </SectionCard>
  );
}

function UserCreateInline({ onSubmit, onCancel }: { onSubmit: (data: { email: string; firstName: string; lastName: string }) => void; onCancel: () => void }) {
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [role, setRole] = useState('operator');
  const [org, setOrg] = useState('');
  const [siteAccess, setSiteAccess] = useState('all');
  const [selectedSites, setSelectedSites] = useState('');
  const [privilege, setPrivilege] = useState('read_write');

  const inputCls = 'mt-1 w-full rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-gray-900 dark:text-slate-100 placeholder-gray-400 dark:placeholder-slate-500';
  const selectCls = 'mt-1 w-full rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-gray-900 dark:text-slate-100';
  const labelCls = 'font-medium text-gray-700 dark:text-slate-300';

  return (
    <div className="mb-5 rounded-lg border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/40 p-5">
      <div className="flex items-center justify-between mb-4">
        <h4 className="text-sm font-semibold text-gray-900 dark:text-slate-100">New User</h4>
        <button onClick={onCancel} className="text-xs text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-200">Cancel</button>
      </div>

      {/* Identity */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3 mb-4">
        <label className="block text-sm"><span className={labelCls}>Email *</span><input type="email" placeholder="user@company.com" value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} /></label>
        <label className="block text-sm"><span className={labelCls}>First Name</span><input placeholder="Jane" value={firstName} onChange={(e) => setFirstName(e.target.value)} className={inputCls} /></label>
        <label className="block text-sm"><span className={labelCls}>Last Name</span><input placeholder="Smith" value={lastName} onChange={(e) => setLastName(e.target.value)} className={inputCls} /></label>
      </div>

      {/* Role + Organization */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3 mb-4">
        <label className="block text-sm">
          <span className={labelCls}>Role</span>
          <select value={role} onChange={(e) => setRole(e.target.value)} className={selectCls}>
            <option value="super_admin">Super Admin</option>
            <option value="admin">Admin</option>
            <option value="org_admin">Organization Admin</option>
            <option value="operator">Operator</option>
            <option value="analyst">Analyst</option>
            <option value="support">Support Agent</option>
          </select>
          <p className="mt-1 text-xs text-gray-500 dark:text-slate-400">
            {role === 'super_admin' ? 'Full access to all organizations and sites' :
             role === 'admin' ? 'Full access within assigned organizations' :
             role === 'org_admin' ? 'Manage users and sites within their org' :
             role === 'operator' ? 'Operate and monitor assigned sites' :
             role === 'analyst' ? 'Read-only analytics and reports' : 'Customer support workflows'}
          </p>
        </label>
        <label className="block text-sm">
          <span className={labelCls}>Organization</span>
          <input placeholder="Organization name" value={org} onChange={(e) => setOrg(e.target.value)} className={inputCls} />
          <p className="mt-1 text-xs text-gray-500 dark:text-slate-400">Org admins can only assign their own org</p>
        </label>
        <label className="block text-sm">
          <span className={labelCls}>Privilege</span>
          <select value={privilege} onChange={(e) => setPrivilege(e.target.value)} className={selectCls}>
            <option value="read">Read Only</option>
            <option value="read_write">Read & Write</option>
            <option value="admin">Full Admin</option>
          </select>
        </label>
      </div>

      {/* Site access */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 mb-4">
        <label className="block text-sm">
          <span className={labelCls}>Site Access</span>
          <select value={siteAccess} onChange={(e) => setSiteAccess(e.target.value)} className={selectCls}>
            <option value="all">All sites in organization</option>
            <option value="selected">Selected sites only</option>
          </select>
        </label>
        {siteAccess === 'selected' && (
          <label className="block text-sm">
            <span className={labelCls}>Sites</span>
            <input placeholder="Site names or IDs (comma-separated)" value={selectedSites} onChange={(e) => setSelectedSites(e.target.value)} className={inputCls} />
          </label>
        )}
      </div>

      <PrimaryButton disabled={!email.trim()} onClick={() => onSubmit({ email: email.trim(), firstName, lastName })}>Create & Invite</PrimaryButton>
    </div>
  );
}

// ─── Tab: Organizations ───────────────────────────────────────────────────────
function OrganizationsTab({ org, setOrg, onSave, valid }: {
  org: OrgDraft; setOrg: React.Dispatch<React.SetStateAction<OrgDraft>>; onSave: () => void; valid: boolean;
}) {
  const [orgSearch, setOrgSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Mock org list — in production this comes from API
  const orgList = [
    { id: '1', name: org.organizationName || 'Default Organization', sites: 2, chargers: 4, contactEmail: org.supportContactEmail, status: 'Active' as const },
  ].filter((o) => o.name);

  const filteredOrgs = orgList.filter((o) =>
    !orgSearch || o.name.toLowerCase().includes(orgSearch.toLowerCase()),
  );

  const orgFields: Array<{ key: keyof OrgDraft; label: string; placeholder: string }> = [
    { key: 'organizationName', label: 'Organization Name', placeholder: 'Acme Charging Inc.' },
    { key: 'organizationBillingAddress', label: 'Billing Address', placeholder: '123 Main St, City, ST 00000' },
    { key: 'organizationPortfolio', label: 'Portfolio / Site Assignment', placeholder: 'Portfolio name or site IDs' },
    { key: 'organizationDefaultSite', label: 'Default Site', placeholder: 'Primary site ID' },
    { key: 'supportContactEmail', label: 'Support Contact Email', placeholder: 'support@company.com' },
    { key: 'supportContactPhone', label: 'Support Contact Phone', placeholder: '+1 (555) 000-0000' },
    { key: 'profileDisplayName', label: 'Admin Display Name', placeholder: 'Admin user display name' },
    { key: 'profileTimezone', label: 'Timezone', placeholder: 'America/Los_Angeles' },
  ];

  return (
    <SectionCard
      title="Organizations"
      description="Manage registered organizations, portfolios, and site assignments."
      actions={<PrimaryButton onClick={() => setShowCreate((v) => !v)}>+ Organization</PrimaryButton>}
    >
      {showCreate && (
        <div className="mb-6 rounded-lg border border-brand-200 dark:border-brand-700 bg-brand-50/30 dark:bg-brand-900/10 p-4">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-semibold text-gray-900 dark:text-slate-100">New Organization</h4>
            <button onClick={() => setShowCreate(false)} className="text-xs text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-200">Cancel</button>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {orgFields.slice(0, 4).map(({ key, label, placeholder }) => (
              <FieldRow key={key} label={label}><Input placeholder={placeholder} value={org[key]} onChange={(e) => setOrg((p) => ({ ...p, [key]: e.target.value }))} /></FieldRow>
            ))}
          </div>
          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
            {orgFields.slice(4).map(({ key, label, placeholder }) => (
              <FieldRow key={key} label={label}><Input placeholder={placeholder} value={org[key]} onChange={(e) => setOrg((p) => ({ ...p, [key]: e.target.value }))} /></FieldRow>
            ))}
          </div>
          <div className="mt-3">
            <FieldRow label="Change Reason (required)"><Input placeholder="Reason" value={org.reason} onChange={(e) => setOrg((p) => ({ ...p, reason: e.target.value }))} /></FieldRow>
          </div>
          <div className="mt-3"><PrimaryButton disabled={!valid} onClick={() => { onSave(); setShowCreate(false); }}>Create Organization</PrimaryButton></div>
        </div>
      )}

      <div className="mb-4">
        <Input placeholder="Search organizations…" value={orgSearch} onChange={(e) => setOrgSearch(e.target.value)} />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 dark:border-slate-800 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-slate-400">
              <th className="px-4 py-3">Organization</th>
              <th className="px-4 py-3">Sites</th>
              <th className="px-4 py-3">Chargers</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50 dark:divide-slate-800">
            {filteredOrgs.map((o) => (
              <tr key={o.id} className="hover:bg-gray-50 dark:hover:bg-slate-800/40">
                <td className="px-4 py-3">
                  <p className="font-medium text-gray-900 dark:text-slate-100">{o.name}</p>
                  <p className="text-xs text-gray-500 dark:text-slate-400">{o.contactEmail || '—'}</p>
                </td>
                <td className="px-4 py-3 text-gray-700 dark:text-slate-300">{o.sites}</td>
                <td className="px-4 py-3 text-gray-700 dark:text-slate-300">{o.chargers}</td>
                <td className="px-4 py-3">
                  <span className="rounded-full bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 px-2 py-0.5 text-xs font-medium">{o.status}</span>
                </td>
                <td className="px-4 py-3">
                  <SecondaryButton onClick={() => setEditingId(editingId === o.id ? null : o.id)}>Edit</SecondaryButton>
                </td>
              </tr>
            ))}
            {filteredOrgs.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-xs text-gray-500 dark:text-slate-400">No organizations found.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {editingId && (
        <div className="mt-4 rounded-lg border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/40 p-4">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-semibold text-gray-900 dark:text-slate-100">Edit Organization</h4>
            <button onClick={() => setEditingId(null)} className="text-xs text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-200">Close</button>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {orgFields.map(({ key, label, placeholder }) => (
              <FieldRow key={key} label={label}><Input placeholder={placeholder} value={org[key]} onChange={(e) => setOrg((p) => ({ ...p, [key]: e.target.value }))} /></FieldRow>
            ))}
          </div>
          <div className="mt-3"><FieldRow label="Change Reason (required)"><Input placeholder="Reason" value={org.reason} onChange={(e) => setOrg((p) => ({ ...p, reason: e.target.value }))} /></FieldRow></div>
          <div className="mt-3 flex gap-2">
            <PrimaryButton disabled={!valid} onClick={onSave}>Save</PrimaryButton>
            <SecondaryButton onClick={() => setEditingId(null)}>Cancel</SecondaryButton>
          </div>
        </div>
      )}
    </SectionCard>
  );
}

// ─── Tab: Notifications ───────────────────────────────────────────────────────
function NotificationsTab({ notifications, setNotifications, reason, setReason, onSave, valid }: {
  notifications: OperatorNotificationPreference | null;
  setNotifications: React.Dispatch<React.SetStateAction<OperatorNotificationPreference | null>>;
  reason: string; setReason: (v: string) => void; onSave: () => void; valid: boolean;
}) {
  if (!notifications) return <p className="text-sm text-gray-500 dark:text-slate-400">Loading notification preferences…</p>;

  const prefs: Array<{ key: keyof OperatorNotificationPreference; label: string; description: string }> = [
    { key: 'emailEnabled', label: 'Email Notifications', description: 'Receive alerts via email' },
    { key: 'smsEnabled', label: 'SMS Notifications', description: 'Receive alerts via SMS' },
    { key: 'outageAlerts', label: 'Outage Alerts', description: 'Notify when chargers go offline or faulted' },
    { key: 'billingAlerts', label: 'Billing Alerts', description: 'Notify on payment failures or revenue anomalies' },
    { key: 'weeklyDigest', label: 'Weekly Digest', description: 'Summary email of fleet performance' },
  ];

  return (
    <SectionCard title="Notification Preferences" description="Configure how and when you receive operational alerts.">
      <div className="space-y-4">
        {prefs.map(({ key, label, description }) => (
          <label key={key} className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-gray-300 dark:border-slate-600 text-brand-600 focus:ring-brand-500"
              checked={!!(notifications as any)[key]}
              onChange={(e) => setNotifications((p) => p ? ({ ...p, [key]: e.target.checked }) : p)}
            />
            <div>
              <p className="text-sm font-medium text-gray-900 dark:text-slate-100">{label}</p>
              <p className="text-xs text-gray-500 dark:text-slate-400">{description}</p>
            </div>
          </label>
        ))}
        <div className="pt-2 border-t border-gray-100 dark:border-slate-800">
          <FieldRow label="Change Reason (required)">
            <Input placeholder="Why are you updating preferences?" value={reason} onChange={(e) => setReason(e.target.value)} />
          </FieldRow>
        </div>
      </div>
      <div className="mt-4">
        <PrimaryButton disabled={!valid} onClick={onSave}>Save Preferences</PrimaryButton>
      </div>
    </SectionCard>
  );
}

// ─── Tab: Audit Log ───────────────────────────────────────────────────────────
function AuditTab({ audit }: { audit: AdminAuditEvent[] }) {
  const [filter, setFilter] = useState('');
  const filtered = audit.filter((a) =>
    !filter || a.action.toLowerCase().includes(filter.toLowerCase()) || a.operatorId?.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <SectionCard title="Audit Log" description="Searchable history of all admin actions with actor, timestamp, and context.">
      <div className="mb-4">
        <Input placeholder="Search by action or operator…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="space-y-2 max-h-[60vh] overflow-y-auto">
        {filtered.map((a) => (
          <div key={a.id} className="rounded-lg border border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/40 px-4 py-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-gray-900 dark:text-slate-100">{a.action}</span>
              <span className="text-xs text-gray-500 dark:text-slate-400">{new Date(a.createdAt).toLocaleString()}</span>
            </div>
            <p className="mt-1 text-xs text-gray-500 dark:text-slate-400">Operator: {a.operatorId}</p>
            {a.reason && <p className="mt-0.5 text-xs text-gray-400 dark:text-slate-500">Reason: {a.reason}</p>}
          </div>
        ))}
        {filtered.length === 0 && <p className="text-xs text-gray-500 dark:text-slate-400 text-center py-8">No audit entries found.</p>}
      </div>
    </SectionCard>
  );
}

// ─── Tab: API Keys & Integrations ─────────────────────────────────────────────
function ApiKeysTab() {
  return (
    <div className="space-y-6">
      <SectionCard title="API Keys" description="Manage service account credentials for programmatic access.">
        <div className="rounded-lg border border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/40 px-4 py-6 text-center">
          <p className="text-sm text-gray-500 dark:text-slate-400">No API keys configured yet.</p>
          <PrimaryButton className="mt-3">Generate API Key</PrimaryButton>
        </div>
        <div className="mt-4 text-xs text-gray-500 dark:text-slate-400 space-y-1">
          <p>• API keys provide programmatic access to charger status, sessions, and analytics.</p>
          <p>• Keys are scoped to the organization and can be restricted by permission set.</p>
          <p>• Rotate keys regularly — revoked keys take effect immediately.</p>
        </div>
      </SectionCard>
      <SectionCard title="Webhooks" description="Configure outbound event notifications to external systems.">
        <div className="rounded-lg border border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/40 px-4 py-6 text-center">
          <p className="text-sm text-gray-500 dark:text-slate-400">No webhooks configured yet.</p>
          <SecondaryButton className="mt-3">Add Webhook</SecondaryButton>
        </div>
      </SectionCard>
      <SectionCard title="Third-Party Integrations" description="Connect external platforms (fleet management, energy providers, etc.).">
        <div className="rounded-lg border border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/40 px-4 py-6 text-center">
          <p className="text-sm text-gray-500 dark:text-slate-400">No integrations connected.</p>
          <SecondaryButton className="mt-3">Browse Integrations</SecondaryButton>
        </div>
      </SectionCard>
    </div>
  );
}

// ─── Tab: Billing & Remittance ────────────────────────────────────────────────
function BillingTab({ org, setOrg, onSave, valid }: {
  org: OrgDraft; setOrg: React.Dispatch<React.SetStateAction<OrgDraft>>; onSave: () => void; valid: boolean;
}) {
  const billingFields: Array<{ key: keyof OrgDraft; label: string; placeholder: string; type?: string }> = [
    { key: 'remittanceBankName', label: 'Bank Name', placeholder: 'First National Bank' },
    { key: 'remittanceAccountType', label: 'Account Type', placeholder: 'checking / savings' },
    { key: 'remittanceEmail', label: 'Remittance Contact Email', placeholder: 'finance@company.com' },
    { key: 'routingNumber', label: 'Routing Number', placeholder: '021000021' },
    { key: 'accountNumber', label: 'Account Number', placeholder: '••••••••1234', type: 'password' },
  ];

  return (
    <div className="space-y-6">
      <SectionCard title="ACH/EFT Remittance" description="Configure bank details for monthly payout processing.">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {billingFields.map(({ key, label, placeholder, type }) => (
            <FieldRow key={key} label={label}>
              <Input type={type} placeholder={placeholder} value={org[key]} onChange={(e) => setOrg((p) => ({ ...p, [key]: e.target.value }))} />
            </FieldRow>
          ))}
          <div className="md:col-span-2">
            <FieldRow label="Change Reason (required for audit)">
              <Input placeholder="Reason for update" value={org.reason} onChange={(e) => setOrg((p) => ({ ...p, reason: e.target.value }))} />
            </FieldRow>
          </div>
        </div>
        <div className="mt-4">
          <PrimaryButton disabled={!valid} onClick={onSave}>Save Remittance Details</PrimaryButton>
        </div>
      </SectionCard>
      <SectionCard title="Payout History" description="View past remittance payouts and invoice records.">
        <div className="rounded-lg border border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/40 px-4 py-6 text-center">
          <p className="text-sm text-gray-500 dark:text-slate-400">No payout records available yet.</p>
        </div>
      </SectionCard>
      <SectionCard title="Vendor Fee Configuration" description="View active software vendor fee applied to transactions.">
        <div className="rounded-lg border border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/40 px-4 py-6 text-center">
          <p className="text-sm text-gray-500 dark:text-slate-400">Vendor fee is configured at the site level in Site Detail → Pricing.</p>
        </div>
      </SectionCard>
    </div>
  );
}

// ─── Tab: Security ────────────────────────────────────────────────────────────
function SecurityTab() {
  return (
    <div className="space-y-6">
      <SectionCard title="Password Policy" description="Set requirements for user passwords across the organization.">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <FieldRow label="Minimum Length"><Input type="number" defaultValue="12" min="8" max="128" /></FieldRow>
          <FieldRow label="Expiry Period (days)"><Input type="number" defaultValue="90" min="0" placeholder="0 = never" /></FieldRow>
          <FieldRow label="Password History Depth"><Input type="number" defaultValue="5" min="0" placeholder="Prevent reuse of last N passwords" /></FieldRow>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-slate-300 cursor-pointer">
              <input type="checkbox" defaultChecked className="h-4 w-4 rounded border-gray-300 dark:border-slate-600 text-brand-600" />
              Require uppercase + lowercase + number + symbol
            </label>
          </div>
        </div>
        <div className="mt-4"><PrimaryButton>Save Password Policy</PrimaryButton></div>
      </SectionCard>

      <SectionCard title="Session Management" description="Control session behavior and concurrent login limits.">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <FieldRow label="Session Timeout (minutes)"><Input type="number" defaultValue="60" min="5" /></FieldRow>
          <FieldRow label="Max Concurrent Sessions"><Input type="number" defaultValue="3" min="1" /></FieldRow>
        </div>
        <div className="mt-4 flex gap-3">
          <PrimaryButton>Save Session Policy</PrimaryButton>
          <SecondaryButton className="text-red-600 dark:text-red-400 border-red-300 dark:border-red-700 hover:bg-red-50 dark:hover:bg-red-900/20">Force Logout All Users</SecondaryButton>
        </div>
      </SectionCard>

      <SectionCard title="MFA Enforcement" description="Multi-factor authentication policy for portal access.">
        <div className="space-y-3">
          {[
            { value: 'required', label: 'Required for all users', description: 'Every user must enroll in MFA before accessing the portal.' },
            { value: 'admin-only', label: 'Required for admin/owner roles only', description: 'MFA required for owner, operator, and admin roles. Optional for others.' },
            { value: 'optional', label: 'Optional (user choice)', description: 'Users can opt in to MFA from their profile settings.' },
          ].map((opt) => (
            <label key={opt.value} className="flex items-start gap-3 cursor-pointer rounded-lg border border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/40 px-4 py-3">
              <input type="radio" name="mfa-policy" defaultChecked={opt.value === 'optional'} className="mt-0.5 h-4 w-4 border-gray-300 dark:border-slate-600 text-brand-600" />
              <div>
                <p className="text-sm font-medium text-gray-900 dark:text-slate-100">{opt.label}</p>
                <p className="text-xs text-gray-500 dark:text-slate-400">{opt.description}</p>
              </div>
            </label>
          ))}
        </div>
        <div className="mt-4"><PrimaryButton>Save MFA Policy</PrimaryButton></div>
      </SectionCard>

      <SectionCard title="IP Allowlist" description="Restrict portal access to specific IP ranges (CIDR notation).">
        <div className="rounded-lg border border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/40 px-4 py-6 text-center">
          <p className="text-sm text-gray-500 dark:text-slate-400">No IP restrictions configured. All IPs are allowed.</p>
          <SecondaryButton className="mt-3">Add IP Range</SecondaryButton>
        </div>
        <p className="mt-3 text-xs text-gray-500 dark:text-slate-400">When enabled, only requests from listed IP ranges can access the portal.</p>
      </SectionCard>

      <SectionCard title="SSO / SAML Configuration" description="Configure enterprise single sign-on via SAML or OIDC federation.">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <FieldRow label="Identity Provider Entity ID"><Input placeholder="https://idp.company.com/saml/metadata" /></FieldRow>
          <FieldRow label="SSO Login URL"><Input placeholder="https://idp.company.com/saml/login" /></FieldRow>
          <FieldRow label="X.509 Certificate (PEM)">
            <textarea className="w-full rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-gray-900 dark:text-slate-100 placeholder-gray-400 dark:placeholder-slate-500 font-mono h-20 resize-y" placeholder="-----BEGIN CERTIFICATE-----&#10;..." />
          </FieldRow>
          <FieldRow label="Protocol">
            <select className="w-full rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-gray-900 dark:text-slate-100">
              <option value="saml">SAML 2.0</option>
              <option value="oidc">OpenID Connect</option>
            </select>
          </FieldRow>
        </div>
        <div className="mt-4"><PrimaryButton>Save SSO Configuration</PrimaryButton></div>
      </SectionCard>

      <SectionCard title="Login Activity" description="Recent authentication attempts across all portal users.">
        <div className="rounded-lg border border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/40 px-4 py-6 text-center">
          <p className="text-sm text-gray-500 dark:text-slate-400">Login activity tracking will appear here once available.</p>
        </div>
      </SectionCard>

      <SectionCard title="API Security" description="Token policies and rate limit visibility.">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <FieldRow label="Access Token Expiry (seconds)"><Input type="number" defaultValue="900" min="60" /></FieldRow>
          <FieldRow label="Refresh Token Expiry (seconds)"><Input type="number" defaultValue="86400" min="300" /></FieldRow>
        </div>
        <div className="mt-3 text-xs text-gray-500 dark:text-slate-400 space-y-1">
          <p>• Rate limiting: 100 req/min per authenticated user, 20/min for unauthenticated.</p>
          <p>• CORS origins restricted to configured portal domains only.</p>
          <p>• Auth failure lockout: 5 consecutive failures → 15 min block per IP+user bucket.</p>
        </div>
        <div className="mt-4"><PrimaryButton>Save Token Policy</PrimaryButton></div>
      </SectionCard>
    </div>
  );
}

// ─── Tab: Charger Models ──────────────────────────────────────────────────────
function ChargerModelsTab({ models, newModel, setNewModel, modelValid, onAdd, onToggle }: {
  models: ChargerModelCatalogItem[];
  newModel: { modelCode: string; vendor: string; displayName: string; maxKw: string; connectorType: string; reason: string };
  setNewModel: React.Dispatch<React.SetStateAction<typeof newModel>>;
  modelValid: boolean;
  onAdd: () => void;
  onToggle: (model: ChargerModelCatalogItem, isActive: boolean) => void;
}) {
  const [modelSearch, setModelSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<{ displayName: string; maxKw: string; connectorType: string } | null>(null);

  const filteredModels = models.filter((m) =>
    !modelSearch ||
    m.modelCode.toLowerCase().includes(modelSearch.toLowerCase()) ||
    m.vendor.toLowerCase().includes(modelSearch.toLowerCase()) ||
    m.displayName.toLowerCase().includes(modelSearch.toLowerCase()) ||
    m.connectorType.toLowerCase().includes(modelSearch.toLowerCase()),
  );

  function deriveType(kw: number): string {
    return kw > 22 ? 'DC' : 'AC';
  }

  function startEdit(m: ChargerModelCatalogItem) {
    setEditingId(m.id);
    setEditDraft({ displayName: m.displayName, maxKw: String(m.maxKw), connectorType: m.connectorType });
  }

  function cancelEdit() { setEditingId(null); setEditDraft(null); }

  async function saveEdit(m: ChargerModelCatalogItem) {
    if (!editDraft) return;
    window.alert(`Edit saved (display only): ${m.modelCode} → ${editDraft.displayName}, ${editDraft.maxKw} kW, ${editDraft.connectorType}`);
    cancelEdit();
  }

  return (
    <SectionCard
      title="Charger Models"
      description="Hardware catalog — make, model, power ratings, and connector types."
      actions={<PrimaryButton onClick={() => setShowCreate((v) => !v)}>+ Charger</PrimaryButton>}
    >
      {showCreate && (
        <div className="mb-6 rounded-lg border border-brand-200 dark:border-brand-700 bg-brand-50/30 dark:bg-brand-900/10 p-4">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-semibold text-gray-900 dark:text-slate-100">New Charger Model</h4>
            <button onClick={() => setShowCreate(false)} className="text-xs text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-200">Cancel</button>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <FieldRow label="Make / Vendor"><Input placeholder="LOOP" value={newModel.vendor} onChange={(e) => setNewModel((p) => ({ ...p, vendor: e.target.value }))} /></FieldRow>
            <FieldRow label="Model Code"><Input placeholder="EX-1762-1A32" value={newModel.modelCode} onChange={(e) => setNewModel((p) => ({ ...p, modelCode: e.target.value }))} /></FieldRow>
            <FieldRow label="Display Name"><Input placeholder="LOOP Level 2 AC" value={newModel.displayName} onChange={(e) => setNewModel((p) => ({ ...p, displayName: e.target.value }))} /></FieldRow>
            <FieldRow label="Max Power (kW)"><Input type="number" placeholder="7.2" value={newModel.maxKw} onChange={(e) => setNewModel((p) => ({ ...p, maxKw: e.target.value }))} /></FieldRow>
            <FieldRow label="Connector Type">
              <select className="w-full rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-gray-900 dark:text-slate-100" value={newModel.connectorType} onChange={(e) => setNewModel((p) => ({ ...p, connectorType: e.target.value }))}>
                <option value="NACS">NACS</option><option value="J1772">J1772</option><option value="CCS1">CCS1</option><option value="CCS2">CCS2</option><option value="CHAdeMO">CHAdeMO</option>
              </select>
            </FieldRow>
            <FieldRow label="Reason"><Input placeholder="Why adding this model?" value={newModel.reason} onChange={(e) => setNewModel((p) => ({ ...p, reason: e.target.value }))} /></FieldRow>
          </div>
          <div className="mt-3"><PrimaryButton disabled={!modelValid} onClick={() => { onAdd(); setShowCreate(false); }}>Add Charger Model</PrimaryButton></div>
        </div>
      )}

      <div className="mb-4">
        <Input placeholder="Search by make, model, name, or connector…" value={modelSearch} onChange={(e) => setModelSearch(e.target.value)} />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 dark:border-slate-800 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-slate-400">
              <th className="px-4 py-3">Make</th>
              <th className="px-4 py-3">Model</th>
              <th className="px-4 py-3">Power (kW)</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Connector</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50 dark:divide-slate-800">
            {filteredModels.map((m) => (
              <tr key={m.id} className="hover:bg-gray-50 dark:hover:bg-slate-800/40">
                {editingId === m.id && editDraft ? (
                  <>
                    <td className="px-4 py-3 text-gray-900 dark:text-slate-100 font-medium">{m.vendor}</td>
                    <td className="px-4 py-3 text-gray-700 dark:text-slate-300">{m.modelCode}</td>
                    <td className="px-4 py-3"><Input type="number" value={editDraft.maxKw} onChange={(e) => setEditDraft((p) => p ? { ...p, maxKw: e.target.value } : p)} className="w-20" /></td>
                    <td className="px-4 py-3 text-gray-700 dark:text-slate-300">{deriveType(Number(editDraft.maxKw))}</td>
                    <td className="px-4 py-3">
                      <select className="rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1 text-sm text-gray-900 dark:text-slate-100" value={editDraft.connectorType} onChange={(e) => setEditDraft((p) => p ? { ...p, connectorType: e.target.value } : p)}>
                        <option value="NACS">NACS</option><option value="J1772">J1772</option><option value="CCS1">CCS1</option><option value="CCS2">CCS2</option><option value="CHAdeMO">CHAdeMO</option>
                      </select>
                    </td>
                    <td className="px-4 py-3"></td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1">
                        <PrimaryButton onClick={() => saveEdit(m)} className="px-2 py-1 text-xs">Save</PrimaryButton>
                        <SecondaryButton onClick={cancelEdit} className="px-2 py-1 text-xs">Cancel</SecondaryButton>
                      </div>
                    </td>
                  </>
                ) : (
                  <>
                    <td className="px-4 py-3 font-medium text-gray-900 dark:text-slate-100">{m.vendor}</td>
                    <td className="px-4 py-3 text-gray-700 dark:text-slate-300">{m.modelCode}<br /><span className="text-xs text-gray-400 dark:text-slate-500">{m.displayName}</span></td>
                    <td className="px-4 py-3 text-gray-700 dark:text-slate-300">{m.maxKw}</td>
                    <td className="px-4 py-3"><span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', deriveType(m.maxKw) === 'DC' ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400' : 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400')}>{deriveType(m.maxKw)}</span></td>
                    <td className="px-4 py-3 text-gray-700 dark:text-slate-300">{m.connectorType}</td>
                    <td className="px-4 py-3"><span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', m.isActive ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400' : 'bg-gray-100 dark:bg-slate-800 text-gray-500 dark:text-slate-400')}>{m.isActive ? 'Active' : 'Inactive'}</span></td>
                    <td className="px-4 py-3"><SecondaryButton onClick={() => startEdit(m)} className="px-2 py-1 text-xs">Edit</SecondaryButton></td>
                  </>
                )}
              </tr>
            ))}
            {filteredModels.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-xs text-gray-500 dark:text-slate-400">No charger models found.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

// ─── Main Settings Page ───────────────────────────────────────────────────────
export default function Settings() {
  const getToken = useToken();
  const { theme, toggleTheme } = usePortalTheme();
  const { logoutPassword } = usePasswordAuth();
  const [activeTab, setActiveTab] = useState<TabId>('users');
  const [org, setOrg] = useState<OrgDraft>(EMPTY_ORG);
  const [notifications, setNotifications] = useState<OperatorNotificationPreference | null>(null);
  const [models, setModels] = useState<ChargerModelCatalogItem[]>([]);
  const [audit, setAudit] = useState<AdminAuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notifReason, setNotifReason] = useState('');
  const [newModel, setNewModel] = useState({ modelCode: '', vendor: '', displayName: '', maxKw: '150', connectorType: 'CCS1', reason: '' });

  const orgValid = useMemo(() => org.reason.trim().length > 2, [org.reason]);
  const notifValid = useMemo(() => notifReason.trim().length > 2, [notifReason]);
  const modelValid = useMemo(() => newModel.reason.trim().length > 2 && !!newModel.modelCode && !!newModel.vendor && !!newModel.displayName && !!newModel.connectorType, [newModel]);

  async function refresh() {
    try {
      setLoading(true);
      setError(null);
      const token = await getToken();
      const api = createApiClient(token);
      const [settingsRes, auditRes] = await Promise.allSettled([api.getAdminSettings(), api.listAdminAudit(40)]);
      const settingsBundle = settingsRes.status === 'fulfilled' ? settingsRes.value : { settings: null, notificationPreferences: null, chargerModels: [] };
      if (settingsRes.status === 'rejected') {
        const msg = settingsRes.reason instanceof Error ? settingsRes.reason.message : 'Failed to load settings';
        if (!/not found/i.test(msg)) setError(msg);
      }
      const auditItems = auditRes.status === 'fulfilled' ? auditRes.value : [];
      setNotifications(settingsBundle.notificationPreferences ?? { id: 'draft', operatorId: 'self', emailEnabled: true, smsEnabled: false, outageAlerts: true, billingAlerts: true, weeklyDigest: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      setModels(settingsBundle.chargerModels ?? []);
      setAudit((auditItems ?? []).filter((a) => typeof a?.action === 'string'));
      setOrg({
        organizationName: settingsBundle.settings?.organizationName ?? '', organizationDefaultSite: settingsBundle.settings?.organizationDefaultSite ?? '',
        organizationPortfolio: settingsBundle.settings?.organizationPortfolio ?? '', organizationBillingAddress: settingsBundle.settings?.organizationBillingAddress ?? '',
        supportContactEmail: settingsBundle.settings?.supportContactEmail ?? '', supportContactPhone: settingsBundle.settings?.supportContactPhone ?? '',
        profileDisplayName: settingsBundle.settings?.profileDisplayName ?? '', profileTimezone: settingsBundle.settings?.profileTimezone ?? 'America/Los_Angeles',
        remittanceBankName: settingsBundle.settings?.remittanceBankName ?? '', remittanceAccountType: settingsBundle.settings?.remittanceAccountType ?? 'checking',
        remittanceEmail: settingsBundle.settings?.remittanceEmail ?? '', routingNumber: settingsBundle.settings?.routingNumber ?? '',
        accountNumber: settingsBundle.settings?.accountNumber ?? '', reason: '',
      });
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to load settings'); }
    finally { setLoading(false); }
  }

  useEffect(() => { refresh(); }, []);

  async function saveOrg() {
    try { const token = await getToken(); await createApiClient(token).updateOrgProfileSettings(org); window.alert('Settings saved.'); await refresh(); }
    catch (err) { window.alert(err instanceof Error ? err.message : 'Failed to save'); }
  }

  async function saveNotifications() {
    if (!notifications) return;
    try { const token = await getToken(); await createApiClient(token).updateNotificationSettings({ ...notifications, reason: notifReason }); setNotifReason(''); window.alert('Notification preferences updated.'); await refresh(); }
    catch (err) { window.alert(err instanceof Error ? err.message : 'Failed to save notifications'); }
  }

  async function addModel() {
    try { const token = await getToken(); await createApiClient(token).createChargerModelCatalogItem({ modelCode: newModel.modelCode.trim(), vendor: newModel.vendor.trim(), displayName: newModel.displayName.trim(), connectorType: newModel.connectorType.trim(), maxKw: Number(newModel.maxKw), reason: newModel.reason.trim() }); setNewModel({ modelCode: '', vendor: '', displayName: '', maxKw: '150', connectorType: 'CCS1', reason: '' }); await refresh(); }
    catch (err) { window.alert(err instanceof Error ? err.message : 'Failed to add model'); }
  }

  async function toggleModel(model: ChargerModelCatalogItem, isActive: boolean) {
    const reason = window.prompt(`Reason for ${isActive ? 'activating' : 'deactivating'} ${model.modelCode}`)?.trim();
    if (!reason) return;
    try { const token = await getToken(); await createApiClient(token).toggleChargerModelCatalogItem(model.id, { isActive, reason }); await refresh(); }
    catch (err) { window.alert(err instanceof Error ? err.message : 'Failed to toggle model'); }
  }

  function handleLogout() {
    logoutPassword();
    if (typeof window !== 'undefined') { window.sessionStorage.removeItem('portal.dev.signedIn'); window.location.assign('/login'); }
  }

  if (loading) return <div className="flex h-64 items-center justify-center text-sm text-gray-500 dark:text-slate-400">Loading admin…</div>;

  return (
    <div className="space-y-4" data-theme-surface={theme}>
      {/* Header with theme toggle + logout */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-slate-400">
            <a href="/overview" className="hover:text-gray-700 dark:hover:text-slate-200 dark:text-slate-300">Overview</a>
            <span>/</span>
            <span className="text-gray-900 dark:text-slate-100">Admin</span>
          </div>
          <h1 className="mt-1 text-2xl font-bold text-gray-900 dark:text-slate-100">Admin</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">Manage users, organizations, security, billing, and system configuration.</p>
          {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggleTheme}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition',
              theme === 'dark'
                ? 'border-gray-600 bg-gray-800 text-gray-100 hover:bg-gray-700'
                : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-100',
            )}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            data-theme-toggle="settings-header"
          >
            {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
            <span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
          </button>
          <button
            type="button"
            onClick={handleLogout}
            className="inline-flex items-center gap-1.5 rounded-md border border-red-300 dark:border-red-700 bg-white dark:bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition"
          >
            Log Out
          </button>
        </div>
      </div>

      {/* Top tab bar — shared component */}
      <TabBar tabs={ADMIN_TABS.map((t) => ({ id: t.id, label: t.label }))} activeTab={activeTab} onChange={(id) => setActiveTab(id as TabId)} />

      {/* Tab content */}
      {activeTab === 'users' && <UsersTab />}
      {activeTab === 'organizations' && <OrganizationsTab org={org} setOrg={setOrg} onSave={saveOrg} valid={orgValid} />}
      {activeTab === 'notifications' && <NotificationsTab notifications={notifications} setNotifications={setNotifications} reason={notifReason} setReason={setNotifReason} onSave={saveNotifications} valid={notifValid} />}
      {activeTab === 'audit' && <AuditTab audit={audit} />}
      {activeTab === 'api' && <ApiKeysTab />}
      {activeTab === 'billing' && <BillingTab org={org} setOrg={setOrg} onSave={saveOrg} valid={orgValid} />}
      {activeTab === 'security' && <SecurityTab />}
      {activeTab === 'charger-models' && <ChargerModelsTab models={models} newModel={newModel} setNewModel={setNewModel} modelValid={modelValid} onAdd={addModel} onToggle={toggleModel} />}
    </div>
  );
}
