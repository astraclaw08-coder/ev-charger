import React from 'react';
import { Tabs, useRouter } from 'expo-router';
import { TouchableOpacity, Text, View } from 'react-native';
import { BottomTabBar, type BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';
import { useAppTheme } from '@/theme';
import { useAppAuth } from '@/providers/AuthProvider';
import { useChargingNotifications } from '@/providers/ChargingNotificationsProvider';
import type { Session } from '@/lib/api';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

function formatElapsed(startedAt: string): string {
  const start = new Date(startedAt).getTime();
  const mins = Math.max(0, Math.floor((Date.now() - start) / 60_000));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${m}m`;
}

function estimateActiveCostUsd(active: Session): number {
  const cents = active.effectiveAmountCents ?? active.estimatedAmountCents ?? active.costEstimateCents;
  if (cents != null && Number.isFinite(Number(cents))) return Math.max(0, Number(cents) / 100);

  const kwh = Number(active.kwhDelivered ?? 0);
  const rate = Number(active.ratePerKwh ?? 0);
  if (kwh > 0 && rate > 0) return kwh * rate;
  return 0;
}

const TAB_CONTENT_SHIFT_Y = 8;

function FloatingTabBar({
  isDark,
  safeAreaBottom,
  bannerVisible,
  ...tabProps
}: BottomTabBarProps & { isDark: boolean; safeAreaBottom: number; bannerVisible: boolean }) {
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        left: 12,
        right: 12,
        bottom: bannerVisible ? 58 + Math.max(safeAreaBottom, 8) : Math.max(safeAreaBottom, 8),
      }}
    >
      <View
        style={{
          borderRadius: 20,
          overflow: 'hidden',
          backgroundColor: isDark ? '#111827f2' : '#fffffff2',
          borderWidth: 1,
          borderColor: isDark ? '#374151' : '#d1d5db',
          shadowColor: '#000',
          shadowOpacity: isDark ? 0.25 : 0.12,
          shadowRadius: 12,
          shadowOffset: { width: 0, height: 6 },
          elevation: 10,
        }}
      >
        <BottomTabBar
          {...tabProps}
          style={{
            borderTopWidth: 0,
            backgroundColor: isDark ? '#111827f2' : '#fffffff2',
            paddingTop: 8,
            paddingBottom: Math.max(safeAreaBottom, 4),
            minHeight: 56 + Math.max(safeAreaBottom, 6),
          }}
        />
      </View>
    </View>
  );
}

function ActiveSessionBanner({ active }: { active: Session }) {
  const router = useRouter();
  const { isDark } = useAppTheme();
  const insets = useSafeAreaInsets();
  const kwh = active.kwhDelivered ?? 0;
  const costUsd = estimateActiveCostUsd(active);
  const siteName = active.connector.charger.site.name;

  return (
    <View style={{
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      zIndex: 1,
      backgroundColor: 'transparent',
      paddingHorizontal: 12,
      paddingBottom: Math.max(insets.bottom, 8),
      paddingTop: 4,
    }}>
      <TouchableOpacity
        style={{
          borderRadius: 16,
          paddingVertical: 10,
          paddingHorizontal: 12,
          backgroundColor: isDark ? '#0f172a' : '#ffffff',
          borderWidth: 1,
          borderColor: isDark ? '#334155' : '#cbd5e1',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
        onPress={() => router.push(`/charger/detail/${active.connector.charger.id}`)}
        activeOpacity={0.85}
      >
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 6 }}>
            <Text style={{ color: isDark ? '#9ca3af' : '#6b7280', fontWeight: '800', fontSize: 12 }}>
              ⚡
            </Text>
            <Text style={{ color: isDark ? '#9ca3af' : '#6b7280', fontWeight: '800', fontSize: 12 }}>
              Active charging session
            </Text>
          </View>
          <View style={{ marginTop: 2, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <Text numberOfLines={1} style={{ flex: 1, color: isDark ? '#f8fafc' : '#111827', fontWeight: '700', fontSize: 13 }}>
              {siteName}
            </Text>
            <Text style={{ color: isDark ? '#cbd5e1' : '#4b5563', fontSize: 12, fontWeight: '700' }}>
              {kwh.toFixed(2)} kWh · ${costUsd.toFixed(2)} · {formatElapsed(active.startedAt)}
            </Text>
          </View>
        </View>
      </TouchableOpacity>
    </View>
  );
}

export default function TabsLayout() {
  const router = useRouter();
  const { isDark } = useAppTheme();
  const { isGuest } = useAppAuth();
  const { activeSession: active, refetchSessions } = useChargingNotifications();
  const insets = useSafeAreaInsets();

  React.useEffect(() => {
    if (!isGuest) refetchSessions();
  }, [isGuest, refetchSessions]);
  const bannerVisible = Boolean(active);

  return (
    <>
      {active && bannerVisible ? <ActiveSessionBanner active={active} /> : null}
      <Tabs
        tabBar={(props) => (
          <FloatingTabBar
            {...props}
            isDark={isDark}
            safeAreaBottom={insets.bottom}
            bannerVisible={bannerVisible}
          />
        )}
        screenOptions={{
          tabBarActiveTintColor: isDark ? '#e2e8f0' : '#0f172a',
          tabBarInactiveTintColor: isDark ? '#64748b' : '#94a3b8',
          tabBarButton: (props) => {
            const selected = Boolean((props as any)?.accessibilityState?.selected);
            return (
              <TouchableOpacity
                {...props}
                style={[
                  props.style,
                  {
                    justifyContent: 'center',
                    alignItems: 'center',
                    transform: [{ translateY: TAB_CONTENT_SHIFT_Y }],
                    borderRadius: 22,
                    marginHorizontal: 1,
                    marginVertical: 1,
                    paddingHorizontal: 6,
                    paddingVertical: 6,
                    backgroundColor: selected ? (isDark ? '#243447' : '#e2e8f0') : 'transparent',
                  },
                ]}
              />
            );
          },
          tabBarItemStyle: {
            justifyContent: 'center',
            alignItems: 'center',
            paddingTop: 0,
            paddingBottom: 0,
          },
          tabBarIconStyle: {
            marginTop: 0,
            marginBottom: 0,
          },
          tabBarLabelStyle: {
            marginTop: 0,
            marginBottom: 0,
            paddingTop: 0,
            lineHeight: 12,
            fontWeight: '700',
            fontSize: 11,
            letterSpacing: 0.2,
            textAlign: 'center',
          },
          sceneStyle: { backgroundColor: bannerVisible ? 'transparent' : (isDark ? '#030712' : '#f9fafb') },
          headerStyle: { backgroundColor: isDark ? '#0b1220' : '#fff' },
          headerTitle: 'Lumeo',
          headerTitleStyle: {
            color: isDark ? '#ffffff' : '#000000',
            fontWeight: '300',
            letterSpacing: 1.5,
            fontSize: 22,
          },
          headerTintColor: isDark ? '#f9fafb' : '#111827',
          headerShadowVisible: false,
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: 'Lumeo',
            headerTransparent: true,
            headerStyle: { backgroundColor: 'transparent' },
            headerShadowVisible: false,
            headerTitleAlign: 'center',
            tabBarLabel: 'Map',
            tabBarIcon: ({ size, color }) => <TabIcon icon="map-outline" size={size} color={color} />,
          }}
        />
        <Tabs.Screen
          name="favorites"
          options={{
            title: 'Lumeo',
            tabBarLabel: 'Favorites',
            tabBarIcon: ({ size, color }) => <TabIcon icon="heart-outline" size={size} color={color} />,
            href: isGuest ? null : undefined,
          }}
        />
        <Tabs.Screen
          name="scan"
          options={{
            title: 'Lumeo',
            tabBarLabel: 'Scan QR',
            tabBarIcon: ({ size, color }) => <TabIcon icon="qr-code-outline" size={size} color={color} />,
            tabBarButton: (props) => {
              const selected = Boolean((props as any)?.accessibilityState?.selected);
              return (
                <TouchableOpacity
                  {...props}
                  onPress={() => router.push('/(tabs)/index?openScanner=1' as any)}
                  style={[
                    props.style,
                    {
                      justifyContent: 'center',
                      alignItems: 'center',
                      transform: [{ translateY: TAB_CONTENT_SHIFT_Y }],
                      borderRadius: 22,
                      marginHorizontal: 1,
                      marginVertical: 1,
                      paddingHorizontal: 6,
                      paddingVertical: 6,
                      backgroundColor: selected ? (isDark ? '#243447' : '#e2e8f0') : 'transparent',
                    },
                  ]}
                />
              );
            },
          }}
        />
        <Tabs.Screen
          name="sessions"
          options={{
            title: 'Lumeo',
            tabBarLabel: 'History',
            tabBarIcon: ({ size, color }) => <TabIcon icon="receipt-outline" size={size} color={color} />,
            href: isGuest ? null : undefined,
          }}
        />
        <Tabs.Screen
          name="profile"
          options={{
            title: 'Lumeo',
            tabBarLabel: 'Profile',
            tabBarIcon: ({ size, color }) => <TabIcon icon="person-circle-outline" size={size} color={color} />,
          }}
        />
      </Tabs>
    </>
  );
}

function TabIcon({ icon, size, color }: { icon: React.ComponentProps<typeof Ionicons>['name']; size: number; color: string }) {
  return <Ionicons name={icon} size={size - 2} color={color} />;
}
