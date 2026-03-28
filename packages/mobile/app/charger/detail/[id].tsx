import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  Animated,
  PanResponder,
  RefreshControl,
  Image,
  Easing,
  Modal,
} from 'react-native';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Connector, type Session } from '@/lib/api';
import { useAppTheme } from '@/theme';
import { useAppAuth } from '@/providers/AuthProvider';
import { useFavorites } from '@/hooks/useFavorites';
import { HeartButton } from '@/components/HeartButton';
import { Ionicons } from '@expo/vector-icons';

function formatKwh(value: number): string {
  return value.toFixed(4).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function formatDuration(startedAt: string, endedAt?: string | null, nowMs?: number): string {
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : (nowMs ?? Date.now());
  const totalSecs = Math.floor((end - start) / 1000);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function connectorStatusLabel(status: Connector['status']): string {
  switch (status) {
    case 'AVAILABLE': return 'Available';
    case 'CHARGING': return 'Charging';
    case 'PREPARING': return 'Preparing';
    case 'SUSPENDED_EV':
    case 'SUSPENDED_EVSE': return 'Paused';
    case 'FINISHING': return 'Finishing';
    case 'FAULTED': return 'Faulted';
    case 'UNAVAILABLE': return 'Unavailable';
    default: return 'Unknown';
  }
}

function connectorTone(status: Connector['status']): { bg: string; text: string } {
  if (status === 'AVAILABLE') return { bg: '#dcfce7', text: '#166534' };
  if (status === 'CHARGING') return { bg: '#cffafe', text: '#0e7490' };
  if (status === 'PREPARING') return { bg: '#dbeafe', text: '#1d4ed8' };
  if (status === 'SUSPENDED_EV' || status === 'SUSPENDED_EVSE') return { bg: '#fef9c3', text: '#854d0e' };
  if (status === 'FAULTED') return { bg: '#fee2e2', text: '#b91c1c' };
  return { bg: '#e5e7eb', text: '#374151' };
}

function getLiveKwh(session: Session): number {
  if (session.kwhDelivered != null) return session.kwhDelivered;
  if (session.meterStop != null && session.meterStart != null) {
    return Math.max(0, (session.meterStop - session.meterStart) / 1000);
  }
  return 0;
}

type TouWindowMobile = { day: number; start: string; end: string; pricePerKwhUsd: number; idleFeePerMinUsd: number };
function toMinutes(v: string): number {
  const [h, m] = String(v).split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return -1;
  return h * 60 + m;
}
function parseTouWindows(raw: unknown): TouWindowMobile[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((w: any) => ({
      day: Number(w?.day ?? 0),
      start: String(w?.start ?? '00:00'),
      end: String(w?.end ?? '00:00'),
      pricePerKwhUsd: Number(w?.pricePerKwhUsd ?? 0),
      idleFeePerMinUsd: Number(w?.idleFeePerMinUsd ?? 0),
    }))
    .filter((w) => w.day >= 0 && w.day <= 6 && toMinutes(w.start) >= 0 && (toMinutes(w.end) > toMinutes(w.start) || w.end === '23:59'))
    .sort((a, b) => a.day - b.day || toMinutes(a.start) - toMinutes(b.start));
}
function currentTouWindow(windows: TouWindowMobile[]): TouWindowMobile | null {
  const now = new Date();
  const d = now.getDay();
  const mins = now.getHours() * 60 + now.getMinutes();
  return windows.find((w) => {
    if (w.day !== d) return false;
    const s = toMinutes(w.start);
    const e = w.end === '23:59' ? 24 * 60 : toMinutes(w.end);
    return mins >= s && mins < e;
  }) ?? null;
}

function SlideToStart({
  disabled,
  isDark,
  onComplete,
  label = 'Slide to charge',
}: {
  disabled?: boolean;
  isDark: boolean;
  onComplete: () => void;
  label?: string;
}) {
  const knobSize = 56;
  const [trackWidth, setTrackWidth] = useState(320);
  const maxX = Math.max(trackWidth - knobSize, 0);
  const x = useRef(new Animated.Value(0)).current;
  const valueRef = useRef(0);
  useEffect(() => {
    const sub = x.addListener(({ value }) => {
      valueRef.current = value;
    });
    return () => x.removeListener(sub);
  }, [x]);

  useEffect(() => {
    if (valueRef.current > maxX) {
      x.setValue(maxX);
    }
  }, [maxX, x]);

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !disabled,
        onMoveShouldSetPanResponder: () => !disabled,
        onPanResponderMove: (_, g) => x.setValue(Math.max(0, Math.min(maxX, g.dx))),
        onPanResponderRelease: () => {
          if (valueRef.current >= maxX * 0.85) {
            Animated.timing(x, { toValue: maxX, duration: 110, useNativeDriver: true }).start(() => {
              onComplete();
              Animated.spring(x, { toValue: 0, useNativeDriver: true }).start();
            });
          } else {
            Animated.spring(x, { toValue: 0, useNativeDriver: true }).start();
          }
        },
      }),
    [disabled, maxX, onComplete, x],
  );

  return (
    <View
      onLayout={(e) => {
        const w = e.nativeEvent.layout.width;
        if (w > 0 && Math.abs(w - trackWidth) > 1) setTrackWidth(w);
      }}
      style={[
        styles.slideTrack,
        {
          backgroundColor: isDark ? '#1f2937' : '#ffffff',
          borderColor: isDark ? '#374151' : '#d1d5db',
          opacity: disabled ? 0.45 : 1,
          width: '100%',
        },
      ]}
    >
      <Text style={[styles.slideLabel, { color: isDark ? '#d1d5db' : '#374151' }]}>{label}</Text>
      <Animated.View {...pan.panHandlers} style={[styles.slideKnob, { transform: [{ translateX: x }] }]}>
        <Image
          source={require('../../../assets/branding/lumeo_logo_swirl_only.png')}
          style={styles.slideKnobLogo}
          resizeMode="contain"
        />
      </Animated.View>
    </View>
  );
}

function TopMetricsHero({
  isDark,
  totalKwh,
  elapsed,
  costUsd,
  powerKw,
  isFlowing,
  chargerName,
  chargerStatus,
  haloMode,
  forceWhiteText,
}: {
  isDark: boolean;
  totalKwh: number;
  elapsed: string;
  costUsd: number;
  powerKw: number;
  isFlowing: boolean;
  chargerName: string;
  chargerStatus: string;
  haloMode: 'available' | 'charging' | 'faulted' | 'idle' | 'awaitingPlug';
  forceWhiteText?: boolean;
}) {
  const travel = useRef(new Animated.Value(0)).current;
  const haloBlink = useRef(new Animated.Value(1)).current;
  const [streamTrackWidth, setStreamTrackWidth] = useState(290);

  useEffect(() => {
    let loop: Animated.CompositeAnimation | null = null;
    if (isFlowing) {
      travel.setValue(0);
      loop = Animated.loop(
        Animated.sequence([
          Animated.timing(travel, {
            toValue: 1,
            duration: 1250,
            easing: Easing.linear,
            useNativeDriver: true,
          }),
          Animated.timing(travel, {
            toValue: 0,
            duration: 1,
            useNativeDriver: true,
          }),
        ]),
      );
      loop.start();
    } else {
      travel.stopAnimation();
      travel.setValue(0);
    }
    return () => loop?.stop();
  }, [isFlowing, travel]);

  useEffect(() => {
    let loop: Animated.CompositeAnimation | null = null;
    if (haloMode === 'charging') {
      loop = Animated.loop(
        Animated.sequence([
          Animated.timing(haloBlink, { toValue: 0.35, duration: 520, useNativeDriver: true }),
          Animated.timing(haloBlink, { toValue: 1, duration: 520, useNativeDriver: true }),
        ]),
      );
      loop.start();
    } else {
      haloBlink.stopAnimation();
      haloBlink.setValue(1);
    }
    return () => loop?.stop();
  }, [haloMode, haloBlink]);

  const streamDotWidth = 24;
  const streamX = travel.interpolate({
    inputRange: [0, 1],
    outputRange: [0, Math.max(streamTrackWidth - streamDotWidth, 0)],
  });

  const haloColor =
    haloMode === 'faulted'
      ? '#dc2626'
      : haloMode === 'charging'
        ? '#0891b2'
        : haloMode === 'idle'
          ? '#d97706'
          : haloMode === 'awaitingPlug'
            ? '#16a34a'
            : '#16a34a';

  const valueColor = forceWhiteText ? '#ffffff' : isDark ? '#f9fafb' : '#0b1220';
  const labelColor = forceWhiteText ? '#e5e7eb' : isDark ? '#9ca3af' : '#475569';

  return (
    <View style={[styles.metricsHeroCard, { backgroundColor: isDark ? '#0b1220' : '#f8fbff' }]}>
      {/* 30% glow bloom behind the ring — blinks in sync with ring */}
      <Animated.View pointerEvents="none" style={[styles.haloGlowOverlay, { shadowColor: haloColor, opacity: haloBlink }]} />
      {/* Crisp halo ring — sits outside tile so tile edge is never exposed */}
      <Animated.View pointerEvents="none" style={[styles.haloRingOverlay, { borderColor: haloColor, shadowColor: haloColor, opacity: haloBlink }]} />
      <View style={styles.metricsGrid}>
        <View style={[styles.metricTile, { backgroundColor: isDark ? '#111827' : '#ffffff' }]}>
          <Text style={[styles.metricLabel, { color: labelColor }]}>Total kWh</Text>
          <Text style={[styles.metricValue, { color: valueColor }]}>{formatKwh(totalKwh)}</Text>
        </View>
        <View style={[styles.metricTile, { backgroundColor: isDark ? '#111827' : '#ffffff' }]}>
          <Text style={[styles.metricLabel, { color: labelColor }]}>Time elapsed</Text>
          <Text style={[styles.metricValue, { color: valueColor }]}>{elapsed}</Text>
        </View>
        <View style={[styles.metricTile, { backgroundColor: isDark ? '#111827' : '#ffffff' }]}>
          <Text style={[styles.metricLabel, { color: labelColor }]}>Cost</Text>
          <Text style={[styles.metricValue, { color: valueColor }]}>${costUsd.toFixed(2)}</Text>
        </View>
        <View style={[styles.metricTile, { backgroundColor: isDark ? '#111827' : '#ffffff' }]}>
          <Text style={[styles.metricLabel, { color: labelColor }]}>Power</Text>
          <Text style={[styles.metricValue, { color: valueColor }]}>{powerKw.toFixed(1)} kW</Text>
        </View>
      </View>

      <View style={styles.chargerIdentityWrap}>
        <Text style={[styles.chargerNameText, { color: valueColor }]} numberOfLines={1}>{chargerName}</Text>
        <View style={styles.statusRow}>
          <View style={[styles.statusDot, { backgroundColor: haloColor }]} />
          <Text style={[styles.chargerStatusText, { color: labelColor }]}>{chargerStatus}</Text>
        </View>
      </View>

      {isFlowing ? (
        <View style={styles.chargingAnimWrap}>
          <View
            style={styles.energyStreamTrack}
            onLayout={(e) => setStreamTrackWidth(e.nativeEvent.layout.width || 290)}
          >
            <Animated.View style={[styles.energyStreamDot, { transform: [{ translateX: streamX }] }]} />
          </View>
          <View style={styles.liveSessionBadge}>
            <Text style={[styles.liveSessionHeader, { color: isDark ? '#67e8f9' : '#0e7490' }]}>LIVE SESSION</Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

export default function ChargerStartScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { isDark } = useAppTheme();
  const { isGuest, loading: authLoading } = useAppAuth();
  const { toggle, isFav } = useFavorites();

  const [siteExpanded, setSiteExpanded] = useState(false);
  const [manualRefreshing, setManualRefreshing] = useState(false);

  const { data: charger, isLoading, refetch } = useQuery({
    queryKey: ['charger', id],
    queryFn: () => api.chargers.get(id),
    refetchInterval: 2500,
    staleTime: 0,
  });

  const { data: sessionsData } = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api.sessions.list(20, 0),
    refetchInterval: 2500,
    staleTime: 0,
  });

  const { data: profile } = useQuery({
    queryKey: ['me-profile'],
    queryFn: () => api.profile.get(),
    enabled: !isGuest,
  });

  const activeSession = useMemo(
    () => sessionsData?.sessions.find((s) => s.status === 'ACTIVE' && s.connector.charger.id === id) ?? null,
    [sessionsData, id],
  );

  const [elapsedNowMs, setElapsedNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!activeSession) return;
    const t = setInterval(() => setElapsedNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [activeSession?.id]);

  const activeConnectorStatus = useMemo(() => {
    if (!activeSession || !charger) return null;
    return charger.connectors.find((c) => c.connectorId === activeSession.connector.connectorId)?.status ?? null;
  }, [activeSession, charger]);

  const isFlowing = Boolean(activeSession && activeConnectorStatus === 'CHARGING');

  const [starting, setStarting] = useState<number | null>(null);
  const [selectedConnectorId, setSelectedConnectorId] = useState<number | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [showActivationModal, setShowActivationModal] = useState(false);
  const [activationDeadlineMs, setActivationDeadlineMs] = useState<number | null>(null);
  const [countdownText, setCountdownText] = useState('02:00');
  const [activationTimedOut, setActivationTimedOut] = useState(false);
  const [activationModalDismissed, setActivationModalDismissed] = useState(false);
  const [awaitingPlugIn, setAwaitingPlugIn] = useState(false);
  const activationPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activationModalDismissedRef = useRef(false);

  useEffect(() => {
    if (!isFlowing) return;
    if (activationPollRef.current) {
      clearTimeout(activationPollRef.current);
      activationPollRef.current = null;
    }
    setShowActivationModal(false);
    setActivationDeadlineMs(null);
    setActivationTimedOut(false);
    setActivationModalDismissed(false);
    setAwaitingPlugIn(false);
  }, [isFlowing]);

  // Reset activation state when charger returns to Available with no active session
  const preferredConnector = useMemo(
    () => charger?.connectors.find((c) => c.status === 'AVAILABLE' || c.status === 'PREPARING' || c.status === 'SUSPENDED_EV') ?? null,
    [charger],
  );

  useEffect(() => {
    if (!charger) return;
    if (charger.connectors.length === 1) {
      setSelectedConnectorId(charger.connectors[0]?.connectorId ?? null);
      return;
    }
    if (selectedConnectorId == null || !charger.connectors.some((c) => c.connectorId === selectedConnectorId)) {
      setSelectedConnectorId(preferredConnector?.connectorId ?? charger.connectors[0]?.connectorId ?? null);
    }
  }, [charger, preferredConnector, selectedConnectorId]);

  const selectedConnector = useMemo(() => {
    if (!charger) return null;
    if (charger.connectors.length === 1) return charger.connectors[0] ?? null;
    return charger.connectors.find((c) => c.connectorId === selectedConnectorId) ?? preferredConnector;
  }, [charger, preferredConnector, selectedConnectorId]);

  // Reset activation UI when connector returns to AVAILABLE
  // (covers the activation-timeout / no EV connected scenario)
  useEffect(() => {
    if (activeSession) return;
    if (selectedConnector?.status === 'AVAILABLE') {
      if (activationPollRef.current) {
        clearTimeout(activationPollRef.current);
        activationPollRef.current = null;
      }
      setActivationTimedOut(false);
      setShowActivationModal(false);
      setActivationDeadlineMs(null);
      setActivationModalDismissed(false);
      setAwaitingPlugIn(false);
    }
  }, [activeSession, selectedConnector?.status]);

  useEffect(() => {
    if (!showActivationModal || !activationDeadlineMs) return;
    const tick = () => {
      const remain = Math.max(0, activationDeadlineMs - Date.now());
      const totalSec = Math.ceil(remain / 1000);
      const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
      const ss = String(totalSec % 60).padStart(2, '0');
      setCountdownText(`${mm}:${ss}`);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [showActivationModal, activationDeadlineMs]);

  useEffect(() => {
    activationModalDismissedRef.current = activationModalDismissed;
  }, [activationModalDismissed]);

  useFocusEffect(
    useCallback(() => {
      queryClient.invalidateQueries({ queryKey: ['charger', id] });
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      return undefined;
    }, [id, queryClient]),
  );

  const onPullRefresh = useCallback(async () => {
    setManualRefreshing(true);
    try {
      await Promise.all([
        refetch(),
        queryClient.invalidateQueries({ queryKey: ['sessions'] }),
      ]);
    } finally {
      setManualRefreshing(false);
    }
  }, [queryClient, refetch]);

  useEffect(() => {
    return () => {
      if (activationPollRef.current) clearTimeout(activationPollRef.current);
    };
  }, []);

  const startMutation = useMutation({
    mutationFn: async ({ chargerId, connectorId }: { chargerId: string; connectorId: number }) => {
      const result = await api.sessions.start(chargerId, connectorId);
      if (!result.accepted) {
        throw new Error('Charger did not accept the remote start command.');
      }
      return result;
    },
    onMutate: ({ connectorId }) => {
      if (activationPollRef.current) {
        clearTimeout(activationPollRef.current);
        activationPollRef.current = null;
      }
      setShowActivationModal(false);
      setActivationDeadlineMs(null);
      setCountdownText('02:00');
      setActivationTimedOut(false);
      setActivationModalDismissed(false);
      setAwaitingPlugIn(true);
      setStartError(null);
      setStarting(connectorId);
    },
    onSettled: () => setStarting(null),
    onSuccess: async (_, variables) => {
      await queryClient.invalidateQueries({ queryKey: ['sessions'] });
      await queryClient.invalidateQueries({ queryKey: ['charger', id] });

      const startedAt = Date.now();
      const timeoutMs = 120000;
      const modalDisplayDelayMs = 2000;

      const pollForChargingTransition = async () => {
        try {
          const [sessionRes, freshCharger] = await Promise.all([
            api.sessions.list(20, 0),
            api.chargers.get(variables.chargerId),
          ]);

          const hasActiveSession = sessionRes.sessions.some(
            (s) =>
              s.status === 'ACTIVE' &&
              s.connector.charger.id === variables.chargerId &&
              s.connector.connectorId === variables.connectorId,
          );

          if (hasActiveSession) {
            setShowActivationModal(false);
            setActivationDeadlineMs(null);
            setActivationTimedOut(false);
            setActivationModalDismissed(false);
            return;
          }

          const connector = freshCharger.connectors.find((c) => c.connectorId === variables.connectorId);
          const connectorIsCharging = connector?.status === 'CHARGING';
          const isPreparingWithoutCharging = connector?.status === 'PREPARING' || connector?.status === 'SUSPENDED_EV';
          const connectorIsAvailable = connector?.status === 'AVAILABLE';

          if (connectorIsCharging) {
            setShowActivationModal(false);
            setActivationDeadlineMs(null);
            setActivationTimedOut(false);
            setActivationModalDismissed(false);
            setAwaitingPlugIn(false);
            return;
          }

          // Charger returned to AVAILABLE — no vehicle plugged in; clean up
          if (connectorIsAvailable && Date.now() - startedAt >= 3000) {
            setShowActivationModal(false);
            setActivationDeadlineMs(null);
            setActivationTimedOut(false);
            setActivationModalDismissed(false);
            setAwaitingPlugIn(false);
            return;
          }

          if (isPreparingWithoutCharging) {
            if (!activationModalDismissedRef.current && Date.now() - startedAt >= modalDisplayDelayMs) {
              setShowActivationModal(true);
            }
            setActivationDeadlineMs(startedAt + timeoutMs);
            setActivationTimedOut(false);
          }

          if (Date.now() - startedAt >= timeoutMs) {
            setShowActivationModal(false);
            setActivationDeadlineMs(null);
            setActivationTimedOut(true);
            setAwaitingPlugIn(false);
            return;
          }

          activationPollRef.current = setTimeout(pollForChargingTransition, 1500);
        } catch {
          if (Date.now() - startedAt >= timeoutMs) {
            setShowActivationModal(false);
            setActivationDeadlineMs(null);
            setActivationTimedOut(true);
            return;
          }
          activationPollRef.current = setTimeout(pollForChargingTransition, 1500);
        }
      };

      activationPollRef.current = setTimeout(pollForChargingTransition, 1000);
    },
    onError: (err: Error) => {
      if (activationPollRef.current) {
        clearTimeout(activationPollRef.current);
        activationPollRef.current = null;
      }
      setShowActivationModal(false);
      setActivationDeadlineMs(null);
      setActivationTimedOut(false);
      setAwaitingPlugIn(false);
      const message = err.message || 'Unable to start charging right now.';
      setStartError(message);

      const lower = message.toLowerCase();
      if (lower.includes('unauthorized') || lower.includes('forbidden') || lower.includes('401') || lower.includes('403')) {
        Alert.alert(
          'Session expired',
          'Please sign in again to start charging.',
          [{ text: 'Go to Sign In', onPress: () => router.replace('/(auth)/sign-in' as any) }, { text: 'Cancel', style: 'cancel' }],
        );
        return;
      }

      Alert.alert('Failed to Start', message);
    },
  });

  const stopMutation = useMutation({
    mutationFn: (sessionId: string) => api.sessions.stop(sessionId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['sessions'] });
      await queryClient.invalidateQueries({ queryKey: ['charger', id] });
    },
    onError: (err: Error) => Alert.alert('Stop Failed', err.message),
  });

  function handleStart(connector: Connector) {
    setStartError(null);
    if (authLoading) return;
    if (isGuest) {
      Alert.alert('Sign in required', 'Please sign in before starting a charging session.');
      return;
    }
    if (!charger) return;
    if (!['AVAILABLE', 'PREPARING', 'SUSPENDED_EV'].includes(connector.status)) {
      Alert.alert('Connector not ready', 'Selected connector is not ready. Please choose a ready connector.');
      return;
    }
    startMutation.mutate({ chargerId: charger.id, connectorId: connector.connectorId });
  }

  function confirmStop() {
    if (!activeSession) return;
    const kwh = getLiveKwh(activeSession);
    const est = kwh * Number(activeSession.ratePerKwh ?? charger?.site.pricePerKwhUsd ?? 0.35);
    Alert.alert('Stop charging?', `You've used ${formatKwh(kwh)} kWh (~$${est.toFixed(2)}).`, [
      { text: 'Keep charging', style: 'cancel' },
      { text: 'Stop session', style: 'destructive', onPress: () => stopMutation.mutate(activeSession.id) },
    ]);
  }

  if (isLoading || !charger) {
    return (
      <>
        <Stack.Screen
          options={{
            title: 'Lumeo',
            headerShown: true,
            headerStyle: { backgroundColor: isDark ? '#0b1220' : '#ffffff' },
            headerTintColor: isDark ? '#f9fafb' : '#111827',
            headerShadowVisible: false,
            headerTitleStyle: {
              color: isDark ? '#ffffff' : '#000000',
              fontWeight: '300',
              letterSpacing: 1.5,
              fontSize: 22,
            } as any,
            gestureEnabled: false,
            headerBackButtonDisplayMode: 'minimal',
            headerLeft: () => (
              <TouchableOpacity onPress={() => router.back()} style={{ paddingHorizontal: 4, paddingVertical: 4 }}>
                <Ionicons name="chevron-back" size={30} color={isDark ? '#ffffff' : '#111827'} />
              </TouchableOpacity>
            ),
            headerRight: () => <View style={{ width: 40, height: 40 }} />,
          }}
        />
        <View style={styles.centered}>
          <ActivityIndicator color="#10b981" />
        </View>
      </>
    );
  }

  const pricePerKwhUsd = Number(charger.site.pricePerKwhUsd ?? 0.35);
  const idleFeePerMinUsd = Number(charger.site.idleFeePerMinUsd ?? 0);
  const activationFeeUsd = Number((charger.site as any).activationFeeUsd ?? 0);
  const pricingMode = String((charger.site as any).pricingMode ?? 'flat');
  const touWindows = parseTouWindows((charger.site as any).touWindows);
  const nowTou = currentTouWindow(touWindows);
  const displayedEnergyRate = pricingMode === 'tou' && nowTou ? nowTou.pricePerKwhUsd : pricePerKwhUsd;
  const displayedIdleRate = pricingMode === 'tou' && nowTou ? nowTou.idleFeePerMinUsd : idleFeePerMinUsd;

  const liveKwh = activeSession ? getLiveKwh(activeSession) : 0;
  const liveRate = Number(activeSession?.ratePerKwh ?? pricePerKwhUsd);
  const liveCost = liveKwh * liveRate;
  const elapsed = activeSession ? formatDuration(activeSession.startedAt, null, elapsedNowMs) : '00:00';
  const livePowerKw = activeSession && activeSession.powerActiveImportW != null
    ? Math.max(0, Number(activeSession.powerActiveImportW) / 1000)
    : 0;
  const topChargerStatus = selectedConnector ? connectorStatusLabel(selectedConnector.status) : 'Unknown';
  const statusRaw = selectedConnector?.status ?? null;
  // When the connector is back to AVAILABLE with no active session, always show
  // the idle/available state — never stay in awaitingPlug after a timeout.
  const haloMode: 'available' | 'charging' | 'faulted' | 'idle' | 'awaitingPlug' =
    statusRaw === 'AVAILABLE' && !activeSession && !awaitingPlugIn
      ? 'available'
      : awaitingPlugIn
        ? 'awaitingPlug'
        : statusRaw === 'FAULTED' || statusRaw === 'UNAVAILABLE'
          ? 'faulted'
          : statusRaw === 'CHARGING'
            ? 'charging'
            : statusRaw === 'PREPARING' || statusRaw === 'FINISHING' || statusRaw === 'SUSPENDED_EV' || statusRaw === 'SUSPENDED_EVSE'
              ? 'idle'
              : 'available';
  const sliderLabel = activeSession
    ? 'Slide to stop'
    : awaitingPlugIn
      ? 'Plug in to start'
      : 'Slide to charge';
  const paymentLabel = profile?.paymentProfile?.trim() || '';
  const hasPaymentMethod = Boolean(paymentLabel);

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Lumeo',
          headerShown: true,
          headerStyle: { backgroundColor: isDark ? '#0b1220' : '#ffffff' },
          headerTintColor: isDark ? '#f9fafb' : '#111827',
          headerShadowVisible: false,
          headerTitleStyle: {
            color: isDark ? '#ffffff' : '#000000',
            fontWeight: '300',
            letterSpacing: 1.5,
            fontSize: 22,
          } as any,
          gestureEnabled: false,
          headerBackButtonDisplayMode: 'minimal',
          headerLeft: () => (
            <TouchableOpacity onPress={() => router.back()} style={{ paddingHorizontal: 4, paddingVertical: 4 }}>
              <Ionicons name="chevron-back" size={30} color={isDark ? '#ffffff' : '#111827'} />
            </TouchableOpacity>
          ),
          headerRight: () => (
            <View style={{ width: 40, alignItems: 'flex-end' }}>
              <HeartButton
                isFavorited={isFav(charger.id)}
                onToggle={async () => {
                  try {
                    await toggle(charger.id);
                  } catch (e) {
                    Alert.alert('Favorites update failed', e instanceof Error ? e.message : 'Please sign in again and retry.');
                  }
                }}
              />
            </View>
          ),
        }}
      />

      <ScrollView
        style={[styles.container, { backgroundColor: isDark ? '#030712' : '#f8fafc' }]}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={manualRefreshing} onRefresh={onPullRefresh} />}
      >
        <TopMetricsHero
          isDark={isDark}
          totalKwh={liveKwh}
          elapsed={elapsed}
          costUsd={liveCost}
          powerKw={livePowerKw}
          isFlowing={isFlowing}
          chargerName={charger.ocppId}
          chargerStatus={topChargerStatus}
          haloMode={haloMode}
          forceWhiteText={haloMode === 'awaitingPlug'}
        />

        <View style={styles.bottomDock}>
          <View style={[styles.heroCard, { backgroundColor: isDark ? '#111827' : '#ffffff' }]}>
            <TouchableOpacity style={styles.collapseHeader} onPress={() => setSiteExpanded((v) => !v)} activeOpacity={0.9}>
              <Text style={[styles.collapseTitle, { color: isDark ? '#f9fafb' : '#111827' }]}>Site information</Text>
              <Text style={[styles.collapseChevron, { color: isDark ? '#cbd5e1' : '#475569' }]}>{siteExpanded ? '▴' : '▾'}</Text>
            </TouchableOpacity>

            {siteExpanded ? (
              <>
                <Text style={[styles.heroTitle, { color: isDark ? '#f9fafb' : '#111827' }]}>{charger.site.name}</Text>
                <Text style={[styles.heroSubtitle, { color: isDark ? '#9ca3af' : '#6b7280' }]}>{charger.site.address}</Text>
              </>
            ) : null}

            {pricingMode === 'tou' && touWindows.length > 0 ? (
              <View style={[styles.touCompact, { backgroundColor: isDark ? '#1e293b' : '#f8fafc', borderColor: isDark ? '#334155' : '#d1d5db' }]}>
                <Text style={[styles.touCompactTitle, { color: isDark ? '#bfdbfe' : '#000000' }]}>TOU pricing</Text>

                <View style={styles.priceTilesRow}>
                  <View style={[styles.priceTile, { backgroundColor: isDark ? '#0f172a' : '#ffffff' }]}>
                    <Text style={[styles.priceTileLabel, { color: isDark ? '#9ca3af' : '#64748b' }]}>Activation</Text>
                    <Text style={[styles.priceTileValue, { color: isDark ? '#f9fafb' : '#0f172a' }]}>${activationFeeUsd.toFixed(2)}</Text>
                  </View>
                  <View style={[styles.priceTile, { backgroundColor: isDark ? '#0f172a' : '#ffffff' }]}>
                    <Text style={[styles.priceTileLabel, { color: isDark ? '#9ca3af' : '#64748b' }]}>Energy (now)</Text>
                    <Text style={[styles.priceTileValue, { color: isDark ? '#f9fafb' : '#0f172a' }]}>${displayedEnergyRate.toFixed(2)}/kWh</Text>
                  </View>
                  <View style={[styles.priceTile, { backgroundColor: isDark ? '#0f172a' : '#ffffff' }]}>
                    <Text style={[styles.priceTileLabel, { color: isDark ? '#9ca3af' : '#64748b' }]}>Idle (now)</Text>
                    <Text style={[styles.priceTileValue, { color: isDark ? '#f9fafb' : '#0f172a' }]}>${displayedIdleRate.toFixed(2)}/min</Text>
                  </View>
                </View>
              </View>
            ) : (
              <View style={styles.priceTilesRow}>
                <View style={[styles.priceTile, { backgroundColor: isDark ? '#0f172a' : '#f1f5f9' }]}> 
                  <Text style={[styles.priceTileLabel, { color: isDark ? '#9ca3af' : '#64748b' }]}>Energy</Text>
                  <Text style={[styles.priceTileValue, { color: isDark ? '#f9fafb' : '#0f172a' }]}>${displayedEnergyRate.toFixed(2)}/kWh</Text>
                </View>
                <View style={[styles.priceTile, { backgroundColor: isDark ? '#0f172a' : '#f1f5f9' }]}> 
                  <Text style={[styles.priceTileLabel, { color: isDark ? '#9ca3af' : '#64748b' }]}>Idle</Text>
                  <Text style={[styles.priceTileValue, { color: isDark ? '#f9fafb' : '#0f172a' }]}>${displayedIdleRate.toFixed(2)}/min</Text>
                </View>
                <View style={[styles.priceTile, { backgroundColor: isDark ? '#0f172a' : '#f1f5f9' }]}> 
                  <Text style={[styles.priceTileLabel, { color: isDark ? '#9ca3af' : '#64748b' }]}>Activation</Text>
                  <Text style={[styles.priceTileValue, { color: isDark ? '#f9fafb' : '#0f172a' }]}>${activationFeeUsd.toFixed(2)}</Text>
                </View>
              </View>
            )}


          </View>

          <View style={[styles.startCard, { backgroundColor: isDark ? '#111827' : '#ffffff' }]}>
            {!activeSession ? (
              <TouchableOpacity
                style={[styles.paymentCard, { backgroundColor: isDark ? '#0f172a' : '#f8fafc', borderColor: isDark ? '#334155' : '#cbd5e1' }]}
                onPress={() => router.push('/profile/payment' as any)}
                activeOpacity={0.9}
              >
                <Text style={[styles.paymentCardTitle, { color: isDark ? '#f8fafc' : '#0f172a' }]}>Payment Method</Text>
                <Text style={[styles.paymentCardBody, { color: isDark ? '#cbd5e1' : '#334155' }]}>
                  {hasPaymentMethod ? paymentLabel : 'No payment method added yet'}
                </Text>
                <Text style={[styles.paymentCardHint, { color: isDark ? '#93c5fd' : '#1d4ed8' }]}>
                  {hasPaymentMethod ? 'Tap to change card or add a new card' : 'Tap to add a payment card'}
                </Text>
              </TouchableOpacity>
            ) : null}

            <SlideToStart
              isDark={isDark}
              disabled={activeSession ? stopMutation.isPending : (starting != null || !selectedConnector)}
              label={sliderLabel}
              onComplete={() => {
                if (activeSession) {
                  confirmStop();
                  return;
                }
                if (!selectedConnector) {
                  setStartError('No ready connector is available right now.');
                  return;
                }
                handleStart(selectedConnector);
              }}
            />

            {!activeSession && !selectedConnector ? (
              <Text style={[styles.subText, { color: isDark ? '#fca5a5' : '#b91c1c' }]}>No connector is ready yet. Pull to refresh and try again.</Text>
            ) : null}

            {!activeSession && starting ? <Text style={[styles.subText, { color: isDark ? '#a7f3d0' : '#065f46' }]}>Sending start command to connector {starting}…</Text> : null}
            {!activeSession && startError ? <Text style={[styles.subText, { color: isDark ? '#fca5a5' : '#b91c1c' }]}>{startError}</Text> : null}
          </View>
        </View>

        <Modal
          visible={showActivationModal}
          transparent
          animationType="fade"
          onRequestClose={() => {
            setActivationModalDismissed(true);
            setShowActivationModal(false);
          }}
        >
          <TouchableOpacity
            activeOpacity={1}
            style={styles.modalBackdrop}
            onPress={() => {
              setActivationModalDismissed(true);
              setShowActivationModal(false);
            }}
          >
            <TouchableOpacity activeOpacity={1} onPress={() => {}} style={[styles.modalCard, { backgroundColor: isDark ? '#0f172a' : '#ffffff' }]}>
              <View style={styles.modalImageViewport}>
                <Image
                  source={require('../../../assets/activation-visual.jpg')}
                  style={styles.modalGifFallback}
                  resizeMode="cover"
                />
              </View>
              <Text style={[styles.modalTitle, { color: isDark ? '#f8fafc' : '#0f172a' }]}>Charger activated</Text>
              <Text style={[styles.modalTimer, { color: isDark ? '#86efac' : '#047857' }]}>Activation window: {countdownText}</Text>
              <Text style={[styles.modalText, { color: isDark ? '#cbd5e1' : '#334155' }]}>
                Please connect the charger plug to your vehicle. We'll keep checking for up to 2 minutes.
              </Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </Modal>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { flexGrow: 1, padding: 16, paddingBottom: 22 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  metricsHeroCard: {
    borderRadius: 18,
    padding: 18,
    gap: 14,
    borderWidth: 0,
    borderColor: 'transparent',
    shadowOpacity: 0,
    elevation: 0,
    overflow: 'visible',
  },
  // 30% glow bloom — sits furthest out, soft and wide
  haloGlowOverlay: {
    position: 'absolute',
    top: -14,
    left: -14,
    right: -14,
    bottom: -14,
    borderRadius: 32,
    borderWidth: 0,
    backgroundColor: 'transparent',
    shadowOpacity: 0.30,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 0 },
    elevation: 0,
  },
  // Crisp halo ring — sits just outside tile edge so tile edge is never visible
  haloRingOverlay: {
    position: 'absolute',
    top: -3,
    left: -3,
    right: -3,
    bottom: -3,
    borderRadius: 21,
    borderWidth: 3,
    shadowOpacity: 0.85,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 0 },
    elevation: 8,
  },
  metricsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  metricTile: {
    width: '48.5%',
    borderRadius: 14,
    paddingVertical: 15,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    alignItems: 'center',
  },
  metricLabel: { fontSize: 13, fontWeight: '700', textAlign: 'center' },
  metricValue: { fontSize: 30, fontWeight: '900', marginTop: 6, textAlign: 'center' },
  chargingAnimWrap: {
    width: '100%',
    borderRadius: 12,
    paddingTop: 10,
    paddingBottom: 8,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  liveSessionBadge: {
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: '#22d3ee22',
  },
  liveSessionHeader: {
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  energyStreamTrack: {
    width: '100%',
    height: 4,
    borderRadius: 999,
    backgroundColor: '#22d3ee30',
    overflow: 'hidden',
  },
  energyStreamDot: {
    width: 24,
    height: 4,
    borderRadius: 999,
    backgroundColor: '#22d3ee',
  },
  chargingIcon: { fontSize: 26 },
  chargingLabel: { marginTop: 4, fontSize: 13, fontWeight: '800' },
  chargerIdentityWrap: { alignItems: 'center', gap: 2, marginTop: 2 },
  chargerNameText: { fontSize: 16, fontWeight: '900' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  chargerStatusText: { fontSize: 13, fontWeight: '700', textTransform: 'capitalize' },

  heroVisualCard: {
    height: 260,
    borderRadius: 20,
    paddingHorizontal: 18,
    paddingVertical: 20,
    marginBottom: 16,
    justifyContent: 'center',
  },
  chargerBody: {
    position: 'absolute',
    left: 24,
    top: 66,
    width: 48,
    height: 118,
    borderRadius: 12,
    backgroundColor: '#0f766e',
    alignItems: 'center',
    paddingTop: 12,
  },
  chargerScreen: { width: 26, height: 16, borderRadius: 5, backgroundColor: '#a7f3d0' },
  chargerPort: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#e2e8f0',
    position: 'absolute',
    bottom: 10,
  },
  cableTrack: {
    position: 'absolute',
    left: 74,
    top: 126,
    width: 150,
    height: 4,
    borderRadius: 2,
  },
  flowBolt: {
    position: 'absolute',
    left: 74,
    top: 110,
  },
  flowBoltText: { fontSize: 17 },
  flowLabel: {
    position: 'absolute',
    left: 24,
    right: 24,
    top: 24,
    textAlign: 'center',
    fontWeight: '700',
    fontSize: 13,
  },
  carBody: {
    position: 'absolute',
    right: 22,
    top: 92,
    width: 138,
    height: 62,
    borderRadius: 20,
    backgroundColor: '#1d4ed8',
  },
  carWindow: {
    position: 'absolute',
    left: 18,
    top: 12,
    width: 62,
    height: 20,
    borderRadius: 8,
    backgroundColor: '#bfdbfe',
  },
  carWheelLeft: {
    position: 'absolute',
    left: 20,
    bottom: -10,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#0f172a',
  },
  carWheelRight: {
    position: 'absolute',
    right: 20,
    bottom: -10,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#0f172a',
  },

  bottomDock: { marginTop: 'auto', gap: 12 },

  heroCard: { borderRadius: 18, padding: 14, gap: 10 },
  collapseHeader: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', position: 'relative' },
  collapseTitle: { fontSize: 15, fontWeight: '800' },
  collapseChevron: { fontSize: 18, fontWeight: '800', position: 'absolute', right: 0 },
  heroTitle: { fontSize: 18, fontWeight: '800', textAlign: 'center' },
  heroSubtitle: { fontSize: 13, marginTop: 2, textAlign: 'center' },

  touCompact: { borderWidth: 1, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 10, marginBottom: 8, gap: 8 },
  touCompactTitle: { fontSize: 12, fontWeight: '900', textAlign: 'center' },

  priceTilesRow: { flexDirection: 'row', gap: 8 },
  priceTile: { flex: 1, borderRadius: 12, paddingVertical: 9, paddingHorizontal: 8, alignItems: 'center', borderWidth: 1, borderColor: '#d1d5db' },
  priceTileLabel: { fontSize: 11, fontWeight: '700', textAlign: 'center' },
  priceTileValue: { fontSize: 14, fontWeight: '800', marginTop: 3, textAlign: 'center' },


  liveCard: { borderRadius: 18, padding: 16, gap: 8 },
  liveHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  liveBadge: { fontSize: 12, fontWeight: '900', letterSpacing: 0.6 },
  liveConnectorLabel: { fontSize: 12, fontWeight: '700' },
  liveValue: { fontSize: 40, fontWeight: '900', marginTop: 8 },
  liveSubline: { fontSize: 14, fontWeight: '600' },

  buttonDisabled: { opacity: 0.6 },

  startCard: { borderRadius: 18, padding: 16, gap: 10 },
  sectionTitle: { fontSize: 18, fontWeight: '800' },
  subText: { fontSize: 13 },
  paymentCard: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 4, alignItems: 'center' },
  paymentCardTitle: { fontSize: 13, fontWeight: '800', textAlign: 'center' },
  paymentCardBody: { fontSize: 13, fontWeight: '700', textAlign: 'center' },
  paymentCardHint: { fontSize: 12, fontWeight: '700', textAlign: 'center' },

  connectorRow: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 11,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  connectorTitle: { fontSize: 14, fontWeight: '800' },
  connectorMeta: { fontSize: 12, marginTop: 2 },
  statusPill: { borderRadius: 999, paddingVertical: 6, paddingHorizontal: 10 },
  statusPillText: { fontSize: 11, fontWeight: '800' },

  slideTrack: {
    height: 56,
    borderRadius: 28,
    justifyContent: 'center',
    paddingHorizontal: 0,
    overflow: 'hidden',
    alignSelf: 'stretch',
    marginTop: 8,
    borderWidth: 1,
  },
  slideLabel: { position: 'absolute', alignSelf: 'center', fontSize: 13, fontWeight: '800' },
  slideKnob: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
    overflow: 'hidden',
  },
  slideKnobLogo: { width: 48, height: 48 },

  modalBackdrop: {
    flex: 1,
    backgroundColor: '#00000088',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  modalCard: {
    width: '100%',
    borderRadius: 16,
    overflow: 'hidden',
  },
  modalImageViewport: {
    width: '100%',
    height: 190,
    overflow: 'hidden',
    backgroundColor: '#0b1220',
  },
  modalGifFallback: {
    width: '100%',
    height: 230,
    marginTop: -20,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '800',
    paddingHorizontal: 16,
    paddingTop: 14,
  },
  modalTimer: {
    fontSize: 13,
    fontWeight: '800',
    paddingHorizontal: 16,
    paddingTop: 6,
  },
  modalText: {
    fontSize: 14,
    lineHeight: 20,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 16,
  },
});
