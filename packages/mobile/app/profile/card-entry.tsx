import React, { useState } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, Alert, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useRouter } from 'expo-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useStripe } from '@stripe/stripe-react-native';
import { api } from '@/lib/api';
import { useAppTheme } from '@/theme';

export default function CardEntryScreen() {
  const { isDark } = useAppTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { confirmSetupIntent } = useStripe();

  const [cardNumber, setCardNumber] = useState('');
  const [exp, setExp] = useState('');
  const [cvc, setCvc] = useState('');
  const [name, setName] = useState('');

  const saveCard = useMutation({
    mutationFn: async () => {
      const { clientSecret } = await api.payments.setupIntent();
      const { error } = await confirmSetupIntent(clientSecret, {
        paymentMethodType: 'Card',
        paymentMethodData: { billingDetails: { name: name || undefined } },
      });
      if (error) throw new Error(error.message);
      return true;
    },
    onSuccess: async () => {
      await api.profile.update({ paymentProfile: `Card •••• ${cardNumber.replace(/\D/g, '').slice(-4) || 'saved'}` });
      queryClient.invalidateQueries({ queryKey: ['me-profile'] });
      Alert.alert('Saved', 'Card added successfully.');
      router.replace('/(tabs)/profile' as any);
    },
    onError: (err: Error) => {
      Alert.alert('Failed', `${err.message}\n\nTip: in iOS, tap card number field and use keyboard card-scan camera icon for fast capture.`);
    },
  });

  return (
    <SafeAreaView edges={['top']} style={[styles.container, { backgroundColor: isDark ? '#030712' : '#f9fafb' }]}>
      <Stack.Screen options={{ title: 'Add Card', headerShown: false }} />
      <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}><Text style={styles.backText}>← Back</Text></TouchableOpacity>

      <Text style={[styles.title, { color: isDark ? '#f9fafb' : '#111827' }]}>Add card details</Text>
      <Text style={[styles.subtitle, { color: isDark ? '#9ca3af' : '#6b7280' }]}>You can type directly. On iOS, card number field supports camera card scan from keyboard.</Text>

      <Field label="Name on Card" value={name} onChangeText={setName} isDark={isDark} />
      <Field
        label="Card Number"
        value={cardNumber}
        onChangeText={setCardNumber}
        isDark={isDark}
        keyboardType="number-pad"
        textContentType={Platform.OS === 'ios' ? 'creditCardNumber' : 'none'}
        placeholder="4242 4242 4242 4242"
      />
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <View style={{ flex: 1 }}>
          <Field label="Exp (MM/YY)" value={exp} onChangeText={setExp} isDark={isDark} placeholder="12/30" />
        </View>
        <View style={{ flex: 1 }}>
          <Field label="CVC" value={cvc} onChangeText={setCvc} isDark={isDark} placeholder="123" keyboardType="number-pad" />
        </View>
      </View>

      <TouchableOpacity style={styles.saveBtn} onPress={() => saveCard.mutate()} disabled={saveCard.isPending}>
        <Text style={styles.saveText}>{saveCard.isPending ? 'Saving…' : 'Save Card'}</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

function Field({ label, isDark, ...props }: any) {
  return (
    <View style={{ marginBottom: 10 }}>
      <Text style={{ color: isDark ? '#d1d5db' : '#374151', fontWeight: '600', marginBottom: 6 }}>{label}</Text>
      <TextInput
        {...props}
        style={{ borderWidth: 1, borderColor: isDark ? '#374151' : '#d1d5db', backgroundColor: isDark ? '#111827' : '#fff', color: isDark ? '#f9fafb' : '#111827', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10 }}
        placeholderTextColor={isDark ? '#6b7280' : '#9ca3af'}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  backBtn: { alignSelf: 'flex-start', backgroundColor: '#2563eb', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, marginBottom: 10 },
  backText: { color: '#fff', fontWeight: '700' },
  title: { fontSize: 24, fontWeight: '800' },
  subtitle: { marginTop: 6, marginBottom: 18, fontSize: 13 },
  saveBtn: { backgroundColor: '#10b981', borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 4 },
  saveText: { color: '#fff', fontWeight: '700', fontSize: 15 },
});
