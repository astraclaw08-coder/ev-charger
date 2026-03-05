import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  RefreshControl,
  ScrollView,
  TextInput,
  Keyboard,
  AppState,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { useQuery } from '@tanstack/react-query';
import * as Location from 'expo-location';
import MapView, { Marker, Region } from 'react-native-maps';
import { api, type Charger } from '@/lib/api';
import { useAppTheme } from '@/theme';
import { useFavorites } from '@/hooks/useFavorites';
import { HeartButton } from '@/components/HeartButton';

type Coord = { latitude: number; longitude: number };

type SiteAggregate = {
  siteId: string;
  siteName: string;
  siteAddress: string;
  lat: number;
  lng: number;
  chargers: Charger[];
  primaryChargerId: string;
  totalPorts: number;
  availablePorts: number;
  distanceKm?: number;
};

function statusColorFromStatuses(statuses: string[], chargerStatuses: string[]): string {
  const hasAvailable = statuses.some((s) => s === 'AVAILABLE');
  const hasInUse = statuses.some((s) => s === 'CHARGING' || s === 'PREPARING' || s === 'FINISHING' || s === 'SUSPENDED_EV' || s === 'SUSPENDED_EVSE');
  const hasFaulted = statuses.some((s) => s === 'FAULTED');
  const isOffline = chargerStatuses.some((s) => s === 'OFFLINE') && !hasAvailable && !hasInUse;

  if (hasAvailable) return '#10b981';
  if (hasInUse) return '#f59e0b';
  if (hasFaulted) return '#ef4444';
  if (isOffline) return '#9ca3af';
  return '#6b7280';
}

function statusLabelFromStatuses(statuses: string[], chargerStatuses: string[]): string {
  const hasAvailable = statuses.some((s) => s === 'AVAILABLE');
  const hasInUse = statuses.some((s) => s === 'CHARGING' || s === 'PREPARING' || s === 'FINISHING' || s === 'SUSPENDED_EV' || s === 'SUSPENDED_EVSE');
  const hasFaulted = statuses.some((s) => s === 'FAULTED');
  const hasUnavailable = statuses.some((s) => s === 'UNAVAILABLE' || s === 'OFFLINE');
  const isOffline = chargerStatuses.some((s) => s === 'OFFLINE') && !hasAvailable && !hasInUse;

  if (hasAvailable) return 'Available';
  if (hasInUse) return 'In Use';
  if (hasFaulted) return 'Faulted';
  if (isOffline || hasUnavailable) return 'Offline';
  return 'Unknown';
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
  const searchInputRef = useRef<TextInput | null>(null);
  const regionRef = useRef<Region | null>(null);
  const { isDark } = useAppTheme();
  const { toggle, isFav } = useFavorites();

  const [hasLocation, setHasLocation] = useState(false);
  const [userLocation, setUserLocation] = useState<Coord | null>(null);
  const [search, setSearch] = useState('');
  const [committedSearch, setCommittedSearch] = useState('');
  const [manualRefreshing, setManualRefreshing] = useState(false);

  const { data: chargers = [], isLoading, refetch } = useQuery({
    queryKey: ['chargers'],
    queryFn: () => api.chargers.list(),
    staleTime: 60_000,
    placeholderData: (prev) => prev,
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

  useFocusEffect(
    React.useCallback(() => {
      refetch();
      return undefined;
    }, [refetch]),
  );

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refetch();
    });
    return () => sub.remove();
  }, [refetch]);


  const sites = useMemo(() => {
    const bySite = new Map<string, SiteAggregate>();

    for (const charger of chargers) {
      const site = charger?.site;
      const connectors = Array.isArray(charger?.connectors) ? charger.connectors : [];
      const hasCoords = Number.isFinite(site?.lat) && Number.isFinite(site?.lng);
      if (!charger?.id || !site || !hasCoords) continue;

      const key = site.id || `${site.name}|${site.address}`;
      const existing = bySite.get(key);
      if (!existing) {
        bySite.set(key, {
          siteId: key,
          siteName: site.name,
          siteAddress: site.address,
          lat: site.lat,
          lng: site.lng,
          chargers: [charger],
          primaryChargerId: charger.id,
          totalPorts: connectors.length,
          availablePorts: connectors.filter((c) => c.status === 'AVAILABLE').length,
        });
      } else {
        existing.chargers.push(charger);
        existing.totalPorts += connectors.length;
        existing.availablePorts += connectors.filter((c) => c.status === 'AVAILABLE').length;
      }
    }

    return Array.from(bySite.values());
  }, [chargers]);

  const filteredSites = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sites;
    return sites.filter((s) =>
      s.siteName.toLowerCase().includes(q) || s.siteAddress.toLowerCase().includes(q),
    );
  }, [sites, search]);

  const suggestions = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [] as SiteAggregate[];
    return filteredSites.slice(0, 5);
  }, [filteredSites, search]);

  const initialCenter = useMemo(() => {
    if (userLocation) return userLocation;
    if (filteredSites.length > 0) {
      return { latitude: filteredSites[0].lat, longitude: filteredSites[0].lng };
    }
    return { latitude: 33.9164, longitude: -118.3526 };
  }, [filteredSites, userLocation]);


  const nearest = useMemo(() => {
    if (filteredSites.length === 0) return [] as SiteAggregate[];

    const withDistance = filteredSites.map((s) => {
      const d = userLocation
        ? distanceKm(userLocation, { latitude: s.lat, longitude: s.lng })
        : undefined;
      return { ...s, distanceKm: d };
    });

    return withDistance
      .sort((a, b) => (a.distanceKm ?? 9999) - (b.distanceKm ?? 9999))
      .slice(0, 3);
  }, [filteredSites, userLocation]);

  async function recenterToUser() {
    try {
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const target = { latitude: loc.coords.latitude, longitude: loc.coords.longitude };
      setUserLocation(target);
      const targetRegion = {
        ...target,
        latitudeDelta: 0.03,
        longitudeDelta: 0.03,
      };
      regionRef.current = targetRegion;
      mapRef.current?.animateToRegion(targetRegion, 400);
    } catch {
      // no-op
    }
  }

  async function onManualRefresh() {
    setManualRefreshing(true);
    try {
      await refetch();
    } finally {
      setManualRefreshing(false);
    }
  }


  useEffect(() => {
    const q = committedSearch.trim();
    if (!q || filteredSites.length === 0 || !mapRef.current) return;

    const coords = filteredSites.map((s) => ({ latitude: s.lat, longitude: s.lng }));
    const unique = Array.from(new Map(coords.map((c) => [`${c.latitude.toFixed(6)},${c.longitude.toFixed(6)}`, c])).values());

    if (unique.length === 1) {
      mapRef.current.animateToRegion(
        {
          latitude: unique[0].latitude,
          longitude: unique[0].longitude,
          latitudeDelta: 0.03,
          longitudeDelta: 0.03,
        },
        350,
      );
      return;
    }

    mapRef.current.fitToCoordinates(unique, {
      edgePadding: { top: 70, right: 70, bottom: 120, left: 70 },
      animated: true,
    });
  }, [committedSearch, filteredSites]);


  function zoomBy(delta: number) {
    if (!mapRef.current) return;
    const base = regionRef.current ?? {
      latitude: initialCenter.latitude,
      longitude: initialCenter.longitude,
      latitudeDelta: 0.06,
      longitudeDelta: 0.06,
    };
    const factor = delta > 0 ? 0.5 : 2;
    const nextRegion: Region = {
      ...base,
      latitudeDelta: Math.max(0.002, Math.min(60, base.latitudeDelta * factor)),
      longitudeDelta: Math.max(0.002, Math.min(60, base.longitudeDelta * factor)),
    };
    regionRef.current = nextRegion;
    mapRef.current.animateToRegion(nextRegion, 250);

  }

  function applySearch(site: SiteAggregate) {
    setSearch(site.siteName);
    setCommittedSearch(site.siteName);
    router.push(`/charger/${site.primaryChargerId}`);
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
          zoomEnabled
          scrollEnabled
          rotateEnabled
          pitchEnabled
          userInterfaceStyle={isDark ? 'dark' : 'light'}
          onRegionChangeComplete={(r) => {
            regionRef.current = r;
          }}
        >
          {filteredSites.map((site) => {
            const allStatuses = site.chargers.flatMap((c) => c.connectors.map((x) => x.status));
            const chargerStatuses = site.chargers.map((c) => String(c.status || '').toUpperCase());
            const pinColor = statusColorFromStatuses(allStatuses, chargerStatuses);
            const label = statusLabelFromStatuses(allStatuses, chargerStatuses);
            return (
              <Marker
                key={site.siteId}
                coordinate={{ latitude: site.lat, longitude: site.lng }}
                title={site.siteName}
                description={`${label} · ${site.availablePorts}/${site.totalPorts} ports available`}
                pinColor={pinColor}
                onCalloutPress={() => router.push(`/charger/${site.primaryChargerId}`)}
              />
            );
          })}
        </MapView>

        <View pointerEvents="box-none" style={styles.mapControls}>
          <TouchableOpacity style={styles.locateBtn} onPress={recenterToUser}>
            <Text style={styles.locateText}>◎</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.zoomBtn} onPress={() => zoomBy(1)}><Text style={styles.zoomText}>＋</Text></TouchableOpacity>
          <TouchableOpacity style={styles.zoomBtn} onPress={() => zoomBy(-1)}><Text style={styles.zoomText}>－</Text></TouchableOpacity>
        </View>

        <View style={[styles.searchWrap, { backgroundColor: isDark ? '#111827cc' : '#ffffffe6' }]}>
          <TextInput
            ref={searchInputRef}
            testID="map-search-input"
            value={search}
            onChangeText={setSearch}
            onSubmitEditing={() => setCommittedSearch(search.trim())}
            autoCorrect={false}
            autoCapitalize="none"
            clearButtonMode="never"
            placeholder="Search site or address"
            placeholderTextColor={isDark ? '#9ca3af' : '#6b7280'}
            style={[styles.searchInput, { color: isDark ? '#f9fafb' : '#111827' }]}
          />
          {search.trim().length > 0 && (
            <TouchableOpacity
              testID="map-search-clear"
              accessibilityRole="button"
              accessibilityLabel="Clear search"
              style={styles.clearBtn}
              onPressIn={() => {
                setSearch('');
                setCommittedSearch('');
                searchInputRef.current?.setNativeProps({ text: '' });
                searchInputRef.current?.clear();
                searchInputRef.current?.blur();
                Keyboard.dismiss();
              }}
            >
              <Text style={styles.clearBtnText}>✕</Text>
            </TouchableOpacity>
          )}
        </View>

        {suggestions.length > 0 && (
          <View style={[styles.suggestWrap, { backgroundColor: isDark ? '#111827ee' : '#fffffff0' }]}>
            {suggestions.map((sug) => (
              <TouchableOpacity key={sug.siteId} style={styles.suggestRow} onPress={() => applySearch(sug)}>
                <Text style={[styles.suggestName, { color: isDark ? '#f9fafb' : '#111827' }]} numberOfLines={1}>{sug.siteName}</Text>
                <Text style={[styles.suggestAddr, { color: isDark ? '#9ca3af' : '#6b7280' }]} numberOfLines={1}>{sug.siteAddress}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
      </View>

      {/* 1/4 screen nearest list */}
      <ScrollView
        style={[styles.bottomSheet, { backgroundColor: isDark ? '#0b1220' : '#ffffff' }]}
        refreshControl={<RefreshControl refreshing={manualRefreshing} onRefresh={onManualRefresh} />}
      >
        <Text style={[styles.sectionTitle, { color: isDark ? '#f9fafb' : '#111827' }]}>Closest chargers</Text>
        <Text style={[styles.sectionSubtitle, { color: isDark ? '#9ca3af' : '#6b7280' }]}>Top 2-3 stations nearest your current location</Text>

        <View style={styles.nearestListWrap}>
          {isLoading && nearest.length === 0 && (
            <View style={[styles.card, { backgroundColor: isDark ? '#111827' : '#f3f4f6', justifyContent: 'center' }]}>
              <ActivityIndicator color="#10b981" />
              <Text style={[styles.meta, { color: isDark ? '#9ca3af' : '#6b7280', marginLeft: 8 }]}>Loading nearby sites…</Text>
            </View>
          )}

          {nearest.map((item) => {
            const statuses = item.chargers.flatMap((c) => c.connectors.map((x) => x.status));
            const chargerStatuses = item.chargers.map((c) => String(c.status || '').toUpperCase());
            const color = statusColorFromStatuses(statuses, chargerStatuses);
            const label = statusLabelFromStatuses(statuses, chargerStatuses);
            return (
              <TouchableOpacity
                key={item.siteId}
                style={[styles.card, { backgroundColor: isDark ? '#111827' : '#f9fafb' }]}
                onPress={() => router.push(`/charger/${item.primaryChargerId}`)}
              >
                <View style={[styles.dot, { backgroundColor: color }]} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.name, { color: isDark ? '#f9fafb' : '#111827' }]}>{item.siteName}</Text>
                  <Text style={[styles.meta, { color: isDark ? '#9ca3af' : '#6b7280' }]}> 
                    {item.distanceKm != null ? `${item.distanceKm.toFixed(2)} km • ` : ''}
                    {item.availablePorts}/{item.totalPorts} ports available
                  </Text>
                </View>
                <Text style={{ color, fontWeight: '700', fontSize: 12 }}>{label}</Text>
                <HeartButton isFavorited={isFav(item.primaryChargerId)} onToggle={() => toggle(item.primaryChargerId)} />
              </TouchableOpacity>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  mapSection: { flex: 3, position: 'relative' },
  map: { flex: 1 },
  mapControls: { position: 'absolute', right: 12, top: 12, gap: 8 },
  locateBtn: { width: 40, height: 40, backgroundColor: '#111827cc', borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  locateText: { color: '#fff', fontWeight: '800', fontSize: 18 },
  zoomBtn: { width: 40, height: 40, backgroundColor: '#111827cc', borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  zoomText: { color: '#fff', fontSize: 22, fontWeight: '700', lineHeight: 22 },
  searchWrap: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 12,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: '#ffffff33',
  },
  searchInput: { fontSize: 14, fontWeight: '600', flex: 1, paddingRight: 40 },
  clearBtn: {
    position: 'absolute',
    right: 10,
    top: 7,
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#374151',
    zIndex: 10,
  },
  clearBtnText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  suggestWrap: { position: 'absolute', left: 12, right: 12, bottom: 64, borderRadius: 12, borderWidth: 1, borderColor: '#ffffff22', overflow: 'hidden' },
  suggestRow: { paddingHorizontal: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#ffffff1f' },
  suggestName: { fontSize: 13, fontWeight: '700' },
  suggestAddr: { fontSize: 11, marginTop: 2 },
  bottomSheet: { flex: 1, paddingHorizontal: 12, paddingTop: 10 },
  sectionTitle: { fontSize: 17, fontWeight: '800' },
  sectionSubtitle: { fontSize: 12, marginTop: 2, marginBottom: 8 },
  nearestListWrap: { minHeight: 120 },
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
