import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { CameraView, type BarcodeScanningResult, useCameraPermissions } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import { useAppTheme } from '@/theme';
import { parseChargerQrPayload } from '@/lib/chargerQr';
import { api } from '@/lib/api';

export default function ScanScreen() {
  const router = useRouter();
  const { isDark } = useAppTheme();
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [scanLocked, setScanLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  React.useEffect(() => {
    void ensurePermission();
  }, []);

  const noPermission = cameraPermission && !cameraPermission.granted;

  return (
    <View style={[styles.container, { backgroundColor: isDark ? '#020617' : '#f8fafc' }]}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: isDark ? '#f9fafb' : '#111827' }]}>Scan Charger QR</Text>
        <TouchableOpacity onPress={() => router.replace('/(tabs)/index' as any)} style={[styles.doneBtn, { backgroundColor: isDark ? '#1f2937' : '#e5e7eb' }]}>
          <Text style={{ color: isDark ? '#f3f4f6' : '#111827', fontWeight: '700' }}>Done</Text>
        </TouchableOpacity>
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
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={scanLocked ? undefined : onScan}
          />
          <View pointerEvents="none" style={styles.frame} />
        </View>
      )}

      {error ? <Text style={[styles.errorText, { color: isDark ? '#fca5a5' : '#b91c1c' }]}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingTop: 56, paddingHorizontal: 12 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  title: { fontSize: 22, fontWeight: '800' },
  doneBtn: { borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 },
  cameraWrap: { flex: 1, borderRadius: 16, overflow: 'hidden', borderWidth: 1, borderColor: '#334155', position: 'relative' },
  camera: { flex: 1 },
  frame: { position: 'absolute', left: '14%', right: '14%', top: '24%', bottom: '24%', borderWidth: 2, borderColor: '#67e8f9', borderRadius: 14 },
  centerState: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 20 },
  stateText: { fontSize: 14, textAlign: 'center' },
  retryBtn: { borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10 },
  errorText: { marginTop: 10, fontSize: 13, fontWeight: '700' },
});
