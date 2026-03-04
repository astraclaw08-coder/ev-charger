// ─── Types ───────────────────────────────────────────────────────────────────

export interface SiteListItem {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
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
  startedAt: string;
  stoppedAt: string | null;
  status: string;
  kwhDelivered: number | null;
  ratePerKwh: number | null;
  idTag: string;
  connector: { connectorId: number };
  user: { name: string | null; email: string } | null;
  payment: { status: string; amountCents: number | null } | null;
}

export interface CreatedCharger {
  id: string;
  ocppId: string;
  serialNumber: string;
  ocppEndpoint: string;
  password: string;
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

// ─── Client ──────────────────────────────────────────────────────────────────

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';
const DEV_OPERATOR_ID = import.meta.env.VITE_DEV_OPERATOR_ID ?? 'operator-001';
const IS_DEV_MODE = !import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

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
  };
}
