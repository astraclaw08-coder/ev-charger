/**
 * Session History screen - driver's past and active sessions.
 */
import React, { useMemo, useState } from 'react';
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
import { useFocusEffect } from '@react-navigation/native';
import { useQuery } from '@tanstack/react-query';
import {
  api,
  isEvcPlatformReadModelEnabled,
  type EnrichedTransaction,
  type Session,
} from '@/lib/api';
import { useAppTheme } from '@/theme';
import { useAppAuth } from '@/providers/AuthProvider';

type SummaryRange = 'week' | 'month' | 'year';

type ReadModelData = {
  portfolioSummary: Awaited<ReturnType<typeof api.analytics.portfolioSummary>> | null;
  enrichedTransactions: Awaited<ReturnType<typeof api.transactions.enriched>> | null;
  rebateIntervals: Awaited<ReturnType<typeof api.rebates.intervals>> | null;
};

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

function formatKwh(value: number): string {
  return value.toFixed(4).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function getRangeStart(range: SummaryRange): Date {
  const now = new Date();
  if (range === 'week') {
    return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  }
  if (range === 'month') {
    return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  }
  return new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
}

function mapEnrichedToSession(tx: EnrichedTransaction): Session {
  return {
    id: tx.sessionId,
    transactionId: tx.transactionId,
    status: tx.status === 'ACTIVE' ? 'ACTIVE' : tx.status === 'COMPLETED' ? 'COMPLETED' : 'FAILED',
    meterStart: tx.meterStart ?? 0,
    meterStop: tx.meterStop,
    kwhDelivered: tx.energyKwh,
    ratePerKwh: null,
    startedAt: tx.startedAt,
    endedAt: tx.stoppedAt,
    costEstimateCents: tx.estimatedAmountCents ?? Math.round((tx.revenueUsd ?? 0) * 100),
    estimatedAmountCents: tx.estimatedAmountCents ?? Math.round((tx.revenueUsd ?? 0) * 100),
    effectiveAmountCents: tx.effectiveAmountCents ?? tx.estimatedAmountCents ?? Math.round((tx.revenueUsd ?? 0) * 100),
    amountState: tx.amountState,
    amountLabel: tx.amountLabel,
    isAmountFinal: tx.isAmountFinal,
    connector: {
      connectorId: 1,
      charger: {
        id: tx.charger.id,
        ocppId: tx.charger.ocppId,
        model: tx.charger.model,
        vendor: tx.charger.vendor,
        status: tx.status,
        site: { name: tx.site.name, address: '' },
      },
    },
    payment: tx.payment
      ? {
          id: tx.id,
          status: tx.payment.status,
          amountCents: tx.payment.amountCents,
          stripeCustomerId: null,
          stripeIntentId: null,
        }
      : null,
  };
}

function SessionCard({ session, onPress, isDark }: { session: Session; onPress: () => void; isDark: boolean }) {
  const isActive = session.status === 'ACTIVE';
  const charger = session.connector.charger;
  const kwh = session.kwhDelivered ?? 0;
  const costCents = session.effectiveAmountCents ?? session.estimatedAmountCents ?? session.costEstimateCents ?? session.payment?.amountCents ?? null;
  const cost = costCents != null ? `$${(costCents / 100).toFixed(2)}` : null;
  const costLabel = session.amountState === 'FINAL' ? 'Cost' : 'Est. Cost';

  return (
    <TouchableOpacity style={[styles.card, { backgroundColor: isDark ? '#111827' : '#fff' }]} onPress={onPress} activeOpacity={0.7}>
      <View style={styles.cardHeader}>
        <Text style={[styles.siteName, { color: isDark ? '#f9fafb' : '#111827' }]}>{charger.site.name}</Text>
        {isActive && (
          <View style={styles.activeBadge}>
            <Text style={styles.activeBadgeText}>Live</Text>
          </View>
        )}
      </View>

      {charger.site.address ? (
        <Text style={[styles.address, { color: isDark ? '#9ca3af' : '#6b7280' }]}>{charger.site.address}</Text>
      ) : null}

      <View style={styles.statsRow}>
        <StatItem label="Date" value={formatDate(session.startedAt)} />
        <StatItem label="Duration" value={formatDuration(session.startedAt, session.endedAt)} />
        <StatItem label="kWh" value={kwh > 0 ? formatKwh(kwh) : '-'} />
        {cost && <StatItem label={costLabel} value={cost} highlight />}
      </View>

      <Text
        style={[
          styles.statusText,
          isActive && styles.statusActive,
          session.status === 'FAILED' && styles.statusFailed,
        ]}
      >
        {isActive ? 'Charging in progress →' : session.status === 'COMPLETED' ? 'Completed' : 'Failed'}
      </Text>
      {session.amountState === 'PENDING' && (
        <Text style={styles.pendingHint}>Payment pending · total shown is estimated</Text>
      )}
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

function SummaryCard({ label, value, isDark }: { label: string; value: string; isDark: boolean }) {
  return (
    <View style={[styles.summaryCard, { backgroundColor: isDark ? '#111827' : '#ffffff' }]}>
      <Text style={[styles.summaryLabel, { color: isDark ? '#9ca3af' : '#6b7280' }]}>{label}</Text>
      <Text style={[styles.summaryValue, { color: isDark ? '#f9fafb' : '#111827' }]}>{value}</Text>
    </View>
  );
}

export default function SessionsScreen() {
  const router = useRouter();
  const { isDark } = useAppTheme();
  const { isGuest } = useAppAuth();
  const [summaryRange, setSummaryRange] = useState<SummaryRange>('month');
  const [manualRefreshing, setManualRefreshing] = useState(false);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api.sessions.list(20, 0),
    staleTime: 60_000,
    placeholderData: (prev) => prev,
    enabled: !isGuest,
  });

  const { data: readModelData, refetch: refetchReadModel } = useQuery({
    queryKey: ['sessions-read-model'],
    enabled: !isGuest && isEvcPlatformReadModelEnabled,
    staleTime: 60_000,
    queryFn: async (): Promise<ReadModelData> => {
      const [portfolioSummary, enrichedTransactions, rebateIntervals] = await Promise.allSettled([
        api.analytics.portfolioSummary(),
        api.transactions.enriched({ limit: 200, offset: 0 }),
        api.rebates.intervals({ limit: 500, offset: 0 }),
      ]);

      return {
        portfolioSummary: portfolioSummary.status === 'fulfilled' ? portfolioSummary.value : null,
        enrichedTransactions: enrichedTransactions.status === 'fulfilled' ? enrichedTransactions.value : null,
        rebateIntervals: rebateIntervals.status === 'fulfilled' ? rebateIntervals.value : null,
      };
    },
  });

  useFocusEffect(
    React.useCallback(() => {
      refetch();
      if (isEvcPlatformReadModelEnabled) {
        refetchReadModel();
      }
      return undefined;
    }, [refetch, refetchReadModel]),
  );

  async function onPullRefresh() {
    setManualRefreshing(true);
    try {
      await refetch();
      if (isEvcPlatformReadModelEnabled) {
        await refetchReadModel();
      }
    } finally {
      setManualRefreshing(false);
    }
  }

  const fallbackSessions = data?.sessions ?? [];
  const enrichedRows = readModelData?.enrichedTransactions?.transactions ?? [];
  const sessions = useMemo(() => {
    if (!isEvcPlatformReadModelEnabled || enrichedRows.length === 0) return fallbackSessions;
    return enrichedRows
      .map(mapEnrichedToSession)
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  }, [fallbackSessions, enrichedRows]);

  const summary = useMemo(() => {
    const rangeStart = getRangeStart(summaryRange).getTime();

    if (isEvcPlatformReadModelEnabled && enrichedRows.length > 0) {
      const inRange = enrichedRows.filter((row) => new Date(row.startedAt).getTime() >= rangeStart);
      const portfolioTotals = readModelData?.portfolioSummary?.totals;
      const rebatesSummary = readModelData?.rebateIntervals?.summary;

      const totalKwh = inRange.reduce((sum, row) => sum + (row.energyKwh ?? 0), 0);
      const totalSpend = inRange.reduce((sum, row) => sum + (row.revenueUsd ?? 0), 0);

      return {
        transactions: inRange.length,
        totalKwh: totalKwh > 0 ? totalKwh : (rebatesSummary?.totalEnergyKwh ?? 0),
        totalSpend: totalSpend > 0 ? totalSpend : (portfolioTotals?.totalRevenueUsd ?? 0),
      };
    }

    const inRange = fallbackSessions.filter((s) => new Date(s.startedAt).getTime() >= rangeStart);

    const totalKwh = inRange.reduce((sum, s) => sum + (s.kwhDelivered ?? 0), 0);
    const totalSpend = inRange.reduce((sum, s) => {
      const amountCents = s.effectiveAmountCents ?? s.estimatedAmountCents ?? s.costEstimateCents ?? s.payment?.amountCents;
      if (amountCents != null) return sum + amountCents / 100;
      return sum;
    }, 0);

    return {
      transactions: inRange.length,
      totalKwh,
      totalSpend,
    };
  }, [fallbackSessions, summaryRange, enrichedRows, readModelData]);

  if (isGuest) {
    return (
      <View style={[styles.centered, { backgroundColor: isDark ? '#030712' : '#f9fafb', paddingHorizontal: 20 }]}> 
        <Text style={[styles.emptyTitle, { marginBottom: 8 }]}>Guest mode</Text>
        <Text style={[styles.emptySubtitle, { marginBottom: 16 }]}>Sign in to view charging history.</Text>
        <TouchableOpacity style={{ backgroundColor: '#10b981', borderRadius: 10, paddingHorizontal: 18, paddingVertical: 12 }} onPress={() => router.replace('/(auth)/sign-in' as any)}>
          <Text style={{ color: '#fff', fontWeight: '700' }}>Sign In</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (isLoading) {
    return (
      <View style={[styles.centered, { backgroundColor: isDark ? '#030712' : '#f9fafb' }]}> 
        <ActivityIndicator size="large" color="#10b981" />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: isDark ? '#030712' : '#f9fafb' }]}> 
      <FlatList
        data={sessions}
        keyExtractor={(s) => s.id}
        contentContainerStyle={styles.listContent}
        refreshControl={<RefreshControl refreshing={manualRefreshing} onRefresh={onPullRefresh} />}
        ListHeaderComponent={
          <View style={styles.headerWrap}>
            <View style={[styles.segmentedControl, { backgroundColor: isDark ? '#111827' : '#e5e7eb' }]}>
              {(['week', 'month', 'year'] as SummaryRange[]).map((range) => {
                const selected = summaryRange === range;
                return (
                  <TouchableOpacity
                    key={range}
                    style={[
                      styles.segmentBtn,
                      selected && { backgroundColor: isDark ? '#1f2937' : '#ffffff' },
                    ]}
                    onPress={() => setSummaryRange(range)}
                    activeOpacity={0.8}
                  >
                    <Text style={[styles.segmentText, { color: selected ? '#10b981' : isDark ? '#9ca3af' : '#6b7280' }]}> 
                      {range === 'week' ? 'Week' : range === 'month' ? 'Month' : 'Year'}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <View style={styles.summaryRow}>
              <SummaryCard label="Transactions" value={`${summary.transactions}`} isDark={isDark} />
              <SummaryCard label="Total kWh" value={formatKwh(summary.totalKwh)} isDark={isDark} />
              <SummaryCard label="Total Spent" value={`$${summary.totalSpend.toFixed(2)}`} isDark={isDark} />
            </View>

            <Text style={[styles.countText, { color: isDark ? '#9ca3af' : '#6b7280' }]}> 
              {sessions.length} total session{sessions.length !== 1 ? 's' : ''}
            </Text>
          </View>
        }
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyIcon}>⚡</Text>
            <Text style={styles.emptyTitle}>No sessions yet</Text>
            <Text style={styles.emptySubtitle}>
              Find a charger on the Find Charger tab to get started.
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <SessionCard
            session={item}
            isDark={isDark}
            onPress={() => router.push(`/session/${item.id}`)}
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
  headerWrap: { marginBottom: 6, gap: 8 },
  segmentedControl: {
    flexDirection: 'row',
    borderRadius: 10,
    padding: 4,
    gap: 6,
    alignSelf: 'flex-start',
  },
  segmentBtn: {
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  segmentText: {
    fontSize: 13,
    fontWeight: '700',
  },
  summaryRow: {
    flexDirection: 'row',
    gap: 8,
  },
  summaryCard: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 10,
  },
  summaryLabel: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    marginBottom: 4,
  },
  summaryValue: {
    fontSize: 18,
    fontWeight: '800',
  },
  countText: {
    fontSize: 13,
    fontWeight: '500',
  },
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
  pendingHint: { marginTop: 4, fontSize: 11, color: '#d97706', fontWeight: '600' },
  statusActive: { color: '#10b981', fontWeight: '600' },
  statusFailed: { color: '#ef4444' },
  emptyContainer: { alignItems: 'center', paddingTop: 60 },
  emptyIcon: { fontSize: 48, marginBottom: 12 },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: '#111827', marginBottom: 6 },
  emptySubtitle: { fontSize: 14, color: '#6b7280', textAlign: 'center' },
});
