/**
 * Charger detail screen — connector list, status, price per kWh, Start button.
 * Also handles Stripe payment setup (save card) before first session.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Alert,
  RefreshControl,
} from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Charger, type Connector } from '@/lib/api';
import { ConnectorStatusBadge } from '@/components/ConnectorStatusBadge';
import { useAppTheme } from '@/theme';

const RATE_PER_KWH = 0.35; // $/kWh (matches hardcoded server value)

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
}: {
  connector: Connector;
  chargerId: string;
  onSessionStarted: (chargerId: string, connectorId: number) => void;
  isDark: boolean;
}) {
  const isStartable = connector.status === 'AVAILABLE' || connector.status === 'PREPARING' || connector.status === 'SUSPENDED_EV';
  const isCharging = connector.status === 'CHARGING' || connector.status === 'FINISHING';

  return (
    <View style={[styles.connectorRow, { borderTopColor: isDark ? '#1f2937' : '#f3f4f6' }]}> 
      <View style={styles.connectorLeft}>
        <Text style={[styles.connectorLabel, { color: isDark ? '#e5e7eb' : '#374151' }]}>Connector {connector.connectorId}</Text>
        <ConnectorStatusBadge status={connector.status} />
        <Text style={[styles.rateText, { color: isDark ? '#9ca3af' : '#9ca3af' }]}>${RATE_PER_KWH.toFixed(2)}/kWh</Text>
      </View>

      {isStartable && (
        <TouchableOpacity
          style={styles.startButton}
          onPress={() => onSessionStarted(chargerId, connector.connectorId)}
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
  const { isDark } = useAppTheme();

  const { data: charger, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['charger', id],
    queryFn: () => api.chargers.get(id),
    refetchInterval: 10_000,
  });

  const startMutation = useMutation({
    mutationFn: ({ chargerId, connectorId }: { chargerId: string; connectorId: number }) =>
      api.sessions.start(chargerId, connectorId),
    onMutate: ({ connectorId }) => setStartingConnector(connectorId),
    onSettled: () => setStartingConnector(null),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['charger', id] });
      queryClient.invalidateQueries({ queryKey: ['sessions'] });

      // Poll for session creation (OCPP server creates it async after StartTransaction)
      Alert.alert(
        'Session starting…',
        'Your session is being started. Check the History tab in a moment.',
        [
          {
            text: 'View Sessions',
            onPress: () => {
              // Wait a moment for the session to be created, then navigate
              setTimeout(() => {
                router.push('/(tabs)/sessions');
                // Then try to find the active session
                api.sessions.list(5, 0).then((res) => {
                  const active = res.sessions.find((s) => s.status === 'ACTIVE');
                  if (active) router.replace(`/session/${active.id}`);
                });
              }, 3000);
            },
          },
          { text: 'Stay Here' },
        ],
      );
    },
    onError: (err: Error) => {
      Alert.alert('Failed to Start', err.message);
    },
  });

  function handleStartSession(chargerId: string, connectorId: number) {
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

  const availableCount = charger.connectors.filter((c) => c.status === 'AVAILABLE').length;

  return (
    <>
      <Stack.Screen options={{ title: charger.site.name, headerShown: true }} />
      <ScrollView
        style={[styles.container, { backgroundColor: isDark ? '#030712' : '#f9fafb' }]}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} />}
      >
        {/* Site info */}
        <View style={[styles.siteCard, { backgroundColor: isDark ? '#111827' : '#fff' }]}> 
          <Text style={[styles.siteName, { color: isDark ? '#f9fafb' : '#111827' }]}>{charger.site.name}</Text>
          <Text style={[styles.siteAddress, { color: isDark ? '#9ca3af' : '#6b7280' }]}>{charger.site.address}</Text>
          <View style={styles.siteMetaRow}>
            <Text style={[styles.chargerModel, { color: isDark ? '#d1d5db' : '#374151' }]}>
              {charger.vendor} {charger.model}
            </Text>
            <Text style={[styles.availCount, { color: '#10b981' }]}>
              {availableCount}/{charger.connectors.length} available
            </Text>
          </View>
        </View>

        {/* Payment setup (dev mode: skipped silently) */}
        <PaymentSetupBanner onSetupComplete={() => {}} isDark={isDark} />

        {/* Connectors */}
        <View style={[styles.section, { backgroundColor: isDark ? '#111827' : '#fff' }]}> 
          <Text style={[styles.sectionTitle, { color: isDark ? '#f9fafb' : '#111827' }]}>Connectors</Text>
          {charger.connectors.map((connector) => (
            <ConnectorRow
              key={connector.id}
              connector={connector}
              chargerId={charger.id}
              isDark={isDark}
              onSessionStarted={(cid, connId) => {
                if (startMutation.isPending) return;
                handleStartSession(cid, connId);
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

        {/* Price info */}
        <View style={[styles.priceNote, { backgroundColor: isDark ? '#1f2937' : '#f3f4f6' }]}> 
          <Text style={[styles.priceNoteText, { color: isDark ? '#d1d5db' : '#6b7280' }]}>
            ⚡ Rate: ${RATE_PER_KWH.toFixed(2)}/kWh · Billed based on energy delivered
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
  siteAddress: { fontSize: 13, color: '#6b7280', marginTop: 4 },
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
});
