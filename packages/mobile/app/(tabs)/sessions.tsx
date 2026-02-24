/**
 * Session History screen — driver's past and active sessions.
 */
import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { api, type Session } from '@/lib/api';

function formatDuration(startedAt: string, endedAt: string | null): string {
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  const mins = Math.floor((end - start) / 60_000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${m}m`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function SessionCard({ session, onPress }: { session: Session; onPress: () => void }) {
  const isActive = session.status === 'ACTIVE';
  const charger = session.connector.charger;
  const kwh = session.kwhDelivered ?? 0;
  const cost =
    session.payment?.amountCents != null
      ? `$${(session.payment.amountCents / 100).toFixed(2)}`
      : session.costEstimateCents != null
        ? `~$${(session.costEstimateCents / 100).toFixed(2)}`
        : null;

  return (
    <TouchableOpacity style={styles.card} onPress={onPress} activeOpacity={0.7}>
      {/* Header row */}
      <View style={styles.cardHeader}>
        <Text style={styles.siteName}>{charger.site.name}</Text>
        {isActive && (
          <View style={styles.activeBadge}>
            <Text style={styles.activeBadgeText}>Live</Text>
          </View>
        )}
      </View>

      {/* Address */}
      <Text style={styles.address}>{charger.site.address}</Text>

      {/* Stats row */}
      <View style={styles.statsRow}>
        <StatItem label="Date" value={formatDate(session.startedAt)} />
        <StatItem label="Duration" value={formatDuration(session.startedAt, session.endedAt)} />
        <StatItem label="kWh" value={kwh > 0 ? kwh.toFixed(2) : '—'} />
        {cost && <StatItem label="Cost" value={cost} highlight />}
      </View>

      {/* Status */}
      <Text
        style={[
          styles.statusText,
          isActive && styles.statusActive,
          session.status === 'FAILED' && styles.statusFailed,
        ]}
      >
        {isActive ? 'Charging in progress →' : session.status === 'COMPLETED' ? 'Completed' : 'Failed'}
      </Text>
    </TouchableOpacity>
  );
}

function StatItem({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <View style={styles.statItem}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, highlight && styles.statHighlight]}>{value}</Text>
    </View>
  );
}

export default function SessionsScreen() {
  const router = useRouter();

  const { data, isLoading, refetch, isRefetching, fetchNextPage, hasNextPage } = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api.sessions.list(20, 0),
    refetchInterval: 15_000,
  });

  if (isLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#10b981" />
      </View>
    );
  }

  const sessions = data?.sessions ?? [];

  return (
    <View style={styles.container}>
      <FlatList
        data={sessions}
        keyExtractor={(s) => s.id}
        contentContainerStyle={styles.listContent}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} />}
        ListHeaderComponent={
          <Text style={styles.heading}>
            {sessions.length} session{sessions.length !== 1 ? 's' : ''}
          </Text>
        }
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyIcon}>⚡</Text>
            <Text style={styles.emptyTitle}>No sessions yet</Text>
            <Text style={styles.emptySubtitle}>
              Find a charger on the Map tab to get started.
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <SessionCard
            session={item}
            onPress={() =>
              item.status === 'ACTIVE'
                ? router.push(`/session/${item.id}`)
                : router.push(`/session/${item.id}`)
            }
          />
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  listContent: { padding: 16, gap: 12, paddingBottom: 32 },
  heading: { fontSize: 18, fontWeight: '700', color: '#111827', marginBottom: 4 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 16,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  siteName: { fontSize: 15, fontWeight: '700', color: '#111827', flex: 1 },
  activeBadge: {
    backgroundColor: '#d1fae5',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
  },
  activeBadgeText: { fontSize: 11, fontWeight: '700', color: '#065f46' },
  address: { fontSize: 12, color: '#6b7280', marginTop: 2, marginBottom: 12 },
  statsRow: { flexDirection: 'row', gap: 16, marginBottom: 10 },
  statItem: {},
  statLabel: { fontSize: 10, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.5 },
  statValue: { fontSize: 14, fontWeight: '600', color: '#374151', marginTop: 2 },
  statHighlight: { color: '#10b981' },
  statusText: { fontSize: 12, color: '#9ca3af' },
  statusActive: { color: '#10b981', fontWeight: '600' },
  statusFailed: { color: '#ef4444' },
  emptyContainer: { alignItems: 'center', paddingTop: 60 },
  emptyIcon: { fontSize: 48, marginBottom: 12 },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: '#111827', marginBottom: 6 },
  emptySubtitle: { fontSize: 14, color: '#6b7280', textAlign: 'center' },
});
