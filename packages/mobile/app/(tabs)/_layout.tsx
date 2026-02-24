import React from 'react';
import { Tabs } from 'expo-router';

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: '#10b981',
        tabBarInactiveTintColor: '#9ca3af',
        tabBarStyle: {
          borderTopColor: '#e5e7eb',
          paddingBottom: 4,
        },
        headerStyle: { backgroundColor: '#fff' },
        headerTintColor: '#111827',
        headerShadowVisible: false,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Find Chargers',
          tabBarLabel: 'Map',
          tabBarIcon: ({ color, size }) => (
            // Simple map icon using Text (no icon library dependency)
            <TabIcon icon="🗺️" size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="sessions"
        options={{
          title: 'Session History',
          tabBarLabel: 'History',
          tabBarIcon: ({ color, size }) => (
            <TabIcon icon="📋" size={size} />
          ),
        }}
      />
    </Tabs>
  );
}

function TabIcon({ icon, size }: { icon: string; size: number }) {
  const { Text } = require('react-native');
  return <Text style={{ fontSize: size - 4 }}>{icon}</Text>;
}
