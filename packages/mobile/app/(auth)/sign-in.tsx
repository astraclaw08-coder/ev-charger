import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Alert,
  ActivityIndicator,
  Pressable,
} from 'react-native';
import { useRouter } from 'expo-router';
import { AntDesign, Ionicons } from '@expo/vector-icons';
import { isDevMode, isKeycloakMode, setBearerToken, setGuestMode } from '@/lib/api';
import { useAppAuth } from '@/providers/AuthProvider';
import { useAppTheme } from '@/theme';

export default function SignInScreen() {
  const router = useRouter();
  const { signIn } = useAppAuth();
  const { isDark } = useAppTheme();

  const continueAsGuest = () => {
    setBearerToken(null);
    setGuestMode(true);
    router.replace('/(tabs)/index' as any);
  };

  if (isKeycloakMode) {
    return (
      <KeyboardAvoidingView
        style={[styles.container, { backgroundColor: isDark ? '#0b1220' : '#f3f4f6' }]}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={continueAsGuest} />
        <KeycloakSignInForm isDark={isDark} onContinueGuest={continueAsGuest} />
      </KeyboardAvoidingView>
    );
  }

  if (isDevMode) {
    return (
      <View style={[styles.container, { backgroundColor: isDark ? '#0b1220' : '#f3f4f6' }]}> 
        <Pressable style={StyleSheet.absoluteFill} onPress={continueAsGuest} />
        <View style={[styles.card, { backgroundColor: isDark ? '#0f172a' : '#ffffff', borderColor: isDark ? '#334155' : '#e5e7eb' }]}>
          <Text style={[styles.title, { color: isDark ? '#f8fafc' : '#111827' }]}>Sign In</Text>
          <Text style={[styles.devNote, { color: isDark ? '#cbd5e1' : '#334155' }]}>Dev Mode — No Clerk Key Set</Text>
          <TouchableOpacity
            style={styles.button}
            onPress={() => {
              signIn?.();
              router.replace('/' as any);
            }}
          >
            <Text style={styles.buttonText}>Continue to App</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.guestBtn} onPress={continueAsGuest}>
            <Text style={styles.guestBtnText}>Continue as Guest</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: isDark ? '#0b1220' : '#f3f4f6' }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <Pressable style={StyleSheet.absoluteFill} onPress={continueAsGuest} />
      <ClerkSignInForm isDark={isDark} onContinueGuest={continueAsGuest} />
    </KeyboardAvoidingView>
  );
}

function KeycloakSignInForm({ isDark, onContinueGuest }: { isDark: boolean; onContinueGuest: () => void }) {
  const { loginWithPassword, loading, error } = useAppAuth();
  const router = useRouter();
  const [countryCode, setCountryCode] = useState('+1');
  const [phone, setPhone] = useState('');
  const [showEmail, setShowEmail] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  async function handleSignIn() {
    const ok = await loginWithPassword?.(username, password);
    if (ok) router.replace('/' as any);
  }

  return (
    <View style={[styles.card, { backgroundColor: isDark ? '#0f172a' : '#ffffff', borderColor: isDark ? '#334155' : '#e5e7eb' }]}>
      <Text style={[styles.title, { color: isDark ? '#f8fafc' : '#111827' }]}>Sign In</Text>

      <View style={styles.row}>
        <TextInput style={[styles.input, styles.countryInput]} value={countryCode} onChangeText={setCountryCode} />
        <TextInput
          style={[styles.input, styles.flexInput]}
          placeholder="Phone number"
          value={phone}
          onChangeText={setPhone}
          keyboardType="phone-pad"
        />
      </View>

      <TouchableOpacity style={styles.button} onPress={() => Alert.alert('Next', 'Phone OTP is not enabled for this sign-in mode yet.')}>
        <Text style={styles.buttonText}>Next</Text>
      </TouchableOpacity>

      <View style={styles.dividerWrap}>
        <View style={styles.dividerLine} />
        <Text style={styles.dividerText}>OR</Text>
        <View style={styles.dividerLine} />
      </View>

      <TouchableOpacity style={styles.oauthBtn} onPress={() => setShowEmail((v) => !v)}>
        <Ionicons name="mail-outline" size={18} color="#111827" />
        <Text style={styles.oauthText}>Email</Text>
      </TouchableOpacity>

      {showEmail && (
        <>
          <TextInput
            style={styles.input}
            placeholder="Email"
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
            testID="keycloak-username-input"
          />
          <TextInput
            style={styles.input}
            placeholder="Password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            testID="keycloak-password-input"
          />
          {!!error && <Text style={{ color: '#dc2626', marginBottom: 8 }}>{error}</Text>}
          <TouchableOpacity style={[styles.button, loading && styles.buttonDisabled]} onPress={handleSignIn} disabled={loading}>
            {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Sign In</Text>}
          </TouchableOpacity>
        </>
      )}

      <TouchableOpacity style={styles.oauthBtn} onPress={() => Alert.alert('Google Sign-In', 'Google sign-in is not configured for this mode yet.')}>
        <AntDesign name="google" size={18} color="#111827" />
        <Text style={styles.oauthText}>Google</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.oauthBtn} onPress={() => Alert.alert('Apple Sign-In', 'Apple sign-in is not configured for this mode yet.')}>
        <Ionicons name="logo-apple" size={18} color="#111827" />
        <Text style={styles.oauthText}>Apple</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.guestBtn} onPress={onContinueGuest}>
        <Text style={styles.guestBtnText}>Continue as Guest</Text>
      </TouchableOpacity>
    </View>
  );
}

function ClerkSignInForm({ isDark, onContinueGuest }: { isDark: boolean; onContinueGuest: () => void }) {
  const { signIn, setActive, isLoaded } = require('@clerk/clerk-expo').useSignIn();
  const googleOAuth = require('@clerk/clerk-expo').useOAuth({ strategy: 'oauth_google' });
  const appleOAuth = require('@clerk/clerk-expo').useOAuth({ strategy: 'oauth_apple' });
  const router = useRouter();
  const [countryCode, setCountryCode] = useState('+1');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [awaitingCode, setAwaitingCode] = useState(false);
  const [showEmail, setShowEmail] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleRequestOtp() {
    if (!isLoaded) return;
    setLoading(true);
    try {
      await signIn.create({ strategy: 'phone_code', identifier: `${countryCode}${phone}` });
      setAwaitingCode(true);
    } catch (err: unknown) {
      Alert.alert('OTP Request Failed', (err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function handleVerifyOtp() {
    if (!isLoaded) return;
    setLoading(true);
    try {
      const result = await signIn.attemptFirstFactor({ strategy: 'phone_code', code });
      if (result.status === 'complete') {
        await setActive({ session: result.createdSessionId });
        router.replace('/' as any);
      }
    } catch (err: unknown) {
      Alert.alert('Verification Failed', (err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function handlePasswordSignIn() {
    if (!isLoaded) return;
    setLoading(true);
    try {
      const result = await signIn.create({ identifier: email, password });
      if (result.status === 'complete') {
        await setActive({ session: result.createdSessionId });
        router.replace('/' as any);
      }
    } catch (err: unknown) {
      Alert.alert('Sign In Failed', (err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function handleOAuth(provider: 'google' | 'apple') {
    setLoading(true);
    try {
      const start = provider === 'google' ? googleOAuth.startOAuthFlow : appleOAuth.startOAuthFlow;
      const result = await start();
      if (result.createdSessionId) {
        await setActive({ session: result.createdSessionId });
        router.replace('/' as any);
      }
    } catch (err: unknown) {
      Alert.alert('SSO Sign In Failed', (err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={[styles.card, { backgroundColor: isDark ? '#0f172a' : '#ffffff', borderColor: isDark ? '#334155' : '#e5e7eb' }]}>
      <Text style={[styles.title, { color: isDark ? '#f8fafc' : '#111827' }]}>Sign In</Text>

      <View style={styles.row}>
        <TextInput style={[styles.input, styles.countryInput]} value={countryCode} onChangeText={setCountryCode} />
        <TextInput style={[styles.input, styles.flexInput]} placeholder="Phone number" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
      </View>
      {awaitingCode && <TextInput style={styles.input} placeholder="Verification code" value={code} onChangeText={setCode} keyboardType="number-pad" />}
      <TouchableOpacity style={[styles.button, loading && styles.buttonDisabled]} onPress={awaitingCode ? handleVerifyOtp : handleRequestOtp} disabled={loading}>
        {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>{awaitingCode ? 'Verify Code' : 'Next'}</Text>}
      </TouchableOpacity>

      <View style={styles.dividerWrap}>
        <View style={styles.dividerLine} />
        <Text style={styles.dividerText}>OR</Text>
        <View style={styles.dividerLine} />
      </View>

      <TouchableOpacity style={styles.oauthBtn} onPress={() => setShowEmail((v) => !v)}>
        <Ionicons name="mail-outline" size={18} color="#111827" />
        <Text style={styles.oauthText}>Email</Text>
      </TouchableOpacity>

      {showEmail && (
        <>
          <TextInput style={styles.input} placeholder="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />
          <TextInput style={styles.input} placeholder="Password" value={password} onChangeText={setPassword} secureTextEntry />
          <TouchableOpacity style={[styles.button, loading && styles.buttonDisabled]} onPress={handlePasswordSignIn} disabled={loading}>
            {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Sign In</Text>}
          </TouchableOpacity>
        </>
      )}

      <TouchableOpacity style={styles.oauthBtn} onPress={() => handleOAuth('google')} disabled={loading}>
        <AntDesign name="google" size={18} color="#111827" />
        <Text style={styles.oauthText}>Google</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.oauthBtn} onPress={() => handleOAuth('apple')} disabled={loading}>
        <Ionicons name="logo-apple" size={18} color="#111827" />
        <Text style={styles.oauthText}>Apple</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.guestBtn} onPress={onContinueGuest}>
        <Text style={styles.guestBtnText}>Continue as Guest</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 24 },
  card: {
    borderRadius: 16,
    padding: 24,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 4,
    borderWidth: 1,
  },
  title: { fontSize: 28, fontWeight: '700', marginBottom: 12 },
  devNote: { fontSize: 13, textAlign: 'center', marginBottom: 20, lineHeight: 20 },
  input: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 10,
    padding: 14,
    fontSize: 15,
    marginBottom: 12,
    backgroundColor: '#f9fafb',
    color: '#111827',
  },
  row: { flexDirection: 'row', gap: 10 },
  countryInput: { width: 78 },
  flexInput: { flex: 1 },
  button: {
    backgroundColor: '#10b981',
    borderRadius: 10,
    padding: 15,
    alignItems: 'center',
    marginTop: 4,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  emailSwitchBtn: {
    marginTop: 8,
    marginBottom: 4,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#94a3b8',
    paddingVertical: 11,
    alignItems: 'center',
    backgroundColor: 'rgba(148,163,184,0.25)',
  },
  emailSwitchText: { color: '#e2e8f0', fontWeight: '700', fontSize: 14 },
  dividerWrap: { marginTop: 14, marginBottom: 10, flexDirection: 'row', alignItems: 'center', gap: 8 },
  dividerLine: { flex: 1, height: 1, backgroundColor: '#e5e7eb' },
  dividerText: { color: '#6b7280', fontSize: 12, fontWeight: '700' },
  oauthBtn: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
    backgroundColor: '#ffffff',
  },
  oauthText: { color: '#111827', fontSize: 15, fontWeight: '600' },
  createAccountBtn: {
    marginTop: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#9ca3af',
    paddingVertical: 12,
    alignItems: 'center',
    backgroundColor: '#9ca3af',
  },
  createAccountBtnText: { color: '#ffffff', fontWeight: '800', fontSize: 14 },
  guestBtn: {
    marginTop: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    paddingVertical: 11,
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.6)',
  },
  guestBtnText: { color: '#334155', fontWeight: '700', fontSize: 14 },
});