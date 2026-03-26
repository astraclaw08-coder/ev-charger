import { useEffect, useMemo, useState } from 'react';
import { createApiClient, type AdminAuditEvent, type ChargerModelCatalogItem, type OperatorNotificationPreference, type PortalSettings } from '../api/client';
import { useToken } from '../auth/TokenContext';
import UserManagement from './UserManagement';
import SiteRoleAssignment from './SiteRoleAssignment';
import { cn } from '../lib/utils';
import { usePortalTheme } from '../theme/ThemeContext';
import { usePasswordAuth } from '../auth/PasswordAuthContext';
import { getDefaultHomePath, getRolePreference, setRolePreference, type PortalRolePreference } from '../lib/portalPreferences';

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
  { id: 'users', label: 'Users & Permissions', icon: '👥' },
  { id: 'organizations', label: 'Organizations', icon: '🏢' },
  { id: 'notifications', label: 'Notifications', icon: '🔔' },
  { id: 'audit', label: 'Audit Log', icon: '📋' },
  { id: 'api', label: 'API Keys & Integrations', icon: '🔑' },
  { id: 'billing', label: 'Billing & Remittance', icon: '💳' },
  { id: 'security', label: 'Security', icon: '🛡️' },
  { id: 'charger-models', label: 'Charger Models', icon: '🔌' },
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
function SectionCard({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-sm">
      <div className="border-b border-gray-200 dark:border-slate-700 px-6 py-4">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-slate-100">{title}</h3>
        {description && <p className="mt-0.5 text-xs text-gray-500 dark:text-slate-400">{description}</p>}
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
    <button
      {...props}
      className={cn('rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50', props.className)}
    />
  );
}

function SecondaryButton({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={cn('rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm font-medium text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700 disabled:opacity-50', props.className)}
    />
  );
}

// ─── Tab: Users & Permissions ─────────────────────────────────────────────────
function UsersTab() {
  return (
    <div className="space-y-6">
      <SectionCard title="User Management" description="Add, edit, and manage user accounts and credentials.">
        <UserManagement />
      </SectionCard>
      <SectionCard title="Site Role Assignments" description="Assign or remove stackable per-site roles across all sites.">
        <SiteRoleAssignment />
      </SectionCard>
    </div>
  );
}

// ─── Tab: Organizations ───────────────────────────────────────────────────────
function OrganizationsTab({ org, setOrg, onSave, valid }: {
  org: OrgDraft; setOrg: React.Dispatch<React.SetStateAction<OrgDraft>>; onSave: () => void; valid: boolean;
}) {
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
    <SectionCard title="Organization Profile" description="Manage organization details, portfolio assignments, and contact information.">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {orgFields.map(({ key, label, placeholder }) => (
          <FieldRow key={key} label={label}>
            <Input placeholder={placeholder} value={org[key]} onChange={(e) => setOrg((p) => ({ ...p, [key]: e.target.value }))} />
          </FieldRow>
        ))}
        <div className="md:col-span-2">
          <FieldRow label="Change Reason (required for audit)">
            <Input placeholder="Reason for update" value={org.reason} onChange={(e) => setOrg((p) => ({ ...p, reason: e.target.value }))} />
          </FieldRow>
        </div>
      </div>
      <div className="mt-4">
        <PrimaryButton disabled={!valid} onClick={onSave}>Save Organization</PrimaryButton>
      </div>
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
        <div className="space-y-4">
          <div className="rounded-lg border border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/40 px-4 py-6 text-center">
            <p className="text-sm text-gray-500 dark:text-slate-400">No API keys configured yet.</p>
            <PrimaryButton className="mt-3">Generate API Key</PrimaryButton>
          </div>
          <div className="text-xs text-gray-500 dark:text-slate-400 space-y-1">
            <p>• API keys provide programmatic access to charger status, sessions, and analytics.</p>
            <p>• Keys are scoped to the organization and can be restricted by permission set.</p>
            <p>• Rotate keys regularly — revoked keys take effect immediately.</p>
          </div>
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
          <FieldRow label="Minimum Length">
            <Input type="number" defaultValue="12" min="8" max="128" />
          </FieldRow>
          <FieldRow label="Expiry Period (days)">
            <Input type="number" defaultValue="90" min="0" placeholder="0 = never" />
          </FieldRow>
          <FieldRow label="Password History Depth">
            <Input type="number" defaultValue="5" min="0" placeholder="Prevent reuse of last N passwords" />
          </FieldRow>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-slate-300 cursor-pointer">
              <input type="checkbox" defaultChecked className="h-4 w-4 rounded border-gray-300 dark:border-slate-600 text-brand-600" />
              Require uppercase + lowercase + number + symbol
            </label>
          </div>
        </div>
        <div className="mt-4">
          <PrimaryButton>Save Password Policy</PrimaryButton>
        </div>
      </SectionCard>

      <SectionCard title="Session Management" description="Control session behavior and concurrent login limits.">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <FieldRow label="Session Timeout (minutes)">
            <Input type="number" defaultValue="60" min="5" />
          </FieldRow>
          <FieldRow label="Max Concurrent Sessions">
            <Input type="number" defaultValue="3" min="1" />
          </FieldRow>
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
        <div className="mt-4">
          <PrimaryButton>Save MFA Policy</PrimaryButton>
        </div>
      </SectionCard>

      <SectionCard title="IP Allowlist" description="Restrict portal access to specific IP ranges (CIDR notation).">
        <div className="space-y-3">
          <div className="rounded-lg border border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/40 px-4 py-6 text-center">
            <p className="text-sm text-gray-500 dark:text-slate-400">No IP restrictions configured. All IPs are allowed.</p>
            <SecondaryButton className="mt-3">Add IP Range</SecondaryButton>
          </div>
          <p className="text-xs text-gray-500 dark:text-slate-400">
            When enabled, only requests from listed IP ranges can access the portal. API keys follow the same restrictions.
          </p>
        </div>
      </SectionCard>

      <SectionCard title="SSO / SAML Configuration" description="Configure enterprise single sign-on via SAML or OIDC federation.">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <FieldRow label="Identity Provider (IdP) Entity ID">
            <Input placeholder="https://idp.company.com/saml/metadata" />
          </FieldRow>
          <FieldRow label="SSO Login URL">
            <Input placeholder="https://idp.company.com/saml/login" />
          </FieldRow>
          <FieldRow label="X.509 Certificate (PEM)">
            <textarea
              className="w-full rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-gray-900 dark:text-slate-100 placeholder-gray-400 dark:placeholder-slate-500 font-mono h-20 resize-y"
              placeholder="-----BEGIN CERTIFICATE-----\n..."
            />
          </FieldRow>
          <FieldRow label="Protocol">
            <select className="w-full rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-gray-900 dark:text-slate-100">
              <option value="saml">SAML 2.0</option>
              <option value="oidc">OpenID Connect</option>
            </select>
          </FieldRow>
        </div>
        <div className="mt-4">
          <PrimaryButton>Save SSO Configuration</PrimaryButton>
        </div>
      </SectionCard>

      <SectionCard title="Login Activity" description="Recent authentication attempts across all portal users.">
        <div className="rounded-lg border border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/40 px-4 py-6 text-center">
          <p className="text-sm text-gray-500 dark:text-slate-400">Login activity tracking will appear here once available.</p>
        </div>
      </SectionCard>

      <SectionCard title="API Security" description="Token policies and rate limit visibility.">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <FieldRow label="Access Token Expiry (seconds)">
            <Input type="number" defaultValue="900" min="60" />
          </FieldRow>
          <FieldRow label="Refresh Token Expiry (seconds)">
            <Input type="number" defaultValue="86400" min="300" />
          </FieldRow>
        </div>
        <div className="mt-3 text-xs text-gray-500 dark:text-slate-400 space-y-1">
          <p>• Rate limiting: 100 requests/min per authenticated user, 20/min for unauthenticated endpoints.</p>
          <p>• CORS origins are restricted to configured portal domains only.</p>
          <p>• Auth failure lockout: 5 consecutive failures → 15 min block per IP+user bucket.</p>
        </div>
        <div className="mt-4">
          <PrimaryButton>Save Token Policy</PrimaryButton>
        </div>
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
  return (
    <SectionCard title="Charger Model Catalog" description="Registry of supported charger hardware models, power ratings, and connector types.">
      <div className="mb-6">
        <h4 className="text-xs font-semibold text-gray-700 dark:text-slate-300 mb-3 uppercase tracking-wide">Add New Model</h4>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <FieldRow label="Model Code"><Input placeholder="EX-1762-1A32" value={newModel.modelCode} onChange={(e) => setNewModel((p) => ({ ...p, modelCode: e.target.value }))} /></FieldRow>
          <FieldRow label="Vendor"><Input placeholder="LOOP" value={newModel.vendor} onChange={(e) => setNewModel((p) => ({ ...p, vendor: e.target.value }))} /></FieldRow>
          <FieldRow label="Display Name"><Input placeholder="LOOP Level 2 AC" value={newModel.displayName} onChange={(e) => setNewModel((p) => ({ ...p, displayName: e.target.value }))} /></FieldRow>
          <FieldRow label="Max Power (kW)"><Input type="number" placeholder="7.2" value={newModel.maxKw} onChange={(e) => setNewModel((p) => ({ ...p, maxKw: e.target.value }))} /></FieldRow>
          <FieldRow label="Connector Type">
            <select
              className="w-full rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-gray-900 dark:text-slate-100"
              value={newModel.connectorType}
              onChange={(e) => setNewModel((p) => ({ ...p, connectorType: e.target.value }))}
            >
              <option value="NACS">NACS</option>
              <option value="J1772">J1772</option>
              <option value="CCS1">CCS1</option>
              <option value="CCS2">CCS2</option>
              <option value="CHAdeMO">CHAdeMO</option>
            </select>
          </FieldRow>
          <FieldRow label="Reason"><Input placeholder="Why adding this model?" value={newModel.reason} onChange={(e) => setNewModel((p) => ({ ...p, reason: e.target.value }))} /></FieldRow>
        </div>
        <div className="mt-3">
          <PrimaryButton disabled={!modelValid} onClick={onAdd}>Add Model</PrimaryButton>
        </div>
      </div>

      <div className="border-t border-gray-100 dark:border-slate-800 pt-4">
        <h4 className="text-xs font-semibold text-gray-700 dark:text-slate-300 mb-3 uppercase tracking-wide">Registered Models</h4>
        {models.length === 0 ? (
          <p className="text-xs text-gray-500 dark:text-slate-400 text-center py-6">No charger models registered yet.</p>
        ) : (
          <div className="space-y-2">
            {models.map((m) => (
              <div key={m.id} className="flex items-center justify-between rounded-lg border border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/40 px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-gray-900 dark:text-slate-100">{m.vendor} · {m.modelCode}</p>
                  <p className="text-xs text-gray-500 dark:text-slate-400">{m.displayName} · {m.maxKw} kW · {m.connectorType}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', m.isActive ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400' : 'bg-gray-100 dark:bg-slate-800 text-gray-500 dark:text-slate-400')}>
                    {m.isActive ? 'Active' : 'Inactive'}
                  </span>
                  <SecondaryButton onClick={() => onToggle(m, !m.isActive)}>
                    {m.isActive ? 'Deactivate' : 'Activate'}
                  </SecondaryButton>
                </div>
              </div>
            ))}
          </div>
        )}
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
  const [rolePref, setRolePref] = useState<PortalRolePreference>(() => getRolePreference());

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

      setNotifications(settingsBundle.notificationPreferences ?? {
        id: 'draft', operatorId: 'self', emailEnabled: true, smsEnabled: false, outageAlerts: true, billingAlerts: true, weeklyDigest: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      setModels(settingsBundle.chargerModels ?? []);
      setAudit((auditItems ?? []).filter((a) => typeof a?.action === 'string'));
      setOrg({
        organizationName: settingsBundle.settings?.organizationName ?? '',
        organizationDefaultSite: settingsBundle.settings?.organizationDefaultSite ?? '',
        organizationPortfolio: settingsBundle.settings?.organizationPortfolio ?? '',
        organizationBillingAddress: settingsBundle.settings?.organizationBillingAddress ?? '',
        supportContactEmail: settingsBundle.settings?.supportContactEmail ?? '',
        supportContactPhone: settingsBundle.settings?.supportContactPhone ?? '',
        profileDisplayName: settingsBundle.settings?.profileDisplayName ?? '',
        profileTimezone: settingsBundle.settings?.profileTimezone ?? 'America/Los_Angeles',
        remittanceBankName: settingsBundle.settings?.remittanceBankName ?? '',
        remittanceAccountType: settingsBundle.settings?.remittanceAccountType ?? 'checking',
        remittanceEmail: settingsBundle.settings?.remittanceEmail ?? '',
        routingNumber: settingsBundle.settings?.routingNumber ?? '',
        accountNumber: settingsBundle.settings?.accountNumber ?? '',
        reason: '',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); }, []);

  async function saveOrg() {
    try {
      const token = await getToken();
      await createApiClient(token).updateOrgProfileSettings(org);
      window.alert('Settings saved.');
      await refresh();
    } catch (err) { window.alert(err instanceof Error ? err.message : 'Failed to save'); }
  }

  async function saveNotifications() {
    if (!notifications) return;
    try {
      const token = await getToken();
      await createApiClient(token).updateNotificationSettings({ ...notifications, reason: notifReason });
      setNotifReason('');
      window.alert('Notification preferences updated.');
      await refresh();
    } catch (err) { window.alert(err instanceof Error ? err.message : 'Failed to save notifications'); }
  }

  async function addModel() {
    try {
      const token = await getToken();
      await createApiClient(token).createChargerModelCatalogItem({
        modelCode: newModel.modelCode.trim(), vendor: newModel.vendor.trim(), displayName: newModel.displayName.trim(),
        connectorType: newModel.connectorType.trim(), maxKw: Number(newModel.maxKw), reason: newModel.reason.trim(),
      });
      setNewModel({ modelCode: '', vendor: '', displayName: '', maxKw: '150', connectorType: 'CCS1', reason: '' });
      await refresh();
    } catch (err) { window.alert(err instanceof Error ? err.message : 'Failed to add model'); }
  }

  async function toggleModel(model: ChargerModelCatalogItem, isActive: boolean) {
    const reason = window.prompt(`Reason for ${isActive ? 'activating' : 'deactivating'} ${model.modelCode}`)?.trim();
    if (!reason) return;
    try {
      const token = await getToken();
      await createApiClient(token).toggleChargerModelCatalogItem(model.id, { isActive, reason });
      await refresh();
    } catch (err) { window.alert(err instanceof Error ? err.message : 'Failed to toggle model'); }
  }

  function handleLogout() {
    logoutPassword();
    if (typeof window !== 'undefined') {
      window.sessionStorage.removeItem('portal.dev.signedIn');
      window.location.assign('/login');
    }
  }

  if (loading) return <div className="flex h-64 items-center justify-center text-sm text-gray-500 dark:text-slate-400">Loading admin…</div>;

  return (
    <div className="flex flex-col lg:flex-row gap-6">
      {/* Sidebar tab navigation */}
      <aside className="lg:w-56 flex-shrink-0">
        <div className="sticky top-6 space-y-1">
          <div className="flex items-center justify-between mb-4">
            <h1 className="text-lg font-bold text-gray-900 dark:text-slate-100">Admin</h1>
            <button
              type="button"
              onClick={toggleTheme}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition',
                theme === 'dark'
                  ? 'border-gray-600 bg-gray-800 text-gray-100 hover:bg-gray-700'
                  : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-100',
              )}
              title={theme === 'dark' ? 'Dark theme' : 'Light theme'}
            >
              {theme === 'dark' ? <MoonIcon /> : <SunIcon />}
            </button>
          </div>

          {ADMIN_TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium transition',
                activeTab === tab.id
                  ? 'bg-brand-50 dark:bg-brand-900/20 text-brand-700 dark:text-brand-300 border border-brand-200 dark:border-brand-700'
                  : 'text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800 hover:text-gray-900 dark:hover:text-slate-100',
              )}
            >
              <span className="text-base">{tab.icon}</span>
              <span>{tab.label}</span>
            </button>
          ))}

          {/* Workspace defaults */}
          <div className="mt-6 pt-4 border-t border-gray-200 dark:border-slate-700">
            <label className="text-xs font-medium text-gray-500 dark:text-slate-400">
              Default landing page
              <select
                className="mt-1 w-full rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1.5 text-xs text-gray-900 dark:text-slate-100"
                value={rolePref}
                onChange={(e) => { const next = e.target.value as PortalRolePreference; setRolePref(next); setRolePreference(next); }}
              >
                <option value="executive">Executive (Overview)</option>
                <option value="operations">Operations</option>
                <option value="finance">Finance (Analytics)</option>
                <option value="field">Field Team (Chargers)</option>
                <option value="admin">Admin (Settings)</option>
              </select>
            </label>
          </div>

          {/* Session / Logout */}
          <div className="mt-4 pt-4 border-t border-gray-200 dark:border-slate-700">
            <button
              type="button"
              onClick={handleLogout}
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition"
            >
              <span className="text-base">🚪</span>
              <span>Log Out</span>
            </button>
          </div>

          {error && <p className="mt-3 text-xs text-red-600 dark:text-red-400">{error}</p>}
        </div>
      </aside>

      {/* Tab content */}
      <main className="flex-1 min-w-0">
        {activeTab === 'users' && <UsersTab />}
        {activeTab === 'organizations' && <OrganizationsTab org={org} setOrg={setOrg} onSave={saveOrg} valid={orgValid} />}
        {activeTab === 'notifications' && <NotificationsTab notifications={notifications} setNotifications={setNotifications} reason={notifReason} setReason={setNotifReason} onSave={saveNotifications} valid={notifValid} />}
        {activeTab === 'audit' && <AuditTab audit={audit} />}
        {activeTab === 'api' && <ApiKeysTab />}
        {activeTab === 'billing' && <BillingTab org={org} setOrg={setOrg} onSave={saveOrg} valid={orgValid} />}
        {activeTab === 'security' && <SecurityTab />}
        {activeTab === 'charger-models' && <ChargerModelsTab models={models} newModel={newModel} setNewModel={setNewModel} modelValid={modelValid} onAdd={addModel} onToggle={toggleModel} />}
      </main>
    </div>
  );
}
