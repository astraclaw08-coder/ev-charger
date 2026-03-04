/**
 * Favorites tab — list of favorited chargers with live status.
 */
import React from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { api, type Charger } from '@/lib/api';
import { useFavorites } from '@/hooks/useFavorites';
import { HeartButton } from '@/components/HeartButton';
import { useAppTheme } from '@/theme';

function statusColor(c: Charger) {
  const s = c.connectors.map((x) => x.status);
  const hasAvailable = s.some((x) => x === 'AVAILABLE');
  const hasInUse = s.some((x) => x === 'CHARGING' || x === 'PREPARING' || x === 'FINISHING' || x === 'SUSPENDED_EV' || x === 'SUSPENDED_EVSE');
  const hasFaulted = s.some((x) => x === 'FAULTED');
  const isOffline = String(c.status || '').toUpperCase() === 'OFFLINE' && !hasAvailable && !hasInUse;

  if (hasAvailable) return '#10b981';
  if (hasInUse) return '#f59e0b';
  if (hasFaulted) return '#ef4444';
  if (isOffline || s.some((x) => x === 'UNAVAILABLE')) return '#9ca3af';
  return '#6b7280';
}

function statusLabel(c: Charger) {
  const s = c.connectors.map((x) => x.status);
  const hasAvailable = s.some((x) => x === 'AVAILABLE');
  const hasInUse = s.some((x) => x === 'CHARGING' || x === 'PREPARING' || x === 'FINISHING' || x === 'SUSPENDED_EV' || x === 'SUSPENDED_EVSE');
  const hasFaulted = s.some((x) => x === 'FAULTED');
  const isOffline = String(c.status || '').toUpperCase() === 'OFFLINE' && !hasAvailable && !hasInUse;

  if (hasAvailable) return 'Available';
  if (hasInUse) return 'In Use';
  if (hasFaulted) return 'Faulted';
  if (isOffline || s.some((x) => x === 'UNAVAILABLE')) return 'Offline';
  return 'Unknown';
}

export default function FavoritesScreen() {
  const router = useRouter();
  const { isDark } = useAppTheme();
  const { favorites, toggle, isFav } = useFavorites();
  const { data: chargers = [], isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['chargers'],
    queryFn: () => api.chargers.list(),
    refetchInterval: 30_000,
  });

  const favChargers = chargers.filter((c) => isFav(c.id));

  if (isLoading) {
    return <View style={styles.centered}><ActivityIndicator size="large" color="#10b981" /></View>;
  }

  return (
    <View style={[styles.container, { backgroundColor: isDark ? '#030712' : '#f9fafb' }]}>
      <FlatList
        data={favChargers}
        keyExtractor={(c) => c.id}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} />}
        contentContainerStyle={favChargers.length === 0 ? styles.emptyContainer : { padding: 12 }}
        ListEmptyComponent={
          <View style={styles.emptyInner}>
            <Text style={styles.emptyHeart}>🤍</Text>
            <Text style={[styles.emptyTitle, { color: isDark ? '#f9fafb' : '#111827' }]}>No favorites yet</Text>
            <Text style={[styles.emptySub, { color: isDark ? '#9ca3af' : '#6b7280' }]}>
              Tap the heart icon on any charger to save it here.
            </Text>
          </View>
        }
        renderItem={({ item }) => {
          const color = statusColor(item);
          const available = item.connectors.filter((c) => c.status === 'AVAILABLE').length;
          return (
            <TouchableOpacity
              style={[styles.card, { backgroundColor: isDark ? '#111827' : '#ffffff' }]}
              onPress={() => router.push(`/charger/${item.id}`)}
            >
              <View style={[styles.dot, { backgroundColor: color }]} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.name, { color: isDark ? '#f9fafb' : '#111827' }]}>{item.site.name}</Text>
                <Text style={[styles.meta, { color: isDark ? '#9ca3af' : '#6b7280' }]}>
                  {item.site.address} · {available}/{item.connectors.length} available
                </Text>
              </View>
              <Text style={{ color, fontWeight: '700', fontSize: 12, marginRight: 8 }}>{statusLabel(item)}</Text>
              <HeartButton isFavorited={isFav(item.id)} onToggle={() => toggle(item.id)} />
            </TouchableOpacity>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyContainer: { flex: 1 },
  emptyInner: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 40 },
  emptyHeart: { fontSize: 48, marginBottom: 12 },
  emptyTitle: { fontSize: 18, fontWeight: '800', marginBottom: 6 },
  emptySub: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  card: {
    borderRadius: 12, padding: 12, marginBottom: 8,
    flexDirection: 'row', alignItems: 'center', gap: 10,
    shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 4,
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  name: { fontSize: 14, fontWeight: '700' },
  meta: { fontSize: 12, marginTop: 2 },
});
