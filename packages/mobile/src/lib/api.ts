import Constants from 'expo-constants';
import { Buffer } from 'buffer';

const API_URL =
  (Constants.expoConfig?.extra?.apiUrl as string | undefined) ||
  process.env.EXPO_PUBLIC_API_URL ||
  'http://127.0.0.1:3001';

export const appEnv =
  ((Constants.expoConfig?.extra?.appEnv as string | undefined) || process.env.APP_ENV || 'dev').toLowerCase();
export const envLabel =
  (Constants.expoConfig?.extra?.envLabel as string | undefined) || process.env.EXPO_PUBLIC_ENV_LABEL || 'DEV';
export const apiBaseUrl = API_URL;

const DEV_USER_ID = process.env.EXPO_PUBLIC_DEV_USER_ID || 'user-test-driver-001';
const AUTH_MODE = ((Constants.expoConfig?.extra?.authMode as string | undefined) || 'keycloak').trim().toLowerCase();

export const authMode = AUTH_MODE === 'keycloak' ? 'keycloak' : 'keycloak';

export const isDevMode = false;
export const isKeycloakMode = true;
export const isEvcPlatformReadModelEnabled = process.env.EXPO_PUBLIC_EVC_PLATFORM_BUSINESS_VIEWS === '1';

// Auth state holders — set by auth context
let _bearerToken: string | null = null;
let _guestMode = false;
let _authRefreshHandler: null | (() => Promise<boolean>) = null;

export function setBearerToken(token: string | null) {
  _bearerToken = token;
}

export function setAuthRefreshHandler(handler: null | (() => Promise<boolean>)) {
  _authRefreshHandler = handler;
}

export function setGuestMode(guest: boolean) {
  _guestMode = guest;
}

export function isGuestMode() {
  return _guestMode;
}

function decodeJwtSubject(token: string): string | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
    const json = Buffer.from(padded, 'base64').toString('utf8');
    if (!json) return null;
    const payload = JSON.parse(json) as { sub?: unknown };
    return typeof payload.sub === 'string' && payload.sub.trim() ? payload.sub.trim() : null;
  } catch {
    return null;
  }
}

export function getAuthIdentityKey(): string | null {
  if (_guestMode) return null;
  if (!_bearerToken) return null;
  return decodeJwtSubject(_bearerToken);
}

async function authHeaders(): Promise<Record<string, string>> {
  if (_guestMode) {
    if (process.env.EXPO_PUBLIC_ALLOW_GUEST_TRANSACT === '1') {
      return { 'x-dev-user-id': DEV_USER_ID };
    }
    return {};
  }
  if (isDevMode) {
    return { 'x-dev-user-id': DEV_USER_ID };
  }
  if (_bearerToken) {
    return { Authorization: `Bearer ${_bearerToken}` };
  }
  return {};
}

async function request<T>(
  path: string,
  opts: RequestInit = {},
  canRetryAuth = true,
): Promise<T> {
  const headers = new Headers({
    'Content-Type': 'application/json',
    ...(await authHeaders()),
    ...(opts.headers as Record<string, string> | undefined),
  });

  headers.set('x-app-env', appEnv);

  const res = await fetch(`${API_URL}${path}`, {
    ...opts,
    headers,
  });

  if (!res.ok) {
    if (canRetryAuth && (res.status === 401 || res.status === 403) && !_guestMode && _authRefreshHandler) {
      try {
        const refreshed = await _authRefreshHandler();
        if (refreshed) {
          return request<T>(path, opts, false);
        }
      } catch {
        // fall through to regular error handling
      }
    }

    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, body.error ?? res.statusText);
  }

  return res.json() as Promise<T>;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface ConnectorActiveReservation {
  id: string;
  reservationId: number;
  userId: string;
  status: string;
  holdStartsAt: string;
  holdExpiresAt: string;
}

export interface Connector {
  id: string;
  connectorId: number;
  status: 'AVAILABLE' | 'PREPARING' | 'CHARGING' | 'SUSPENDED_EVSE' | 'SUSPENDED_EV' | 'FINISHING' | 'RESERVED' | 'UNAVAILABLE' | 'FAULTED';
  sessions?: ActiveSession[];
  lastPlugOutAt?: string | null;
  activeReservation?: ConnectorActiveReservation | null;
}

export interface Charger {
  id: string;
  ocppId: string;
  model: string;
  vendor: string;
  status: string;
  serialNumber: string;
  site: {
    id: string;
    name: string;
    address: string;
    lat: number;
    lng: number;
    pricePerKwhUsd?: number;
    idleFeePerMinUsd?: number;
    activationFeeUsd?: number;
    gracePeriodMin?: number;
    pricingMode?: 'flat' | 'tou';
    touWindows?: unknown;
    reservationEnabled?: boolean;
    reservationMaxDurationMin?: number;
  };
  connectors: Connector[];
}

export interface Session {
  id: string;
  transactionId: number | null;
  status: 'ACTIVE' | 'COMPLETED' | 'FAILED';
  meterStart: number;
  meterStop: number | null;
  kwhDelivered: number | null;
  powerActiveImportW?: number | null;
  ratePerKwh: number | null;
  startedAt: string;
  endedAt: string | null;
  plugInAt?: string | null;
  plugOutAt?: string | null;
  costEstimateCents?: number | null;
  estimatedAmountCents?: number | null;
  effectiveAmountCents?: number | null;
  amountState?: 'FINAL' | 'PENDING' | 'ESTIMATED' | 'UNAVAILABLE';
  amountLabel?: string;
  isAmountFinal?: boolean;
  billingBreakdown?: {
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
  connector: {
    connectorId: number;
    charger: {
      id: string;
      ocppId: string;
      model: string;
      vendor: string;
      status: string;
      site: { name: string; address: string };
    };
  };
  payment: Payment | null;
}

export interface ActiveSession {
  id: string;
  status: string;
}


export interface UserProfile {
  id: string;
  name: string | null;
  email: string;
  phone: string | null;
  homeAddress: string | null;
  homeSiteAddress: string | null;
  homeCity: string | null;
  homeState: string | null;
  homeZipCode: string | null;
  paymentProfile: string | null;
  stripeCustomerId: string | null;
}

export interface Payment {
  id: string;
  status: 'PENDING' | 'REQUIRES_ACTION' | 'AUTHORIZED' | 'CAPTURE_IN_PROGRESS' | 'CAPTURED' | 'PARTIAL_CAPTURED' | 'FAILED' | 'CANCELED' | 'REFUNDED';
  purpose: 'CHARGING' | 'RESERVATION' | 'REMAINDER' | 'REFUND_ADJUSTMENT';
  amountCents: number | null;
  authorizedCents: number | null;
  deficitCents: number | null;
  stripeCustomerId: string | null;
  stripeIntentId: string | null;
}

export interface InAppNotificationItem {
  id: string;
  campaignId: string;
  title: string;
  message: string;
  actionLabel?: string | null;
  actionUrl?: string | null;
  deepLink?: string | null;
  sentAt: string;
  createdAt: string;
  readAt?: string | null;
  isRead: boolean;
}

export interface FavoriteListResponse {
  chargerIds: string[];
}

export interface ConsentStatus {
  tosAcceptedAt: string | null;
  tosVersion: string | null;
  privacyAcceptedAt: string | null;
  privacyVersion: string | null;
}

export interface AccountDeletionResponse {
  ok: boolean;
  deletionRequestedAt?: string;
  message: string;
}

export interface ChargerUptime {
  chargerId: string;
  currentStatus: 'ONLINE' | 'OFFLINE' | 'FAULTED';
  lastOnlineAt: string | null;
  uptimePercent24h: number;
  uptimePercent7d: number;
  uptimePercent30d: number;
}


export interface PortfolioSummaryResponse {
  range: { startDate: string; endDate: string };
  totals: {
    siteCount: number;
    sessionsCount: number;
    totalEnergyKwh: number;
    totalRevenueUsd: number;
  };
}

export interface EnrichedTransaction {
  id: string;
  sessionId: string;
  transactionId: number | null;
  status: string;
  startedAt: string;
  stoppedAt: string | null;
  energyKwh: number;
  revenueUsd: number;
  payment: { status: string; amountCents: number | null } | null;
  effectiveAmountCents?: number | null;
  estimatedAmountCents?: number | null;
  amountState?: 'FINAL' | 'PENDING' | 'ESTIMATED' | 'UNAVAILABLE';
  amountLabel?: string;
  isAmountFinal?: boolean;
  billingBreakdown?: Session['billingBreakdown'];
  meterStart: number | null;
  meterStop: number | null;
  site: { id: string; name: string };
  charger: { id: string; ocppId: string; model: string; vendor: string };
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
  intervalStart: string;
  intervalEnd: string;
  intervalMinutes: number;
  energyKwh: number;
  avgPowerKw: number;
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

// ── API calls ────────────────────────────────────────────────────────────────

function normalizeCharger(charger: Charger): Charger {
  const chargerStatus = String(charger.status || '').toUpperCase();
  if (chargerStatus === 'OFFLINE') {
    return {
      ...charger,
      connectors: charger.connectors.map((c) => ({ ...c, status: 'UNAVAILABLE' })),
    };
  }
  return charger;
}

export const api = {
  auth: {
    passwordLogin(username: string, password: string) {
      return request<{
        ok: boolean;
        accessToken: string;
        refreshToken?: string;
        tokenType?: string;
        expiresIn?: number;
        refreshExpiresIn?: number;
      }>('/auth/password-login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
    },
    passwordRefresh(refreshToken: string) {
      return request<{
        ok: boolean;
        accessToken: string;
        refreshToken?: string;
        tokenType?: string;
        expiresIn?: number;
        refreshExpiresIn?: number;
      }>('/auth/password-refresh', {
        method: 'POST',
        body: JSON.stringify({ refreshToken }),
      });
    },
    otpSend(phone: string) {
      return request<{
        challengeId: string;
        expiresInSeconds: number;
        resendAvailableInSeconds: number;
        destinationHint: string;
        devOtpCode?: string;
      }>('/auth/otp/send', {
        method: 'POST',
        body: JSON.stringify({ phone, channel: 'sms' }),
      });
    },
    otpVerify(challengeId: string, code: string) {
      return request<{
        ok: boolean;
        accessToken: string;
        expiresIn: number;
        tokenType: string;
        user: { id: string; email: string; phone: string | null; name: string | null };
      }>('/auth/otp/verify', {
        method: 'POST',
        body: JSON.stringify({ challengeId, code }),
      });
    },
    otpResend(challengeId: string, phone: string) {
      return request<{
        challengeId: string;
        expiresInSeconds: number;
        resendAvailableInSeconds: number;
        destinationHint: string;
        devOtpCode?: string;
      }>('/auth/otp/resend', {
        method: 'POST',
        body: JSON.stringify({ challengeId, phone, channel: 'sms' }),
      });
    },
  },
  analytics: {
    portfolioSummary(params?: { startDate?: string; endDate?: string }) {
      const query = new URLSearchParams();
      if (params?.startDate) query.set('startDate', params.startDate);
      if (params?.endDate) query.set('endDate', params.endDate);
      const qs = query.toString();
      return request<PortfolioSummaryResponse>(`/analytics/portfolio-summary${qs ? `?${qs}` : ''}`);
    },
  },
  chargers: {
    async list(bbox?: { minLat: number; maxLat: number; minLng: number; maxLng: number }) {
      const params = bbox
        ? `?minLat=${bbox.minLat}&maxLat=${bbox.maxLat}&minLng=${bbox.minLng}&maxLng=${bbox.maxLng}`
        : '';
      const rows = await request<Charger[]>(`/chargers${params}`);
      return rows.map(normalizeCharger);
    },
    async get(id: string) {
      const row = await request<Charger>(`/chargers/${id}`);
      return normalizeCharger(row);
    },
    uptime(id: string) {
      return request<ChargerUptime>(`/chargers/${id}/uptime`);
    },
    async search(q: string) {
      const rows = await request<Charger[]>(`/chargers/search?q=${encodeURIComponent(q)}`);
      return rows.map(normalizeCharger);
    },
  },

  sessions: {
    start(chargerId: string, connectorId: number) {
      return request<{ accepted: boolean; chargerId: string; connectorId: number }>('/sessions/start', {
        method: 'POST',
        body: JSON.stringify({ chargerId, connectorId }),
      });
    },
    stop(sessionId: string) {
      return request<{ status: string }>(`/sessions/${sessionId}/stop`, {
        method: 'POST',
      });
    },
    list(limit = 20, offset = 0) {
      return request<{ sessions: Session[]; total: number; limit: number; offset: number }>(
        `/sessions?limit=${limit}&offset=${offset}`,
      );
    },
    get(id: string) {
      return request<Session>(`/sessions/${id}`);
    },
  },

  transactions: {
    enriched(params?: { startDate?: string; endDate?: string; limit?: number; offset?: number }) {
      const query = new URLSearchParams();
      if (params?.startDate) query.set('startDate', params.startDate);
      if (params?.endDate) query.set('endDate', params.endDate);
      if (params?.limit != null) query.set('limit', String(params.limit));
      if (params?.offset != null) query.set('offset', String(params.offset));
      const qs = query.toString();
      return request<EnrichedTransactionsResponse>(`/me/transactions/enriched${qs ? `?${qs}` : ''}`);
    },
  },

  rebates: {
    intervals(params?: { startDate?: string; endDate?: string; limit?: number; offset?: number }) {
      const query = new URLSearchParams();
      if (params?.startDate) query.set('startDate', params.startDate);
      if (params?.endDate) query.set('endDate', params.endDate);
      if (params?.limit != null) query.set('limit', String(params.limit));
      if (params?.offset != null) query.set('offset', String(params.offset));
      const qs = query.toString();
      return request<RebateIntervalsResponse>(`/rebates/intervals${qs ? `?${qs}` : ''}`);
    },
  },

  payments: {
    setupIntent() {
      return request<{ clientSecret: string; stripeCustomerId: string }>('/payments/setup-intent', {
        method: 'POST',
      });
    },
    preauth(connectorRefId: string) {
      return request<{
        paymentId: string;
        preauthToken: string;
        authorizedCents: number;
        status: 'AUTHORIZED' | 'REQUIRES_ACTION' | 'FAILED';
        clientSecret?: string;
        alreadyExists?: boolean;
      }>('/payments/preauth', {
        method: 'POST',
        body: JSON.stringify({ connectorRefId }),
      });
    },
    cancel(paymentId: string) {
      return request<{ status: string }>(`/payments/${paymentId}/cancel`, {
        method: 'POST',
      });
    },
  },

  profile: {
    get() {
      return request<UserProfile>('/me/profile');
    },
    update(input: Partial<Pick<UserProfile, 'name' | 'email' | 'phone' | 'homeAddress' | 'homeSiteAddress' | 'homeCity' | 'homeState' | 'homeZipCode' | 'paymentProfile'>>) {
      return request<UserProfile>('/me/profile', {
        method: 'PUT',
        body: JSON.stringify(input),
      });
    },
  },

  consent: {
    status() {
      return request<ConsentStatus>('/me/consent');
    },
    accept(tosVersion: string, privacyVersion: string) {
      return request<ConsentStatus>('/me/consent', {
        method: 'POST',
        body: JSON.stringify({ tosVersion, privacyVersion }),
      });
    },
  },

  account: {
    deleteAccount() {
      return request<AccountDeletionResponse>('/me', {
        method: 'DELETE',
      });
    },
  },

  favorites: {
    list() {
      return request<FavoriteListResponse>('/me/favorites');
    },
    add(chargerId: string) {
      return request<{ ok: boolean }>('/me/favorites', {
        method: 'POST',
        body: JSON.stringify({ chargerId }),
      });
    },
    remove(chargerId: string) {
      return request<{ ok: boolean }>(`/me/favorites/${chargerId}`, {
        method: 'DELETE',
      });
    },
    replace(chargerIds: string[]) {
      return request<FavoriteListResponse>('/me/favorites', {
        method: 'PUT',
        body: JSON.stringify({ chargerIds }),
      });
    },
  },

  notifications: {
    list(limit = 40) {
      return request<InAppNotificationItem[]>(`/me/notifications?limit=${limit}`);
    },
    markRead(id: string) {
      return request<{ ok: boolean }>(`/me/notifications/${id}/read`, {
        method: 'POST',
      });
    },
  },

  reservations: {
    create(connectorId: string, holdMinutes?: number) {
      return request<{ id: string; reservationId: number; status: string; holdStartsAt: string; holdExpiresAt: string }>(
        '/reservations',
        {
          method: 'POST',
          body: JSON.stringify({ connectorId, ...(holdMinutes != null ? { holdMinutes } : {}) }),
        },
      );
    },
    getActive() {
      return request<{ id: string; reservationId: number; userId: string; connectorId: string; status: string; holdStartsAt: string; holdExpiresAt: string } | null>(
        '/reservations/active',
      );
    },
    list(limit = 20, offset = 0) {
      return request<{ reservations: Array<{ id: string; reservationId: number; status: string; holdStartsAt: string; holdExpiresAt: string }>; total: number; limit: number; offset: number }>(
        `/reservations?limit=${limit}&offset=${offset}`,
      );
    },
    cancel(id: string) {
      return request<{ ok: boolean }>(`/reservations/${id}/cancel`, {
        method: 'POST',
      });
    },
  },
};
