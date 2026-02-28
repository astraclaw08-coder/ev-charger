/**
 * Map screen — shows charger pins color-coded by status.
 * Shows interactive charger map + list view.
 */
import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  useColorScheme,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import * as Location from 'expo-location';
import { api, type Charger } from '@/lib/api';
import MapView, { Marker } from 'react-native-maps';


// ── Status → map pin color mapping ───────────────────────────────────────────

function statusColor(charger: Charger): string {
  const statuses = charger.connectors.map((c) => c.status);
  if (statuses.some((s) => s === 'AVAILABLE')) return '#10b981'; // green
  if (statuses.some((s) => s === 'CHARGING' || s === 'PREPARING' || s === 'FINISHING')) return '#f59e0b'; // yellow
  if (statuses.some((s) => s === 'FAULTED')) return '#ef4444'; // red
  return '#9ca3af'; // grey — offline / unavailable
}

function statusLabel(charger: Charger): string {
  const statuses = charger.connectors.map((c) => c.status);
  if (statuses.some((s) => s === 'AVAILABLE')) return 'Available';
  if (statuses.some((s) => s === 'CHARGING')) return 'In Use';
  if (statuses.some((s) => s === 'FAULTED')) return 'Faulted';
  return 'Offline';
}

// ── Interactive native map view ────────────────────────────────────────────────

function InteractiveMapView({ chargers, hasLocation }: { chargers: Charger[]; hasLocation: boolean }) {
  const router = useRouter();

  const lats = chargers.map((c) => c.site.lat);
  const lngs = chargers.map((c) => c.site.lng);
  const minLat = lats.length ? Math.min(...lats) : 33.9164;
  const maxLat = lats.length ? Math.max(...lats) : 33.9164;
  const minLng = lngs.length ? Math.min(...lngs) : -118.3526;
  const maxLng = lngs.length ? Math.max(...lngs) : -118.3526;

  const centerLat = (minLat + maxLat) / 2;
  const centerLng = (minLng + maxLng) / 2;

  return (
    <MapView
      style={styles.map}
      initialRegion={{
        latitude: centerLat,
        longitude: centerLng,
        latitudeDelta: Math.max(0.05, (maxLat - minLat) * 1.8),
        longitudeDelta: Math.max(0.05, (maxLng - minLng) * 1.8),
      }}
      showsUserLocation={hasLocation}
      showsMyLocationButton
    >
      {chargers.map((c) => (
        <Marker
          key={c.id}
          coordinate={{ latitude: c.site.lat, longitude: c.site.lng }}
          title={c.site.name}
          description={`${c.vendor} ${c.model} · ${statusLabel(c)}`}
          pinColor={statusColor(c)}
          onCalloutPress={() => router.push(`/charger/${c.id}`)}
        />
      ))}
    </MapView>
  );
}

// ── Charger list view ─────────────────────────────────

function ChargerListView({
  chargers,
  onRefresh,
  refreshing,
  isDark,
}: {
  chargers: Charger[];
  onRefresh: () => void;
  refreshing: boolean;
  isDark: boolean;
}) {
  const router = useRouter();

  return (
    <FlatList
      data={chargers}
      keyExtractor={(item) => item.id}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      contentContainerStyle={styles.listContent}
      ListEmptyComponent={
        <Text style={styles.emptyText}>No chargers found in your area.</Text>
      }
      renderItem={({ item }) => {
        const color = statusColor(item);
        const label = statusLabel(item);
        const available = item.connectors.filter((c) => c.status === 'AVAILABLE').length;
        return (
          <TouchableOpacity
            style={[styles.chargerCard, { backgroundColor: isDark ? '#111827' : '#fff' }]}
            onPress={() => router.push(`/charger/${item.id}`)}
          >
            <View style={[styles.statusDot, { backgroundColor: color }]} />
            <View style={styles.chargerInfo}>
              <Text style={[styles.chargerName, { color: isDark ? '#f9fafb' : '#111827' }]}>{item.site.name}</Text>
              <Text style={[styles.chargerAddress, { color: isDark ? '#9ca3af' : '#6b7280' }]}>{item.site.address}</Text>
              <Text style={[styles.chargerMeta, { color: isDark ? '#6b7280' : '#9ca3af' }]}>
                {item.vendor} {item.model} · {available}/{item.connectors.length} available
              </Text>
            </View>
            <View style={[styles.statusBadge, { backgroundColor: color + '22' }]}>
              <Text style={[styles.statusBadgeText, { color }]}>{label}</Text>
            </View>
          </TouchableOpacity>
        );
      }}
    />
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function MapScreen() {
  const [hasLocation, setHasLocation] = useState(false);
  const isDark = useColorScheme() === 'dark';

  const { data: chargers = [], isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['chargers'],
    queryFn: () => api.chargers.list(),
    refetchInterval: 30_000,
  });

  useEffect(() => {
    Location.requestForegroundPermissionsAsync()
      .then(({ status }) => setHasLocation(status === 'granted'))
      .catch(() => setHasLocation(false));
  }, []);

  if (isLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#10b981" />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: isDark ? '#030712' : '#f9fafb' }]}>
      <View style={styles.interactiveMapWrap}>
        <InteractiveMapView chargers={chargers} hasLocation={hasLocation} />
      </View>
      <ChargerListView
        chargers={chargers}
        onRefresh={refetch}
        refreshing={isRefetching}
        isDark={isDark}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  map: { flex: 1 },
  interactiveMapWrap: { height: 300, margin: 12, borderRadius: 12, overflow: 'hidden' },
  listContent: { padding: 16, gap: 12 },
  emptyText: { textAlign: 'center', color: '#9ca3af', marginTop: 40, fontSize: 15 },
  chargerCard: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  statusDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    flexShrink: 0,
  },
  chargerInfo: { flex: 1 },
  chargerName: { fontSize: 15, fontWeight: '600', color: '#111827' },
  chargerAddress: { fontSize: 12, color: '#6b7280', marginTop: 2 },
  chargerMeta: { fontSize: 12, color: '#9ca3af', marginTop: 4 },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  statusBadgeText: { fontSize: 12, fontWeight: '600' },
  noBanner: {
    backgroundColor: '#fef3c7',
    padding: 10,
    margin: 12,
    borderRadius: 8,
  },
  noBannerText: { fontSize: 12, color: '#92400e', textAlign: 'center' },
  fallbackMapWrap: { paddingHorizontal: 12, paddingBottom: 4 },
  fallbackMap: {
    backgroundColor: '#e5e7eb',
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#d1d5db',
    position: 'relative',
  },
  fallbackMapTitle: {
    position: 'absolute',
    top: 8,
    left: 10,
    fontSize: 12,
    fontWeight: '600',
    color: '#374151',
  },
  fallbackPin: {
    position: 'absolute',
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: '#fff',
  },
  fallbackEmpty: { textAlign: 'center', color: '#6b7280', marginTop: 100 },
});
