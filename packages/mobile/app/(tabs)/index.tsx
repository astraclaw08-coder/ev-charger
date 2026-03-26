import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Keyboard,
  AppState,
  Modal,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import { useQuery } from '@tanstack/react-query';
import * as Location from 'expo-location';
import { CameraView, type BarcodeScanningResult, useCameraPermissions } from 'expo-camera';
import MapView, { Marker, PROVIDER_GOOGLE, Region } from 'react-native-maps';
import { api, type Charger } from '@/lib/api';
import { parseChargerQrPayload } from '@/lib/chargerQr';
import { useAppTheme } from '@/theme';
import { useChargingNotifications } from '@/providers/ChargingNotificationsProvider';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

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
  chargerTypes: string[];
};

function deriveChargerType(model: string, vendor: string): string {
  const s = `${model} ${vendor}`.toLowerCase();
  if (s.includes('dc') || s.includes('ccs') || s.includes('chademo') || s.includes('fast') || s.includes('dcfc') || s.includes('supercharger')) return 'DCFC';
  return 'Level 2';
}

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

export default function MapScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ openScanner?: string; scanNonce?: string }>();
  const mapRef = useRef<MapView | null>(null);
  const searchInputRef = useRef<TextInput | null>(null);
  const regionRef = useRef<Region | null>(null);
  const { isDark } = useAppTheme();
  const tabBarHeight = useBottomTabBarHeight();
  const insets = useSafeAreaInsets();
  const { activeSession } = useChargingNotifications();

  const [hasLocation, setHasLocation] = useState(false);
  const [userLocation, setUserLocation] = useState<Coord | null>(null);
  const [search, setSearch] = useState('');
  const [committedSearch, setCommittedSearch] = useState('');
  const [showScanner, setShowScanner] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [scanLocked, setScanLocked] = useState(false);
  const [scannerError, setScannerError] = useState<string | null>(null);
  const [resolvingScan, setResolvingScan] = useState(false);
  const [torchEnabled, setTorchEnabled] = useState(false);
  const [manualStationNumber, setManualStationNumber] = useState('');
  const [selectedSite, setSelectedSite] = useState<SiteAggregate | null>(null);

  useEffect(() => {
    if (params.openScanner !== '1') return;
    void openScanner();
    router.setParams({ openScanner: undefined, scanNonce: undefined });
  }, [params.openScanner, params.scanNonce]);

  const { data: chargers = [], refetch } = useQuery({
    queryKey: ['chargers'],
    queryFn: () => api.chargers.list(),
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });

  const activeBannerOffset = activeSession ? 58 + Math.max(insets.bottom, 8) : 0;
  const controlsBottom = tabBarHeight + activeBannerOffset + 44;

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
      const cType = deriveChargerType(charger.model ?? '', charger.vendor ?? '');
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
          chargerTypes: [cType],
        });
      } else {
        existing.chargers.push(charger);
        existing.totalPorts += connectors.length;
        existing.availablePorts += connectors.filter((c) => c.status === 'AVAILABLE').length;
        if (!existing.chargerTypes.includes(cType)) existing.chargerTypes.push(cType);
      }
    }

    const result = Array.from(bySite.values());
    if (userLocation) {
      for (const s of result) {
        const dLat = (s.lat - userLocation.latitude) * (Math.PI / 180);
        const dLng = (s.lng - userLocation.longitude) * (Math.PI / 180);
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(s.lat * Math.PI / 180) * Math.cos(userLocation.latitude * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
        s.distanceKm = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      }
    }
    return result;
  }, [chargers, userLocation]);

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

  async function openScanner() {
    setScannerError(null);
    setScanLocked(false);

    if (!cameraPermission?.granted) {
      const req = await requestCameraPermission();
      if (!req.granted) {
        setScannerError('Camera access is required to scan charger QR codes. Enable camera permission in Settings and retry.');
        setShowScanner(true);
        return;
      }
    }

    setShowScanner(true);
  }

  function closeScanner() {
    setShowScanner(false);
    setScannerError(null);
    setScanLocked(false);
    setResolvingScan(false);
    setTorchEnabled(false);
    setManualStationNumber('');
  }

  async function resolveAndRouteCharger(raw: string, source: 'qr' | 'manual') {
    const normalized = raw.trim();
    if (!normalized) {
      setScannerError('Please enter a valid charger station number.');
      return;
    }

    const localMatch = chargers.find((c) =>
      c.id === normalized ||
      c.ocppId === normalized ||
      c.ocppId?.toLowerCase() === normalized.toLowerCase(),
    );

    if (localMatch) {
      closeScanner();
      router.push(`/charger/${localMatch.id}`);
      return;
    }

    try {
      const remote = await api.chargers.get(normalized);
      if (!remote?.id) {
        setScannerError(source === 'manual'
          ? 'This station number was not found. Check the number and try again.'
          : 'This charger QR code is not recognized in your account.');
        return;
      }
      closeScanner();
      router.push(`/charger/${remote.id}`);
    } catch {
      setScannerError(source === 'manual'
        ? 'Could not find that station right now. Please check the number or try scanning QR.'
        : 'We could not open this charger from the scanned code. Please retry or search manually.');
    }
  }

  async function handleManualStationSubmit() {
    if (resolvingScan) return;
    const value = manualStationNumber.trim();
    if (!/^[A-Za-z0-9-]{3,40}$/.test(value)) {
      setScannerError('Station number format looks invalid. Use letters/numbers (and dashes) only.');
      return;
    }

    setScannerError(null);
    setResolvingScan(true);
    try {
      await resolveAndRouteCharger(value, 'manual');
    } finally {
      setResolvingScan(false);
    }
  }

  async function handleQrScanned(result: BarcodeScanningResult) {
    if (scanLocked || resolvingScan) return;

    setScanLocked(true);
    setResolvingScan(true);
    const parsed = parseChargerQrPayload(result.data);

    if (!parsed?.chargerId) {
      setScannerError('Invalid or unsupported QR code. Please scan a charger QR code and try again.');
      setResolvingScan(false);
      return;
    }

    const normalizedId = parsed.chargerId.trim();
    if (!normalizedId) {
      setScannerError('Invalid or unsupported QR code. Please try again.');
      setResolvingScan(false);
      return;
    }

    try {
      await resolveAndRouteCharger(normalizedId, 'qr');
    } finally {
      setResolvingScan(false);
    }
  }

  const permissionDenied = Boolean(showScanner && cameraPermission && !cameraPermission.granted);

  return (
    <View style={[styles.container, { backgroundColor: isDark ? '#030712' : '#f9fafb' }]}>
      <View style={styles.mapSection}>
        <MapView
          ref={mapRef}
          provider={PROVIDER_GOOGLE}
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
          legalLabelInsets={{ bottom: controlsBottom + 56, left: 8, right: 0, top: 0 }}
          onRegionChangeComplete={(r) => {
            regionRef.current = r;
          }}
        >
          {filteredSites.map((site) => {
            const allStatuses = site.chargers.flatMap((c) => c.connectors.map((x) => x.status));
            const chargerStatuses = site.chargers.map((c) => String(c.status || '').toUpperCase());
            const pinColor = statusColorFromStatuses(allStatuses, chargerStatuses);
            return (
              <Marker
                key={site.siteId}
                coordinate={{ latitude: site.lat, longitude: site.lng }}
                tracksViewChanges={false}
                onPress={() => setSelectedSite(site)}
              >
                <View style={[mapStyles.pin, { backgroundColor: pinColor }]}>
                  <Text style={mapStyles.pinCount}>{site.availablePorts}</Text>
                  <Text style={mapStyles.pinTotal}>/{site.totalPorts}</Text>
                </View>
              </Marker>
            );
          })}
        </MapView>

        <View pointerEvents="box-none" style={[styles.mapControls, { bottom: controlsBottom + 72 }]}> 
          <TouchableOpacity
            style={[
              styles.locateBtn,
              {
                backgroundColor: isDark ? '#111827e6' : '#fffffff0',
                borderColor: isDark ? '#374151' : '#d1d5db',
              },
            ]}
            onPress={recenterToUser}
          >
            <Ionicons name="locate" size={20} color={isDark ? '#f9fafb' : '#0f172a'} />
          </TouchableOpacity>
        </View>

        <View
          style={[
            styles.searchWrap,
            {
              bottom: controlsBottom,
              backgroundColor: isDark ? '#111827cc' : '#ffffffe6',
            },
          ]}
        >
          <Ionicons
            name="search"
            size={16}
            color={isDark ? '#9ca3af' : '#6b7280'}
            style={styles.searchIcon}
          />
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
          <View
            style={[
              styles.suggestWrap,
              {
                bottom: controlsBottom + 52,
                backgroundColor: isDark ? '#111827ee' : '#fffffff0',
              },
            ]}
          >
            {suggestions.map((sug) => (
              <TouchableOpacity key={sug.siteId} style={styles.suggestRow} onPress={() => applySearch(sug)}>
                <Text style={[styles.suggestName, { color: isDark ? '#f9fafb' : '#111827' }]} numberOfLines={1}>{sug.siteName}</Text>
                <Text style={[styles.suggestAddr, { color: isDark ? '#9ca3af' : '#6b7280' }]} numberOfLines={1}>{sug.siteAddress}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
      </View>

      <Modal visible={showScanner} animationType="slide" onRequestClose={closeScanner}>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <View style={[styles.scannerModalContainer, { backgroundColor: isDark ? '#020617' : '#030712' }]}>
            <View style={styles.scannerHeader}>
              <Text style={styles.scannerTitle}>Scan Charger QR</Text>
              <TouchableOpacity onPress={closeScanner} style={styles.scannerCloseBtn}>
                <Text style={styles.scannerCloseText}>Done</Text>
              </TouchableOpacity>
            </View>

            {permissionDenied ? (
              <View style={styles.scannerStateCard}>
                <Text style={styles.scannerErrorTitle}>Camera access needed</Text>
                <Text style={styles.scannerErrorText}>
                  Camera permission is denied or restricted. Please allow camera access in Settings, then retry.
                </Text>
                <TouchableOpacity style={styles.scannerRetryBtn} onPress={openScanner}>
                  <Text style={styles.scannerRetryText}>Retry Permission</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <>
                <View style={styles.cameraWrap}>
                  <CameraView
                    style={styles.cameraView}
                    facing="back"
                    enableTorch={torchEnabled}
                    barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                    onBarcodeScanned={scanLocked ? undefined : handleQrScanned}
                  />
                  <View pointerEvents="none" style={styles.qrGuideFrame} />
                </View>

                <View style={styles.scannerControlsRow}>
                  <TouchableOpacity
                    style={[styles.flashBtn, { backgroundColor: torchEnabled ? '#0f766e' : '#1f2937' }]}
                    onPress={() => setTorchEnabled((v) => !v)}
                  >
                    <Text style={styles.flashBtnText}>{torchEnabled ? 'Flashlight On' : 'Flashlight Off'}</Text>
                  </TouchableOpacity>
                </View>

                <View style={styles.scannerHintWrap}>
                  <Text style={styles.scannerHintText}>Align the charger QR code inside the camera frame.</Text>
                </View>

                <View style={[styles.manualEntryDock, { paddingBottom: Math.max(insets.bottom, 10) }]}>
                  <View style={[styles.manualEntryCard, { backgroundColor: isDark ? '#111827' : '#ffffff' }]}>
                    <Text style={[styles.manualEntryTitle, { color: isDark ? '#f9fafb' : '#111827' }]}>No QR code?</Text>
                    <Text style={[styles.manualEntrySub, { color: isDark ? '#9ca3af' : '#64748b' }]}>Enter charger station number manually.</Text>
                    <View style={styles.manualEntryRow}>
                      <TextInput
                        value={manualStationNumber}
                        onChangeText={setManualStationNumber}
                        placeholder="e.g. CP-00008"
                        autoCapitalize="characters"
                        autoCorrect={false}
                        placeholderTextColor={isDark ? '#6b7280' : '#9ca3af'}
                        style={[styles.manualEntryInput, { color: isDark ? '#f9fafb' : '#111827', borderColor: isDark ? '#374151' : '#d1d5db' }]}
                      />
                      <TouchableOpacity style={styles.manualEntryBtn} onPress={handleManualStationSubmit} disabled={resolvingScan}>
                        <Text style={styles.manualEntryBtnText}>Next</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                </View>
              </>
            )}

          {(scannerError || resolvingScan) && (
            <View style={[styles.scanResultCard, { backgroundColor: isDark ? '#111827' : '#ffffff' }]}>
              {resolvingScan ? (
                <View style={styles.scanPendingRow}>
                  <ActivityIndicator color="#10b981" />
                  <Text style={[styles.scanPendingText, { color: isDark ? '#d1fae5' : '#065f46' }]}>Opening charger…</Text>
                </View>
              ) : (
                <>
                  <Text style={[styles.scanErrorTitle, { color: isDark ? '#fca5a5' : '#b91c1c' }]}>Unsupported code</Text>
                  <Text style={[styles.scanErrorBody, { color: isDark ? '#cbd5e1' : '#374151' }]}>{scannerError}</Text>
                  <TouchableOpacity
                    style={[styles.scannerRetryBtn, { alignSelf: 'flex-start' }]}
                    onPress={() => {
                      setScannerError(null);
                      setScanLocked(false);
                      setResolvingScan(false);
                    }}
                  >
                    <Text style={styles.scannerRetryText}>Try Again</Text>
                  </TouchableOpacity>
                </>
              )}
            </View>
          )}
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Site preview bottom sheet */}
      {selectedSite && (
        <TouchableOpacity
          activeOpacity={1}
          style={[mapStyles.sheetBackdrop]}
          onPress={() => setSelectedSite(null)}
        >
          <TouchableOpacity
            activeOpacity={0.92}
            style={[mapStyles.sheet, {
              backgroundColor: isDark ? '#111827' : '#ffffff',
              borderColor: isDark ? '#374151' : '#e5e7eb',
              paddingBottom: Math.max(tabBarHeight + 8, 28),
            }]}
            onPress={() => {
              setSelectedSite(null);
              router.push(`/charger/${selectedSite.primaryChargerId}`);
            }}
          >
            {/* Handle */}
            <View style={mapStyles.sheetHandle} />

            {/* Header row */}
            <View style={mapStyles.sheetHeader}>
              <View style={{ flex: 1 }}>
                <Text style={[mapStyles.sheetTitle, { color: isDark ? '#f9fafb' : '#111827' }]} numberOfLines={1}>{selectedSite.siteName}</Text>
                <Text style={[mapStyles.sheetAddress, { color: isDark ? '#9ca3af' : '#6b7280' }]} numberOfLines={2}>{selectedSite.siteAddress}</Text>
              </View>
              {selectedSite.distanceKm != null && (
                <View style={[mapStyles.distancePill, { backgroundColor: isDark ? '#1f2937' : '#f3f4f6' }]}>
                  <Text style={[mapStyles.distanceText, { color: isDark ? '#d1d5db' : '#374151' }]}>
                    {selectedSite.distanceKm < 1
                      ? `${Math.round(selectedSite.distanceKm * 1000)} m`
                      : `${(selectedSite.distanceKm * 0.621371).toFixed(1)} mi`}
                  </Text>
                </View>
              )}
            </View>

            {/* Stats row */}
            <View style={mapStyles.sheetStats}>
              {/* Availability */}
              <View style={[mapStyles.statChip, { backgroundColor: isDark ? '#064e3b22' : '#d1fae5' }]}>
                <View style={[mapStyles.statDot, { backgroundColor: (() => {
                  const all = selectedSite.chargers.flatMap((c) => c.connectors.map((x) => x.status));
                  const cs = selectedSite.chargers.map((c) => String(c.status || '').toUpperCase());
                  return statusColorFromStatuses(all, cs);
                })() }]} />
                <Text style={[mapStyles.statText, { color: isDark ? '#6ee7b7' : '#065f46' }]}>
                  {selectedSite.availablePorts}/{selectedSite.totalPorts} available
                </Text>
              </View>

              {/* Charger types */}
              {selectedSite.chargerTypes.map((t) => (
                <View key={t} style={[mapStyles.statChip, { backgroundColor: isDark ? '#1e3a5f33' : '#dbeafe' }]}>
                  <Text style={[mapStyles.statText, { color: isDark ? '#93c5fd' : '#1d4ed8' }]}>{t}</Text>
                </View>
              ))}
            </View>

            <Text style={[mapStyles.sheetCta, { color: isDark ? '#34d399' : '#059669' }]}>Tap to view site →</Text>
          </TouchableOpacity>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  mapSection: { flex: 1, position: 'relative' },
  map: { flex: 1 },
  mapControls: { position: 'absolute', right: 12, gap: 8 },
  locateBtn: { width: 42, height: 42, borderRadius: 21, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  zoomBtn: { width: 42, height: 42, backgroundColor: '#111827cc', borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  searchWrap: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 12,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 11,
    borderWidth: 1,
    borderColor: '#ffffff33',
    flexDirection: 'row',
    alignItems: 'center',
  },
  searchIcon: { marginRight: 8 },
  searchInput: { fontSize: 14, fontWeight: '600', flex: 1, paddingRight: 40 },
  clearBtn: {
    position: 'absolute',
    right: 10,
    top: 10,
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

  scannerModalContainer: { flex: 1, paddingTop: 56, paddingHorizontal: 12 },
  scannerHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  scannerTitle: { color: '#f9fafb', fontSize: 20, fontWeight: '800' },
  scannerCloseBtn: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: '#1f2937' },
  scannerCloseText: { color: '#d1d5db', fontSize: 13, fontWeight: '700' },
  cameraWrap: { flex: 1, borderRadius: 16, overflow: 'hidden', borderWidth: 1, borderColor: '#1f2937', position: 'relative' },
  cameraView: { flex: 1 },
  qrGuideFrame: {
    position: 'absolute',
    left: '13%',
    right: '13%',
    top: '24%',
    bottom: '24%',
    borderWidth: 2,
    borderColor: '#67e8f9',
    borderRadius: 18,
    backgroundColor: 'transparent',
  },
  scannerControlsRow: { paddingTop: 10, alignItems: 'flex-end' },
  flashBtn: { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  flashBtnText: { color: '#ecfeff', fontSize: 12, fontWeight: '800' },
  scannerHintWrap: { paddingTop: 8, paddingBottom: 6, alignItems: 'center' },
  scannerHintText: { color: '#9ca3af', fontSize: 13, textAlign: 'center' },
  manualEntryDock: { marginTop: 'auto' },
  manualEntryCard: { borderRadius: 12, padding: 12, borderWidth: 1, borderColor: '#374151', gap: 8 },
  manualEntryTitle: { fontSize: 14, fontWeight: '800' },
  manualEntrySub: { fontSize: 12 },
  manualEntryRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  manualEntryInput: { flex: 1, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 14, fontSize: 13, fontWeight: '700' },
  manualEntryBtn: { backgroundColor: '#065f46', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 14 },
  manualEntryBtnText: { color: '#ecfdf5', fontSize: 13, fontWeight: '800' },
  scannerStateCard: { borderRadius: 14, borderWidth: 1, borderColor: '#374151', backgroundColor: '#111827', padding: 16, gap: 10, marginTop: 8 },
  scannerErrorTitle: { color: '#fca5a5', fontSize: 16, fontWeight: '800' },
  scannerErrorText: { color: '#cbd5e1', fontSize: 13, lineHeight: 20 },
  scannerRetryBtn: { backgroundColor: '#065f46', paddingHorizontal: 12, paddingVertical: 9, borderRadius: 8 },
  scannerRetryText: { color: '#ecfdf5', fontWeight: '700', fontSize: 13 },
  scanResultCard: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 26,
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: '#374151',
    gap: 8,
  },
  scanErrorTitle: { fontSize: 14, fontWeight: '800' },
  scanErrorBody: { fontSize: 13, lineHeight: 19 },
  scanPendingRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  scanPendingText: { fontSize: 13, fontWeight: '700' },
});

const mapStyles = StyleSheet.create({
  pin: {
    flexDirection: 'row',
    alignItems: 'baseline',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.6)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 5,
  },
  pinCount: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '800',
    lineHeight: 18,
  },
  pinTotal: {
    color: '#ffffffcc',
    fontSize: 11,
    fontWeight: '600',
    lineHeight: 18,
  },
  // Bottom sheet styles
  sheetBackdrop: {
    position: 'absolute',
    inset: 0,
    justifyContent: 'flex-end',
  } as any,
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    paddingHorizontal: 18,
    paddingTop: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 10,
  },
  sheetHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#d1d5db',
    alignSelf: 'center',
    marginBottom: 14,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginBottom: 12,
  },
  sheetTitle: {
    fontSize: 17,
    fontWeight: '800',
    letterSpacing: -0.3,
    marginBottom: 3,
  },
  sheetAddress: {
    fontSize: 13,
    lineHeight: 18,
  },
  distancePill: {
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 5,
    alignSelf: 'flex-start',
    marginTop: 2,
  },
  distanceText: {
    fontSize: 12,
    fontWeight: '700',
  },
  sheetStats: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 14,
  },
  statChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
  },
  statDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  statText: {
    fontSize: 12,
    fontWeight: '700',
  },
  sheetCta: {
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 4,
  },
});


