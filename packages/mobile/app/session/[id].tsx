/**
 * Live session screen — polls for kWh + cost, shows Stop button.
 * After stop: shows session summary (kWh, duration, cost).
 */
import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  ScrollView,
} from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Session } from '@/lib/api';
import { useAppTheme } from '@/theme';

const RATE_PER_KWH = 0.35;

function formatDuration(startedAt: string, endedAt?: string | null): string {
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  const totalSecs = Math.floor((end - start) / 1000);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}


function formatKwh(value: number): string {
  // up to 4 decimal places, trimming trailing zeros
  return value.toFixed(4).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function getLiveKwh(session: Session): number {
  if (session.kwhDelivered != null) return session.kwhDelivered;
  if (session.meterStop != null && session.meterStart != null) {
    return Math.max(0, (session.meterStop - session.meterStart) / 1000);
  }
  return 0;
}

// ── Live ticker (updates every second for duration display) ───────────────────

function useLiveDuration(startedAt: string, active: boolean): string {
  const [duration, setDuration] = useState(() => formatDuration(startedAt));
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setDuration(formatDuration(startedAt)), 1000);
    return () => clearInterval(timer);
  }, [startedAt, active]);
  return duration;
}

// ── Session Summary (completed) ───────────────────────────────────────────────

function SessionSummary({ session }: { session: Session }) {
  const router = useRouter();
  const kwh = getLiveKwh(session);
  const cost =
    session.payment?.amountCents != null
      ? session.payment.amountCents / 100
      : kwh * RATE_PER_KWH;

  return (
    <View style={styles.summaryContainer}>
      <Text style={styles.summaryCheckmark}>✓</Text>
      <Text style={styles.summaryTitle}>Session Complete</Text>
      <Text style={styles.summarySubtitle}>{session.connector.charger.site.name}</Text>

      <View style={styles.summaryStats}>
        <SummaryStatCard label="Energy" value={`${formatKwh(kwh)} kWh`} icon="⚡" />
        <SummaryStatCard
          label="Duration"
          value={formatDuration(session.startedAt, session.endedAt)}
          icon="⏱"
        />
        <SummaryStatCard
          label="Total Cost"
          value={`$${cost.toFixed(2)}`}
          icon="💳"
          highlight
        />
      </View>

      {session.payment?.status === 'CAPTURED' && (
        <View style={styles.paymentSuccess}>
          <Text style={styles.paymentSuccessText}>
            Payment of ${cost.toFixed(2)} charged successfully
          </Text>
        </View>
      )}

      {session.payment?.status === 'PENDING' && (
        <View style={styles.paymentPending}>
          <Text style={styles.paymentPendingText}>Payment processing…</Text>
        </View>
      )}

      <View style={styles.summaryMeta}>
        <Text style={styles.metaText}>Started: {formatDate(session.startedAt)}</Text>
        {session.endedAt && (
          <Text style={styles.metaText}>Ended: {formatDate(session.endedAt)}</Text>
        )}
        <Text style={styles.metaText}>Rate: ${RATE_PER_KWH.toFixed(2)}/kWh</Text>
      </View>

      <TouchableOpacity
        style={styles.doneButton}
        onPress={() => router.replace('/(tabs)/sessions')}
      >
        <Text style={styles.doneButtonText}>View All Sessions</Text>
      </TouchableOpacity>
    </View>
  );
}

function SummaryStatCard({
  label,
  value,
  icon,
  highlight,
}: {
  label: string;
  value: string;
  icon: string;
  highlight?: boolean;
}) {
  return (
    <View style={[styles.statCard, highlight && styles.statCardHighlight]}>
      <Text style={styles.statIcon}>{icon}</Text>
      <Text style={[styles.statValue, highlight && styles.statValueHighlight]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

// ── Live Session View ─────────────────────────────────────────────────────────

function LiveSessionView({
  session,
  onStop,
  stopping,
}: {
  session: Session;
  onStop: () => void;
  stopping: boolean;
}) {
  const { isDark } = useAppTheme();
  const kwh = getLiveKwh(session);
  const estimatedCost = kwh * RATE_PER_KWH;
  const duration = useLiveDuration(session.startedAt, true);

  function confirmStop() {
    Alert.alert(
      'Stop Charging?',
      `You've used ${formatKwh(kwh)} kWh (~$${estimatedCost.toFixed(2)}) so far.`,
      [
        { text: 'Keep Charging', style: 'cancel' },
        { text: 'Stop Session', style: 'destructive', onPress: onStop },
      ],
    );
  }

  return (
    <View style={[styles.liveContainer, { backgroundColor: isDark ? '#030712' : '#f9fafb' }]}>
      {/* Pulsing status indicator */}
      <View style={styles.liveHeader}>
        <View style={styles.liveDot} />
        <Text style={styles.liveLabel}>Charging</Text>
      </View>

      {/* Site name */}
      <Text style={[styles.liveSiteName, { color: isDark ? '#f9fafb' : '#111827' }]}>{session.connector.charger.site.name}</Text>
      <Text style={[styles.liveConnector, { color: isDark ? '#9ca3af' : '#6b7280' }]}>
        {session.connector.charger.vendor} {session.connector.charger.model} ·
        Connector {session.connector.connectorId}
      </Text>

      {/* Big kWh counter */}
      <View style={styles.kwhContainer}>
        <Text style={styles.kwhValue}>{formatKwh(kwh)}</Text>
        <Text style={[styles.kwhUnit, { color: isDark ? '#94a3b8' : '#6b7280' }]}>kWh delivered</Text>
      </View>

      {/* Stats row */}
      <View style={[styles.liveStats, { backgroundColor: isDark ? '#0f172a' : '#fff', borderColor: isDark ? '#1f2937' : '#e5e7eb', borderWidth: 1 }]}> 
        <View style={styles.liveStat}>
          <Text style={[styles.liveStatValue, { color: isDark ? '#f8fafc' : '#111827' }]}>{duration}</Text>
          <Text style={[styles.liveStatLabel, { color: isDark ? '#94a3b8' : '#9ca3af' }]}>Duration</Text>
        </View>
        <View style={[styles.liveStatDivider, { backgroundColor: isDark ? '#334155' : '#e5e7eb' }]} />
        <View style={styles.liveStat}>
          <Text style={[styles.liveStatValue, styles.costValue]}>
            ${estimatedCost.toFixed(2)}
          </Text>
          <Text style={[styles.liveStatLabel, { color: isDark ? '#94a3b8' : '#9ca3af' }]}>Est. Cost</Text>
        </View>
        <View style={[styles.liveStatDivider, { backgroundColor: isDark ? '#334155' : '#e5e7eb' }]} />
        <View style={styles.liveStat}>
          <Text style={[styles.liveStatValue, { color: isDark ? '#f8fafc' : '#111827' }]}>${RATE_PER_KWH.toFixed(2)}</Text>
          <Text style={[styles.liveStatLabel, { color: isDark ? '#94a3b8' : '#9ca3af' }]}>Per kWh</Text>
        </View>
      </View>

      {/* Stop button */}
      <TouchableOpacity
        style={[styles.stopButton, stopping && styles.buttonDisabled]}
        onPress={confirmStop}
        disabled={stopping}
      >
        {stopping ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.stopButtonText}>Stop Charging</Text>
        )}
      </TouchableOpacity>

      <Text style={styles.pollingNote}>Updating every 3 seconds</Text>
    </View>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function SessionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { isDark } = useAppTheme();
  const router = useRouter();
  const queryClient = useQueryClient();

  const { data: session, isLoading } = useQuery({
    queryKey: ['session', id],
    queryFn: () => api.sessions.get(id),
    refetchInterval: (query) => {
      // Poll aggressively while active
      return query.state.data?.status === 'ACTIVE' ? 3_000 : false;
    },
  });

  const stopMutation = useMutation({
    mutationFn: () => api.sessions.stop(id),
    onSuccess: () => {
      // Invalidate and refetch session + list
      queryClient.invalidateQueries({ queryKey: ['session', id] });
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      // Final refetch after a moment (OCPP might take a second to close the session)
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['session', id] });
      }, 3000);
    },
    onError: (err: Error) => {
      Alert.alert('Stop Failed', err.message);
    },
  });

  if (isLoading) {
    return (
      <View style={[styles.centered, { backgroundColor: isDark ? '#030712' : '#f9fafb' }]}> 
        <ActivityIndicator size="large" color="#10b981" />
      </View>
    );
  }

  if (!session) {
    return (
      <View style={[styles.centered, { backgroundColor: isDark ? '#030712' : '#f9fafb' }]}> 
        <Text style={styles.errorText}>Session not found.</Text>
      </View>
    );
  }

  return (
    <>
      <Stack.Screen
        options={{
          title: session.status === 'ACTIVE' ? 'Charging' : 'Session Details',
          headerShown: true,
          headerStyle: {
            backgroundColor:
              session.status === 'ACTIVE' ? '#030712' : isDark ? '#030712' : '#f9fafb',
          },
          headerTintColor: session.status === 'ACTIVE' ? '#f8fafc' : isDark ? '#f8fafc' : '#111827',
          headerBackButtonDisplayMode: 'minimal',
          headerTitleStyle: {
            color: session.status === 'ACTIVE' ? '#f8fafc' : isDark ? '#f8fafc' : '#111827',
          },
          headerShadowVisible: false,
        }}
      />
      <ScrollView contentContainerStyle={[styles.scrollContent, { backgroundColor: isDark ? '#030712' : '#f9fafb' }]}> 
        {session.status === 'ACTIVE' ? (
          <LiveSessionView
            session={session}
            onStop={() => stopMutation.mutate()}
            stopping={stopMutation.isPending}
          />
        ) : (
          <SessionSummary session={session} />
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  scrollContent: { flexGrow: 1, backgroundColor: '#f9fafb' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#f9fafb' },
  errorText: { color: '#ef4444', fontSize: 15 },

  // ── Live view ──
  liveContainer: {
    flex: 1,
    padding: 24,
    alignItems: 'center',
    paddingTop: 32,
  },
  liveHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  liveDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#10b981',
  },
  liveLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#10b981',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  liveSiteName: {
    fontSize: 20,
    fontWeight: '700',
    color: '#111827',
    textAlign: 'center',
    marginBottom: 4,
  },
  liveConnector: {
    fontSize: 13,
    color: '#6b7280',
    textAlign: 'center',
    marginBottom: 32,
  },
  kwhContainer: { alignItems: 'center', marginBottom: 32 },
  kwhValue: { fontSize: 72, fontWeight: '800', color: '#10b981', lineHeight: 80 },
  kwhUnit: { fontSize: 16, color: '#6b7280', marginTop: 4 },
  liveStats: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 20,
    width: '100%',
    marginBottom: 32,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  liveStat: { flex: 1, alignItems: 'center' },
  liveStatValue: { fontSize: 20, fontWeight: '700', color: '#111827' },
  costValue: { color: '#10b981' },
  liveStatLabel: { fontSize: 11, color: '#9ca3af', marginTop: 4, textTransform: 'uppercase' },
  liveStatDivider: { width: 1, backgroundColor: '#e5e7eb', marginVertical: 4 },
  stopButton: {
    backgroundColor: '#ef4444',
    borderRadius: 14,
    paddingVertical: 16,
    paddingHorizontal: 48,
    alignItems: 'center',
    width: '100%',
    marginBottom: 12,
  },
  stopButtonText: { color: '#fff', fontSize: 17, fontWeight: '700' },
  buttonDisabled: { opacity: 0.6 },
  pollingNote: { fontSize: 11, color: '#d1d5db' },

  // ── Summary view ──
  summaryContainer: {
    flex: 1,
    padding: 24,
    alignItems: 'center',
    paddingTop: 40,
  },
  summaryCheckmark: { fontSize: 56, marginBottom: 12 },
  summaryTitle: { fontSize: 24, fontWeight: '800', color: '#111827', marginBottom: 4 },
  summarySubtitle: { fontSize: 14, color: '#6b7280', marginBottom: 28 },
  summaryStats: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 20,
    width: '100%',
  },
  statCard: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 14,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 6,
    elevation: 2,
  },
  statCardHighlight: { backgroundColor: '#ecfdf5' },
  statIcon: { fontSize: 24, marginBottom: 6 },
  statValue: { fontSize: 18, fontWeight: '700', color: '#111827' },
  statValueHighlight: { color: '#10b981' },
  statLabel: { fontSize: 11, color: '#9ca3af', marginTop: 2, textTransform: 'uppercase' },
  paymentSuccess: {
    backgroundColor: '#d1fae5',
    borderRadius: 10,
    padding: 10,
    width: '100%',
    marginBottom: 16,
  },
  paymentSuccessText: { color: '#065f46', fontSize: 13, textAlign: 'center', fontWeight: '600' },
  paymentPending: {
    backgroundColor: '#fef9c3',
    borderRadius: 10,
    padding: 10,
    width: '100%',
    marginBottom: 16,
  },
  paymentPendingText: { color: '#713f12', fontSize: 13, textAlign: 'center' },
  summaryMeta: {
    backgroundColor: '#f3f4f6',
    borderRadius: 12,
    padding: 14,
    width: '100%',
    gap: 4,
    marginBottom: 24,
  },
  metaText: { fontSize: 13, color: '#6b7280' },
  doneButton: {
    backgroundColor: '#10b981',
    borderRadius: 14,
    paddingVertical: 15,
    paddingHorizontal: 40,
    alignItems: 'center',
    width: '100%',
  },
  doneButtonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
