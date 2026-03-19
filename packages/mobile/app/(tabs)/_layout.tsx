import React from 'react';
import { Tabs, useRouter } from 'expo-router';
import { TouchableOpacity, Text, View } from 'react-native';
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

function ActiveSessionBanner({ active }: { active: Session }) {
  const router = useRouter();
  const { isDark } = useAppTheme();
  const insets = useSafeAreaInsets();
  const kwh = active.kwhDelivered ?? 0;
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
        <View style={{ flex: 1, paddingRight: 8 }}>
          <Text style={{ color: isDark ? '#dbeafe' : '#374151', fontWeight: '800', fontSize: 12 }}>
            ⚡ Active charging session
          </Text>
          <Text numberOfLines={1} style={{ color: isDark ? '#f8fafc' : '#111827', fontWeight: '700', fontSize: 13, marginTop: 2 }}>
            {siteName}
          </Text>
          <Text style={{ color: isDark ? '#cbd5e1' : '#4b5563', fontSize: 12, marginTop: 1 }}>
            {kwh.toFixed(2)} kWh · {formatElapsed(active.startedAt)} · Tap to return
          </Text>
        </View>
        <Text style={{ color: isDark ? '#e2e8f0' : '#111827', fontWeight: '800' }}>Open</Text>
      </TouchableOpacity>
    </View>
  );
}

export default function TabsLayout() {
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
        screenOptions={{
          tabBarActiveTintColor: isDark ? '#67e8f9' : '#0f766e',
          tabBarInactiveTintColor: isDark ? '#64748b' : '#94a3b8',
          tabBarStyle: {
            borderTopColor: 'transparent',
            borderTopWidth: 0,
            backgroundColor: isDark ? '#0b1220' : '#ffffff',
            position: 'absolute',
            width: 'auto',
            left: 12,
            right: 12,
            bottom: bannerVisible ? 72 + Math.max(insets.bottom, 8) : Math.max(insets.bottom, 8),
            borderRadius: 20,
            paddingBottom: Math.max(insets.bottom, 6),
            paddingTop: 6,
            minHeight: 56 + Math.max(insets.bottom, 6),
            marginBottom: 0,
            shadowColor: '#000',
            shadowOpacity: isDark ? 0.25 : 0.12,
            shadowRadius: 12,
            shadowOffset: { width: 0, height: 6 },
            elevation: 10,
          },
          tabBarItemStyle: {
            justifyContent: 'center',
            alignItems: 'center',
            paddingVertical: 0,
          },
          tabBarLabelStyle: {
            marginTop: 1,
            marginBottom: 1,
            paddingTop: 0,
            lineHeight: 13,
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
            tabBarLabel: 'Find Charger',
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
