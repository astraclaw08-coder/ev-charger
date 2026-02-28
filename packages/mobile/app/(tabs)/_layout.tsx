import React from 'react';
import { Tabs } from 'expo-router';
import { useColorScheme } from 'react-native';

export default function TabsLayout() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';

  return (
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
        }}
      />
    </Tabs>
  );
}

function TabIcon({ icon, size }: { icon: string; size: number }) {
  const { Text } = require('react-native');
  return <Text style={{ fontSize: size - 4 }}>{icon}</Text>;
}
