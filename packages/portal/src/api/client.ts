// ─── Types ───────────────────────────────────────────────────────────────────

export interface SiteListItem {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  pricingMode?: 'flat' | 'tou';
  pricePerKwhUsd?: number;
  idleFeePerMinUsd?: number;
  activationFeeUsd?: number;
  gracePeriodMin?: number;
  touWindows?: unknown;
  organizationName?: string | null;
  portfolioName?: string | null;
  createdAt: string;
  chargerCount: number;
  statusSummary: { online: number; offline: number; faulted: number };
}

export interface ConnectorInfo {
  id: string;
  connectorId: number;
  status: string;
  chargerId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChargerInfo {
  id: string;
  ocppId: string;
  serialNumber: string;
  model: string;
  vendor: string;
  status: 'ONLINE' | 'OFFLINE' | 'FAULTED' | 'DEGRADED';
  lastHeartbeat: string | null;
  siteId: string;
  connectors: ConnectorInfo[];
  createdAt: string;
  updatedAt: string;
}

export interface ChargerListItem extends ChargerInfo {
  site: { id: string; name: string; address: string; lat: number; lng: number };
}

export interface SiteDetail {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  pricingMode?: 'flat' | 'tou';
  pricePerKwhUsd?: number;
  idleFeePerMinUsd?: number;
  activationFeeUsd?: number;
  gracePeriodMin?: number;
  touWindows?: unknown;
  organizationName?: string | null;
  portfolioName?: string | null;
  createdAt: string;
  chargers: ChargerInfo[];
}

export interface DailyEntry {
  date: string;
  sessions: number;
  kwhDelivered: number;
  revenueCents: number;
}

export interface Analytics {
  siteId: string;
  siteName: string;
  periodDays: number;
  sessionsCount: number;
  kwhDelivered: number;
  revenueCents: number;
  revenueUsd: number;
  uptimePct: number;
  activeChargingSeconds: number;
  availableConnectorSeconds: number;
  utilizationRatePct: number;
  daily: DailyEntry[];
}

export interface ActiveSession {
  id: string;
  idTag: string;
  startedAt: string;
  user?: { id: string; name: string | null; email: string };
}

export interface ConnectorStatus {
  connectorId: number;
  status: string;
  activeSession: ActiveSession | null;
}

export interface ChargerStatus {
  id: string;
  ocppId: string;
  status: string;
  lastHeartbeat: string | null;
  connectors: ConnectorStatus[];
}

export interface SessionRecord {
  id: string;
  transactionId: number | null;
  startedAt: string;
  stoppedAt: string | null;
  status: string;
  kwhDelivered: number | null;
  ratePerKwh: number | null;
  idTag: string;
  connector: { connectorId: number };
  user: { name: string | null; email: string } | null;
  payment: { status: string; amountCents: number | null } | null;
  effectiveAmountCents?: number | null;
}

export interface CreatedCharger {
  id: string;
  ocppId: string;
  serialNumber: string;
  ocppEndpoint: string;
  password: string;
}

export interface PortfolioSummarySite {
  siteId: string;
  siteName: string;
  organizationName: string | null;
  portfolioName: string | null;
  sessionsCount: number;
  totalEnergyKwh: number;
  totalRevenueUsd: number;
}

export interface PortfolioSummaryOrganization {
  organizationName: string;
  siteCount: number;
  sessionsCount: number;
  totalEnergyKwh: number;
  totalRevenueUsd: number;
  portfolios: Array<{
    portfolioName: string;
    siteCount: number;
    sessionsCount: number;
    totalEnergyKwh: number;
    totalRevenueUsd: number;
  }>;
}

export interface PortfolioSummaryResponse {
  range: { startDate: string; endDate: string };
  totals: {
    siteCount: number;
    sessionsCount: number;
    totalEnergyKwh: number;
    totalRevenueUsd: number;
  };
  organizations: PortfolioSummaryOrganization[];
  sites: PortfolioSummarySite[];
}

export interface EnrichedTransaction {
  id: string;
  sessionId: string;
  transactionId: number | null;
  idTag: string;
  status: string;
  startedAt: string;
  stoppedAt: string | null;
  durationMinutes: number | null;
  energyKwh: number;
  revenueUsd: number;
  payment: { status: string; amountCents: number | null } | null;
  meterStart: number | null;
  meterStop: number | null;
  site: { id: string; name: string; organizationName: string | null; portfolioName: string | null };
  charger: { id: string; ocppId: string; serialNumber: string; model: string; vendor: string };
  sourceVersion: string;
}

export interface EnrichedTransactionsResponse {
  total: number;
  limit: number;
  offset: number;
  transactions: EnrichedTransaction[];
}

export interface RebateInterval {
  id: string;
  site: { id: string; name: string };
  charger: { id: string; ocppId: string };
  session: { id: string; transactionId: number | null } | null;
  connectorId: number;
  intervalStart: string;
  intervalEnd: string;
  intervalMinutes: number;
  energyKwh: number;
  avgPowerKw: number;
  maxPowerKw: number | null;
  portStatus: string | null;
  vehicleConnected: boolean | null;
  dataQualityFlag: string | null;
  sourceVersion: string;
}

export interface RebateIntervalsResponse {
  total: number;
  limit: number;
  offset: number;
  range: { startDate: string; endDate: string };
  summary: {
    totalEnergyKwh: number;
    avgPowerKw: number;
    maxPowerKw: number;
  };
  intervals: RebateInterval[];
}

export interface UptimeIncident {
  event: 'ONLINE' | 'OFFLINE' | 'FAULTED' | 'DEGRADED' | 'RECOVERED';
  reason: string | null;
  errorCode: string | null;
  connectorId: number | null;
  timestamp: string;
}

export interface ChargerUptime {
  chargerId: string;
  currentStatus: 'ONLINE' | 'OFFLINE' | 'FAULTED' | 'DEGRADED';
  lastOnlineAt: string | null;
  uptimePercent24h: number;
  uptimePercent7d: number;
  uptimePercent30d: number;
  incidents: UptimeIncident[];
}

export interface SiteUptime {
  siteId: string;
  siteName: string;
  chargerCount: number;
  uptimePercent24h: number;
  uptimePercent7d: number;
  uptimePercent30d: number;
  degradedChargers: number;
  incidents: Array<UptimeIncident & { chargerId: string }>;
}

export interface AdminUser {
  id: string;
  username?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  enabled?: boolean;
  emailVerified?: boolean;
  createdTimestamp?: number;
  realmRoles?: string[];
}

export interface AdminAuditEvent {
  id: string;
  operatorId: string;
  action: string;
  targetUserId?: string;
  targetEmail?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface PortalSettings {
  id: string;
  scopeKey: string;
  organizationName?: string | null;
  organizationDefaultSite?: string | null;
  organizationPortfolio?: string | null;
  organizationBillingAddress?: string | null;
  supportContactEmail?: string | null;
  supportContactPhone?: string | null;
  profileDisplayName?: string | null;
  profileTimezone?: string | null;
  remittanceBankName?: string | null;
  remittanceAccountType?: string | null;
  remittanceEmail?: string | null;
  routingNumber?: string | null;
  accountNumber?: string | null;
  updatedByOperatorId: string;
  createdAt: string;
  updatedAt: string;
}

export interface OperatorNotificationPreference {
  id: string;
  operatorId: string;
  emailEnabled: boolean;
  smsEnabled: boolean;
  outageAlerts: boolean;
  billingAlerts: boolean;
  weeklyDigest: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ChargerModelCatalogItem {
  id: string;
  scopeKey: string;
  modelCode: string;
  vendor: string;
  displayName: string;
  maxKw: number;
  connectorType: string;
  isActive: boolean;
  updatedByOperatorId: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Client ──────────────────────────────────────────────────────────────────

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';
const DEV_OPERATOR_ID = import.meta.env.VITE_DEV_OPERATOR_ID ?? 'operator-001';
const AUTH_MODE = String(import.meta.env.VITE_AUTH_MODE ?? '').trim().toLowerCase();
const IS_DEV_MODE = AUTH_MODE === 'dev';

async function request<T>(
  path: string,
  token: string | null | undefined,
  options?: RequestInit,
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (IS_DEV_MODE) {
    headers['x-dev-operator-id'] = DEV_OPERATOR_ID;
  } else if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: { ...headers, ...(options?.headers as Record<string, string> ?? {}) },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
  }

  return res.json() as Promise<T>;
}

export function createApiClient(token: string | null | undefined) {
  return {
    getSites: () => request<SiteListItem[]>('/sites', token),
    getSite: (id: string) => request<SiteDetail>(`/sites/${id}`, token),
    getChargers: () => request<ChargerListItem[]>('/chargers', token),
    getAnalytics: (siteId: string, params?: { periodDays?: number; startDate?: string; endDate?: string }) => {
      const query = new URLSearchParams();
      if (params?.periodDays) query.set('periodDays', String(params.periodDays));
      if (params?.startDate) query.set('startDate', params.startDate);
      if (params?.endDate) query.set('endDate', params.endDate);
      const qs = query.toString();
      return request<Analytics>(`/sites/${siteId}/analytics${qs ? `?${qs}` : ''}`, token);
    },

    getPortfolioSummary: (params?: { startDate?: string; endDate?: string; siteId?: string; organizationName?: string; portfolioName?: string }) => {
      const query = new URLSearchParams();
      if (params?.startDate) query.set('startDate', params.startDate);
      if (params?.endDate) query.set('endDate', params.endDate);
      if (params?.siteId) query.set('siteId', params.siteId);
      if (params?.organizationName) query.set('organizationName', params.organizationName);
      if (params?.portfolioName) query.set('portfolioName', params.portfolioName);
      const qs = query.toString();
      return request<PortfolioSummaryResponse>(`/analytics/portfolio-summary${qs ? `?${qs}` : ''}`, token);
    },

    getEnrichedTransactions: (params?: { limit?: number; offset?: number; siteId?: string; chargerId?: string; status?: string; startDate?: string; endDate?: string }) => {
      const query = new URLSearchParams();
      if (params?.limit != null) query.set('limit', String(params.limit));
      if (params?.offset != null) query.set('offset', String(params.offset));
      if (params?.siteId) query.set('siteId', params.siteId);
      if (params?.chargerId) query.set('chargerId', params.chargerId);
      if (params?.status) query.set('status', params.status);
      if (params?.startDate) query.set('startDate', params.startDate);
      if (params?.endDate) query.set('endDate', params.endDate);
      const qs = query.toString();
      return request<EnrichedTransactionsResponse>(`/transactions/enriched${qs ? `?${qs}` : ''}`, token);
    },

    getRebateIntervals: (params?: { siteId?: string; chargerId?: string; sessionId?: string; startDate?: string; endDate?: string; limit?: number; offset?: number }) => {
      const query = new URLSearchParams();
      if (params?.siteId) query.set('siteId', params.siteId);
      if (params?.chargerId) query.set('chargerId', params.chargerId);
      if (params?.sessionId) query.set('sessionId', params.sessionId);
      if (params?.startDate) query.set('startDate', params.startDate);
      if (params?.endDate) query.set('endDate', params.endDate);
      if (params?.limit != null) query.set('limit', String(params.limit));
      if (params?.offset != null) query.set('offset', String(params.offset));
      const qs = query.toString();
      return request<RebateIntervalsResponse>(`/rebates/intervals${qs ? `?${qs}` : ''}`, token);
    },

    getChargerStatus: (id: string) => request<ChargerStatus>(`/chargers/${id}/status`, token),
    getChargerSessions: (id: string) =>
      request<SessionRecord[]>(`/chargers/${id}/sessions`, token),
    getChargerUptime: (id: string) =>
      request<ChargerUptime>(`/chargers/${id}/uptime`, token),
    getSiteUptime: (id: string) =>
      request<SiteUptime>(`/sites/${id}/uptime`, token),

    createSite: (body: { name: string; address: string; lat: number; lng: number }) =>
      request<{ id: string; name: string }>('/sites', token, {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    updateSite: (
      id: string,
      body: {
        name: string;
        address: string;
        lat: number;
        lng: number;
        pricingMode?: 'flat' | 'tou';
        pricePerKwhUsd?: number;
        idleFeePerMinUsd?: number;
        activationFeeUsd?: number;
        gracePeriodMin?: number;
        touWindows?: unknown;
        organizationName?: string;
        portfolioName?: string;
      },
    ) =>
      request<SiteDetail>(`/sites/${id}`, token, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),

    createCharger: (body: {
      siteId: string;
      ocppId: string;
      serialNumber: string;
      model: string;
      vendor: string;
    }) =>
      request<CreatedCharger>('/chargers', token, {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    resetCharger: (id: string, type: 'Soft' | 'Hard' = 'Soft') =>
      request<{ status: string }>(`/chargers/${id}/reset`, token, {
        method: 'POST',
        body: JSON.stringify({ type }),
      }),

    remoteStartCharger: (id: string, body: { connectorId: number; idTag: string }) =>
      request<{ status: string }>(`/chargers/${id}/remote-start`, token, {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    triggerHeartbeat: (id: string) =>
      request<{ status: string }>(`/chargers/${id}/trigger-heartbeat`, token, {
        method: 'POST',
      }),

    getChargerConfiguration: (id: string) =>
      request<{ configurationKey?: Array<{ key?: string; value?: string; readonly?: boolean }>; unknownKey?: string[]; error?: string }>(`/chargers/${id}/get-configuration`, token, {
        method: 'POST',
      }),

    listAdminUsers: (params?: { search?: string; max?: number }) => {
      const qs = new URLSearchParams();
      if (params?.search) qs.set('search', params.search);
      if (params?.max != null) qs.set('max', String(params.max));
      return request<AdminUser[]>(`/admin/users${qs.toString() ? `?${qs}` : ''}`, token);
    },

    createAdminUser: (body: { email: string; firstName?: string; lastName?: string; sendInvite?: boolean; temporaryPassword?: string }) =>
      request<AdminUser>('/admin/users', token, {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    addAdminUserRole: (userId: string, role: string, reason?: string) =>
      request<{ ok: boolean }>(`/admin/users/${userId}/roles/add`, token, {
        method: 'POST',
        body: JSON.stringify({ role, reason }),
      }),

    removeAdminUserRole: (userId: string, role: string, options?: { reason?: string; confirmPrivilegedRoleRemoval?: boolean }) =>
      request<{ ok: boolean }>(`/admin/users/${userId}/roles/remove`, token, {
        method: 'POST',
        body: JSON.stringify({ role, reason: options?.reason, confirmPrivilegedRoleRemoval: options?.confirmPrivilegedRoleRemoval }),
      }),

    deactivateAdminUser: (userId: string, options?: { reason?: string; revokeSessions?: boolean }) =>
      request<{ ok: boolean }>(`/admin/users/${userId}/deactivate`, token, {
        method: 'POST',
        body: JSON.stringify(options ?? {}),
      }),

    reactivateAdminUser: (userId: string, reason?: string) =>
      request<{ ok: boolean }>(`/admin/users/${userId}/reactivate`, token, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),

    triggerPasswordReset: (userId: string, options?: { reason?: string; revokeSessions?: boolean }) =>
      request<{ ok: boolean }>(`/admin/users/${userId}/reset-credentials`, token, {
        method: 'POST',
        body: JSON.stringify(options ?? {}),
      }),

    revokeAdminUserSessions: (userId: string, reason?: string) =>
      request<{ ok: boolean }>(`/admin/users/${userId}/revoke-sessions`, token, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),

    listAdminAudit: (limit = 50) =>
      request<AdminAuditEvent[]>(`/admin/users/audit?limit=${limit}`, token),

    getAdminSettings: () =>
      request<{ settings: PortalSettings | null; notificationPreferences: OperatorNotificationPreference | null; chargerModels: ChargerModelCatalogItem[] }>('/admin/settings', token),

    updateOrgProfileSettings: (body: Record<string, unknown>) =>
      request<PortalSettings>('/admin/settings/org-profile', token, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),

    updateNotificationSettings: (body: { emailEnabled?: boolean; smsEnabled?: boolean; outageAlerts?: boolean; billingAlerts?: boolean; weeklyDigest?: boolean; reason: string }) =>
      request<OperatorNotificationPreference>('/admin/settings/notifications', token, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),

    createChargerModelCatalogItem: (body: { modelCode: string; vendor: string; displayName: string; maxKw: number; connectorType: string; reason: string }) =>
      request<ChargerModelCatalogItem>('/admin/settings/charger-models', token, {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    toggleChargerModelCatalogItem: (id: string, body: { isActive: boolean; reason: string }) =>
      request<ChargerModelCatalogItem>(`/admin/settings/charger-models/${id}/toggle`, token, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  };
}
