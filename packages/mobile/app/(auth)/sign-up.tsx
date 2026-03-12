import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Pressable,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useAppTheme } from '@/theme';
import { AntDesign, Ionicons } from '@expo/vector-icons';
import { isDevMode, setBearerToken, setGuestMode } from '@/lib/api';
import { useAppAuth } from '@/providers/AuthProvider';

type VerifyMethod = 'email_code' | 'phone_code';

export default function SignUpScreen() {
  const router = useRouter();
  const { signIn } = useAppAuth();
  const { isDark } = useAppTheme();

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [countryCode, setCountryCode] = useState('+1');
  const [phone, setPhone] = useState('');
  const [showEmail, setShowEmail] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [pendingVerify, setPendingVerify] = useState(false);
  const [verifyMethod, setVerifyMethod] = useState<VerifyMethod>('phone_code');
  const [verifyTargetLabel, setVerifyTargetLabel] = useState('');
  const [loading, setLoading] = useState(false);

  let signUp: ReturnType<typeof import('@clerk/clerk-expo').useSignUp>['signUp'] | null = null;
  let setActive: ReturnType<typeof import('@clerk/clerk-expo').useSignUp>['setActive'] | null = null;
  let isLoaded = false;
  let startGoogleFlow: (() => Promise<{ createdSessionId?: string }>) | null = null;
  let startAppleFlow: (() => Promise<{ createdSessionId?: string }>) | null = null;

  try {
    const clerk = require('@clerk/clerk-expo').useSignUp();
    signUp = clerk.signUp;
    setActive = clerk.setActive;
    isLoaded = clerk.isLoaded;

    const googleOAuth = require('@clerk/clerk-expo').useOAuth({ strategy: 'oauth_google' });
    const appleOAuth = require('@clerk/clerk-expo').useOAuth({ strategy: 'oauth_apple' });
    startGoogleFlow = googleOAuth.startOAuthFlow;
    startAppleFlow = appleOAuth.startOAuthFlow;
  } catch {
    // Clerk not loaded
  }

  const continueAsGuest = () => {
    setBearerToken(null);
    setGuestMode(true);
    router.replace('/(tabs)/index' as any);
  };

  async function handleSignUpPhoneOtp() {
    if (isDevMode) {
      signIn?.();
      router.replace('/' as any);
      return;
    }
    if (!isLoaded || !signUp) {
      Alert.alert('Error', 'Clerk is not configured. Set EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY.');
      return;
    }
    const fullPhone = `${countryCode}${phone}`.trim();
    if (!phone.trim()) {
      Alert.alert('Error', 'Phone number is required.');
      return;
    }

    setLoading(true);
    try {
      await signUp.create({ firstName, lastName, phoneNumber: fullPhone });
      await signUp.preparePhoneNumberVerification({ strategy: 'phone_code' });
      setVerifyMethod('phone_code');
      setVerifyTargetLabel(fullPhone);
      setPendingVerify(true);
    } catch (err: unknown) {
      Alert.alert('Sign Up Failed', (err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function handleSignUpEmail() {
    if (isDevMode) {
      signIn?.();
      router.replace('/' as any);
      return;
    }
    if (!isLoaded || !signUp) {
      Alert.alert('Error', 'Clerk is not configured. Set EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY.');
      return;
    }
    if (!email.trim() || !password.trim()) {
      Alert.alert('Error', 'Email and password are required.');
      return;
    }

    setLoading(true);
    try {
      await signUp.create({ firstName, lastName, emailAddress: email.trim(), password });
      await signUp.prepareEmailAddressVerification({ strategy: 'email_code' });
      setVerifyMethod('email_code');
      setVerifyTargetLabel(email.trim());
      setPendingVerify(true);
    } catch (err: unknown) {
      Alert.alert('Sign Up Failed', (err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function handleVerify() {
    if (!isLoaded || !signUp || !setActive) return;
    setLoading(true);
    try {
      const result =
        verifyMethod === 'email_code'
          ? await signUp.attemptEmailAddressVerification({ code })
          : await signUp.attemptPhoneNumberVerification({ code });

      if (result.status === 'complete') {
        await setActive({ session: result.createdSessionId });
        router.replace('/' as any);
      } else {
        Alert.alert('Verification incomplete', JSON.stringify(result.status));
      }
    } catch (err: unknown) {
      Alert.alert('Verification Failed', (err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function handleOAuth(provider: 'google' | 'apple') {
    if (isDevMode) {
      signIn?.();
      router.replace('/' as any);
      return;
    }
    if (!isLoaded || !setActive) {
      Alert.alert('Error', 'Clerk is not configured.');
      return;
    }

    const startFlow = provider === 'google' ? startGoogleFlow : startAppleFlow;
    if (!startFlow) {
      Alert.alert('Unavailable', `${provider === 'google' ? 'Google' : 'Apple'} SSO is not configured.`);
      return;
    }

    setLoading(true);
    try {
      const result = await startFlow();
      if (result.createdSessionId) {
        await setActive({ session: result.createdSessionId });
        router.replace('/' as any);
      }
    } catch (err: unknown) {
      Alert.alert('SSO Sign Up Failed', (err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: isDark ? '#0b1220' : '#f3f4f6' }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <Pressable style={StyleSheet.absoluteFill} onPress={continueAsGuest} />
      <View style={[styles.card, { backgroundColor: isDark ? 'rgba(255,255,255,0.84)' : 'rgba(30,41,59,0.8)', borderColor: isDark ? '#d1d5db' : '#94a3b8' }]}> 
        {pendingVerify ? (
          <>
            <Text style={[styles.title, { color: isDark ? '#111827' : '#f8fafc' }]}>Verify {verifyMethod === 'email_code' ? 'Email' : 'Phone'}</Text>
            <Text style={[styles.subtitle, { color: isDark ? '#334155' : '#cbd5e1' }]}>Enter the code sent to {verifyTargetLabel}</Text>
            <TextInput
              style={styles.input}
              placeholder="Verification code"
              value={code}
              onChangeText={setCode}
              keyboardType="number-pad"
            />
            <TouchableOpacity style={[styles.button, loading && styles.buttonDisabled]} onPress={handleVerify} disabled={loading}>
              {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Verify</Text>}
            </TouchableOpacity>
          </>
        ) : (
          <>
            <Text style={[styles.title, { color: isDark ? '#111827' : '#f8fafc' }]}>Create Account</Text>

            <View style={styles.row}>
              <TextInput style={[styles.input, styles.halfInput]} placeholder="First name" value={firstName} onChangeText={setFirstName} />
              <TextInput style={[styles.input, styles.halfInput]} placeholder="Last name" value={lastName} onChangeText={setLastName} />
            </View>

            <View style={styles.row}>
              <TextInput style={[styles.input, styles.countryInput]} value={countryCode} onChangeText={setCountryCode} />
              <TextInput style={[styles.input, styles.flexInput]} placeholder="Phone number" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
            </View>

            <TouchableOpacity style={[styles.button, loading && styles.buttonDisabled]} onPress={handleSignUpPhoneOtp} disabled={loading}>
              {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Continue with Phone OTP</Text>}
            </TouchableOpacity>

            <TouchableOpacity style={styles.emailSwitchBtn} onPress={() => setShowEmail((v) => !v)}>
              <Text style={styles.emailSwitchText}>Sign up with Email</Text>
            </TouchableOpacity>

            {showEmail && (
              <>
                <TextInput style={styles.input} placeholder="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />
                <TextInput style={styles.input} placeholder="Password" value={password} onChangeText={setPassword} secureTextEntry />
                <TouchableOpacity style={[styles.button, loading && styles.buttonDisabled]} onPress={handleSignUpEmail} disabled={loading}>
                  {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Create Account</Text>}
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

            <View style={styles.dividerWrap}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>ALREADY HAVE AN ACCOUNT?</Text>
              <View style={styles.dividerLine} />
            </View>
            <TouchableOpacity onPress={() => router.replace('/(auth)/sign-in' as any)} style={styles.signInCtaBtn}>
              <Text style={styles.signInCtaText}>Sign In</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.guestBtn} onPress={continueAsGuest}>
              <Text style={styles.guestBtnText}>Continue as Guest</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </KeyboardAvoidingView>
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
  title: { fontSize: 28, fontWeight: '700', marginBottom: 8 },
  subtitle: { marginTop: 6, marginBottom: 18, fontSize: 14 },
  row: { flexDirection: 'row', gap: 10 },
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
  halfInput: { flex: 1 },
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
  oauthText: { color: '#111827', fontSize: 15, fontWeight: '600' },
  signInCtaBtn: {
    marginTop: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#9ca3af',
    paddingVertical: 11,
    alignItems: 'center',
    backgroundColor: '#9ca3af',
  },
  signInCtaText: { color: '#ffffff', fontWeight: '800', fontSize: 14 },
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