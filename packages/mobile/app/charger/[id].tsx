/**
 * Charger detail screen - connector list, status, price per kWh, Start button.
 * Also handles Stripe payment setup (save card) before first session.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
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
import { api, type Charger, type Connector, type ChargerUptime } from '@/lib/api';
import { ConnectorStatusBadge } from '@/components/ConnectorStatusBadge';
import { useAppTheme } from '@/theme';
import { useFavorites } from '@/hooks/useFavorites';
import { HeartButton } from '@/components/HeartButton';
import { useAppAuth } from '@/providers/AuthProvider';

const RATE_PER_KWH = 0.35; // fallback only

// ── Payment Setup Modal ───────────────────────────────────────────────────────

function PaymentSetupBanner({ onSetupComplete, isDark }: { onSetupComplete: () => void; isDark: boolean }) {
  const [loading, setLoading] = useState(false);
  const STRIPE_KEY = process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY;

  async function handleSetupCard() {
    if (!STRIPE_KEY) {
      Alert.alert(
        'Stripe not configured',
        'Set EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY to enable payments. In dev mode, payment is skipped.',
        [{ text: 'Continue anyway', onPress: onSetupComplete }],
      );
      return;
    }

    setLoading(true);
    try {
      const { confirmSetupIntent } = require('@stripe/stripe-react-native').useStripe();
      const { clientSecret } = await api.payments.setupIntent();
      const { error } = await confirmSetupIntent(clientSecret, {
        paymentMethodType: 'Card',
      });
      if (error) {
        Alert.alert('Payment Setup Failed', error.message);
      } else {
        Alert.alert('Card saved!', 'Your card has been saved for future sessions.', [
          { text: 'OK', onPress: onSetupComplete },
        ]);
      }
    } catch (err: unknown) {
      Alert.alert('Error', (err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={[styles.paymentBanner, { backgroundColor: isDark ? '#1f2937' : '#fffbeb', borderColor: isDark ? '#374151' : '#fde68a' }]}>
      <Text style={[styles.paymentBannerTitle, { color: isDark ? '#f9fafb' : '#92400e' }]}>Save a payment method</Text>
      <Text style={[styles.paymentBannerSubtitle, { color: isDark ? '#d1d5db' : '#78350f' }]}>
        Add a card to start charging. You'll only be charged for energy used.
      </Text>
      <TouchableOpacity
        style={[styles.paymentButton, loading && styles.buttonDisabled]}
        onPress={handleSetupCard}
        disabled={loading}
      >
        {loading ? (
          <ActivityIndicator color="#fff" size="small" />
        ) : (
          <Text style={styles.paymentButtonText}>💳 Add Payment Method</Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

// ── Connector Row ─────────────────────────────────────────────────────────────

function ConnectorRow({
  connector,
  chargerId,
  onSessionStarted,
  isDark,
  ratePerKwh,
}: {
  connector: Connector;
  chargerId: string;
  onSessionStarted: (
    chargerId: string,
    connectorId: number,
    connectorStatus: Connector['status'],
  ) => void;
  isDark: boolean;
  ratePerKwh: number;
}) {
  const isStartable = connector.status === 'AVAILABLE' || connector.status === 'PREPARING' || connector.status === 'SUSPENDED_EV';
  const isCharging = connector.status === 'CHARGING' || connector.status === 'FINISHING';

  return (
    <View style={[styles.connectorRow, { borderTopColor: isDark ? '#1f2937' : '#f3f4f6' }]}>
      <View style={styles.connectorLeft}>
        <Text style={[styles.connectorLabel, { color: isDark ? '#e5e7eb' : '#374151' }]}>Connector {connector.connectorId}</Text>
        <ConnectorStatusBadge status={connector.status} />
        <Text style={[styles.rateText, { color: isDark ? '#9ca3af' : '#9ca3af' }]}>${ratePerKwh.toFixed(2)}/kWh</Text>
      </View>

      {isStartable && (
        <TouchableOpacity
          style={styles.startButton}
          onPress={() => onSessionStarted(chargerId, connector.connectorId, connector.status)}
        >
          <Text style={styles.startButtonText}>Start</Text>
        </TouchableOpacity>
      )}

      {isCharging && (
        <View style={styles.inUseTag}>
          <Text style={styles.inUseText}>In Use</Text>
        </View>
      )}
    </View>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function ChargerDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [startingConnector, setStartingConnector] = useState<number | null>(null);
  const [activationMessage, setActivationMessage] = useState<string | null>(null);
  const [showActivationModal, setShowActivationModal] = useState(false);
  const [activationDeadlineMs, setActivationDeadlineMs] = useState<number | null>(null);
  const [countdownText, setCountdownText] = useState('02:00');
  const activationPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startContextRef = useRef<{ alreadyPlugged: boolean } | null>(null);
  const { isDark } = useAppTheme();
  const { toggle, isFav } = useFavorites();
  const { isGuest } = useAppAuth();

  const { data: charger, isLoading, refetch, isRefetching } = useQuery({
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

  const { data: uptime, refetch: refetchUptime } = useQuery<ChargerUptime | null>({
    queryKey: ['charger-uptime', selectedCharger?.id ?? id],
    queryFn: () => api.chargers.uptime(selectedCharger?.id ?? id).catch(() => null),
    enabled: Boolean(selectedCharger?.id ?? id),
  });

  const { data: profile } = useQuery({
    queryKey: ['me-profile'],
    queryFn: () => api.profile.get(),
    enabled: !isGuest,
  });

  useFocusEffect(
    React.useCallback(() => {
      refetch();
      refetchAllChargers();
      refetchUptime();
      return undefined;
    }, [refetch, refetchAllChargers, refetchUptime]),
  );

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
            router.replace(`/session/${active.id}`);
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
    if (isGuest) {
      Alert.alert('Sign in required', 'Please sign in to start a charging session.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Sign In', onPress: () => router.replace('/(auth)/sign-in' as any) },
      ]);
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
  const showPaymentSetupBanner = !isGuest && !hasDefaultPaymentMethod && hasBillablePricing;

  return (
    <>
      <Stack.Screen
        options={{
          title: charger.site.name,
          headerShown: true,
          headerStyle: { backgroundColor: isDark ? '#0b1220' : '#ffffff' },
          headerTintColor: isDark ? '#f9fafb' : '#111827',
          headerShadowVisible: false,
          headerBackButtonDisplayMode: 'minimal',
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
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} />}
      >
        {/* Site info */}
        <View style={[styles.siteCard, { backgroundColor: isDark ? '#111827' : '#fff' }]}>
          <Text style={[styles.siteAddress, { color: isDark ? '#9ca3af' : '#6b7280' }]}>{charger.site.address}</Text>
          <View style={styles.siteMetaRow}>
            <Text style={[styles.chargerModel, { color: isDark ? '#d1d5db' : '#374151' }]}>
              {siteChargers.length} charger{siteChargers.length !== 1 ? 's' : ''} at this site
            </Text>
            <Text style={[styles.availCount, { color: '#10b981' }]}>
              {siteAvailableChargers} charger{siteAvailableChargers !== 1 ? 's' : ''} available
            </Text>
          </View>
          {uptime && (
            <View style={{ marginTop: 8, flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={{ color: isDark ? '#9ca3af' : '#6b7280', fontSize: 12 }}>Uptime (7d)</Text>
              <Text style={{
                fontSize: 12,
                fontWeight: '700',
                color: uptime.uptimePercent7d >= 99 ? '#16a34a' : uptime.uptimePercent7d >= 95 ? '#d97706' : '#dc2626',
              }}>
                {uptime.uptimePercent7d.toFixed(2)}%{uptime.uptimePercent7d < 95 ? ' · Degraded' : ''}
              </Text>
            </View>
          )}
        </View>

        {/* Payment setup: show only for signed-in users without a default payment method on billable sites */}
        {showPaymentSetupBanner && <PaymentSetupBanner onSetupComplete={() => {}} isDark={isDark} />}

        {/* Chargers at this site */}
        <View style={[styles.section, { backgroundColor: isDark ? '#111827' : '#fff' }]}>
          <Text style={[styles.sectionTitle, { color: isDark ? '#f9fafb' : '#111827' }]}>Chargers at this site</Text>
          {siteChargers.map((siteCharger) => {
            const selected = siteCharger.id === selectedCharger?.id;
            const available = siteCharger.connectors.filter((c) => c.status === 'AVAILABLE').length;
            return (
              <TouchableOpacity
                key={siteCharger.id}
                style={[
                  styles.chargerSelectRow,
                  { backgroundColor: selected ? (isDark ? '#1f2937' : '#ecfdf5') : 'transparent' },
                ]}
                onPress={() => setSelectedChargerId(siteCharger.id)}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[styles.chargerSelectTitle, { color: isDark ? '#f9fafb' : '#111827' }]}>
                    {siteCharger.ocppId}
                  </Text>
                  <Text style={[styles.chargerSelectMeta, { color: isDark ? '#9ca3af' : '#6b7280' }]}>
                    {siteCharger.vendor} {siteCharger.model} · {available}/{siteCharger.connectors.length} available
                  </Text>
                </View>
                {selected && <Text style={styles.selectedTag}>Selected</Text>}
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Connectors for selected charger */}
        <View style={[styles.section, { backgroundColor: isDark ? '#111827' : '#fff' }]}>
          <Text style={[styles.sectionTitle, { color: isDark ? '#f9fafb' : '#111827' }]}>Connectors</Text>
          {selectedCharger?.connectors.map((connector) => (
            <ConnectorRow
              key={connector.id}
              connector={connector}
              chargerId={selectedCharger.id}
              isDark={isDark}
              ratePerKwh={selectedCharger.site.pricePerKwhUsd ?? RATE_PER_KWH}
              onSessionStarted={(cid, connId, connectorStatus) => {
                if (startMutation.isPending) return;
                handleStartSession(cid, connId, connectorStatus);
              }}
            />
          ))}
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

        {/* Price info */}
        <View style={[styles.priceNote, { backgroundColor: isDark ? '#1f2937' : '#f3f4f6' }]}>
          <Text style={[styles.priceNoteText, { color: isDark ? '#d1d5db' : '#6b7280' }]}> 
            ⚡ Rate: ${(selectedCharger?.site.pricePerKwhUsd ?? RATE_PER_KWH).toFixed(2)}/kWh{activationFeeUsd > 0 ? ` · Activation fee: $${activationFeeUsd.toFixed(2)}` : ''} · Billed based on energy delivered
          </Text>
        </View>
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
  siteName: { fontSize: 18, fontWeight: '700', color: '#111827' },
  siteAddress: { fontSize: 13, color: '#6b7280' },
  siteMetaRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10 },
  chargerModel: { fontSize: 13, color: '#374151' },
  availCount: { fontSize: 13, fontWeight: '600', color: '#10b981' },

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
  sectionTitle: { fontSize: 16, fontWeight: '700', color: '#111827', marginBottom: 4 },
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
  selectedTag: { color: '#10b981', fontWeight: '700', fontSize: 12 },

  connectorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: '#f3f4f6',
  },
  connectorLeft: { flex: 1, gap: 4 },
  connectorLabel: { fontSize: 14, fontWeight: '600', color: '#374151' },
  rateText: { fontSize: 12, color: '#9ca3af', marginTop: 2 },

  startButton: {
    backgroundColor: '#10b981',
    borderRadius: 10,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  startButtonText: { color: '#fff', fontWeight: '700', fontSize: 14 },

  inUseTag: {
    backgroundColor: '#fef3c7',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  inUseText: { color: '#92400e', fontSize: 12, fontWeight: '600' },

  startingOverlay: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#ecfdf5',
    borderRadius: 10,
    padding: 12,
  },
  startingText: { color: '#065f46', fontSize: 13, flex: 1 },

  priceNote: {
    backgroundColor: '#f3f4f6',
    borderRadius: 10,
    padding: 12,
    alignItems: 'center',
  },
  priceNoteText: { fontSize: 12, color: '#6b7280', textAlign: 'center' },

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
