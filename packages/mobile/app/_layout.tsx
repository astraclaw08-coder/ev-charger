import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StripeProvider } from '@stripe/stripe-react-native';
import { useFonts } from 'expo-font';

import { AuthProvider } from '@/providers/AuthProvider';
import { ChargingNotificationsProvider } from '@/providers/ChargingNotificationsProvider';
import { ThemeProvider, useAppTheme } from '@/theme';
import { patchTextDefaults } from '@/setupFonts';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 10_000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
    },
  },
});

const STRIPE_KEY = process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '';

function AppShell() {
  const { isDark } = useAppTheme();
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={queryClient}>
        <StripeProvider publishableKey={STRIPE_KEY}>
          <AuthProvider>
            <ChargingNotificationsProvider>
              <Stack screenOptions={{ headerShown: false }}>
                <Stack.Screen name="charger" options={{ gestureEnabled: false }} />
              </Stack>
              <StatusBar style={isDark ? 'light' : 'dark'} />
            </ChargingNotificationsProvider>
          </AuthProvider>
        </StripeProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    'NunitoSans-Light': require('../assets/fonts/NunitoSans-Light.ttf'),
    'NunitoSans-Regular': require('../assets/fonts/NunitoSans-Regular.ttf'),
    'NunitoSans-Medium': require('../assets/fonts/NunitoSans-Medium.ttf'),
    'NunitoSans-SemiBold': require('../assets/fonts/NunitoSans-SemiBold.ttf'),
    'NunitoSans-Bold': require('../assets/fonts/NunitoSans-Bold.ttf'),
    'NunitoSans-ExtraBold': require('../assets/fonts/NunitoSans-ExtraBold.ttf'),
    'NunitoSans-Black': require('../assets/fonts/NunitoSans-Black.ttf'),
  });

  React.useEffect(() => {
    if (fontsLoaded) {
      patchTextDefaults();
    }
  }, [fontsLoaded]);

  if (!fontsLoaded) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#ffffff' }}>
        <ActivityIndicator size="large" color="#0891b2" />
      </View>
    );
  }

  return (
    <ThemeProvider>
      <AppShell />
    </ThemeProvider>
  );
}
