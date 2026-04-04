import React, { useEffect, useState } from 'react';
import { Redirect } from 'expo-router';
import { View, ActivityIndicator, StyleSheet } from 'react-native';

const PASSWORD_SESSION_KEY = 'mobile.keycloak.session.v1';

export default function RootIndex() {
  const [target, setTarget] = useState<'tabs' | 'sign-in' | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const SecureStore = require('expo-secure-store');
        const raw = await SecureStore.getItemAsync(PASSWORD_SESSION_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed?.accessToken) {
            // Valid stored session — go straight to app
            // AuthProvider.restoreSession() will handle token refresh if needed
            setTarget('tabs');
            return;
          }
        }
      } catch {
        // SecureStore read failed — fall through to sign-in
      }
      setTarget('sign-in');
    })();
  }, []);

  if (!target) {
    return (
      <View style={styles.splash}>
        <ActivityIndicator size="large" color="#10b981" />
      </View>
    );
  }

  return target === 'tabs'
    ? <Redirect href="/(tabs)" />
    : <Redirect href="/(auth)/sign-in" />;
}

const styles = StyleSheet.create({
  splash: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0b1220' },
});
