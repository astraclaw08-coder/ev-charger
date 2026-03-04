import React, { useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';
import { Tabs, useRouter, useSegments } from 'expo-router';
import { TouchableOpacity, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAppTheme } from '@/theme';
import { useAppAuth } from '@/providers/AuthProvider';

function formatElapsed(startedAt: string): string {
  const start = new Date(startedAt).getTime();
  const mins = Math.max(0, Math.floor((Date.now() - start) / 60_000));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${m}m`;
}

function ActiveSessionBanner() {
  const router = useRouter();
  const segments = useSegments();
  const { isDark } = useAppTheme();
  const [, setTick] = useState(0);

  const { data, refetch } = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api.sessions.list(20, 0),
  });

  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(timer);
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

  const active = useMemo(() => data?.sessions.find((s) => s.status === 'ACTIVE') ?? null, [data]);
  const currentTab = segments[segments.length - 1];
  if (!active || currentTab === 'sessions') return null;

  const kwh = active.kwhDelivered ?? 0;
  const siteName = active.connector.charger.site.name;

  return (
    <View style={{
      position: 'absolute',
      left: 12,
      right: 12,
      top: 8,
      zIndex: 20,
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

  return (
    <>
      <Tabs
        screenOptions={{
          tabBarActiveTintColor: '#10b981',
          tabBarInactiveTintColor: isDark ? '#9ca3af' : '#6b7280',
          tabBarStyle: {
            borderTopColor: isDark ? '#1f2937' : '#e5e7eb',
            backgroundColor: isDark ? '#0b1220' : '#ffffff',
            paddingBottom: 4,
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
          }}
        />
        <Tabs.Screen
          name="sessions"
          options={{
            title: 'Session History',
            tabBarLabel: 'History',
            tabBarIcon: ({ size }) => <TabIcon icon="📋" size={size} />,
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
      <ActiveSessionBanner />
    </>
  );
}

function TabIcon({ icon, size }: { icon: string; size: number }) {
  return <Text style={{ fontSize: size - 4 }}>{icon}</Text>;
}
