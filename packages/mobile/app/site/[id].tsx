import React, { useMemo } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { api } from '@/lib/api';
import { useAppTheme } from '@/theme';
import { buildSiteAggregates, getFirstReadyConnectorId } from '@/lib/siteFlow';

function formatCurrency(value: number): string {
  return `$${value.toFixed(2)}`;
}

type TouWindowMobile = { day: number; start: string; end: string; pricePerKwhUsd: number; idleFeePerMinUsd: number };

function toMinutes(v: string): number {
  const [h, m] = String(v).split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return -1;
  return h * 60 + m;
}

function parseTouWindows(raw: unknown): TouWindowMobile[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((w: any) => ({
      day: Number(w?.day ?? 0),
      start: String(w?.start ?? '00:00'),
      end: String(w?.end ?? '00:00'),
      pricePerKwhUsd: Number(w?.pricePerKwhUsd ?? 0),
      idleFeePerMinUsd: Number(w?.idleFeePerMinUsd ?? 0),
    }))
    .filter((w) => w.day >= 0 && w.day <= 6 && toMinutes(w.start) >= 0 && (toMinutes(w.end) > toMinutes(w.start) || w.end === '23:59'))
    .sort((a, b) => a.day - b.day || toMinutes(a.start) - toMinutes(b.start));
}

function currentTouWindow(windows: TouWindowMobile[]): TouWindowMobile | null {
  const now = new Date();
  const d = now.getDay();
  const mins = now.getHours() * 60 + now.getMinutes();
  return windows.find((w) => {
    if (w.day !== d) return false;
    const s = toMinutes(w.start);
    const e = w.end === '23:59' ? 24 * 60 : toMinutes(w.end);
    return mins >= s && mins < e;
  }) ?? null;
}

function dayLabel(day: number): string {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day] ?? '-';
}

type SiteRouteParams = { id?: string };

export default function SiteDetailScreen() {
  const { id } = useLocalSearchParams<SiteRouteParams>();
  const router = useRouter();
  const { isDark } = useAppTheme();

  const { data: chargers = [], isLoading, isError, refetch } = useQuery({
    queryKey: ['chargers'],
    queryFn: () => api.chargers.list(),
    staleTime: 60_000,
  });

  const site = useMemo(() => {
    if (!id) return null;
    return buildSiteAggregates(chargers).find((entry) => entry.siteId === id) ?? null;
  }, [chargers, id]);

  const sortedChargers = useMemo(() => {
    if (!site) return [];
    return [...site.chargers].sort((a, b) => {
      const aReady = getFirstReadyConnectorId(a) != null ? 0 : 1;
      const bReady = getFirstReadyConnectorId(b) != null ? 0 : 1;
      if (aReady !== bReady) return aReady - bReady;
      return String(a.ocppId).localeCompare(String(b.ocppId));
    });
  }, [site]);

  const sitePricing = useMemo(() => {
    const sampleSite = site?.chargers[0]?.site;
    if (!sampleSite) {
      return {
        pricingMode: 'flat' as const,
        pricePerKwhUsd: 0.35,
        idleFeePerMinUsd: 0,
        activationFeeUsd: 0,
        touWindows: [] as TouWindowMobile[],
        currentTou: null as TouWindowMobile | null,
      };
    }

    const pricingMode = String((sampleSite as any).pricingMode ?? 'flat') === 'tou' ? 'tou' : 'flat';
    const touWindows = parseTouWindows((sampleSite as any).touWindows);
    const currentTou = currentTouWindow(touWindows);

    return {
      pricingMode,
      pricePerKwhUsd: Number(sampleSite.pricePerKwhUsd ?? 0.35),
      idleFeePerMinUsd: Number(sampleSite.idleFeePerMinUsd ?? 0),
      activationFeeUsd: Number((sampleSite as any).activationFeeUsd ?? 0),
      touWindows,
      currentTou,
    };
  }, [site]);

  const displayedEnergyRate = sitePricing.pricingMode === 'tou' && sitePricing.currentTou
    ? sitePricing.currentTou.pricePerKwhUsd
    : sitePricing.pricePerKwhUsd;

  const displayedIdleRate = sitePricing.pricingMode === 'tou' && sitePricing.currentTou
    ? sitePricing.currentTou.idleFeePerMinUsd
    : sitePricing.idleFeePerMinUsd;

  const openCharger = (chargerId: string) => {
    router.push(`/charger/detail/${chargerId}` as any);
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Lumeo',
          headerShown: true,
          headerStyle: { backgroundColor: isDark ? '#0b1220' : '#ffffff' },
          headerTintColor: isDark ? '#f9fafb' : '#111827',
          headerShadowVisible: false,
          headerTitleStyle: {
            color: isDark ? '#ffffff' : '#000000',
            fontWeight: '300',
            letterSpacing: 1.5,
            fontSize: 22,
          } as any,
          headerBackButtonDisplayMode: 'minimal',
        }}
      />

      <ScrollView style={[styles.container, { backgroundColor: isDark ? '#030712' : '#f8fafc' }]} contentContainerStyle={styles.content}>
        {isLoading ? (
          <View style={[styles.card, { backgroundColor: isDark ? '#111827' : '#ffffff' }]}>
            <Text style={[styles.title, { color: isDark ? '#f9fafb' : '#111827' }]}>Loading site...</Text>
          </View>
        ) : isError ? (
          <View style={[styles.card, { backgroundColor: isDark ? '#111827' : '#ffffff' }]}>
            <Text style={[styles.title, { color: isDark ? '#f9fafb' : '#111827' }]}>Could not load site</Text>
            <Text style={[styles.sub, { color: isDark ? '#9ca3af' : '#6b7280' }]}>Refresh and try again.</Text>
            <TouchableOpacity style={styles.primaryBtn} onPress={() => refetch()}>
              <Text style={styles.primaryBtnText}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : !site ? (
          <View style={[styles.card, { backgroundColor: isDark ? '#111827' : '#ffffff' }]}>
            <Text style={[styles.title, { color: isDark ? '#f9fafb' : '#111827' }]}>Site not found</Text>
            <Text style={[styles.sub, { color: isDark ? '#9ca3af' : '#6b7280' }]}>This site route exists now, but the selected site could not be resolved from the current charger list.</Text>
            <TouchableOpacity style={styles.primaryBtn} onPress={() => router.replace('/(tabs)' as any)}>
              <Text style={styles.primaryBtnText}>Back to map</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            <View style={[styles.hero, { backgroundColor: isDark ? '#111827' : '#ffffff' }]}> 
              <Text style={[styles.kicker, { color: isDark ? '#86efac' : '#059669' }]}>Site details</Text>
              <Text style={[styles.title, { color: isDark ? '#f9fafb' : '#111827' }]}>{site.siteName}</Text>
              <Text style={[styles.sub, { color: isDark ? '#9ca3af' : '#6b7280' }]}>{site.siteAddress}</Text>

              <View style={styles.metricsRow}>
                <View style={[styles.metricPill, { backgroundColor: isDark ? '#0f172a' : '#eef2ff' }]}> 
                  <Text style={[styles.metricLabel, { color: isDark ? '#93c5fd' : '#3730a3' }]}>{site.availablePorts}/{site.totalPorts} available</Text>
                </View>
                <View style={[styles.metricPill, { backgroundColor: isDark ? '#0f172a' : '#ecfdf5' }]}> 
                  <Text style={[styles.metricLabel, { color: isDark ? '#a7f3d0' : '#047857' }]}>{sortedChargers.length} charger{sortedChargers.length === 1 ? '' : 's'}</Text>
                </View>
                {site.chargerTypes.map((type) => (
                  <View key={type} style={[styles.metricPill, { backgroundColor: isDark ? '#1f2937' : '#f3f4f6' }]}> 
                    <Text style={[styles.metricLabel, { color: isDark ? '#d1d5db' : '#374151' }]}>{type}</Text>
                  </View>
                ))}
              </View>
            </View>

            <View style={[styles.pricingCard, { backgroundColor: isDark ? '#111827' : '#ffffff', borderColor: isDark ? '#334155' : '#e2e8f0' }]}>
              <View style={styles.pricingHeader}>
                <View>
                  <Text style={[styles.pricingEyebrow, { color: isDark ? '#93c5fd' : '#1d4ed8' }]}>
                    {sitePricing.pricingMode === 'tou' ? 'Time-of-use pricing' : 'Pricing'}
                  </Text>
                  <Text style={[styles.pricingTitle, { color: isDark ? '#f8fafc' : '#0f172a' }]}>Charging rates</Text>
                </View>
                {sitePricing.pricingMode === 'tou' && sitePricing.currentTou ? (
                  <View style={[styles.liveNowBadge, { backgroundColor: isDark ? '#082f49' : '#dbeafe' }]}>
                    <Text style={[styles.liveNowBadgeText, { color: isDark ? '#7dd3fc' : '#1d4ed8' }]}>Live now</Text>
                  </View>
                ) : null}
              </View>

              <View style={styles.priceTilesRow}>
                <View style={[styles.priceTile, { backgroundColor: isDark ? '#0f172a' : '#f8fafc' }]}>
                  <Text style={[styles.priceTileLabel, { color: isDark ? '#9ca3af' : '#64748b' }]}>Energy</Text>
                  <Text style={[styles.priceTileValue, { color: isDark ? '#f9fafb' : '#0f172a' }]}>{formatCurrency(displayedEnergyRate)}/kWh</Text>
                </View>
                <View style={[styles.priceTile, { backgroundColor: isDark ? '#0f172a' : '#f8fafc' }]}>
                  <Text style={[styles.priceTileLabel, { color: isDark ? '#9ca3af' : '#64748b' }]}>Idle</Text>
                  <Text style={[styles.priceTileValue, { color: isDark ? '#f9fafb' : '#0f172a' }]}>{formatCurrency(displayedIdleRate)}/min</Text>
                </View>
                <View style={[styles.priceTile, { backgroundColor: isDark ? '#0f172a' : '#f8fafc' }]}>
                  <Text style={[styles.priceTileLabel, { color: isDark ? '#9ca3af' : '#64748b' }]}>Activation</Text>
                  <Text style={[styles.priceTileValue, { color: isDark ? '#f9fafb' : '#0f172a' }]}>{formatCurrency(sitePricing.activationFeeUsd)}</Text>
                </View>
              </View>

              {sitePricing.pricingMode === 'tou' && sitePricing.touWindows.length > 0 ? (
                <View style={styles.touList}>
                  {sitePricing.touWindows.map((window, index) => {
                    const isActive = sitePricing.currentTou === window;
                    return (
                      <View
                        key={`${window.day}-${window.start}-${window.end}-${index}`}
                        style={[
                          styles.touRow,
                          {
                            backgroundColor: isActive
                              ? (isDark ? '#0f172a' : '#eff6ff')
                              : 'transparent',
                            borderColor: isActive
                              ? (isDark ? '#1d4ed8' : '#bfdbfe')
                              : (isDark ? '#1f2937' : '#e5e7eb'),
                          },
                        ]}
                      >
                        <View style={{ flex: 1 }}>
                          <Text style={[styles.touDay, { color: isDark ? '#f8fafc' : '#0f172a' }]}>
                            {dayLabel(window.day)} • {window.start}–{window.end}
                          </Text>
                          <Text style={[styles.touMeta, { color: isDark ? '#94a3b8' : '#64748b' }]}>
                            Energy {formatCurrency(window.pricePerKwhUsd)}/kWh • Idle {formatCurrency(window.idleFeePerMinUsd)}/min
                          </Text>
                        </View>
                        {isActive ? (
                          <Text style={[styles.touNow, { color: isDark ? '#7dd3fc' : '#2563eb' }]}>Now</Text>
                        ) : null}
                      </View>
                    );
                  })}
                </View>
              ) : null}
            </View>

            <View style={styles.sectionHeader}>
              <Text style={[styles.sectionTitle, { color: isDark ? '#f9fafb' : '#111827' }]}>Chargers at this site</Text>
              <Text style={[styles.sectionSub, { color: isDark ? '#9ca3af' : '#6b7280' }]}>Tap a charger to open the detailed start-charge screen.</Text>
            </View>

            {sortedChargers.map((charger) => {
              const readyConnectorId = getFirstReadyConnectorId(charger);
              const isReady = readyConnectorId != null;
              const statuses = (charger.connectors ?? []).map((c) => c.status).join(' · ');
              return (
                <TouchableOpacity
                  key={charger.id}
                  testID={`site-charger-${charger.id}`}
                  style={[styles.chargerCard, { backgroundColor: isDark ? '#111827' : '#ffffff', borderColor: isDark ? '#374151' : '#e5e7eb' }]}
                  activeOpacity={0.9}
                  onPress={() => openCharger(charger.id)}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.chargerTitle, { color: isDark ? '#f9fafb' : '#111827' }]}>{charger.ocppId}</Text>
                    <Text style={[styles.chargerSub, { color: isDark ? '#9ca3af' : '#6b7280' }]}>{charger.vendor} {charger.model}</Text>
                    <Text style={[styles.chargerSub, { color: isDark ? '#cbd5e1' : '#475569' }]}>{statuses}</Text>
                  </View>
                  <View style={{ alignItems: 'flex-end', gap: 8 }}>
                    <View style={[styles.statusBadge, { backgroundColor: isReady ? '#dcfce7' : '#fee2e2' }]}>
                      <Text style={[styles.statusBadgeText, { color: isReady ? '#166534' : '#b91c1c' }]}>{isReady ? `Ready · Connector ${readyConnectorId}` : 'Not ready'}</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={20} color={isDark ? '#94a3b8' : '#64748b'} />
                  </View>
                </TouchableOpacity>
              );
            })}

            <TouchableOpacity
              style={[styles.secondaryBtn, { borderColor: isDark ? '#334155' : '#cbd5e1' }]}
              onPress={() => {
                const firstReady = sortedChargers.find((charger) => getFirstReadyConnectorId(charger) != null);
                if (!firstReady) {
                  Alert.alert('No ready charger', 'This site has no ready charger right now. Pull to refresh and try again.');
                  return;
                }
                openCharger(firstReady.id);
              }}
            >
              <Text style={[styles.secondaryBtnText, { color: isDark ? '#e5e7eb' : '#0f172a' }]}>Open first ready charger</Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 16, gap: 14, paddingBottom: 28 },
  hero: { borderRadius: 20, padding: 18, gap: 10 },
  card: { borderRadius: 20, padding: 18, gap: 12 },
  kicker: { fontSize: 12, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.8 },
  title: { fontSize: 26, fontWeight: '800' },
  sub: { fontSize: 14, lineHeight: 20 },
  metricsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  metricPill: { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8 },
  metricLabel: { fontSize: 12, fontWeight: '700' },
  pricingCard: { borderRadius: 20, borderWidth: 1, padding: 16, gap: 12 },
  pricingHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 },
  pricingEyebrow: { fontSize: 12, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.7 },
  pricingTitle: { fontSize: 20, fontWeight: '800', marginTop: 4 },
  liveNowBadge: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 },
  liveNowBadgeText: { fontSize: 11, fontWeight: '800', textTransform: 'uppercase' },
  priceTilesRow: { flexDirection: 'row', gap: 8 },
  priceTile: { flex: 1, borderRadius: 14, paddingVertical: 12, paddingHorizontal: 8, alignItems: 'center', borderWidth: 1, borderColor: '#d1d5db' },
  priceTileLabel: { fontSize: 11, fontWeight: '700', textAlign: 'center' },
  priceTileValue: { fontSize: 14, fontWeight: '800', marginTop: 3, textAlign: 'center' },
  touList: { gap: 8 },
  touRow: { borderWidth: 1, borderRadius: 14, paddingVertical: 10, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 10 },
  touDay: { fontSize: 13, fontWeight: '800' },
  touMeta: { fontSize: 12, marginTop: 3 },
  touNow: { fontSize: 12, fontWeight: '900', textTransform: 'uppercase' },
  sectionHeader: { marginTop: 4, gap: 4 },
  sectionTitle: { fontSize: 18, fontWeight: '800' },
  sectionSub: { fontSize: 13 },
  chargerCard: { borderRadius: 18, borderWidth: 1, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 12 },
  chargerTitle: { fontSize: 17, fontWeight: '800' },
  chargerSub: { fontSize: 13, marginTop: 3 },
  statusBadge: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 },
  statusBadgeText: { fontSize: 11, fontWeight: '800' },
  primaryBtn: { alignSelf: 'flex-start', backgroundColor: '#10b981', paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12 },
  primaryBtnText: { color: '#ffffff', fontWeight: '800' },
  secondaryBtn: { marginTop: 4, borderWidth: 1, borderRadius: 14, paddingVertical: 14, alignItems: 'center', justifyContent: 'center' },
  secondaryBtnText: { fontSize: 14, fontWeight: '800' },
});
