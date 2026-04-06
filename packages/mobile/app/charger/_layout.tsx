import React from 'react';
import { Stack } from 'expo-router';
import { useAppTheme } from '@/theme';

export default function ChargerLayout() {
  const { isDark } = useAppTheme();

  return (
    <Stack
      screenOptions={{
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
        headerTitle: 'Lumeo',
        headerBackButtonDisplayMode: 'minimal',
        gestureEnabled: false,
        fullScreenGestureEnabled: false,
      }}
    >
      <Stack.Screen name="detail/[id]" options={{ gestureEnabled: false, fullScreenGestureEnabled: false }} />
    </Stack>
  );
}
