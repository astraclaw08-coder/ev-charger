import AsyncStorage from '@react-native-async-storage/async-storage';
import { useQuery } from '@tanstack/react-query';
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Linking, Text, TouchableOpacity, View } from 'react-native';
import { useRouter } from 'expo-router';
import { api, type Session } from '@/lib/api';
import { useAppAuth } from '@/providers/AuthProvider';
import { useAppTheme } from '@/theme';

const STORAGE_KEY = 'charging.notifications.v1';
const MAX_NOTIFICATIONS = 50;

type NotificationEventType =
  | 'SESSION_STARTED'
  | 'CHARGING_PAUSED'
  | 'CHARGING_RESUMED'
  | 'NEARING_COMPLETION'
  | 'SESSION_COMPLETED'
  | 'SESSION_FAILED'
  | 'PAYMENT_ISSUE'
  | 'CUSTOM_ADMIN';

export type ChargingNotification = {
  id: string;
  type: NotificationEventType;
  sessionId?: string;
  title: string;
  body: string;
  siteName: string;
  createdAt: string;
  read: boolean;
  actionLabel?: string | null;
  actionUrl?: string | null;
  deepLink?: string | null;
  remoteId?: string;
};

type ChargingNotificationsContextValue = {
  notifications: ChargingNotification[];
  unreadCount: number;
  markAsRead: (id: string) => void;
  markAllAsRead: () => void;
  activeSession: Session | null;
  refetchSessions: () => void;
};

const ChargingNotificationsContext = createContext<ChargingNotificationsContextValue | null>(null);

const pausedConnectorStates = new Set(['SUSPENDED_EV', 'SUSPENDED_EVSE']);
const chargingConnectorStates = new Set(['CHARGING']);
const paymentIssueStates = new Set(['FAILED', 'CANCELED', 'REQUIRES_PAYMENT_METHOD', 'REQUIRES_ACTION']);

function titleFor(type: NotificationEventType): string {
  switch (type) {
    case 'SESSION_STARTED': return 'Charging started';
    case 'CHARGING_PAUSED': return 'Charging paused';
    case 'CHARGING_RESUMED': return 'Charging resumed';
    case 'NEARING_COMPLETION': return 'Charging nearly complete';
    case 'SESSION_COMPLETED': return 'Charging complete';
    case 'SESSION_FAILED': return 'Charging session failed';
    case 'PAYMENT_ISSUE': return 'Payment issue';
  }
}

function bodyFor(type: NotificationEventType, session: Session): string {
  const site = session.connector.charger.site.name;
  switch (type) {
    case 'SESSION_STARTED': return `Your session at ${site} is now active.`;
    case 'CHARGING_PAUSED': return `Power flow paused at ${site}. Check your connector or vehicle state.`;
    case 'CHARGING_RESUMED': return `Power flow resumed at ${site}.`;
    case 'NEARING_COMPLETION': return `Charging at ${site} is entering finishing state.`;
    case 'SESSION_COMPLETED': return `Session completed at ${site}. Tap to review summary.`;
    case 'SESSION_FAILED': return `Session ended unexpectedly at ${site}.`;
    case 'PAYMENT_ISSUE': return `We couldn't finalize payment for ${site}. Update payment details.`;
  }
}

function shouldNotify(lastSentRef: React.MutableRefObject<Map<string, number>>, key: string, cooldownMs: number): boolean {
  const now = Date.now();
  const last = lastSentRef.current.get(key) ?? 0;
  if (now - last < cooldownMs) return false;
  lastSentRef.current.set(key, now);
  return true;
}

export function ChargingNotificationsProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { isDark } = useAppTheme();
  const { isGuest } = useAppAuth();
  const [notifications, setNotifications] = useState<ChargingNotification[]>([]);
  const [toast, setToast] = useState<ChargingNotification | null>(null);
  const previousSessionsRef = useRef<Map<string, Session>>(new Map());
  const previousConnectorStateRef = useRef<Map<string, string>>(new Map());
  const lastSentRef = useRef<Map<string, number>>(new Map());
  const initializedRef = useRef(false);

  const { data, refetch } = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api.sessions.list(20, 0),
    enabled: !isGuest,
    staleTime: 0,
    refetchInterval: 7_000,
    refetchIntervalInBackground: true,
  });

  const activeSession = useMemo(() => data?.sessions.find((s) => s.status === 'ACTIVE') ?? null, [data]);

  const { data: activeCharger } = useQuery({
    queryKey: ['charger-live-state', activeSession?.connector.charger.id],
    queryFn: () => api.chargers.get(activeSession!.connector.charger.id),
    enabled: Boolean(activeSession?.connector.charger.id),
    staleTime: 0,
    refetchInterval: activeSession ? 2_000 : false,
    refetchIntervalInBackground: true,
  });

  const activeConnectorState = useMemo(() => {
    if (!activeSession || !activeCharger) return null;
    const connector = activeCharger.connectors.find((c) => c.connectorId === activeSession.connector.connectorId);
    return connector?.status ?? null;
  }, [activeSession, activeCharger]);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (!raw) return;
        const parsed = JSON.parse(raw) as ChargingNotification[];
        if (Array.isArray(parsed)) setNotifications(parsed);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(notifications)).catch(() => undefined);
  }, [notifications]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (!isGuest && state === 'active') refetch();
    });
    return () => sub.remove();
  }, [isGuest, refetch]);

  useEffect(() => {
    if (!data?.sessions || isGuest) return;

    const nextMap = new Map<string, Session>();
    data.sessions.forEach((s) => nextMap.set(s.id, s));

    if (!initializedRef.current) {
      previousSessionsRef.current = nextMap;
      if (activeSession && activeConnectorState) {
        previousConnectorStateRef.current.set(activeSession.id, activeConnectorState);
      }
      initializedRef.current = true;
      return;
    }

    const emitted: ChargingNotification[] = [];
    const emit = (type: NotificationEventType, session: Session, cooldownMs = 90_000) => {
      const key = `${session.id}:${type}`;
      if (!shouldNotify(lastSentRef, key, cooldownMs)) return;
      emitted.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type,
        sessionId: session.id,
        title: titleFor(type),
        body: bodyFor(type, session),
        siteName: session.connector.charger.site.name,
        createdAt: new Date().toISOString(),
        read: false,
      });
    };

    for (const session of data.sessions) {
      const prev = previousSessionsRef.current.get(session.id);
      if (!prev && session.status === 'ACTIVE') {
        emit('SESSION_STARTED', session, 60_000);
      }
      if (prev?.status === 'ACTIVE' && session.status === 'COMPLETED') {
        emit('SESSION_COMPLETED', session, 60_000);
      }
      if (prev?.status === 'ACTIVE' && session.status === 'FAILED') {
        emit('SESSION_FAILED', session, 60_000);
      }
      const prevPayment = String(prev?.payment?.status ?? '').toUpperCase();
      const nextPayment = String(session.payment?.status ?? '').toUpperCase();
      if (nextPayment && paymentIssueStates.has(nextPayment) && prevPayment !== nextPayment) {
        emit('PAYMENT_ISSUE', session, 5 * 60_000);
      }
    }

    if (activeSession && activeConnectorState) {
      const prevConnector = previousConnectorStateRef.current.get(activeSession.id);
      if (prevConnector) {
        if (!pausedConnectorStates.has(prevConnector) && pausedConnectorStates.has(activeConnectorState)) {
          emit('CHARGING_PAUSED', activeSession, 45_000);
        }
        if (pausedConnectorStates.has(prevConnector) && chargingConnectorStates.has(activeConnectorState)) {
          emit('CHARGING_RESUMED', activeSession, 45_000);
        }
        if (prevConnector !== 'FINISHING' && activeConnectorState === 'FINISHING') {
          emit('NEARING_COMPLETION', activeSession, 60_000);
        }
      }
      previousConnectorStateRef.current.set(activeSession.id, activeConnectorState);
    }

    previousSessionsRef.current = nextMap;

    if (emitted.length > 0) {
      emitted.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      setNotifications((prev) => [...emitted, ...prev].slice(0, MAX_NOTIFICATIONS));
      setToast(emitted[0]);
    }
  }, [data, activeSession, activeConnectorState, isGuest]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timer);
  }, [toast]);

  const markAsRead = (id: string) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
  };

  const markAllAsRead = () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  };

  const value = useMemo<ChargingNotificationsContextValue>(() => ({
    notifications,
    unreadCount: notifications.filter((n) => !n.read).length,
    markAsRead,
    markAllAsRead,
    activeSession,
    refetchSessions: () => { void refetch(); },
  }), [notifications, activeSession, refetch]);

  return (
    <ChargingNotificationsContext.Provider value={value}>
      {children}
      {toast ? (
        <View pointerEvents="box-none" style={{ position: 'absolute', left: 12, right: 12, top: 56, zIndex: 99 }}>
          <TouchableOpacity
            activeOpacity={0.9}
            onPress={() => {
              setToast(null);
              router.push(`/session/${toast.sessionId}` as any);
            }}
            style={{
              borderRadius: 12,
              padding: 12,
              borderWidth: 1,
              borderColor: isDark ? '#1d4ed8' : '#93c5fd',
              backgroundColor: isDark ? '#0f172a' : '#eff6ff',
            }}
          >
            <Text style={{ color: isDark ? '#bfdbfe' : '#1d4ed8', fontWeight: '800', fontSize: 12 }}>{toast.title}</Text>
            <Text style={{ color: isDark ? '#e2e8f0' : '#1e293b', marginTop: 2, fontSize: 12 }}>{toast.body}</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </ChargingNotificationsContext.Provider>
  );
}

export function useChargingNotifications() {
  const ctx = useContext(ChargingNotificationsContext);
  if (!ctx) throw new Error('useChargingNotifications must be used within ChargingNotificationsProvider');
  return ctx;
}
