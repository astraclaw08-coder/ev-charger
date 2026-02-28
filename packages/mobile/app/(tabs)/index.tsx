import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  RefreshControl,
  ScrollView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import * as Location from 'expo-location';
import MapView, { Marker } from 'react-native-maps';
import { api, type Charger } from '@/lib/api';
import { useAppTheme } from '@/theme';

type Coord = { latitude: number; longitude: number };

function statusColor(charger: Charger): string {
  const statuses = charger.connectors.map((c) => c.status);
  if (statuses.some((s) => s === 'AVAILABLE')) return '#10b981';
  if (statuses.some((s) => s === 'CHARGING' || s === 'PREPARING' || s === 'FINISHING')) return '#f59e0b';
  if (statuses.some((s) => s === 'FAULTED')) return '#ef4444';
  return '#9ca3af';
}

function statusLabel(charger: Charger): string {
  const statuses = charger.connectors.map((c) => c.status);
  if (statuses.some((s) => s === 'AVAILABLE')) return 'Available';
  if (statuses.some((s) => s === 'CHARGING')) return 'In Use';
  if (statuses.some((s) => s === 'FAULTED')) return 'Faulted';
  return 'Offline';
}

function distanceKm(a: Coord, b: Coord): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);

  const sinDlat = Math.sin(dLat / 2);
  const sinDlng = Math.sin(dLng / 2);
  const h = sinDlat * sinDlat + Math.cos(lat1) * Math.cos(lat2) * sinDlng * sinDlng;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export default function MapScreen() {
  const router = useRouter();
  const mapRef = useRef<MapView | null>(null);
  const { isDark } = useAppTheme();

  const [hasLocation, setHasLocation] = useState(false);
  const [userLocation, setUserLocation] = useState<Coord | null>(null);

  const { data: chargers = [], isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['chargers'],
    queryFn: () => api.chargers.list(),
    refetchInterval: 30_000,
  });

  useEffect(() => {
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      const granted = status === 'granted';
      setHasLocation(granted);
      if (!granted) return;

      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      setUserLocation({ latitude: loc.coords.latitude, longitude: loc.coords.longitude });
    })().catch(() => setHasLocation(false));
  }, []);

  const initialCenter = useMemo(() => {
    if (userLocation) return userLocation;
    if (chargers.length > 0) {
      return { latitude: chargers[0].site.lat, longitude: chargers[0].site.lng };
    }
    return { latitude: 33.9164, longitude: -118.3526 };
  }, [chargers, userLocation]);

  const nearest = useMemo(() => {
    if (chargers.length === 0) return [] as Array<Charger & { distanceKm?: number }>;

    const withDistance = chargers.map((c) => {
      const d = userLocation
        ? distanceKm(userLocation, { latitude: c.site.lat, longitude: c.site.lng })
        : undefined;
      return { ...c, distanceKm: d };
    });

    return withDistance
      .sort((a, b) => (a.distanceKm ?? 9999) - (b.distanceKm ?? 9999))
      .slice(0, 3);
  }, [chargers, userLocation]);

  async function recenterToUser() {
    try {
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const target = { latitude: loc.coords.latitude, longitude: loc.coords.longitude };
      setUserLocation(target);
      mapRef.current?.animateToRegion(
        {
          ...target,
          latitudeDelta: 0.03,
          longitudeDelta: 0.03,
        },
        400,
      );
    } catch {
      // no-op
    }
  }

  if (isLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#10b981" />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: isDark ? '#030712' : '#f9fafb' }]}>
      {/* 3/4 screen map */}
      <View style={styles.mapSection}>
        <MapView
          ref={mapRef}
          style={styles.map}
          initialRegion={{
            latitude: initialCenter.latitude,
            longitude: initialCenter.longitude,
            latitudeDelta: 0.06,
            longitudeDelta: 0.06,
          }}
          showsUserLocation={hasLocation}
          showsMyLocationButton={false}
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

        <TouchableOpacity style={styles.locateBtn} onPress={recenterToUser}>
          <Text style={styles.locateText}>📍 Locate Me</Text>
        </TouchableOpacity>
      </View>

      {/* 1/4 screen nearest list */}
      <ScrollView
        style={[styles.bottomSheet, { backgroundColor: isDark ? '#0b1220' : '#ffffff' }]}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} />}
      >
        <Text style={[styles.sectionTitle, { color: isDark ? '#f9fafb' : '#111827' }]}>Closest chargers</Text>
        <Text style={[styles.sectionSubtitle, { color: isDark ? '#9ca3af' : '#6b7280' }]}>Top 2–3 stations nearest your current location</Text>

        {nearest.map((item) => {
          const color = statusColor(item);
          const available = item.connectors.filter((c) => c.status === 'AVAILABLE').length;
          return (
            <TouchableOpacity
              key={item.id}
              style={[styles.card, { backgroundColor: isDark ? '#111827' : '#f9fafb' }]}
              onPress={() => router.push(`/charger/${item.id}`)}
            >
              <View style={[styles.dot, { backgroundColor: color }]} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.name, { color: isDark ? '#f9fafb' : '#111827' }]}>{item.site.name}</Text>
                <Text style={[styles.meta, { color: isDark ? '#9ca3af' : '#6b7280' }]}>
                  {item.distanceKm != null ? `${item.distanceKm.toFixed(2)} km • ` : ''}
                  {available}/{item.connectors.length} available
                </Text>
              </View>
              <Text style={{ color, fontWeight: '700', fontSize: 12 }}>{statusLabel(item)}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  mapSection: { flex: 3, position: 'relative' },
  map: { flex: 1 },
  locateBtn: {
    position: 'absolute',
    right: 12,
    bottom: 12,
    backgroundColor: '#111827',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
  },
  locateText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  bottomSheet: { flex: 1, paddingHorizontal: 12, paddingTop: 10 },
  sectionTitle: { fontSize: 17, fontWeight: '800' },
  sectionSubtitle: { fontSize: 12, marginTop: 2, marginBottom: 8 },
  card: {
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  name: { fontSize: 14, fontWeight: '700' },
  meta: { fontSize: 12, marginTop: 2 },
});
