import { useEffect, useMemo, useState } from 'react';
import { createApiClient, type AdminAuditEvent, type ChargerModelCatalogItem, type OperatorNotificationPreference, type PortalSettings } from '../api/client';
import { useToken } from '../auth/TokenContext';
import UserManagement from './UserManagement';
import SiteRoleAssignment from './SiteRoleAssignment';
import { cn } from '../lib/utils';
import { usePortalTheme } from '../theme/ThemeContext';

type OrgDraft = {
  organizationName: string;
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

export default function Settings() {
  const getToken = useToken();
  const { theme, toggleTheme } = usePortalTheme();
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
  const modelValid = useMemo(() => newModel.reason.trim().length > 2 && newModel.modelCode && newModel.vendor && newModel.displayName && newModel.connectorType, [newModel]);

  async function refresh() {
    try {
      setLoading(true);
      setError(null);
      const token = await getToken();
      const api = createApiClient(token);
      const [settingsRes, auditRes] = await Promise.allSettled([api.getAdminSettings(), api.listAdminAudit(40)]);

      const settingsBundle = settingsRes.status === 'fulfilled'
        ? settingsRes.value
        : { settings: null, notificationPreferences: null, chargerModels: [] };

      if (settingsRes.status === 'rejected') {
        const msg = settingsRes.reason instanceof Error ? settingsRes.reason.message : 'Failed to load settings';
        if (!/not found/i.test(msg)) {
          setError(msg);
        }
      }

      const auditItems = auditRes.status === 'fulfilled' ? auditRes.value : [];

      setNotifications(settingsBundle.notificationPreferences ?? {
        id: 'draft', operatorId: 'self', emailEnabled: true, smsEnabled: false, outageAlerts: true, billingAlerts: true, weeklyDigest: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      setModels(settingsBundle.chargerModels ?? []);
      setAudit((auditItems ?? []).filter((a) => typeof a?.action === 'string' && a.action.startsWith('admin.settings.')));
      setOrg({
        organizationName: settingsBundle.settings?.organizationName ?? '',
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

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveOrg() {
    try {
      const token = await getToken();
      const api = createApiClient(token);
      await api.updateOrgProfileSettings(org);
      window.alert('Organization/profile/remittance settings updated.');
      await refresh();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Failed to save');
    }
  }

  async function saveNotifications() {
    if (!notifications) return;
    try {
      const token = await getToken();
      const api = createApiClient(token);
      await api.updateNotificationSettings({ ...notifications, reason: notifReason });
      setNotifReason('');
      window.alert('Notification preferences updated.');
      await refresh();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Failed to save notifications');
    }
  }

  async function addModel() {
    try {
      const token = await getToken();
      const api = createApiClient(token);
      await api.createChargerModelCatalogItem({
        modelCode: newModel.modelCode.trim(),
        vendor: newModel.vendor.trim(),
        displayName: newModel.displayName.trim(),
        connectorType: newModel.connectorType.trim(),
        maxKw: Number(newModel.maxKw),
        reason: newModel.reason.trim(),
      });
      setNewModel({ modelCode: '', vendor: '', displayName: '', maxKw: '150', connectorType: 'CCS1', reason: '' });
      await refresh();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Failed to add model');
    }
  }

  async function toggleModel(model: ChargerModelCatalogItem, isActive: boolean) {
    const reason = window.prompt(`Reason for ${isActive ? 'activating' : 'deactivating'} ${model.modelCode}`)?.trim();
    if (!reason) return;
    try {
      const token = await getToken();
      const api = createApiClient(token);
      await api.toggleChargerModelCatalogItem(model.id, { isActive, reason });
      await refresh();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Failed to toggle model');
    }
  }

  if (loading) return <div className="text-sm text-gray-500">Loading settings…</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Settings</h1>
          <p className="text-sm text-gray-500">RBAC-gated admin settings with reason-required, audit-friendly updates.</p>
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        </div>
        <button
          type="button"
          onClick={toggleTheme}
          className={cn(
            'inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-1',
            theme === 'dark'
              ? 'border-gray-600 bg-gray-800 text-gray-100 hover:bg-gray-700 hover:text-white'
              : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-100 hover:text-gray-900',
          )}
          aria-label={theme === 'dark' ? 'Dark theme active' : 'Light theme active'}
          title={theme === 'dark' ? 'Dark theme active' : 'Light theme active'}
        >
          {theme === 'dark' ? <MoonIcon /> : <SunIcon />}
          <span>{theme === 'dark' ? 'Dark' : 'Light'}</span>
        </button>
      </div>

      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-gray-700">Organization / user profile + ACH/EFT remittance</h2>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {Object.entries(org).filter(([k]) => k !== 'reason').map(([key, value]) => (
            <input key={key} className="rounded border px-3 py-2 text-sm" placeholder={key} value={value} onChange={(e) => setOrg((p) => ({ ...p, [key]: e.target.value }))} />
          ))}
          <input className="rounded border px-3 py-2 text-sm md:col-span-2" placeholder="Change reason (required for audit)" value={org.reason} onChange={(e) => setOrg((p) => ({ ...p, reason: e.target.value }))} />
        </div>
        <button className="mt-3 rounded bg-brand-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-60" disabled={!orgValid} onClick={saveOrg}>Save org/profile/remittance</button>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-gray-700">Notification preferences</h2>
        {notifications && (
          <div className="space-y-2 text-sm">
            {(['emailEnabled', 'smsEnabled', 'outageAlerts', 'billingAlerts', 'weeklyDigest'] as const).map((k) => (
              <label key={k} className="flex items-center gap-2">
                <input type="checkbox" checked={!!notifications[k]} onChange={(e) => setNotifications((p) => p ? ({ ...p, [k]: e.target.checked }) : p)} />
                <span>{k}</span>
              </label>
            ))}
            <input className="mt-2 w-full rounded border px-3 py-2 text-sm" placeholder="Change reason (required)" value={notifReason} onChange={(e) => setNotifReason(e.target.value)} />
            <button className="rounded border px-3 py-2 text-sm disabled:opacity-60" disabled={!notifValid} onClick={saveNotifications}>Save notification preferences</button>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-gray-700">Charger model catalog</h2>
        <div className="mb-3 grid grid-cols-1 gap-2 md:grid-cols-6">
          <input className="rounded border px-2 py-1 text-sm" placeholder="modelCode" value={newModel.modelCode} onChange={(e) => setNewModel((p) => ({ ...p, modelCode: e.target.value }))} />
          <input className="rounded border px-2 py-1 text-sm" placeholder="vendor" value={newModel.vendor} onChange={(e) => setNewModel((p) => ({ ...p, vendor: e.target.value }))} />
          <input className="rounded border px-2 py-1 text-sm" placeholder="displayName" value={newModel.displayName} onChange={(e) => setNewModel((p) => ({ ...p, displayName: e.target.value }))} />
          <input className="rounded border px-2 py-1 text-sm" placeholder="maxKw" value={newModel.maxKw} onChange={(e) => setNewModel((p) => ({ ...p, maxKw: e.target.value }))} />
          <input className="rounded border px-2 py-1 text-sm" placeholder="connectorType" value={newModel.connectorType} onChange={(e) => setNewModel((p) => ({ ...p, connectorType: e.target.value }))} />
          <input className="rounded border px-2 py-1 text-sm" placeholder="reason" value={newModel.reason} onChange={(e) => setNewModel((p) => ({ ...p, reason: e.target.value }))} />
        </div>
        <button className="mb-3 rounded border px-3 py-2 text-sm disabled:opacity-60" disabled={!modelValid} onClick={addModel}>Add catalog model</button>
        <div className="space-y-2">
          {models.map((m) => (
            <div key={m.id} className="flex items-center justify-between rounded border border-gray-100 p-2 text-sm">
              <div>{m.vendor} · {m.modelCode} · {m.displayName} · {m.maxKw}kW · {m.connectorType}</div>
              <button className="rounded border px-2 py-1 text-xs" onClick={() => toggleModel(m, !m.isActive)}>{m.isActive ? 'Deactivate' : 'Activate'}</button>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-gray-700">User management</h2>
        <UserManagement />
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="mb-1 text-sm font-semibold text-gray-700">Site role assignments</h2>
        <p className="mb-3 text-xs text-gray-500">Assign or remove stackable per-site roles across all sites.</p>
        <SiteRoleAssignment />
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-gray-700">Settings audit evidence</h2>
        <div className="space-y-2">
          {audit.map((a) => (
            <div key={a.id} className="rounded border border-gray-100 p-2 text-xs text-gray-600">
              <div>{new Date(a.createdAt).toLocaleString()} · <span className="font-medium">{a.action}</span></div>
              <div>operator={a.operatorId}</div>
            </div>
          ))}
          {audit.length === 0 && <p className="text-xs text-gray-500">No settings updates yet.</p>}
        </div>
      </section>
    </div>
  );
}
