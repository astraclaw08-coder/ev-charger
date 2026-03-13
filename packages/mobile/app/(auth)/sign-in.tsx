import React, { useEffect, useRef, useState } from 'react';
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

function normalizePhoneInput(value: string) {
  const trimmed = value.trim();
  const hasPlusPrefix = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');

  if (hasPlusPrefix) {
    return `+${digits.slice(0, 15)}`;
  }

  const ten = digits.slice(0, 10);
  if (ten.length <= 3) return ten;
  if (ten.length <= 6) return `${ten.slice(0, 3)}-${ten.slice(3)}`;
  return `${ten.slice(0, 3)}-${ten.slice(3, 6)}-${ten.slice(6)}`;
}

function toPhoneIdentifier(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('+')) {
    const digits = trimmed.slice(1).replace(/\D/g, '');
    if (digits.length < 10) return null;
    return `+${digits}`;
  }

  const digits = trimmed.replace(/\D/g, '');
  if (digits.length !== 10) return null;
  return `+1${digits}`;
}

function formatPhoneForDisplay(identifier: string) {
  const trimmed = identifier.trim();
  if (!trimmed) return trimmed;

  if (trimmed.startsWith('+1')) {
    const digits = trimmed.slice(2).replace(/\D/g, '').slice(0, 10);
    if (digits.length === 10) {
      return `+1 ${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
    }
  }

  if (trimmed.startsWith('+')) {
    const digits = trimmed.slice(1).replace(/\D/g, '');
    if (digits.length > 3) {
      return `+${digits.slice(0, digits.length - 10)} ${digits.slice(-10, -7)}-${digits.slice(-7, -4)}-${digits.slice(-4)}`;
    }
  }

  return trimmed;
}

export default function SignInScreen() {
  const router = useRouter();
  const { signIn, continueAsGuest: continueAsGuestFromAuth } = useAppAuth();
  const { isDark } = useAppTheme();

  const continueAsGuest = () => {
    setBearerToken(null);
    setGuestMode(true);

    if (continueAsGuestFromAuth) {
      continueAsGuestFromAuth();
      return;
    }

    router.replace('/(tabs)' as any);
  };

  if (isKeycloakMode) {
    return (
      <KeyboardAvoidingView
        style={[styles.container, { backgroundColor: isDark ? '#0b1220' : '#f3f4f6' }]}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <KeycloakSignInForm isDark={isDark} onContinueGuest={continueAsGuest} />
      </KeyboardAvoidingView>
    );
  }

  if (isDevMode) {
    return (
      <View style={[styles.container, { backgroundColor: isDark ? '#0b1220' : '#f3f4f6' }]}> 
        <View style={styles.card}>
          <Text style={[styles.title, { color: isDark ? '#f8fafc' : '#111827' }]}>Sign In</Text>
          <Text style={[styles.devNote, { color: isDark ? '#cbd5e1' : '#334155' }]}>Dev Mode — No Clerk Key Set</Text>
          <TouchableOpacity
            style={styles.button}
            onPress={() => {
              signIn?.();
              router.replace('/(tabs)' as any);
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
      <ClerkSignInForm isDark={isDark} onContinueGuest={continueAsGuest} />
    </KeyboardAvoidingView>
  );
}

function KeycloakSignInForm({ isDark, onContinueGuest }: { isDark: boolean; onContinueGuest: () => void }) {
  const { loginWithPassword, loading, error } = useAppAuth();
  const router = useRouter();
  const [phone, setPhone] = useState('');
  const [showEmail, setShowEmail] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const usernameInputRef = useRef<TextInput>(null);
  const [awaitingCode, setAwaitingCode] = useState(false);
  const [code, setCode] = useState('');
  const [otpTarget, setOtpTarget] = useState('');

  async function handleSignIn() {
    const ok = await loginWithPassword?.(username, password);
    if (ok) router.replace('/(tabs)' as any);
  }

  function openEmailLogin() {
    setShowEmail(true);
    setTimeout(() => usernameInputRef.current?.focus(), 50);
  }

  function handleNextOtp() {
    const identifier = toPhoneIdentifier(phone);
    if (!identifier) {
      Alert.alert('Invalid phone number', 'Enter a complete phone number (example: 123-456-7890).');
      return;
    }
    setOtpTarget(identifier);
    setAwaitingCode(true);
  }

  useEffect(() => {
    if (!awaitingCode || code.length !== 5) return;
    Alert.alert('OTP', 'OTP verification is not enabled for this sign-in mode yet.');
  }, [awaitingCode, code]);

  if (awaitingCode) {
    return (
      <View style={styles.card}>
        <TouchableOpacity
          style={[
            styles.backBtn,
            {
              backgroundColor: isDark ? '#111827' : '#ffffff',
              borderColor: isDark ? '#334155' : '#d1d5db',
            },
          ]}
          onPress={() => { setAwaitingCode(false); setCode(''); }}
        >
          <Ionicons name="arrow-back" size={18} color={isDark ? '#f8fafc' : '#111827'} />
        </TouchableOpacity>
        <Text style={[styles.title, styles.otpTitle, { color: isDark ? '#f8fafc' : '#111827' }]}>Enter Your Code</Text>
        <Text style={[styles.helperText, styles.otpHelperText, { marginBottom: 12 }]}>Code was sent to {formatPhoneForDisplay(otpTarget)}</Text>
        <Pressable style={styles.codeDotsWrap} onPress={() => {}}>
          {Array.from({ length: 5 }).map((_, idx) => (
            <View key={`kc-dot-${idx}`} style={styles.codeDot}>
              <Text style={styles.codeDotText}>{code[idx] ? code[idx] : '•'}</Text>
            </View>
          ))}
        </Pressable>
        <TextInput
          style={styles.hiddenCodeInput}
          value={code}
          onChangeText={(value) => setCode(value.replace(/\D/g, '').slice(0, 5))}
          keyboardType="number-pad"
          maxLength={5}
          autoFocus
        />
        <TouchableOpacity style={styles.oauthBtn} onPress={() => Alert.alert('OTP', `A new OTP would be sent to ${formatPhoneForDisplay(otpTarget)}`)}>
          <Text style={styles.oauthText}>Request a new OTP</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <Text style={[styles.title, { color: isDark ? '#f8fafc' : '#111827' }]}>Sign In</Text>

      <TextInput
        style={[styles.input, styles.centerText]}
        placeholder="123-456-7890"
        value={phone}
        onChangeText={(value) => setPhone(normalizePhoneInput(value))}
        keyboardType="phone-pad"
      />
      <Text style={[styles.helperText, styles.centerText]}>A code will be sent to your phone for verification</Text>

      <TouchableOpacity style={styles.button} onPress={handleNextOtp}>
        <Text style={styles.buttonText}>Next</Text>
      </TouchableOpacity>

      <View style={styles.dividerWrap}>
        <View style={styles.dividerLine} />
        <Text style={styles.dividerText}>OR</Text>
        <View style={styles.dividerLine} />
      </View>

      <TouchableOpacity testID="keycloak-email-toggle" style={styles.oauthBtn} onPress={openEmailLogin}>
        <Ionicons name="mail-outline" size={18} color="#111827" />
        <Text style={styles.oauthText}>Email</Text>
      </TouchableOpacity>

      {showEmail && (
        <>
          <TextInput
            ref={usernameInputRef}
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
          <TouchableOpacity style={[styles.button, styles.emailSignInButton, loading && styles.buttonDisabled]} onPress={handleSignIn} disabled={loading}>
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
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [awaitingCode, setAwaitingCode] = useState(false);
  const [otpTarget, setOtpTarget] = useState('');
  const [showEmail, setShowEmail] = useState(false);
  const [loading, setLoading] = useState(false);
  const emailInputRef = useRef<TextInput>(null);

  async function handleRequestOtp() {
    if (!isLoaded) return;
    const identifier = toPhoneIdentifier(phone);
    if (!identifier) {
      Alert.alert('Invalid phone number', 'Enter a complete phone number (example: 123-456-7890).');
      return;
    }

    setLoading(true);
    try {
      await signIn.create({ strategy: 'phone_code', identifier });
      setOtpTarget(identifier);
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
        router.replace('/(tabs)' as any);
      }
    } catch (err: unknown) {
      Alert.alert('Verification Failed', (err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function handleResendOtp() {
    if (!isLoaded || !otpTarget) return;
    setLoading(true);
    try {
      await signIn.create({ strategy: 'phone_code', identifier: otpTarget });
      Alert.alert('OTP sent', `A new OTP was sent to ${formatPhoneForDisplay(otpTarget)}`);
    } catch (err: unknown) {
      Alert.alert('OTP Request Failed', (err as Error).message);
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
        router.replace('/(tabs)' as any);
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
        router.replace('/(tabs)' as any);
      }
    } catch (err: unknown) {
      Alert.alert('SSO Sign In Failed', (err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function openEmailLogin() {
    setShowEmail(true);
    setTimeout(() => emailInputRef.current?.focus(), 50);
  }

  useEffect(() => {
    if (!awaitingCode || code.length !== 5 || loading) return;
    handleVerifyOtp();
  }, [awaitingCode, code]);

  if (awaitingCode) {
    return (
      <View style={styles.card}>
        <TouchableOpacity
          style={[
            styles.backBtn,
            {
              backgroundColor: isDark ? '#111827' : '#ffffff',
              borderColor: isDark ? '#334155' : '#d1d5db',
            },
          ]}
          onPress={() => { setAwaitingCode(false); setCode(''); }}
        >
          <Ionicons name="arrow-back" size={18} color={isDark ? '#f8fafc' : '#111827'} />
        </TouchableOpacity>
        <Text style={[styles.title, styles.otpTitle, { color: isDark ? '#f8fafc' : '#111827' }]}>Enter Your Code</Text>
        <Text style={[styles.helperText, styles.otpHelperText, { marginBottom: 12 }]}>Code was sent to {formatPhoneForDisplay(otpTarget)}</Text>
        <Pressable style={styles.codeDotsWrap}>
          {Array.from({ length: 5 }).map((_, idx) => (
            <View key={`otp-dot-${idx}`} style={styles.codeDot}>
              <Text style={styles.codeDotText}>{code[idx] ? code[idx] : '•'}</Text>
            </View>
          ))}
        </Pressable>
        <TextInput
          style={styles.hiddenCodeInput}
          value={code}
          onChangeText={(value) => setCode(value.replace(/\D/g, '').slice(0, 5))}
          keyboardType="number-pad"
          maxLength={5}
          autoFocus
        />
        {loading ? <ActivityIndicator color="#10b981" style={{ marginBottom: 10 }} /> : null}
        <TouchableOpacity style={styles.oauthBtn} onPress={handleResendOtp} disabled={loading}>
          <Text style={styles.oauthText}>Request a new OTP</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <Text style={[styles.title, { color: isDark ? '#f8fafc' : '#111827' }]}>Sign In</Text>

      <TextInput
        style={[styles.input, styles.centerText]}
        placeholder="123-456-7890"
        value={phone}
        onChangeText={(value) => setPhone(normalizePhoneInput(value))}
        keyboardType="phone-pad"
      />
      <Text style={[styles.helperText, styles.centerText]}>A code will be sent to your phone for verification</Text>
      <TouchableOpacity style={[styles.button, loading && styles.buttonDisabled]} onPress={handleRequestOtp} disabled={loading}>
        {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Next</Text>}
      </TouchableOpacity>

      <View style={styles.dividerWrap}>
        <View style={styles.dividerLine} />
        <Text style={styles.dividerText}>OR</Text>
        <View style={styles.dividerLine} />
      </View>

      <TouchableOpacity testID="clerk-email-toggle" style={styles.oauthBtn} onPress={openEmailLogin}>
        <Ionicons name="mail-outline" size={18} color="#111827" />
        <Text style={styles.oauthText}>Email</Text>
      </TouchableOpacity>

      {showEmail && (
        <>
          <TextInput ref={emailInputRef} style={styles.input} placeholder="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />
          <TextInput style={styles.input} placeholder="Password" value={password} onChangeText={setPassword} secureTextEntry />
          <TouchableOpacity style={[styles.button, styles.emailSignInButton, loading && styles.buttonDisabled]} onPress={handlePasswordSignIn} disabled={loading}>
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
    width: '100%',
    maxWidth: 420,
    alignSelf: 'center',
    paddingVertical: 8,
  },
  title: { fontSize: 28, fontWeight: '700', marginBottom: 12, textAlign: 'center' },
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
  emailSignInButton: { marginBottom: 10 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  helperText: { color: '#64748b', fontSize: 12, marginTop: -4, marginBottom: 12 },
  centerText: { textAlign: 'center' },
  otpTitle: { textAlign: 'center' },
  otpHelperText: { textAlign: 'center' },
  backBtn: {
    marginBottom: 10,
    width: 34,
    height: 34,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  codeDotsWrap: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 14 },
  codeDot: {
    width: 52,
    height: 52,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f8fafc',
  },
  codeDotText: { fontSize: 20, fontWeight: '700', color: '#111827' },
  hiddenCodeInput: {
    position: 'absolute',
    opacity: 0,
    width: 1,
    height: 1,
  },
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