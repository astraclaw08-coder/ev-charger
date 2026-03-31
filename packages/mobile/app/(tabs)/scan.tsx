import React, { useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, TextInput,
  ActivityIndicator, FlatList,
} from 'react-native';
import { useRouter } from 'expo-router';
import { CameraView, type BarcodeScanningResult, useCameraPermissions } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import { useAppTheme } from '@/theme';
import { parseChargerQrPayload } from '@/lib/chargerQr';
import { api, type Charger } from '@/lib/api';
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export default function ScanScreen() {
  const router = useRouter();
  const { isDark } = useAppTheme();
  const tabBarHeight = useBottomTabBarHeight();
  const insets = useSafeAreaInsets();
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [scanLocked, setScanLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualStationNumber, setManualStationNumber] = useState('');
  const [resolvingManual, setResolvingManual] = useState(false);
  const [torchEnabled, setTorchEnabled] = useState(false);
  const [searchResults, setSearchResults] = useState<Charger[]>([]);
  const [hasSearched, setHasSearched] = useState(false);

  async function ensurePermission() {
    if (cameraPermission?.granted) return true;
    const req = await requestCameraPermission();
    return req.granted;
  }

  const onScan = async (result: BarcodeScanningResult) => {
    if (scanLocked) return;
    setScanLocked(true);
    setError(null);

    try {
      const parsed = parseChargerQrPayload(result.data);
      const chargerId = parsed?.chargerId?.trim();
      if (!chargerId) {
        setError('Invalid or unsupported QR code.');
        return;
      }

      try {
        const remote = await api.chargers.get(chargerId);
        if (remote?.id) {
          router.replace(`/charger/${remote.id}`);
          return;
        }
      } catch {
        // fallback to direct id path
      }

      router.replace(`/charger/${chargerId}`);
    } finally {
      setTimeout(() => setScanLocked(false), 1200);
    }
  };

  const handleManualSubmit = useCallback(async () => {
    const station = manualStationNumber.trim();
    if (!station || station.length < 2) {
      setError('Enter at least 2 characters to search.');
      return;
    }
    setResolvingManual(true);
    setError(null);
    setSearchResults([]);
    setHasSearched(false);

    try {
      // Try exact match first
      try {
        const remote = await api.chargers.get(station);
        if (remote?.id) {
          router.replace(`/charger/${remote.id}`);
          return;
        }
      } catch {
        // not found by exact — fall through to search
      }

      // Partial search
      const results = await api.chargers.search(station);
      setHasSearched(true);
      if (results.length === 1) {
        router.replace(`/charger/${results[0].id}`);
        return;
      }
      if (results.length > 1) {
        setSearchResults(results);
        return;
      }
      setError('No chargers found. Try a different station number or name.');
    } catch {
      setError('Could not search right now. Please try again.');
    } finally {
      setResolvingManual(false);
    }
  }, [manualStationNumber, router]);

  React.useEffect(() => {
    void ensurePermission();
  }, []);

  const noPermission = cameraPermission && !cameraPermission.granted;

  const renderSearchResult = ({ item }: { item: Charger }) => {
    const connStatus = item.connectors?.[0]?.status ?? 'UNKNOWN';
    const dotColor =
      connStatus === 'AVAILABLE' ? '#10b981' :
      connStatus === 'CHARGING' || connStatus === 'PREPARING' ? '#f59e0b' :
      connStatus === 'FAULTED' ? '#ef4444' : '#9ca3af';

    return (
      <TouchableOpacity
        style={[styles.resultRow, { backgroundColor: isDark ? '#1e293b' : '#f1f5f9', borderColor: isDark ? '#334155' : '#e2e8f0' }]}
        onPress={() => router.replace(`/charger/${item.id}`)}
        activeOpacity={0.7}
      >
        <View style={styles.resultLeft}>
          <Text style={[styles.resultOcpp, { color: isDark ? '#f1f5f9' : '#0f172a' }]}>{(item as any).ocppId ?? item.id.slice(0, 12)}</Text>
          <Text style={[styles.resultSite, { color: isDark ? '#94a3b8' : '#64748b' }]}>{(item as any).site?.name ?? 'Unknown site'}</Text>
        </View>
        <View style={[styles.statusDot, { backgroundColor: dotColor }]} />
      </TouchableOpacity>
    );
  };

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: isDark ? '#020617' : '#f8fafc',
          paddingBottom: Math.max(tabBarHeight + 14, insets.bottom + 90),
        },
      ]}
    >
      <View style={styles.header}>
        <Text style={[styles.subTitle, { color: isDark ? '#cbd5e1' : '#4b5563' }]}>Scan QR code on charger</Text>
      </View>

      {noPermission ? (
        <View style={styles.centerState}>
          <Ionicons name="camera-outline" size={36} color={isDark ? '#93c5fd' : '#1d4ed8'} />
          <Text style={[styles.stateText, { color: isDark ? '#cbd5e1' : '#334155' }]}>Camera access is required to scan QR codes.</Text>
          <TouchableOpacity onPress={ensurePermission} style={[styles.retryBtn, { backgroundColor: isDark ? '#0f766e' : '#10b981' }]}>
            <Text style={{ color: '#fff', fontWeight: '800' }}>Enable Camera</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.cameraWrap}>
          <CameraView
            style={styles.camera}
            facing="back"
            enableTorch={torchEnabled}
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={scanLocked ? undefined : onScan}
          />
          <View pointerEvents="none" style={styles.frame} />
        </View>
      )}

      {!noPermission ? (
        <View style={[styles.manualCard, { backgroundColor: isDark ? '#111827' : '#ffffff', borderColor: isDark ? '#374151' : '#d1d5db' }]}>
          <Text style={[styles.manualSub, { color: isDark ? '#9ca3af' : '#64748b' }]}>Search by station number, serial, or site name.</Text>
          <View style={styles.manualRow}>
            <TextInput
              value={manualStationNumber}
              onChangeText={(t) => { setManualStationNumber(t); setSearchResults([]); setHasSearched(false); setError(null); }}
              placeholder="e.g. 1A32 or Hawthorne"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              onSubmitEditing={handleManualSubmit}
              placeholderTextColor={isDark ? '#6b7280' : '#9ca3af'}
              style={[styles.manualInput, { color: isDark ? '#f9fafb' : '#111827', borderColor: isDark ? '#374151' : '#d1d5db' }]}
            />
            <TouchableOpacity
              style={[styles.manualBtn, { opacity: resolvingManual ? 0.75 : 1 }]}
              onPress={handleManualSubmit}
              disabled={resolvingManual}
            >
              {resolvingManual ? <ActivityIndicator color="#ecfdf5" size="small" /> : <Text style={styles.manualBtnText}>Search</Text>}
            </TouchableOpacity>
          </View>
          <TouchableOpacity
            style={[styles.flashBtn, { backgroundColor: torchEnabled ? '#0f766e' : (isDark ? '#1f2937' : '#e5e7eb') }]}
            onPress={() => setTorchEnabled((v) => !v)}
          >
            <Text style={[styles.flashBtnText, { color: torchEnabled ? '#ecfdf5' : (isDark ? '#f3f4f6' : '#111827') }]}>
              {torchEnabled ? 'Flashlight On' : 'Flashlight Off'}
            </Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {error ? <Text style={[styles.errorText, { color: isDark ? '#fca5a5' : '#b91c1c' }]}>{error}</Text> : null}

      {searchResults.length > 0 && (
        <View style={styles.resultsWrap}>
          <Text style={[styles.resultsLabel, { color: isDark ? '#94a3b8' : '#64748b' }]}>
            {searchResults.length} charger{searchResults.length > 1 ? 's' : ''} found — tap to select
          </Text>
          <FlatList
            data={searchResults}
            keyExtractor={(item) => item.id}
            renderItem={renderSearchResult}
            style={styles.resultsList}
            scrollEnabled={searchResults.length > 4}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingTop: 56, paddingHorizontal: 12 },
  header: { alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  subTitle: { fontSize: 14, fontWeight: '700', textAlign: 'center' },
  cameraWrap: { height: '44%', minHeight: 260, borderRadius: 16, overflow: 'hidden', borderWidth: 1, borderColor: '#334155', position: 'relative' },
  camera: { flex: 1 },
  frame: { position: 'absolute', left: '14%', right: '14%', top: '24%', bottom: '24%', borderWidth: 2, borderColor: '#67e8f9', borderRadius: 14 },
  centerState: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 20 },
  stateText: { fontSize: 14, textAlign: 'center' },
  retryBtn: { borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10 },
  manualCard: { borderRadius: 12, padding: 12, borderWidth: 1, gap: 8, marginTop: 10 },
  manualSub: { fontSize: 12 },
  manualRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  manualInput: { flex: 1, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 12, fontSize: 13, fontWeight: '700' },
  manualBtn: { backgroundColor: '#065f46', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 12, minWidth: 72, alignItems: 'center', justifyContent: 'center' },
  manualBtnText: { color: '#ecfdf5', fontSize: 13, fontWeight: '800' },
  flashBtn: { marginTop: 2, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 11, alignItems: 'center' },
  flashBtnText: { fontSize: 13, fontWeight: '800' },
  errorText: { marginTop: 10, fontSize: 13, fontWeight: '700' },
  resultsWrap: { marginTop: 10, maxHeight: 220 },
  resultsLabel: { fontSize: 12, fontWeight: '600', marginBottom: 6 },
  resultsList: { flexGrow: 0 },
  resultRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 12, borderRadius: 10, borderWidth: 1, marginBottom: 6 },
  resultLeft: { flex: 1 },
  resultOcpp: { fontSize: 14, fontWeight: '700' },
  resultSite: { fontSize: 12, marginTop: 2 },
  statusDot: { width: 10, height: 10, borderRadius: 5, marginLeft: 10 },
});
