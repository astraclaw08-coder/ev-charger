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
} from 'react-native';
import { Link, useRouter } from 'expo-router';
import { AntDesign, Ionicons } from '@expo/vector-icons';
import { isDevMode, isKeycloakMode } from '@/lib/api';
import { useAppAuth } from '@/providers/AuthProvider';
import { useAppTheme } from '@/theme';

export default function SignInScreen() {
  const router = useRouter();
  const { signIn } = useAppAuth();
  const { isDark } = useAppTheme();

  if (isKeycloakMode) {
    return (
      <KeyboardAvoidingView
        style={[styles.container, { backgroundColor: isDark ? '#020617' : '#ecfdf5' }]}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <BackgroundDecor isDark={isDark} />
        <KeycloakSignInForm isDark={isDark} />
      </KeyboardAvoidingView>
    );
  }

  // ── Dev mode: skip auth ───────────────────────────────────────────────────
  if (isDevMode) {
    return (
      <View style={[styles.container, { backgroundColor: isDark ? '#020617' : '#ecfdf5' }]}>
        <BackgroundDecor isDark={isDark} />
        <View style={[styles.card, styles.cardGlass, { backgroundColor: isDark ? 'rgba(15,23,42,0.78)' : 'rgba(255,255,255,0.78)', borderColor: isDark ? '#334155' : '#d1fae5' }]}>
          <Text style={styles.title}>EV Charger</Text>
          <Text style={styles.subtitle}>Dev Mode — No Clerk Key Set</Text>
          <Text style={styles.devNote}>
            Authenticated automatically as{'\n'}test driver (user-test-driver-001)
          </Text>
          <TouchableOpacity
            style={styles.button}
            onPress={() => {
              signIn?.();
              router.replace('/' as any);
            }}
          >
            <Text style={styles.buttonText}>Continue to App</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: isDark ? '#020617' : '#ecfdf5' }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <BackgroundDecor isDark={isDark} />
      <ClerkSignInForm isDark={isDark} />
    </KeyboardAvoidingView>
  );
}

export function KeycloakSignInForm({ isDark }: { isDark: boolean }) {
  const { loginWithPassword, loading, error } = useAppAuth();
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  async function handleSignIn() {
    const ok = await loginWithPassword?.(username, password);
    if (ok) router.replace('/' as any);
  }

  return (
    <View style={[styles.card, styles.cardGlass, { backgroundColor: isDark ? 'rgba(15,23,42,0.78)' : 'rgba(255,255,255,0.78)', borderColor: isDark ? '#334155' : '#d1fae5' }] }>
      <Text style={[styles.title, { color: isDark ? '#f8fafc' : '#111827' }]}>Sign In</Text>
      <Text style={[styles.subtitle, { color: isDark ? '#94a3b8' : '#6b7280' }]}>Username/password</Text>
      <TextInput
        style={styles.input}
        placeholder="Username or Email"
        value={username}
        onChangeText={setUsername}
        autoCapitalize="none"
      />
      <TextInput
        style={styles.input}
        placeholder="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
      />
      {!!error && <Text style={{ color: '#dc2626', marginBottom: 8 }}>{error}</Text>}
      <TouchableOpacity
        style={[styles.button, loading && styles.buttonDisabled]}
        onPress={handleSignIn}
        disabled={loading}
      >
        {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Sign In</Text>}
      </TouchableOpacity>
      <Link href="/(auth)/sign-up" style={styles.link}>
        Don't have an account? Create account
      </Link>
    </View>
  );
}

// ── Clerk sign-in inner component (used when Clerk is configured) ─────────────
export function ClerkSignInForm({ isDark }: { isDark: boolean }) {
  const { signIn, setActive, isLoaded } = require('@clerk/clerk-expo').useSignIn();
  const googleOAuth = require('@clerk/clerk-expo').useOAuth({ strategy: 'oauth_google' });
  const appleOAuth = require('@clerk/clerk-expo').useOAuth({ strategy: 'oauth_apple' });
  const router = useRouter();
  const [method, setMethod] = useState<'password' | 'otp'>('password');
  const [otpChannel, setOtpChannel] = useState<'email' | 'phone'>('phone');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [awaitingCode, setAwaitingCode] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handlePasswordSignIn() {
    if (!isLoaded) return;
    setLoading(true);
    try {
      const result = await signIn.create({ identifier, password });
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

  async function handleRequestOtp() {
    if (!isLoaded) return;
    setLoading(true);
    try {
      await signIn.create({
        strategy: otpChannel === 'phone' ? 'phone_code' : 'email_code',
        identifier,
      });
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
      const result = await signIn.attemptFirstFactor({
        strategy: otpChannel === 'phone' ? 'phone_code' : 'email_code',
        code,
      });
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
    <View style={[styles.card, styles.cardGlass, { backgroundColor: isDark ? 'rgba(15,23,42,0.78)' : 'rgba(255,255,255,0.78)', borderColor: isDark ? '#334155' : '#d1fae5' }] }>
      <Text style={[styles.title, { color: isDark ? '#f8fafc' : '#111827' }]}>Sign In</Text>
      <Text style={[styles.subtitle, { color: isDark ? '#94a3b8' : '#6b7280' }]}>Use password, OTP, or SSO.</Text>

      <View style={styles.methodSwitch}>
        <TouchableOpacity style={[styles.methodBtn, method === 'password' && styles.methodBtnActive]} onPress={() => { setMethod('password'); setAwaitingCode(false); }}>
          <Text style={[styles.methodText, method === 'password' && styles.methodTextActive]}>Password</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.methodBtn, method === 'otp' && styles.methodBtnActive]} onPress={() => setMethod('otp')}>
          <Text style={[styles.methodText, method === 'otp' && styles.methodTextActive]}>Phone OTP</Text>
        </TouchableOpacity>
      </View>

      {method === 'otp' && (
        <View style={styles.methodSwitch}>
          <TouchableOpacity style={[styles.methodBtn, otpChannel === 'phone' && styles.methodBtnActive]} onPress={() => setOtpChannel('phone')}>
            <Text style={[styles.methodText, otpChannel === 'phone' && styles.methodTextActive]}>Phone</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.methodBtn, otpChannel === 'email' && styles.methodBtnActive]} onPress={() => setOtpChannel('email')}>
            <Text style={[styles.methodText, otpChannel === 'email' && styles.methodTextActive]}>Email OTP</Text>
          </TouchableOpacity>
        </View>
      )}

      <TextInput
        style={styles.input}
        placeholder={method === 'otp' ? (otpChannel === 'phone' ? 'Phone (+1...)' : 'Email') : 'Email'}
        value={identifier}
        onChangeText={setIdentifier}
        autoCapitalize="none"
        keyboardType={method === 'otp' && otpChannel === 'phone' ? 'phone-pad' : 'email-address'}
      />

      {method === 'password' ? (
        <>
          <TextInput style={styles.input} placeholder="Password" value={password} onChangeText={setPassword} secureTextEntry />
          <TouchableOpacity style={[styles.button, loading && styles.buttonDisabled]} onPress={handlePasswordSignIn} disabled={loading}>
            {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Sign In</Text>}
          </TouchableOpacity>
        </>
      ) : (
        <>
          {awaitingCode && (
            <TextInput style={styles.input} placeholder="Verification code" value={code} onChangeText={setCode} keyboardType="number-pad" />
          )}
          <TouchableOpacity style={[styles.button, loading && styles.buttonDisabled]} onPress={awaitingCode ? handleVerifyOtp : handleRequestOtp} disabled={loading}>
            {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>{awaitingCode ? 'Verify Code' : 'Send OTP'}</Text>}
          </TouchableOpacity>
        </>
      )}

      <View style={styles.dividerWrap}>
        <View style={styles.dividerLine} />
        <Text style={styles.dividerText}>OR</Text>
        <View style={styles.dividerLine} />
      </View>

      <TouchableOpacity style={styles.oauthBtn} onPress={() => handleOAuth('google')} disabled={loading}>
        <AntDesign name="google" size={18} color="#111827" />
        <Text style={styles.oauthText}>Continue with Google</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.oauthBtn} onPress={() => handleOAuth('apple')} disabled={loading}>
        <Ionicons name="logo-apple" size={18} color="#111827" />
        <Text style={styles.oauthText}>Continue with Apple</Text>
      </TouchableOpacity>

      <Link href="/(auth)/sign-up" style={styles.link}>
        Don't have an account? Create account
      </Link>
    </View>
  );
}

function BackgroundDecor({ isDark }: { isDark: boolean }) {
  return (
    <>
      <View style={[styles.blob, styles.blobTop, { backgroundColor: isDark ? 'rgba(16,185,129,0.18)' : 'rgba(16,185,129,0.22)' }]} />
      <View style={[styles.blob, styles.blobBottom, { backgroundColor: isDark ? 'rgba(59,130,246,0.14)' : 'rgba(59,130,246,0.18)' }]} />
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f0fdf4',
    justifyContent: 'center',
    padding: 24,
  },
  blob: {
    position: 'absolute',
    borderRadius: 999,
  },
  blobTop: {
    width: 220,
    height: 220,
    top: -60,
    right: -40,
  },
  blobBottom: {
    width: 260,
    height: 260,
    bottom: -90,
    left: -70,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 28,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 4,
    borderWidth: 1,
  },
  cardGlass: {
    // visual translucency handled by rgba background colors assigned at render time
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: '#6b7280',
    marginBottom: 24,
  },
  devNote: {
    fontSize: 13,
    color: '#6b7280',
    textAlign: 'center',
    marginBottom: 20,
    lineHeight: 20,
  },
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
  button: {
    backgroundColor: '#10b981',
    borderRadius: 10,
    padding: 15,
    alignItems: 'center',
    marginTop: 4,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  methodSwitch: {
    flexDirection: 'row',
    backgroundColor: '#f3f4f6',
    borderRadius: 10,
    padding: 4,
    marginBottom: 12,
  },
  methodBtn: {
    flex: 1,
    borderRadius: 8,
    paddingVertical: 8,
    alignItems: 'center',
  },
  methodBtnActive: {
    backgroundColor: '#10b981',
  },
  methodText: {
    color: '#6b7280',
    fontWeight: '600',
  },
  methodTextActive: {
    color: '#ffffff',
  },
  dividerWrap: {
    marginTop: 14,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
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
  oauthText: {
    color: '#111827',
    fontSize: 15,
    fontWeight: '600',
  },
  link: {
    marginTop: 16,
    textAlign: 'center',
    color: '#10b981',
    fontSize: 14,
  },
});
