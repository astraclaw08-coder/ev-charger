import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useRouter } from 'expo-router';
import { isPlatformPaySupported } from '@stripe/stripe-react-native';
import { useAppTheme } from '@/theme';

export default function PaymentProfileScreen() {
  const { isDark } = useAppTheme();
  const router = useRouter();

  async function onPlatformPay() {
    const supported = await isPlatformPaySupported();
    if (!supported) {
      Alert.alert('Not available', 'Apple Pay / Google Pay is not available on this device yet.');
      return;
    }
    Alert.alert('Supported', 'Apple/Google Pay is available on this device.');
  }

  return (
    <SafeAreaView edges={['top']} style={[styles.container, { backgroundColor: isDark ? '#030712' : '#f9fafb' }]}>
      <Stack.Screen options={{ title: 'Payment Methods', headerShown: false }} />
      <TouchableOpacity style={styles.backBtn} hitSlop={10} onPress={() => router.replace('/(tabs)/profile' as any)}>
        <Text style={styles.backText}>← Back to Profile</Text>
      </TouchableOpacity>

      <Text style={[styles.title, { color: isDark ? '#f9fafb' : '#111827' }]}>Choose how you pay</Text>
      <Text style={[styles.subtitle, { color: isDark ? '#9ca3af' : '#6b7280' }]}>Add card details manually or scan with camera from the card entry screen.</Text>

      <TouchableOpacity style={styles.primaryBtn} onPress={() => router.push('/profile/card-entry' as any)}>
        <Text style={styles.primaryText}>Add Card Details</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.secondaryBtn} onPress={onPlatformPay}>
        <Text style={styles.secondaryText}>Use Apple Pay / Google Pay</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  backBtn: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', paddingVertical: 10, paddingHorizontal: 14, backgroundColor: '#2563eb', borderRadius: 12, marginBottom: 12 },
  backText: { color: '#ffffff', fontWeight: '800', fontSize: 14 },
  title: { fontSize: 24, fontWeight: '800' },
  subtitle: { marginTop: 6, marginBottom: 18, fontSize: 14 },
  primaryBtn: { backgroundColor: '#10b981', borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginBottom: 10 },
  primaryText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  secondaryBtn: { backgroundColor: '#111827', borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  secondaryText: { color: '#fff', fontWeight: '700', fontSize: 15 },
});
