/**
 * Map screen — shows charger pins color-coded by status.
 * Uses Mapbox when EXPO_PUBLIC_MAPBOX_TOKEN is set, falls back to a list view.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  FlatList,
  TouchableOpacity,
  RefreshControl,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import * as Location from 'expo-location';
import { api, type Charger } from '@/lib/api';

const MAPBOX_TOKEN = process.env.EXPO_PUBLIC_MAPBOX_TOKEN;

// Detect whether @rnmapbox/maps native code is actually available (not in Expo Go)
let mapboxAvailable = false;
try {
  const Mapbox = require('@rnmapbox/maps');
  if (Mapbox?.MapView) mapboxAvailable = true;
} catch (_) {
  mapboxAvailable = false;
}

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

// ── Mapbox map view (when token present) ─────────────────────────────────────

function MapboxView({ chargers }: { chargers: Charger[] }) {
  const router = useRouter();
  const Mapbox = require('@rnmapbox/maps'); // safe — only called when mapboxAvailable is true

  const geojson: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: chargers.map((c) => ({
      type: 'Feature',
      id: c.id,
      geometry: {
        type: 'Point',
        coordinates: [c.site.lng, c.site.lat],
      },
      properties: {
        id: c.id,
        name: c.site.name,
        address: c.site.address,
        color: statusColor(c),
        label: statusLabel(c),
      },
    })),
  };

  return (
    <Mapbox.MapView style={styles.map} styleURL={Mapbox.StyleURL.Street}>
      <Mapbox.Camera
        zoomLevel={11}
        centerCoordinate={
          chargers.length > 0
            ? [chargers[0].site.lng, chargers[0].site.lat]
            : [-118.3526, 33.9164]
        }
        animationMode="none"
      />

      <Mapbox.ShapeSource
        id="chargers"
        shape={geojson}
        onPress={(e: { features: Array<{ properties: { id: string } }> }) => {
          const feature = e.features[0];
          if (feature?.properties?.id) {
            router.push(`/charger/${feature.properties.id}`);
          }
        }}
      >
        <Mapbox.CircleLayer
          id="charger-circles"
          style={{
            circleRadius: 14,
            circleColor: ['get', 'color'],
            circleStrokeWidth: 2,
            circleStrokeColor: '#fff',
          }}
        />
        <Mapbox.SymbolLayer
          id="charger-labels"
          style={{
            textField: ['get', 'label'],
            textSize: 10,
            textOffset: [0, 2],
            textAnchor: 'top',
            textColor: '#111827',
            textHaloColor: '#fff',
            textHaloWidth: 1,
          }}
        />
      </Mapbox.ShapeSource>
    </Mapbox.MapView>
  );
}

// ── Fallback list view (when no Mapbox token) ─────────────────────────────────

function ChargerListView({
  chargers,
  onRefresh,
  refreshing,
}: {
  chargers: Charger[];
  onRefresh: () => void;
  refreshing: boolean;
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
            style={styles.chargerCard}
            onPress={() => router.push(`/charger/${item.id}`)}
          >
            <View style={[styles.statusDot, { backgroundColor: color }]} />
            <View style={styles.chargerInfo}>
              <Text style={styles.chargerName}>{item.site.name}</Text>
              <Text style={styles.chargerAddress}>{item.site.address}</Text>
              <Text style={styles.chargerMeta}>
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

  if (!MAPBOX_TOKEN || !mapboxAvailable) {
    return (
      <View style={styles.container}>
        {MAPBOX_TOKEN && !mapboxAvailable && (
          <View style={styles.noBanner}>
            <Text style={styles.noBannerText}>
              Map requires a development build — showing list view
            </Text>
          </View>
        )}
        {!MAPBOX_TOKEN && (
          <View style={styles.noBanner}>
            <Text style={styles.noBannerText}>
              Set EXPO_PUBLIC_MAPBOX_TOKEN in .env to enable the map
            </Text>
          </View>
        )}
        <ChargerListView
          chargers={chargers}
          onRefresh={refetch}
          refreshing={isRefetching}
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <MapboxView chargers={chargers} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  map: { flex: 1 },
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
});
