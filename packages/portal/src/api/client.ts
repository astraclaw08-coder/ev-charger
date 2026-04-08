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
  softwareVendorFeeMode?: 'none' | 'percentage_total' | 'fixed_per_kwh' | 'fixed_per_minute';
  softwareVendorFeeValue?: number;
  softwareFeeIncludesActivation?: boolean;
  touWindows?: unknown;
  organizationName?: string | null;
  portfolioName?: string | null;
  createdAt: string;
  chargerCount: number;
  connectorCount?: number;
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
  status: 'ONLINE' | 'OFFLINE' | 'FAULTED';
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
  softwareVendorFeeMode?: 'none' | 'percentage_total' | 'fixed_per_kwh' | 'fixed_per_minute';
  softwareVendorFeeValue?: number;
  softwareFeeIncludesActivation?: boolean;
  touWindows?: unknown;
  organizationName?: string | null;
  portfolioName?: string | null;
  maxChargeDurationMin?: number | null;
  maxIdleDurationMin?: number | null;
  maxSessionCostUsd?: number | null;
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

type BillingBreakdown = {
  pricingMode: 'flat' | 'tou';
  durationMinutes: number;
  gracePeriodMin: number;
  energy: {
    kwhDelivered: number;
    totalUsd: number;
    segments: Array<{
      startedAt: string;
      endedAt: string;
      minutes: number;
      source: 'flat' | 'tou';
      pricePerKwhUsd: number;
      idleFeePerMinUsd: number;
      kwh: number;
      energyAmountUsd: number;
      idleMinutes: number;
      idleAmountUsd: number;
    }>;
  };
  idle: {
    minutes: number;
    totalUsd: number;
    segments: Array<{
      startedAt: string;
      endedAt: string;
      minutes: number;
      idleFeePerMinUsd: number;
      amountUsd: number;
      source: 'flat' | 'tou';
    }>;
  };
  activation: { totalUsd: number };
  grossTotalUsd: number;
  totals?: {
    energyUsd: number;
    idleUsd: number;
    activationUsd: number;
    grossUsd: number;
    vendorFeeUsd: number;
    netUsd: number;
  };
};

export interface SessionRecord {
  id: string;
  transactionId: number | null;
  startedAt: string;
  stoppedAt: string | null;
  plugInAt?: string | null;
  plugOutAt?: string | null;
  status: string;
  kwhDelivered: number | null;
  ratePerKwh: number | null;
  idTag: string;
  connector: { connectorId: number };
  user: { name: string | null; email: string } | null;
  payment: { status: string; amountCents: number | null } | null;
  effectiveAmountCents?: number | null;
  estimatedAmountCents?: number | null;
  amountState?: 'FINAL' | 'PENDING' | 'ESTIMATED' | 'UNAVAILABLE';
  amountLabel?: string;
  isAmountFinal?: boolean;
  billingBreakdown?: BillingBreakdown;
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
  plugInAt?: string | null;
  plugOutAt?: string | null;
  durationMinutes: number | null;
  energyKwh: number;
  revenueUsd: number;
  payment: { status: string; amountCents: number | null } | null;
  effectiveAmountCents?: number | null;
  estimatedAmountCents?: number | null;
  amountState?: 'FINAL' | 'PENDING' | 'ESTIMATED' | 'UNAVAILABLE';
  amountLabel?: string;
  isAmountFinal?: boolean;
  billingBreakdown?: BillingBreakdown;
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
  event: 'ONLINE' | 'OFFLINE' | 'FAULTED' | 'RECOVERED';
  reason: string | null;
  errorCode: string | null;
  connectorId: number | null;
  timestamp: string;
}

export interface ChargerUptime {
  chargerId: string;
  currentStatus: 'ONLINE' | 'OFFLINE' | 'FAULTED';
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

export interface AdminInAppNotificationCampaign {
  id: string;
  createdByOperatorId: string;
  targetMode: 'all' | 'user_ids' | 'emails';
  targetUserIds: string[];
  targetEmails: string[];
  title: string;
  message: string;
  actionLabel?: string | null;
  actionUrl?: string | null;
  deepLink?: string | null;
  sentAt: string;
  deliveryCount: number;
}

// ── Support Driver Types ────────────────────────────────────────────────
export interface SupportDriverSummary {
  id: string;
  email: string;
  phone: string | null;
  name: string | null;
  idTag: string;
  createdAt: string;
  sessionCount: number;
}

export interface SupportDriverDetail {
  id: string;
  clerkId: string;
  email: string;
  phone: string | null;
  name: string | null;
  homeAddress: string | null;
  homeSiteAddress: string | null;
  homeCity: string | null;
  homeState: string | null;
  homeZipCode: string | null;
  paymentProfile: string | null;
  idTag: string;
  createdAt: string;
  sessionCount: number;
  paymentCount: number;
}

export interface SupportDriverProfileUpdate {
  name: string;
  phone: string;
  homeAddress: string;
  homeSiteAddress: string;
  homeCity: string;
  homeState: string;
  homeZipCode: string;
  idTag: string;
}

export interface SupportDriverSession {
  id: string;
  status: string;
  startedAt: string;
  stoppedAt: string | null;
  energyKwh: number | null;
  costUsd: number | null;
  ratePerKwh: number | null;
  chargerOcppId: string | null;
  siteName: string | null;
  connectorId: number | null;
}

export interface SupportDriverSessionsResponse {
  sessions: SupportDriverSession[];
  total: number;
  page: number;
  limit: number;
  pages: number;
}

export interface SupportDriverPaymentCard {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  isDefault: boolean;
}

export interface SupportDriverPaymentMethodsResponse {
  cards: SupportDriverPaymentCard[];
}

export interface SmartChargingGroup {
  id: string;
  name: string;
  description?: string | null;
  siteId?: string | null;
  createdAt: string;
  updatedAt: string;
  chargers?: Array<{ id: string; ocppId: string; status: string }>;
}

export interface SmartChargingProfile {
  id: string;
  name: string;
  scope: 'CHARGER' | 'GROUP' | 'SITE';
  enabled: boolean;
  priority: number;
  defaultLimitKw: number | null;
  schedule: unknown;
  validFrom: string | null;
  validTo: string | null;
  siteId?: string | null;
  chargerGroupId?: string | null;
  chargerId?: string | null;
  updatedAt: string;
}

export interface SmartChargingState {
  id: string;
  chargerId: string;
  effectiveLimitKw: number;
  fallbackApplied: boolean;
  sourceScope: 'CHARGER' | 'GROUP' | 'SITE' | null;
  sourceProfileId: string | null;
  sourceWindowId: string | null;
  sourceReason: string;
  status: string;
  lastAttemptAt: string;
  lastAppliedAt: string | null;
  lastError: string | null;
  ocppChargingProfileId?: number | null;
  ocppStackLevel?: number | null;
  compositeScheduleVerified?: boolean;
  compositeScheduleVerifiedAt?: string | null;
  updatedAt: string;
  charger: { id: string; ocppId: string; siteId: string; status: string };
  sourceProfile?: { id: string; name: string; scope: 'CHARGER' | 'GROUP' | 'SITE' } | null;
}

export interface StackedProfileInfo {
  profileId: string;
  profileName: string;
  scope: 'CHARGER' | 'GROUP' | 'SITE';
  ocppStackLevel: number;
  ocppChargingProfileId: number;
  defaultLimitKw: number | null;
}

export interface MergedScheduleSlot {
  hour: number;
  effectiveLimitKw: number;
  sourceProfileIds: string[];
}

export interface SmartChargingEffectiveResponse {
  charger: { id: string; ocppId: string; siteId: string; groupId: string | null; status: string };
  calculated: {
    effectiveLimitKw: number;
    fallbackApplied: boolean;
    sourceScope: 'CHARGER' | 'GROUP' | 'SITE' | null;
    sourceProfileId: string | null;
    sourceWindowId: string | null;
    sourceReason: string;
    invalidProfileIds: string[];
  };
  persisted: SmartChargingState | null;
  persistedStates?: SmartChargingState[];
  stackedProfiles?: StackedProfileInfo[];
  mergedSchedule?: MergedScheduleSlot[];
  config: { safeFallbackLimitKw: number; ocppStackLevel: number; timezone: string };
}

export interface CompositeScheduleResponse {
  status: string;
  connectorId?: number;
  scheduleStart?: string;
  chargingSchedule?: {
    chargingRateUnit?: string;
    chargingSchedulePeriod?: Array<{ startPeriod: number; limit: number }>;
  };
}

// ─── Client ──────────────────────────────────────────────────────────────────

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';
const QR_REDIRECT_BASE_URL = import.meta.env.VITE_QR_REDIRECT_BASE_URL ?? API_URL;
const DEV_OPERATOR_ID = import.meta.env.VITE_DEV_OPERATOR_ID ?? 'operator-001';
const AUTH_MODE = String(import.meta.env.VITE_AUTH_MODE ?? '').trim().toLowerCase();
const IS_DEV_MODE = AUTH_MODE === 'dev';

const GET_CACHE_TTL_MS = 30_000;
type CacheEntry = { expiresAt: number; value: unknown };
const responseCache = new Map<string, CacheEntry>();
const inFlightGets = new Map<string, Promise<unknown>>();

function cacheKey(path: string, token: string | null | undefined) {
  const tokenKey = token ? token.slice(0, 24) : 'anon';
  return `${tokenKey}::${path}`;
}

async function request<T>(
  path: string,
  token: string | null | undefined,
  options?: RequestInit,
): Promise<T> {
  const headers: Record<string, string> = {};

  const hasBody = options?.body !== undefined && options?.body !== null;
  if (hasBody) {
    headers['Content-Type'] = 'application/json';
  }

  if (IS_DEV_MODE) {
    headers['x-dev-operator-id'] = DEV_OPERATOR_ID;
  } else if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const method = (options?.method ?? 'GET').toUpperCase();
  const isGet = method === 'GET';
  const key = cacheKey(path, token);

  if (isGet) {
    const cached = responseCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value as T;
    }

    const pending = inFlightGets.get(key);
    if (pending) return pending as Promise<T>;
  } else {
    // Conservative invalidation on mutations to avoid stale UI state.
    responseCache.clear();
  }

  const doFetch = async () => fetch(`${API_URL}${path}`, {
    ...options,
    headers: { ...headers, ...(options?.headers as Record<string, string> ?? {}) },
  });

  const run = (async () => {
    let res: Response;
    try {
      res = await doFetch();
    } catch (e) {
      // transient startup/network hiccup; one quick retry for GET requests prevents hard-refresh UX.
      if (!isGet) throw e;
      await new Promise((r) => setTimeout(r, 450));
      res = await doFetch();
    }

    if (!res.ok && isGet && (res.status === 401 || res.status >= 500)) {
      // first-load auth/API warmup race: retry once before surfacing an error.
      await new Promise((r) => setTimeout(r, 450));
      res = await doFetch();
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
    }

    const data = await res.json() as T;
    if (isGet) {
      responseCache.set(key, { value: data, expiresAt: Date.now() + GET_CACHE_TTL_MS });
    }
    return data;
  })();

  if (!isGet) return run;

  inFlightGets.set(key, run as Promise<unknown>);
  try {
    return await run;
  } finally {
    inFlightGets.delete(key);
  }
}

export function buildChargerQrRedirectUrl(chargerId: string) {
  return `${QR_REDIRECT_BASE_URL}/r/charger/${encodeURIComponent(chargerId)}`;
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
        softwareVendorFeeMode?: 'none' | 'percentage_total' | 'fixed_per_kwh' | 'fixed_per_minute';
        softwareVendorFeeValue?: number;
        softwareFeeIncludesActivation?: boolean;
        touWindows?: unknown;
        organizationName?: string;
        portfolioName?: string;
        maxChargeDurationMin?: number | null;
        maxIdleDurationMin?: number | null;
        maxSessionCostUsd?: number | null;
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

    unassignCharger: (id: string, reason?: string) =>
      request<{ unassigned: boolean; chargerId: string; ocppId: string; previousSiteId: string; previousSiteName: string }>(
        `/chargers/${id}/unassign`, token, {
          method: 'POST',
          body: JSON.stringify({ reason: reason ?? 'Unassigned from site via portal' }),
        },
      ),

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

    getSmartChargingConfig: () =>
      request<{ safeFallbackLimitKw: number; ocppStackLevel: number; timezone: string }>('/smart-charging/config', token),

    listSmartChargingGroups: (params?: { siteId?: string }) => {
      const qs = new URLSearchParams();
      if (params?.siteId) qs.set('siteId', params.siteId);
      return request<SmartChargingGroup[]>(`/smart-charging/groups${qs.toString() ? `?${qs}` : ''}`, token);
    },

    createSmartChargingGroup: (body: { name: string; description?: string; siteId?: string }) =>
      request<SmartChargingGroup>('/smart-charging/groups', token, {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    updateSmartChargingGroup: (id: string, body: { name?: string; description?: string; siteId?: string | null }) =>
      request<SmartChargingGroup>(`/smart-charging/groups/${id}`, token, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),

    deleteSmartChargingGroup: (id: string) =>
      request<{ deleted: boolean }>(`/smart-charging/groups/${id}`, token, {
        method: 'DELETE',
      }),

    assignChargerToSmartGroup: (groupId: string, chargerId: string) =>
      request<{ assigned: boolean }>(`/smart-charging/groups/${groupId}/chargers/${chargerId}`, token, {
        method: 'POST',
      }),

    unassignChargerFromSmartGroup: (groupId: string, chargerId: string) =>
      request<{ unassigned: boolean }>(`/smart-charging/groups/${groupId}/chargers/${chargerId}`, token, {
        method: 'DELETE',
      }),

    listSmartChargingProfiles: (params?: { scope?: 'CHARGER' | 'GROUP' | 'SITE'; siteId?: string; chargerGroupId?: string; chargerId?: string; enabled?: boolean }) => {
      const qs = new URLSearchParams();
      if (params?.scope) qs.set('scope', params.scope);
      if (params?.siteId) qs.set('siteId', params.siteId);
      if (params?.chargerGroupId) qs.set('chargerGroupId', params.chargerGroupId);
      if (params?.chargerId) qs.set('chargerId', params.chargerId);
      if (params?.enabled !== undefined) qs.set('enabled', String(params.enabled));
      return request<SmartChargingProfile[]>(`/smart-charging/profiles${qs.toString() ? `?${qs}` : ''}`, token);
    },

    createSmartChargingProfile: (body: {
      name: string;
      scope: 'CHARGER' | 'GROUP' | 'SITE';
      enabled?: boolean;
      priority?: number;
      defaultLimitKw?: number | null;
      schedule?: unknown;
      validFrom?: string;
      validTo?: string;
      siteId?: string;
      chargerGroupId?: string;
      chargerId?: string;
    }) =>
      request<{ profile: SmartChargingProfile }>(`/smart-charging/profiles`, token, {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    updateSmartChargingProfile: (id: string, body: {
      name?: string;
      enabled?: boolean;
      priority?: number;
      defaultLimitKw?: number | null;
      schedule?: unknown;
      validFrom?: string | null;
      validTo?: string | null;
    }) =>
      request<{ profile: SmartChargingProfile }>(`/smart-charging/profiles/${id}`, token, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),

    deleteSmartChargingProfile: (id: string) =>
      request<{ deleted: boolean }>(`/smart-charging/profiles/${id}`, token, {
        method: 'DELETE',
      }),

    getSmartChargingEffectiveLimit: (chargerId: string) =>
      request<SmartChargingEffectiveResponse>(`/smart-charging/chargers/${chargerId}/effective`, token),

    reconcileSmartChargingForCharger: (chargerId: string) =>
      request<Record<string, unknown>>(`/smart-charging/chargers/${chargerId}/reconcile`, token, {
        method: 'POST',
      }),

    listSmartChargingStates: (params?: { siteId?: string; status?: string }) => {
      const qs = new URLSearchParams();
      if (params?.siteId) qs.set('siteId', params.siteId);
      if (params?.status) qs.set('status', params.status);
      return request<SmartChargingState[]>(`/smart-charging/states${qs.toString() ? `?${qs}` : ''}`, token);
    },

    getCompositeSchedule: (chargerId: string, duration?: number) =>
      request<CompositeScheduleResponse>(`/smart-charging/chargers/${chargerId}/composite-schedule${duration ? `?duration=${duration}` : ''}`, token),

    getStackingPreview: (chargerId: string, at?: string) =>
      request<SmartChargingEffectiveResponse>(`/smart-charging/chargers/${chargerId}/stacking-preview${at ? `?at=${at}` : ''}`, token),

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

    addAdminUserRole: (userId: string, role: string, reason: string) =>
      request<{ ok: boolean }>(`/admin/users/${userId}/roles/add`, token, {
        method: 'POST',
        body: JSON.stringify({ role, reason }),
      }),

    removeAdminUserRole: (userId: string, role: string, options?: { reason: string; confirmPrivilegedRoleRemoval?: boolean }) =>
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

    updateAdminUser: (userId: string, body: { email?: string; firstName?: string; lastName?: string }) =>
      request<AdminUser>(`/admin/users/${userId}`, token, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),

    deleteAdminUser: (userId: string, reason?: string) =>
      request<{ ok: boolean }>(`/admin/users/${userId}`, token, {
        method: 'DELETE',
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

    sendInAppNotification: (body: {
      targetMode: 'all' | 'user_ids' | 'emails';
      userIds?: string[];
      emails?: string[];
      title: string;
      message: string;
      actionLabel?: string;
      actionUrl?: string;
      deepLink?: string;
      reason?: string;
    }) => request<{ id: string; sentAt: string; title: string; message: string; targetMode: string; deliveryCount: number }>(
      '/admin/notifications/send',
      token,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    ),

    listInAppNotificationAudit: (limit = 40) =>
      request<AdminInAppNotificationCampaign[]>(`/admin/notifications/audit?limit=${limit}`, token),

    // ── Support Driver Management ──────────────────────────────────────
    supportDriverLookup: (q: string) =>
      request<SupportDriverSummary[]>(`/admin/support/driver-lookup?q=${encodeURIComponent(q)}`, token),

    supportDriverDetail: (id: string) =>
      request<SupportDriverDetail>(`/admin/support/drivers/${id}`, token),

    supportDriverUpdate: (id: string, body: Partial<SupportDriverProfileUpdate>) =>
      request<SupportDriverDetail>(`/admin/support/drivers/${id}`, token, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),

    supportDriverSessions: (id: string, params?: { page?: number; limit?: number; status?: string; from?: string; to?: string }) => {
      const qs = new URLSearchParams();
      if (params?.page) qs.set('page', String(params.page));
      if (params?.limit) qs.set('limit', String(params.limit));
      if (params?.status) qs.set('status', params.status);
      if (params?.from) qs.set('from', params.from);
      if (params?.to) qs.set('to', params.to);
      return request<SupportDriverSessionsResponse>(`/admin/support/drivers/${id}/sessions${qs.toString() ? `?${qs}` : ''}`, token);
    },

    supportDriverPaymentMethods: (id: string) =>
      request<SupportDriverPaymentMethodsResponse>(`/admin/support/drivers/${id}/payment-methods`, token),

    // ── OpenAI OAuth (AI Agent) ───────────────────────────────────────
    getOpenAIStatus: () =>
      request<{ connected: boolean; email?: string; connectedAt?: string; tokenExpiresAt?: string }>('/settings/openai/status', token),

    getOpenAIAuthUrl: () =>
      request<{ url: string; state: string }>('/settings/openai/auth-url', token),

    postOpenAICallback: (body: { code: string; state: string }) =>
      request<{ success: boolean; email?: string }>('/settings/openai/callback', token, {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    postOpenAIDisconnect: () =>
      request<{ success: boolean }>('/settings/openai/disconnect', token, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
  };
}
