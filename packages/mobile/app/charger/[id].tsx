/**
 * Charger detail screen - connector list, status, price per kWh, Start button.
 * Also handles Stripe payment setup (save card) before first session.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Alert,
  RefreshControl,
  Modal,
  Image,
} from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Charger, type Connector } from '@/lib/api';
import { useAppTheme } from '@/theme';
import { useFavorites } from '@/hooks/useFavorites';
import { HeartButton } from '@/components/HeartButton';
import { Ionicons } from '@expo/vector-icons';
import { useAppAuth } from '@/providers/AuthProvider';

const RATE_PER_KWH = 0.35; // fallback only

type TouWindowMobile = {
  day: number; // 0 Sun..6 Sat
  start: string; // HH:mm
  end: string;   // HH:mm|23:59
  pricePerKwhUsd: number;
  idleFeePerMinUsd: number;
};

function toMinutes(v: string): number {
  const [h, m] = String(v).split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return -1;
  return h * 60 + m;
}

function hour12(h: number): string {
  if (h === 0 || h === 24) return '12 AM';
  if (h === 12) return '12 PM';
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

function time12(v: string): string {
  const [hh, mm] = String(v).split(':');
  const h = Number(hh);
  if (!Number.isFinite(h)) return v;
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  if (mm === '00') return `${h12} ${suffix}`;
  return `${h12}:${mm} ${suffix}`;
}

function windowLabel12(start: string, end: string): string {
  const normalizedEnd = end === '23:59' ? '24:00' : end;
  if (normalizedEnd === '24:00') return `${time12(start)}-12 AM`;
  return `${time12(start)}-${time12(normalizedEnd)}`;
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
  const day = now.getDay();
  const mins = now.getHours() * 60 + now.getMinutes();
  return windows.find((w) => {
    if (w.day !== day) return false;
    const s = toMinutes(w.start);
    const e = w.end === '23:59' ? 24 * 60 : toMinutes(w.end);
    return mins >= s && mins < e;
  }) ?? null;
}

function chargerStatusLabel(charger: Charger): string {
  const statuses = charger.connectors.map((c) => c.status);
  if (statuses.some((s) => s === 'AVAILABLE')) return 'Available';
  if (statuses.some((s) => s === 'CHARGING' || s === 'PREPARING' || s === 'FINISHING' || s === 'SUSPENDED_EV' || s === 'SUSPENDED_EVSE')) return 'In Use';
  if (statuses.some((s) => s === 'FAULTED')) return 'Faulted';
  if (statuses.some((s) => s === 'UNAVAILABLE')) return 'Unavailable';
  if (String(charger.status || '').toUpperCase() === 'OFFLINE') return 'Offline';
  return 'Unknown';
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function ChargerDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [startingConnector, setStartingConnector] = useState<number | null>(null);
  const [activationMessage, setActivationMessage] = useState<string | null>(null);
  const [showActivationModal, setShowActivationModal] = useState(false);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const [activationDeadlineMs, setActivationDeadlineMs] = useState<number | null>(null);
  const [countdownText, setCountdownText] = useState('02:00');
  const activationPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startContextRef = useRef<{ alreadyPlugged: boolean } | null>(null);
  const { isDark } = useAppTheme();
  const { toggle, isFav } = useFavorites();
  const { isGuest, loading: authLoading } = useAppAuth();

  const { data: charger, isLoading, refetch } = useQuery({
    queryKey: ['charger', id],
    queryFn: () => api.chargers.get(id),
  });

  const { data: allChargers = [], refetch: refetchAllChargers } = useQuery({
    queryKey: ['chargers'],
    queryFn: () => api.chargers.list(),
  });

  const siteChargers = useMemo(() => {
    if (!charger) return [] as Charger[];
    return allChargers.filter((c) => c.site.id === charger.site.id);
  }, [allChargers, charger]);

  const [selectedChargerId, setSelectedChargerId] = useState<string | null>(null);
  const [showTouDetails, setShowTouDetails] = useState(false);

  useEffect(() => {
    if (!charger) return;
    if (!selectedChargerId) {
      setSelectedChargerId(charger.id);
      return;
    }
    if (!siteChargers.some((c) => c.id === selectedChargerId)) {
      setSelectedChargerId(charger.id);
    }
  }, [charger, selectedChargerId, siteChargers]);

  const selectedCharger = useMemo(() => {
    if (!charger) return null;
    return siteChargers.find((c) => c.id === selectedChargerId) ?? charger;
  }, [charger, selectedChargerId, siteChargers]);


  const { data: profile } = useQuery({
    queryKey: ['me-profile'],
    queryFn: () => api.profile.get(),
    enabled: !isGuest,
  });

  useFocusEffect(
    useCallback(() => {
      queryClient.invalidateQueries({ queryKey: ['charger', id] });
      queryClient.invalidateQueries({ queryKey: ['chargers'] });
      return undefined;
    }, [id, queryClient]),
  );

  const onPullRefresh = useCallback(async () => {
    setManualRefreshing(true);
    try {
      await Promise.all([refetch(), refetchAllChargers()]);
    } finally {
      setManualRefreshing(false);
    }
  }, [refetch, refetchAllChargers]);

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

  const startMutation = useMutation({
    mutationFn: ({ chargerId, connectorId }: { chargerId: string; connectorId: number }) =>
      api.sessions.start(chargerId, connectorId),
    onMutate: ({ connectorId }) => {
      setStartingConnector(connectorId);
      setActivationMessage(null);
      setShowActivationModal(false);
      setActivationDeadlineMs(null);
      setCountdownText('02:00');
    },
    onSettled: () => setStartingConnector(null),
    onSuccess: async (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['charger', id] });
      queryClient.invalidateQueries({ queryKey: ['sessions'] });

      const alreadyPlugged = startContextRef.current?.alreadyPlugged ?? false;
      if (alreadyPlugged) {
        setActivationMessage('Charger activated. Starting your session…');
        setShowActivationModal(false);
        setActivationDeadlineMs(null);
      } else {
        setActivationMessage('Your charger has been successfully activated. Please plug in the connector to your vehicle to start charging.');
        setShowActivationModal(true);
        setActivationDeadlineMs(Date.now() + 120000);
      }

      const startedAt = Date.now();
      const timeoutMs = 120000;

      const pollForSession = async () => {
        try {
          const res = await api.sessions.list(20, 0);
          const active = res.sessions.find(
            (s) =>
              s.status === 'ACTIVE' &&
              s.connector.charger.id === variables.chargerId &&
              s.connector.connectorId === variables.connectorId,
          );

          if (active) {
            setActivationMessage('Charging started. Opening live session…');
            setShowActivationModal(false);
            setActivationDeadlineMs(null);
            router.replace(`/charger/detail/${variables.chargerId}` as any);
            return;
          }

          if (Date.now() - startedAt >= timeoutMs) {
            setActivationMessage(null);
            setShowActivationModal(false);
            setActivationDeadlineMs(null);
            router.push('/(tabs)/sessions');
            return;
          }

          activationPollRef.current = setTimeout(pollForSession, 1500);
        } catch {
          if (Date.now() - startedAt >= timeoutMs) {
            setActivationMessage(null);
            setShowActivationModal(false);
            setActivationDeadlineMs(null);
            Alert.alert(
              'Could not confirm activation yet',
              'Network check failed while waiting for session creation. Please check History.',
              [{ text: 'Go to History', onPress: () => router.push('/(tabs)/sessions') }, { text: 'OK' }],
            );
            return;
          }
          activationPollRef.current = setTimeout(pollForSession, 1500);
        }
      };

      activationPollRef.current = setTimeout(pollForSession, 900);
    },
    onError: (err: Error) => {
      setActivationMessage(null);
      setShowActivationModal(false);
      setActivationDeadlineMs(null);
      const lower = err.message.toLowerCase();
      if (lower.includes('occupied') || lower.includes('in use')) {
        Alert.alert('Connector unavailable', 'This connector is currently occupied. Please choose another connector.');
        return;
      }
      if (lower.includes('timeout')) {
        Alert.alert('Activation timeout', 'The charger did not confirm start in time. Please try again.');
        return;
      }
      if (lower.includes('unauthorized') || lower.includes('forbidden')) {
        Alert.alert(
          'Sign in required',
          'Your session is not authenticated. Please sign in again, then retry.',
          [{ text: 'Go to Sign In', onPress: () => router.push('/(auth)/sign-in') }, { text: 'Cancel', style: 'cancel' }],
        );
        return;
      }
      Alert.alert('Failed to Start', err.message);
    },
  });

  useEffect(() => {
    return () => {
      if (activationPollRef.current) clearTimeout(activationPollRef.current);
    };
  }, []);

  function handleStartSession(
    chargerId: string,
    connectorId: number,
    connectorStatus: Connector['status'],
  ) {
    if (authLoading) {
      Alert.alert('Authenticating', 'Please wait a moment and try again.');
      return;
    }

    if (isGuest) {
      Alert.alert(
        'Sign in required',
        'Please sign in before starting a charging session.',
        [{ text: 'Go to Sign In', onPress: () => router.push('/(auth)/sign-in') }, { text: 'Cancel', style: 'cancel' }],
      );
      return;
    }

    if (activationPollRef.current) {
      clearTimeout(activationPollRef.current);
      activationPollRef.current = null;
    }
    startContextRef.current = {
      alreadyPlugged: connectorStatus === 'PREPARING' || connectorStatus === 'SUSPENDED_EV',
    };
    startMutation.mutate({ chargerId, connectorId });
  }

  if (isLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#10b981" />
      </View>
    );
  }

  if (!charger) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>Charger not found.</Text>
      </View>
    );
  }

  const siteAvailableChargers = siteChargers.filter((c) =>
    c.connectors.some((connector) => connector.status === 'AVAILABLE'),
  ).length;

  const hasDefaultPaymentMethod = Boolean(profile?.paymentProfile?.trim());
  const pricePerKwhUsd = Number(selectedCharger?.site.pricePerKwhUsd ?? 0);
  const idleFeePerMinUsd = Number(selectedCharger?.site.idleFeePerMinUsd ?? 0);
  const activationFeeUsd = Number(
    ((selectedCharger?.site as any)?.activationFeeUsd ?? ((selectedCharger?.site as any)?.activationFeeCents != null
      ? Number((selectedCharger?.site as any).activationFeeCents) / 100
      : 0)) ?? 0,
  );
  const hasBillablePricing = [pricePerKwhUsd, idleFeePerMinUsd, activationFeeUsd].some(
    (value) => Number.isFinite(value) && value > 0,
  );
  const showPaymentSetupBanner = !hasDefaultPaymentMethod && hasBillablePricing;

  const pricingMode = String((selectedCharger?.site as any)?.pricingMode ?? 'flat');
  const touWindows = parseTouWindows((selectedCharger?.site as any)?.touWindows);
  const nowTou = currentTouWindow(touWindows);
  const displayedEnergyRate = pricingMode === 'tou' && nowTou ? nowTou.pricePerKwhUsd : (selectedCharger?.site.pricePerKwhUsd ?? RATE_PER_KWH);
  const displayedIdleRate = pricingMode === 'tou' && nowTou ? nowTou.idleFeePerMinUsd : idleFeePerMinUsd;
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // Collapse saved windows into one representative day-bar + applicable days list
  const dayRows = Array.from({ length: 7 }, (_, day) => ({
    day,
    rows: touWindows.filter((w) => w.day === day).sort((a, b) => toMinutes(a.start) - toMinutes(b.start)),
  })).filter((d) => d.rows.length > 0);

  const signatureFor = (rows: TouWindowMobile[]) => rows.map((r) => `${r.start}-${r.end}-${r.pricePerKwhUsd.toFixed(4)}-${r.idleFeePerMinUsd.toFixed(4)}`).join('|');
  const canonical = (() => {
    if (dayRows.length === 0) return null as null | { rows: TouWindowMobile[]; days: number[] };
    const bySig = new Map<string, { rows: TouWindowMobile[]; days: number[] }>();
    for (const d of dayRows) {
      const sig = signatureFor(d.rows);
      if (!bySig.has(sig)) bySig.set(sig, { rows: d.rows, days: [] });
      bySig.get(sig)!.days.push(d.day);
    }
    return Array.from(bySig.values()).sort((a, b) => b.days.length - a.days.length)[0] ?? null;
  })();


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
          },
          headerBackButtonDisplayMode: 'minimal',
          headerLeft: () => (
            <TouchableOpacity onPress={() => router.back()} style={{ paddingHorizontal: 4, paddingVertical: 4 }}>
              <Ionicons name="chevron-back" size={30} color={isDark ? '#f9fafb' : '#111827'} />
            </TouchableOpacity>
          ),
          headerRight: () => (
            <HeartButton
              isFavorited={isFav(selectedCharger?.id ?? charger.id)}
              onToggle={() => toggle(selectedCharger?.id ?? charger.id)}
            />
          ),
        }}
      />
      <ScrollView
        style={[styles.container, { backgroundColor: isDark ? '#030712' : '#f9fafb' }]}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={manualRefreshing} onRefresh={onPullRefresh} />}
      >
        {/* Site info */}
        <View style={[styles.siteCard, { backgroundColor: isDark ? '#111827' : '#fff' }]}>
          <Text style={[styles.siteName, { color: isDark ? '#f9fafb' : '#111827' }]}>{charger.site.name}</Text>
          <Text style={[styles.siteAddress, { color: isDark ? '#9ca3af' : '#6b7280' }]}>{charger.site.address}</Text>

          <View style={[styles.pricingWrap, { borderTopColor: isDark ? '#1f2937' : '#e5e7eb' }]}>
            <Text style={[styles.pricingTitle, { color: isDark ? '#e5e7eb' : '#111827' }]}>Price</Text>
            {pricingMode === 'tou' && nowTou ? (
              <Text style={[styles.pricingSubtitle, { color: isDark ? '#cbd5e1' : '#94a3b8' }]}>TOU {windowLabel12(nowTou.start, nowTou.end)}</Text>
            ) : null}

            <View style={styles.priceTilesRow}>
              <View style={[styles.priceTile, { backgroundColor: isDark ? '#0f172a' : '#f3f4f6' }]}>
                <Text numberOfLines={1} style={[styles.priceTileLabel, { color: isDark ? '#9ca3af' : '#6b7280' }]}>Activation</Text>
                <Text style={[styles.priceTileValue, { color: isDark ? '#f9fafb' : '#111827' }]}>${activationFeeUsd.toFixed(2)}</Text>
              </View>
              <View style={[styles.priceTile, { backgroundColor: isDark ? '#0f172a' : '#f3f4f6' }]}>
                <Text numberOfLines={1} style={[styles.priceTileLabel, { color: isDark ? '#9ca3af' : '#6b7280' }]}>Energy</Text>
                <Text style={[styles.priceTileValue, { color: isDark ? '#f9fafb' : '#111827' }]}>${displayedEnergyRate.toFixed(2)}/kWh</Text>
              </View>
              <View style={[styles.priceTile, { backgroundColor: isDark ? '#0f172a' : '#f3f4f6' }]}>
                <Text numberOfLines={1} style={[styles.priceTileLabel, { color: isDark ? '#9ca3af' : '#6b7280' }]}>Idle</Text>
                <Text style={[styles.priceTileValue, { color: isDark ? '#f9fafb' : '#111827' }]}>${displayedIdleRate.toFixed(2)}/min</Text>
              </View>
            </View>

            {pricingMode === 'tou' && touWindows.length > 0 ? (
              <View style={styles.touDetailsWrap}>
                <TouchableOpacity
                  style={[styles.touDetailsToggle, { backgroundColor: isDark ? '#0b1220' : '#f8fafc', borderColor: isDark ? '#334155' : '#dbeafe' }]}
                  onPress={() => setShowTouDetails((v) => !v)}
                  activeOpacity={0.85}
                >
                  <View style={styles.touDetailsIconSpacer} />
                  <Text style={[styles.touDetailsToggleText, { color: isDark ? '#cbd5e1' : '#94a3b8' }]}>TOU details</Text>
                  <Ionicons name={showTouDetails ? 'chevron-up' : 'chevron-down'} size={18} color={isDark ? '#cbd5e1' : '#94a3b8'} />
                </TouchableOpacity>

                {showTouDetails ? (
                  <View style={[styles.touBlock, { borderColor: isDark ? '#334155' : '#dbeafe', backgroundColor: isDark ? '#0b1220' : '#f8fafc' }]}> 
                    {(() => {
                      const tierMap = new Map<string, { label: string; color: string; darkColor: string; energy: number; idle: number }>();
                      const colors = [
                        { color: '#10b981', darkColor: '#34d399' },
                        { color: '#f59e0b', darkColor: '#fbbf24' },
                        { color: '#ef4444', darkColor: '#f87171' },
                        { color: '#8b5cf6', darkColor: '#a78bfa' },
                        { color: '#06b6d4', darkColor: '#22d3ee' },
                      ];
                      const unique = Array.from(new Set(touWindows.map((w) => `${w.pricePerKwhUsd.toFixed(4)}|${w.idleFeePerMinUsd.toFixed(4)}`)));
                      const sortedByEnergy = unique
                        .map((k) => {
                          const [e, idl] = k.split('|').map(Number);
                          return { k, e, idl };
                        })
                        .sort((a, b) => a.e - b.e || a.idl - b.idl);
                      const tierName = (idx: number) => (idx === 0 ? 'Low' : idx === 1 ? 'Med' : idx === 2 ? 'High' : `Tier ${idx + 1}`);
                      sortedByEnergy.forEach((row, i) => {
                        tierMap.set(row.k, { label: tierName(i), ...colors[i % colors.length], energy: row.e, idle: row.idl });
                      });

                      const rows = canonical?.rows ?? [];
                      const days = canonical?.days ?? [];

                      return (
                        <>
                          <Text style={[styles.touDaysMeta, { color: isDark ? '#cbd5e1' : '#94a3b8' }]}>Applies on: {days.map((d) => dayNames[d]).join(', ')}</Text>

                          <View style={styles.touVisualDayRow}>
                            <View style={styles.touTrackWrap}>
                              <View style={[styles.touTrack, { backgroundColor: isDark ? '#1f2937' : '#e5e7eb' }]}>
                              {rows.map((w, idx) => {
                                const k = `${w.pricePerKwhUsd.toFixed(4)}|${w.idleFeePerMinUsd.toFixed(4)}`;
                                const meta = tierMap.get(k)!;
                                const start = toMinutes(w.start);
                                const end = w.end === '23:59' ? 1440 : toMinutes(w.end);
                                const leftPct = Math.max(0, Math.min(100, (start / 1440) * 100));
                                const widthPct = Math.max(1, Math.min(100 - leftPct, ((end - start) / 1440) * 100));
                                return (
                                  <View
                                    key={`canon-${idx}`}
                                    style={[
                                      styles.touSegment,
                                      {
                                        left: `${leftPct}%`,
                                        width: `${widthPct}%`,
                                        backgroundColor: isDark ? meta.darkColor : meta.color,
                                      },
                                    ]}
                                  />
                                );
                              })}
                              </View>
                              <View style={styles.touAxisRow}>
                                {['12A', '6A', '12P', '6P', '12A'].map((t, idx) => (
                                  <Text key={`${t}-${idx}`} style={[styles.touAxisText, { color: isDark ? '#94a3b8' : '#64748b' }]}>{t}</Text>
                                ))}
                              </View>
                            </View>
                          </View>

                          <View style={styles.touLegendRow}>
                            {unique.map((k) => {
                              const meta = tierMap.get(k)!;
                              return (
                                <View key={k} style={styles.touLegendItem}>
                                  <View style={[styles.touLegendDot, { backgroundColor: isDark ? meta.darkColor : meta.color }]} />
                                  <Text style={[styles.touLegendText, { color: isDark ? '#cbd5e1' : '#334155' }]}>
                                    {meta.label}: ${meta.energy.toFixed(2)}/kWh · ${meta.idle.toFixed(2)}/min
                                  </Text>
                                </View>
                              );
                            })}
                          </View>
                        </>
                      );
                    })()}
                  </View>
                ) : null}
              </View>
            ) : null}
          </View>
        </View>

        {/* Chargers at this site */}
        <View style={[styles.section, { backgroundColor: isDark ? '#111827' : '#fff' }]}>
          <View style={styles.sectionHeaderRow}>
            <Text style={[styles.sectionTitle, { color: isDark ? '#f9fafb' : '#111827' }]}>Chargers at this site</Text>
            <Text style={[styles.sectionAvailability, { color: '#10b981' }]}>{siteAvailableChargers}/{siteChargers.length} available</Text>
          </View>
          {siteChargers.map((siteCharger) => {
            const selected = siteCharger.id === selectedCharger?.id;
            return (
              <TouchableOpacity
                key={siteCharger.id}
                style={[
                  styles.chargerSelectRow,
                  { backgroundColor: selected ? (isDark ? '#1f2937' : '#ecfdf5') : 'transparent' },
                ]}
                onPress={() => {
                  setSelectedChargerId(siteCharger.id);
                  router.push(`/charger/detail/${siteCharger.id}` as any);
                }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[styles.chargerSelectTitle, { color: isDark ? '#f9fafb' : '#111827' }]}>
                    {siteCharger.ocppId}
                  </Text>
                  <Text style={[styles.chargerSelectMeta, { color: isDark ? '#9ca3af' : '#6b7280' }]}>
                    {siteCharger.vendor} {siteCharger.model}
                  </Text>
                </View>
                <Text style={[styles.chargerOpenHint, { color: isDark ? '#93c5fd' : '#2563eb' }]}>{chargerStatusLabel(siteCharger)}</Text>
              </TouchableOpacity>
            );
          })}
        </View>


        {startMutation.isPending && (
          <View style={[styles.startingOverlay, { backgroundColor: isDark ? '#052e2b' : '#ecfdf5' }]}>
            <ActivityIndicator color="#10b981" />
            <Text style={[styles.startingText, { color: isDark ? '#a7f3d0' : '#065f46' }]}>
              Sending start command to connector {startingConnector}…
            </Text>
          </View>
        )}

        {activationMessage && !showActivationModal && (
          <View style={[styles.startingOverlay, { backgroundColor: isDark ? '#1e293b' : '#eff6ff' }]}>
            <ActivityIndicator color={isDark ? '#93c5fd' : '#2563eb'} />
            <Text style={[styles.startingText, { color: isDark ? '#bfdbfe' : '#1d4ed8' }]}>
              {activationMessage}
            </Text>
          </View>
        )}

        <Modal visible={showActivationModal} transparent animationType="fade" onRequestClose={() => setShowActivationModal(false)}>
          <View style={styles.modalBackdrop}>
            <View style={[styles.modalCard, { backgroundColor: isDark ? '#0f172a' : '#ffffff' }]}>
              <View style={styles.modalImageViewport}>
                <Image
                  source={require('../../assets/activation-visual.jpg')}
                  style={styles.modalGifFallback}
                  resizeMode="cover"
                />
              </View>
              <Text style={[styles.modalTitle, { color: isDark ? '#f8fafc' : '#0f172a' }]}>Charger activated</Text>
              <Text style={[styles.modalTimer, { color: isDark ? '#86efac' : '#047857' }]}>Activation window: {countdownText}</Text>
              <Text style={[styles.modalText, { color: isDark ? '#cbd5e1' : '#334155' }]}>
                Your charger has been successfully activated. Please plug in the connector to your vehicle to start charging.
              </Text>
            </View>
          </View>
        </Modal>


      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },
  content: { padding: 16, gap: 16, paddingBottom: 40 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  errorText: { color: '#ef4444', fontSize: 15 },

  siteCard: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 16,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  siteName: { fontSize: 18, fontWeight: '700', color: '#111827', textAlign: 'center' },
  siteAddress: { fontSize: 13, color: '#6b7280', textAlign: 'center' },
  pricingWrap: { marginTop: 12, borderTopWidth: 1, paddingTop: 10, gap: 10 },
  pricingTitle: { fontSize: 13, fontWeight: '700', textAlign: 'center' },
  pricingSubtitle: { fontSize: 11, fontWeight: '700', textAlign: 'center', marginTop: -4 },
  priceTilesRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'stretch' },
  touDetailsWrap: { gap: 8, marginTop: 2 },
  touDetailsToggle: {
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
  },
  touDetailsIconSpacer: { width: 18, height: 18 },
  touDetailsToggleText: { flex: 1, fontSize: 12, fontWeight: '800', textAlign: 'center' },
  priceTile: { width: '31.5%', minWidth: 0, minHeight: 82, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center' },
  priceTileLabel: { width: '100%', fontSize: 12, fontWeight: '600', textAlign: 'center', lineHeight: 16 },
  priceTileValue: { width: '100%', fontSize: 13, fontWeight: '700', marginTop: 6, textAlign: 'center' },

  touBlock: { marginTop: 10, borderWidth: 1, borderRadius: 12, padding: 10, gap: 10 },
  touNowPill: { borderRadius: 10, paddingVertical: 7, paddingHorizontal: 9 },
  touNowText: { fontSize: 12, fontWeight: '700', lineHeight: 17 },
  touDaysMeta: { fontSize: 11, fontWeight: '700', textAlign: 'center' },
  touLegendRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'center' },
  touLegendItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  touLegendDot: { width: 10, height: 10, borderRadius: 5 },
  touLegendText: { fontSize: 11, fontWeight: '700' },
  touVisualDayRow: { width: '100%' },
  touTrackWrap: { width: '100%', gap: 4 },
  touTrack: { height: 18, borderRadius: 9, position: 'relative', overflow: 'hidden' },
  touAxisRow: { flexDirection: 'row', justifyContent: 'space-between' },
  touAxisText: { fontSize: 10, fontWeight: '700' },
  touSegment: { position: 'absolute', top: 0, bottom: 0, borderRadius: 8 },
  touActivationNote: { marginTop: 6, borderWidth: 1, borderRadius: 10, paddingVertical: 7, paddingHorizontal: 9 },
  touActivationText: { fontSize: 11, fontWeight: '700', lineHeight: 16 },

  paymentBanner: {
    backgroundColor: '#fffbeb',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#fde68a',
  },
  paymentBannerTitle: { fontSize: 14, fontWeight: '700', color: '#92400e', marginBottom: 4 },
  paymentBannerSubtitle: { fontSize: 12, color: '#78350f', marginBottom: 10, lineHeight: 18 },
  paymentButton: {
    backgroundColor: '#f59e0b',
    borderRadius: 8,
    padding: 10,
    alignItems: 'center',
  },
  paymentButtonText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  buttonDisabled: { opacity: 0.6 },

  section: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 16,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
    gap: 12,
  },
  sectionHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: '#111827', marginBottom: 4 },
  sectionAvailability: { fontSize: 12, fontWeight: '700' },
  chargerSelectRow: {
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#37415133',
  },
  chargerSelectTitle: { fontSize: 14, fontWeight: '700' },
  chargerSelectMeta: { fontSize: 12, marginTop: 2 },
  chargerOpenHint: { fontWeight: '700', fontSize: 12 },


  startingOverlay: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#ecfdf5',
    borderRadius: 10,
    padding: 12,
  },
  startingText: { color: '#065f46', fontSize: 13, flex: 1 },


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
