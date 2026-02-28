import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import { Stack } from 'expo-router';
import { useMutation } from '@tanstack/react-query';
import { useStripe, isPlatformPaySupported } from '@stripe/stripe-react-native';
import { api } from '@/lib/api';
import { useAppTheme } from '@/theme';

export default function PaymentProfileScreen() {
  const { isDark } = useAppTheme();
  const { confirmSetupIntent } = useStripe();

  const cardSetup = useMutation({
    mutationFn: async () => {
      const { clientSecret } = await api.payments.setupIntent();
      const { error } = await confirmSetupIntent(clientSecret, { paymentMethodType: 'Card' });
      if (error) throw new Error(error.message);
      return true;
    },
    onSuccess: () => Alert.alert('Saved', 'Card payment method added.'),
    onError: (err: Error) => Alert.alert('Failed', err.message),
  });

  async function onPlatformPay() {
    const supported = await isPlatformPaySupported();
    if (!supported) {
      Alert.alert('Not available', 'Apple Pay / Google Pay is not available on this device yet.');
      return;
    }
    Alert.alert('Ready', 'Platform Pay is supported. Next step: enable merchant config and wallet tokenization flow.');
  }

  return (
    <View style={[styles.container, { backgroundColor: isDark ? '#030712' : '#f9fafb' }]}>
      <Stack.Screen options={{ title: 'Payment Methods', headerShown: true }} />
      <Text style={[styles.title, { color: isDark ? '#f9fafb' : '#111827' }]}>Choose how you pay</Text>
      <Text style={[styles.subtitle, { color: isDark ? '#9ca3af' : '#6b7280' }]}>Add a card directly or use Apple/Google Pay where supported.</Text>

      <TouchableOpacity style={styles.primaryBtn} onPress={() => cardSetup.mutate()} disabled={cardSetup.isPending}>
        <Text style={styles.primaryText}>{cardSetup.isPending ? 'Opening secure card form…' : 'Add Card (direct entry)'}</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.secondaryBtn} onPress={onPlatformPay}>
        <Text style={styles.secondaryText}>Use Apple Pay / Google Pay</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  title: { fontSize: 24, fontWeight: '800' },
  subtitle: { marginTop: 6, marginBottom: 18, fontSize: 14 },
  primaryBtn: { backgroundColor: '#10b981', borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginBottom: 10 },
  primaryText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  secondaryBtn: { backgroundColor: '#111827', borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  secondaryText: { color: '#fff', fontWeight: '700', fontSize: 15 },
});
