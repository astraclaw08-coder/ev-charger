import React, { useEffect, useMemo } from 'react';
import { AppState } from 'react-native';
import { Tabs, useRouter, useSegments } from 'expo-router';
import { TouchableOpacity, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useQuery } from '@tanstack/react-query';
import { api, type Session } from '@/lib/api';
import { useAppTheme } from '@/theme';
import { useAppAuth } from '@/providers/AuthProvider';
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
      backgroundColor: isDark ? '#030712' : '#f9fafb',
      paddingHorizontal: 12,
      paddingBottom: Math.max(insets.bottom, 8),
      paddingTop: 4,
    }}>
      <TouchableOpacity
        style={{
          borderRadius: 12,
          paddingVertical: 10,
          paddingHorizontal: 12,
          backgroundColor: isDark ? '#0f172a' : '#ecfeff',
          borderWidth: 1,
          borderColor: isDark ? '#334155' : '#bae6fd',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
        onPress={() => router.push(`/session/${active.id}`)}
        activeOpacity={0.85}
      >
        <View style={{ flex: 1, paddingRight: 8 }}>
          <Text style={{ color: isDark ? '#bae6fd' : '#0369a1', fontWeight: '800', fontSize: 12 }}>
            ⚡ Active charging session
          </Text>
          <Text numberOfLines={1} style={{ color: isDark ? '#f8fafc' : '#0f172a', fontWeight: '700', fontSize: 13, marginTop: 2 }}>
            {siteName}
          </Text>
          <Text style={{ color: isDark ? '#cbd5e1' : '#334155', fontSize: 12, marginTop: 1 }}>
            {kwh.toFixed(2)} kWh · {formatElapsed(active.startedAt)} · Tap to return
          </Text>
        </View>
        <Text style={{ color: isDark ? '#93c5fd' : '#0284c7', fontWeight: '800' }}>Open</Text>
      </TouchableOpacity>
    </View>
  );
}

export default function TabsLayout() {
  const { isDark } = useAppTheme();
  const { isGuest } = useAppAuth();
  const segments = useSegments();
  const insets = useSafeAreaInsets();

  const { data, refetch } = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api.sessions.list(20, 0),
    refetchInterval: isGuest ? false : 5_000,
    enabled: !isGuest,
  });

  useFocusEffect(
    React.useCallback(() => {
      if (!isGuest) refetch();
      return undefined;
    }, [isGuest, refetch]),
  );

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (!isGuest && state === 'active') refetch();
    });
    return () => sub.remove();
  }, [isGuest, refetch]);

  const active = useMemo(() => data?.sessions.find((s) => s.status === 'ACTIVE') ?? null, [data]);
  const currentTab = segments[segments.length - 1];
  const bannerVisible = Boolean(active);
  const tabIconGap = 6;
  const tabBottomGap = bannerVisible ? tabIconGap : Math.max(insets.bottom, 8);

  return (
    <>
      {active && bannerVisible ? <ActiveSessionBanner active={active} /> : null}
      <Tabs
        screenOptions={{
          tabBarActiveTintColor: '#10b981',
          tabBarInactiveTintColor: isDark ? '#9ca3af' : '#6b7280',
          tabBarStyle: {
            borderTopColor: isDark ? '#1f2937' : '#e5e7eb',
            backgroundColor: isDark ? '#0b1220' : '#ffffff',
            paddingBottom: tabBottomGap,
            paddingTop: tabIconGap,
            height: 62 + tabBottomGap,
            marginBottom: bannerVisible ? 72 + Math.max(insets.bottom, 8) : 0,
          },
          tabBarItemStyle: {
            justifyContent: 'center',
            alignItems: 'center',
            paddingVertical: 2,
          },
          tabBarLabelStyle: {
            marginTop: 2,
            paddingTop: 0,
            lineHeight: 14,
          },
          sceneStyle: { backgroundColor: isDark ? '#030712' : '#f9fafb' },
          headerStyle: { backgroundColor: isDark ? '#0b1220' : '#fff' },
          headerTintColor: isDark ? '#f9fafb' : '#111827',
          headerShadowVisible: false,
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: 'Find Chargers',
            tabBarLabel: 'Find Charger',
            tabBarIcon: ({ size }) => <TabIcon icon="🗺️" size={size} />,
          }}
        />
        <Tabs.Screen
          name="favorites"
          options={{
            title: 'Favorites',
            tabBarLabel: 'Favorites',
            tabBarIcon: ({ size }) => <TabIcon icon="❤️" size={size} />,
            href: isGuest ? null : undefined,
          }}
        />
        <Tabs.Screen
          name="sessions"
          options={{
            title: 'Session History',
            tabBarLabel: 'History',
            tabBarIcon: ({ size }) => <TabIcon icon="📋" size={size} />,
            href: isGuest ? null : undefined,
          }}
        />
        <Tabs.Screen
          name="profile"
          options={{
            title: 'Profile',
            tabBarLabel: 'Profile',
            tabBarIcon: ({ size }) => <TabIcon icon="👤" size={size} />,
            tabBarBadge: isGuest ? 'Guest' : undefined,
          }}
        />
      </Tabs>
    </>
  );
}

function TabIcon({ icon, size }: { icon: string; size: number }) {
  return <Text style={{ fontSize: size - 4 }}>{icon}</Text>;
}
