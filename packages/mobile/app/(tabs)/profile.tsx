import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAppTheme } from '@/theme';

type DriverProfile = {
  name: string;
  email: string;
  phone: string;
  homeAddress: string;
  paymentProfile: string;
};

const EMPTY: DriverProfile = {
  name: '',
  email: '',
  phone: '',
  homeAddress: '',
  paymentProfile: '',
};

export default function ProfileScreen() {
  const { isDark, mode, setMode } = useAppTheme();
  const router = useRouter();
  const [profile, setProfile] = useState<DriverProfile>(EMPTY);
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['me-profile'],
    queryFn: () => api.profile.get(),
  });

  React.useEffect(() => {
    if (!data) return;
    setProfile({
      name: data.name ?? '',
      email: data.email ?? '',
      phone: data.phone ?? '',
      homeAddress: data.homeAddress ?? '',
      paymentProfile: data.paymentProfile ?? '',
    });
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: () =>
      api.profile.update({
        name: profile.name,
        email: profile.email,
        phone: profile.phone,
        homeAddress: profile.homeAddress,
        paymentProfile: profile.paymentProfile,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['me-profile'] });
      Alert.alert('Saved', 'Your profile sync is updated.');
    },
    onError: (err: Error) => Alert.alert('Save failed', err.message),
  });

  function set<K extends keyof DriverProfile>(k: K, v: DriverProfile[K]) {
    setProfile((prev) => ({ ...prev, [k]: v }));
  }

  return (
    <ScrollView style={[styles.container, { backgroundColor: isDark ? '#030712' : '#f9fafb' }]} contentContainerStyle={styles.content}>
      <Text style={[styles.title, { color: isDark ? '#f9fafb' : '#111827' }]}>Driver Profile</Text>
      <Text style={[styles.subtitle, { color: isDark ? '#9ca3af' : '#6b7280' }]}>Set your details once and use them across devices.</Text>

      <View style={[styles.card, { backgroundColor: isDark ? '#111827' : '#fff', borderColor: isDark ? '#374151' : '#e5e7eb' }]}> 
        <Text style={[styles.sectionTitle, { color: isDark ? '#f9fafb' : '#111827' }]}>Appearance</Text>
        <View style={styles.themeRow}>
          {(['system', 'light', 'dark'] as const).map((m) => (
            <TouchableOpacity
              key={m}
              onPress={() => setMode(m)}
              style={[
                styles.modeBtn,
                {
                  backgroundColor: mode === m ? '#10b981' : isDark ? '#1f2937' : '#f3f4f6',
                },
              ]}
            >
              <Text style={{ color: mode === m ? '#fff' : isDark ? '#d1d5db' : '#374151', fontWeight: '600' }}>
                {m[0].toUpperCase() + m.slice(1)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <Field label="Name" value={profile.name} onChangeText={(v) => set('name', v)} isDark={isDark} autoCapitalize="words" />
      <Field label="Email" value={profile.email} onChangeText={(v) => set('email', v)} isDark={isDark} keyboardType="email-address" autoCapitalize="none" />
      <Field label="Phone" value={profile.phone} onChangeText={(v) => set('phone', v)} isDark={isDark} keyboardType="phone-pad" />
      <Field label="Home Address" value={profile.homeAddress} onChangeText={(v) => set('homeAddress', v)} isDark={isDark} multiline />
      <Field label="Payment Profile" value={profile.paymentProfile} onChangeText={(v) => set('paymentProfile', v)} isDark={isDark} placeholder="Visa •••• 4242 / Apple Pay" />

      <TouchableOpacity style={styles.paymentBtn} onPress={() => router.push('/profile/payment' as any)}>
        <Text style={styles.paymentBtnText}>Manage Payment Methods</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={[styles.saveBtn, (isLoading || saveMutation.isPending) && { opacity: 0.6 }]}
        onPress={() => saveMutation.mutate()}
        disabled={isLoading || saveMutation.isPending}
      >
        <Text style={styles.saveText}>Save Profile</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

function Field({ label, isDark, multiline, ...props }: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  isDark: boolean;
  multiline?: boolean;
  placeholder?: string;
  keyboardType?: 'default' | 'email-address' | 'phone-pad';
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
}) {
  return (
    <View style={styles.fieldWrap}>
      <Text style={[styles.label, { color: isDark ? '#d1d5db' : '#374151' }]}>{label}</Text>
      <TextInput
        {...props}
        multiline={multiline}
        style={[
          styles.input,
          multiline && { minHeight: 72, textAlignVertical: 'top' as const },
          {
            backgroundColor: isDark ? '#111827' : '#ffffff',
            borderColor: isDark ? '#374151' : '#d1d5db',
            color: isDark ? '#f9fafb' : '#111827',
          },
        ]}
        placeholderTextColor={isDark ? '#6b7280' : '#9ca3af'}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 16, gap: 12, paddingBottom: 36 },
  title: { fontSize: 24, fontWeight: '800' },
  subtitle: { fontSize: 13, marginBottom: 10 },
  card: { borderWidth: 1, borderRadius: 12, padding: 12 },
  sectionTitle: { fontSize: 14, fontWeight: '700', marginBottom: 10 },
  themeRow: { flexDirection: 'row', gap: 8 },
  modeBtn: { flex: 1, borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
  fieldWrap: { gap: 6 },
  label: { fontSize: 13, fontWeight: '600' },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  paymentBtn: { backgroundColor: '#111827', borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 8 },
  paymentBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  saveBtn: { backgroundColor: '#10b981', borderRadius: 12, marginTop: 8, paddingVertical: 14, alignItems: 'center' },
  saveText: { color: '#fff', fontWeight: '700', fontSize: 16 },
});
