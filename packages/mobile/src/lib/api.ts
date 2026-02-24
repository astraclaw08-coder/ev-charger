import Constants from 'expo-constants';

const API_URL =
  (Constants.expoConfig?.extra?.apiUrl as string | undefined) ||
  process.env.EXPO_PUBLIC_API_URL ||
  'http://localhost:3001';

const DEV_USER_ID = process.env.EXPO_PUBLIC_DEV_USER_ID || 'user-test-driver-001';
const CLERK_KEY = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;

export const isDevMode = !CLERK_KEY;

// Auth token holder — set by auth context
let _bearerToken: string | null = null;
export function setBearerToken(token: string | null) {
  _bearerToken = token;
}

async function authHeaders(): Promise<Record<string, string>> {
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
): Promise<T> {
  const headers = new Headers({
    'Content-Type': 'application/json',
    ...(await authHeaders()),
    ...(opts.headers as Record<string, string> | undefined),
  });

  const res = await fetch(`${API_URL}${path}`, {
    ...opts,
    headers,
  });

  if (!res.ok) {
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

export interface Connector {
  id: string;
  connectorId: number;
  status: 'AVAILABLE' | 'PREPARING' | 'CHARGING' | 'SUSPENDED_EVSE' | 'SUSPENDED_EV' | 'FINISHING' | 'RESERVED' | 'UNAVAILABLE' | 'FAULTED';
  sessions?: ActiveSession[];
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
  ratePerKwh: number | null;
  startedAt: string;
  endedAt: string | null;
  costEstimateCents?: number | null;
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

export interface Payment {
  id: string;
  status: string;
  amountCents: number | null;
  stripeCustomerId: string | null;
  stripeIntentId: string | null;
}

// ── API calls ────────────────────────────────────────────────────────────────

export const api = {
  chargers: {
    list(bbox?: { minLat: number; maxLat: number; minLng: number; maxLng: number }) {
      const params = bbox
        ? `?minLat=${bbox.minLat}&maxLat=${bbox.maxLat}&minLng=${bbox.minLng}&maxLng=${bbox.maxLng}`
        : '';
      return request<Charger[]>(`/chargers${params}`);
    },
    get(id: string) {
      return request<Charger>(`/chargers/${id}`);
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

  payments: {
    setupIntent() {
      return request<{ clientSecret: string; stripeCustomerId: string }>('/payments/setup-intent', {
        method: 'POST',
      });
    },
  },
};
