import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  Alert,
  Modal,
  Pressable,
} from 'react-native';
import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import { Ionicons } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiBaseUrl, envLabel } from '@/lib/api';
import { useAppTheme } from '@/theme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import { useAppAuth } from '@/providers/AuthProvider';
import { useChargingNotifications } from '@/providers/ChargingNotificationsProvider';

type DriverProfile = {
  name: string;
  email: string;
  phone: string;
  homeAddress: string;
  homeSiteAddress: string;
  homeCity: string;
  homeState: string;
  homeZipCode: string;
  paymentProfile: string;
};

const EMPTY: DriverProfile = {
  name: '',
  email: '',
  phone: '',
  homeAddress: '',
  homeSiteAddress: '',
  homeCity: '',
  homeState: '',
  homeZipCode: '',
  paymentProfile: '',
};

const expoVersion = Constants.expoConfig?.version || '1.0.0';
const mobileVersion = `${expoVersion} (${envLabel.toLowerCase()})`;

export default function ProfileScreen() {
  const { isDark, setMode } = useAppTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const tabBarHeight = useBottomTabBarHeight();
  const [profile, setProfile] = useState<DriverProfile>(EMPTY);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const queryClient = useQueryClient();
  const { isGuest, signOut } = useAppAuth();
  const { unreadCount } = useChargingNotifications();

  const { data, isLoading } = useQuery({
    queryKey: ['me-profile'],
    queryFn: () => api.profile.get(),
    enabled: !isGuest,
  });

  React.useEffect(() => {
    if (!data) return;
    setProfile({
      name: data.name ?? '',
      email: data.email ?? '',
      phone: data.phone ?? '',
      homeAddress: data.homeAddress ?? '',
      homeSiteAddress: data.homeSiteAddress ?? data.homeAddress ?? '',
      homeCity: data.homeCity ?? '',
      homeState: data.homeState ?? '',
      homeZipCode: data.homeZipCode ?? '',
      paymentProfile: data.paymentProfile ?? '',
    });
  }, [data]);

  const hasProfileChanges = useMemo(() => {
    if (!data) return false;
    const baseline: DriverProfile = {
      name: data.name ?? '',
      email: data.email ?? '',
      phone: data.phone ?? '',
      homeAddress: data.homeAddress ?? '',
      homeSiteAddress: data.homeSiteAddress ?? data.homeAddress ?? '',
      homeCity: data.homeCity ?? '',
      homeState: data.homeState ?? '',
      homeZipCode: data.homeZipCode ?? '',
      paymentProfile: data.paymentProfile ?? '',
    };
    return (
      profile.name !== baseline.name ||
      profile.email !== baseline.email ||
      profile.phone !== baseline.phone ||
      profile.homeAddress !== baseline.homeAddress ||
      profile.homeSiteAddress !== baseline.homeSiteAddress ||
      profile.homeCity !== baseline.homeCity ||
      profile.homeState !== baseline.homeState ||
      profile.homeZipCode !== baseline.homeZipCode ||
      profile.paymentProfile !== baseline.paymentProfile
    );
  }, [data, profile]);

  const saveMutation = useMutation({
    mutationFn: () =>
      api.profile.update({
        name: profile.name,
        email: profile.email,
        phone: profile.phone,
        homeAddress: profile.homeSiteAddress || profile.homeAddress,
        homeSiteAddress: profile.homeSiteAddress,
        homeCity: profile.homeCity,
        homeState: profile.homeState,
        homeZipCode: profile.homeZipCode,
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

  const currentThemeLabel = isDark ? 'Dark' : 'Light';
  const currentThemeIcon = isDark ? 'moon' : 'sunny';
  const toggleTheme = () => setMode(isDark ? 'light' : 'dark');

  if (isGuest) {
    return (
      <View style={[styles.guestWrap, { backgroundColor: isDark ? '#030712' : '#f9fafb' }]}>
        <View style={styles.headerRow}>
          <Text style={[styles.title, { color: isDark ? '#f9fafb' : '#111827' }]}>Guest Mode</Text>
          <TouchableOpacity
            onPress={toggleTheme}
            accessibilityRole="button"
            accessibilityLabel={`Theme: ${currentThemeLabel}. Tap to switch theme`}
            style={[
              styles.themeIconBtn,
              {
                backgroundColor: isDark ? '#111827' : '#ffffff',
                borderColor: isDark ? '#374151' : '#d1d5db',
              },
            ]}
          >
            <Ionicons name={currentThemeIcon as any} size={16} color={isDark ? '#f9fafb' : '#111827'} />
            <Text style={[styles.themeIconText, { color: isDark ? '#f9fafb' : '#111827' }]}>{currentThemeLabel}</Text>
          </TouchableOpacity>
        </View>
        <Text style={[styles.subtitle, { color: isDark ? '#9ca3af' : '#6b7280' }]}>Sign in to access profile, history, and charging actions.</Text>
        <TouchableOpacity style={styles.saveBtn} onPress={() => router.replace('/(auth)/sign-in' as any)}>
          <Text style={styles.saveText}>Sign in / Sign up</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: isDark ? '#030712' : '#f9fafb' }]}
      contentContainerStyle={[styles.content, { paddingBottom: Math.max(36 + insets.bottom, tabBarHeight + 24), flexGrow: 1 }]}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.headerRow}>
        <Text style={[styles.title, { color: isDark ? '#f9fafb' : '#111827' }]}>Driver Profile</Text>
        <View style={styles.headerActions}>
          <TouchableOpacity
            onPress={() => router.push('/notifications' as any)}
            accessibilityRole="button"
            accessibilityLabel="Open charging notifications"
            style={[
              styles.bellBtn,
              {
                backgroundColor: isDark ? '#111827' : '#ffffff',
                borderColor: isDark ? '#374151' : '#d1d5db',
              },
            ]}
          >
            <Ionicons name="notifications-outline" size={18} color={isDark ? '#f9fafb' : '#111827'} />
            {unreadCount > 0 ? (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{unreadCount > 9 ? '9+' : unreadCount}</Text>
              </View>
            ) : null}
          </TouchableOpacity>
          <TouchableOpacity
            onPress={toggleTheme}
            accessibilityRole="button"
            accessibilityLabel={`Theme: ${currentThemeLabel}. Tap to switch theme`}
            style={[
              styles.themeIconBtn,
              {
                backgroundColor: isDark ? '#111827' : '#ffffff',
                borderColor: isDark ? '#374151' : '#d1d5db',
              },
            ]}
          >
            <Ionicons name={currentThemeIcon as any} size={16} color={isDark ? '#f9fafb' : '#111827'} />
            <Text style={[styles.themeIconText, { color: isDark ? '#f9fafb' : '#111827' }]}>{currentThemeLabel}</Text>
          </TouchableOpacity>
        </View>
      </View>
      <Text style={[styles.subtitle, { color: isDark ? '#9ca3af' : '#6b7280' }]}>Set your details once and use them across devices.</Text>

      <View style={[styles.card, { backgroundColor: isDark ? '#111827' : '#fff', borderColor: isDark ? '#374151' : '#e5e7eb' }]}>
        <Text style={[styles.sectionTitle, { color: isDark ? '#f9fafb' : '#111827' }]}>Payment Methods</Text>
        <Text style={[styles.paymentSummary, { color: isDark ? '#9ca3af' : '#4b5563' }]}>
          {profile.paymentProfile || 'No payment method added yet'}
        </Text>
        <TouchableOpacity
          style={[
            styles.paymentBtn,
            isDark ? styles.paymentBtnDark : styles.paymentBtnLight,
          ]}
          onPress={() => router.push('/profile/payment' as any)}
        >
          <Text style={styles.paymentBtnText}>Add Payment Method</Text>
        </TouchableOpacity>
      </View>


      <Field label="Name" value={profile.name} onChangeText={(v) => set('name', v)} isDark={isDark} autoCapitalize="words" />
      <Field label="Email" value={profile.email} onChangeText={(v) => set('email', v)} isDark={isDark} keyboardType="email-address" autoCapitalize="none" />
      <Field label="Phone" value={profile.phone} onChangeText={(v) => set('phone', v)} isDark={isDark} keyboardType="phone-pad" />
      <Field label="Site Address" value={profile.homeSiteAddress} onChangeText={(v) => set('homeSiteAddress', v)} isDark={isDark} />
      <Field label="City" value={profile.homeCity} onChangeText={(v) => set('homeCity', v)} isDark={isDark} autoCapitalize="words" />
      <View style={styles.row}>
        <View style={styles.stateItem}>
          <Field label="State" value={profile.homeState} onChangeText={(v) => set('homeState', v.toUpperCase())} isDark={isDark} autoCapitalize="characters" maxLength={2} />
        </View>
        <View style={styles.zipItem}>
          <Field label="Zip Code" value={profile.homeZipCode} onChangeText={(v) => set('homeZipCode', v)} isDark={isDark} keyboardType="number-pad" maxLength={10} />
        </View>
      </View>

      <TouchableOpacity
        style={[
          styles.saveBtn,
          !hasProfileChanges && {
            backgroundColor: isDark ? '#374151' : '#e5e7eb',
            borderColor: isDark ? '#4b5563' : '#d1d5db',
            borderWidth: 1,
          },
          (isLoading || saveMutation.isPending) && { opacity: 0.6 },
        ]}
        onPress={() => saveMutation.mutate()}
        disabled={isLoading || saveMutation.isPending || !hasProfileChanges}
      >
        <Text style={[styles.saveText, !hasProfileChanges && { color: isDark ? '#d1d5db' : '#6b7280' }]}>Save Profile</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={[
          styles.logoutBtn,
          { backgroundColor: isDark ? '#6b7280' : '#4b5563' },
        ]}
        onPress={() => setShowLogoutConfirm(true)}
      >
        <Text style={styles.logoutText}>Log Out</Text>
      </TouchableOpacity>

      <Modal visible={showLogoutConfirm} transparent animationType="fade" onRequestClose={() => setShowLogoutConfirm(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setShowLogoutConfirm(false)}>
          <Pressable
            style={[
              styles.modalCard,
              { backgroundColor: isDark ? '#111827' : '#ffffff', borderColor: isDark ? '#374151' : '#e5e7eb' },
            ]}
            onPress={(e) => e.stopPropagation()}
          >
            <Text style={[styles.modalTitle, { color: isDark ? '#f9fafb' : '#111827' }]}>Log Out?</Text>
            <Text style={[styles.modalBody, { color: isDark ? '#9ca3af' : '#6b7280' }]}>You can still browse chargers in guest mode.</Text>
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalBtn, { borderColor: isDark ? '#4b5563' : '#d1d5db', backgroundColor: isDark ? '#1f2937' : '#f9fafb' }]}
                onPress={() => setShowLogoutConfirm(false)}
              >
                <Text style={[styles.modalBtnText, { color: isDark ? '#f3f4f6' : '#111827' }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalDangerBtn]}
                onPress={() => {
                  setShowLogoutConfirm(false);
                  signOut();
                }}
              >
                <Text style={styles.modalDangerText}>Log Out</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <Text style={[styles.versionText, { color: isDark ? '#6b7280' : '#9ca3af' }]}>Version {mobileVersion}</Text>
      <Text style={[styles.versionText, { color: isDark ? '#6b7280' : '#9ca3af' }]}>Environment {envLabel}</Text>
      <Text style={[styles.versionText, { color: isDark ? '#6b7280' : '#9ca3af' }]} numberOfLines={1}>API {apiBaseUrl}</Text>
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
  keyboardType?: 'default' | 'email-address' | 'phone-pad' | 'number-pad';
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  maxLength?: number;
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
  content: { padding: 16, paddingBottom: 36 },
  guestWrap: { flex: 1, padding: 16, justifyContent: 'center' },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 24, fontWeight: '800' },
  subtitle: { fontSize: 13, marginBottom: 10 },
  bellBtn: {
    width: 40,
    height: 40,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 3,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ef4444',
  },
  badgeText: { color: '#fff', fontSize: 10, fontWeight: '800' },
  themeIconBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  themeIconText: { fontSize: 13, fontWeight: '700' },
  card: { borderWidth: 1, borderRadius: 12, padding: 12, marginBottom: 12 },
  sectionTitle: { fontSize: 14, fontWeight: '700', marginBottom: 10 },
  paymentSummary: { fontSize: 13, marginBottom: 12 },

  row: { flexDirection: 'row', marginBottom: 12, columnGap: 12 },
  stateItem: { width: 96 },
  zipItem: { flex: 1 },
  fieldWrap: { marginBottom: 12 },
  label: { fontSize: 13, fontWeight: '600', marginBottom: 6 },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  paymentBtn: { borderRadius: 12, paddingVertical: 14, alignItems: 'center', borderWidth: 1 },
  paymentBtnDark: { backgroundColor: '#374151', borderColor: '#4b5563' },
  paymentBtnLight: { backgroundColor: '#111827', borderColor: '#111827' },
  paymentBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  saveBtn: { backgroundColor: '#10b981', borderRadius: 12, marginTop: 8, paddingVertical: 14, alignItems: 'center' },
  saveText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  createAccountBtn: { backgroundColor: '#111827', borderRadius: 12, marginTop: 10, paddingVertical: 14, alignItems: 'center' },
  createAccountText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  logoutBtn: { backgroundColor: '#991b1b', borderRadius: 12, marginTop: 12, paddingVertical: 14, alignItems: 'center' },
  logoutText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    padding: 24,
  },
  modalCard: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 16,
  },
  modalTitle: { fontSize: 18, fontWeight: '800', marginBottom: 6 },
  modalBody: { fontSize: 14, marginBottom: 14 },
  modalActions: { flexDirection: 'row', gap: 10 },
  modalBtn: {
    flex: 1,
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 11,
    alignItems: 'center',
  },
  modalBtnText: { fontWeight: '700', fontSize: 14 },
  modalDangerBtn: { backgroundColor: '#991b1b', borderColor: '#991b1b' },
  modalDangerText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  versionText: { marginTop: 16, textAlign: 'center', fontSize: 12, fontWeight: '500' },
});
