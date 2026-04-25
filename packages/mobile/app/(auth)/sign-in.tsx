import React, { useCallback, useEffect, useRef, useState } from 'react';
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
  Image,
  Linking,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { AntDesign, Ionicons } from '@expo/vector-icons';
import { api, setBearerToken, setGuestMode } from '@/lib/api';
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
  if (ten.length <= 6) return `(${ten.slice(0, 3)}) ${ten.slice(3)}`;
  return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
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

function BrandHeader({ isDark }: { isDark: boolean }) {
  return (
    <View style={styles.brandWrap}>
      <Image
        source={isDark ? require('../../assets/branding/lumeo_logo_darktheme.png') : require('../../assets/branding/lumeo_logo_transparent.png')}
        style={styles.brandLogo}
        resizeMode="contain"
      />
      <Text style={[styles.signInHeader, { color: isDark ? '#f1f5f9' : '#111827' }]}>Sign in / Sign up</Text>
    </View>
  );
}

export default function SignInScreen() {
  const router = useRouter();
  const { isDark } = useAppTheme();
  // ?expired=1 is set by AuthProvider's _authExpiredHandler when an in-flight
  // protected call 401s mid-session. Used to render a one-shot banner above
  // the sign-in form so the user understands why they landed here.
  const params = useLocalSearchParams<{ expired?: string }>();
  const sessionExpired = params?.expired === '1';

  const continueAsGuest = () => {
    setBearerToken(null);
    setGuestMode(true);
    router.replace('/(tabs)' as any);
  };

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: isDark ? '#0b1220' : 'transparent' }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      {sessionExpired && (
        <View style={[styles.expiredBanner, { backgroundColor: isDark ? '#7c2d12' : '#fef3c7', borderColor: isDark ? '#b45309' : '#f59e0b' }]}>
          <Text style={[styles.expiredBannerText, { color: isDark ? '#fed7aa' : '#78350f' }]}>
            Session expired, please sign in again.
          </Text>
        </View>
      )}
      <KeycloakSignInForm isDark={isDark} onContinueGuest={continueAsGuest} />
    </KeyboardAvoidingView>
  );
}

function KeycloakSignInForm({ isDark, onContinueGuest }: { isDark: boolean; onContinueGuest: () => void }) {
  const { loginWithPassword, loginWithOtp, loading: authLoading, error: authError } = useAppAuth();
  const router = useRouter();
  const [phone, setPhone] = useState('');
  const [showEmail, setShowEmail] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const usernameInputRef = useRef<TextInput>(null);
  const codeInputRef = useRef<TextInput>(null);

  // OTP state
  const [awaitingCode, setAwaitingCode] = useState(false);
  const [code, setCode] = useState('');
  const [otpTarget, setOtpTarget] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [otpLoading, setOtpLoading] = useState(false);
  const [otpError, setOtpError] = useState('');
  const [resendCooldown, setResendCooldown] = useState(0);
  const [verifying, setVerifying] = useState(false);
  const resendTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingReauthChecked = useRef(false);

  const [consentChecked, setConsentChecked] = useState(false);
  const loading = authLoading || otpLoading || verifying;

  // Check for pending OTP re-auth (session expired, code already sent)
  useEffect(() => {
    if (pendingReauthChecked.current) return;
    pendingReauthChecked.current = true;
    (async () => {
      try {
        const SecureStore = require('expo-secure-store');
        const raw = await SecureStore.getItemAsync('mobile.pending-otp-reauth.v1');
        if (!raw) return;
        await SecureStore.deleteItemAsync('mobile.pending-otp-reauth.v1').catch(() => {});
        const pending = JSON.parse(raw);
        if (pending?.phone && pending?.challengeId) {
          setChallengeId(pending.challengeId);
          setOtpTarget(pending.phone);
          setResendCooldown(pending.resendCooldown ?? 0);
          setConsentChecked(true);
          setAwaitingCode(true);
          setTimeout(() => codeInputRef.current?.focus(), 200);
        }
      } catch {
        // ignore
      }
    })();
  }, []);

  // Resend cooldown timer
  useEffect(() => {
    if (resendCooldown <= 0) {
      if (resendTimerRef.current) clearInterval(resendTimerRef.current);
      return;
    }
    resendTimerRef.current = setInterval(() => {
      setResendCooldown((prev) => {
        if (prev <= 1) {
          if (resendTimerRef.current) clearInterval(resendTimerRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => { if (resendTimerRef.current) clearInterval(resendTimerRef.current); };
  }, [resendCooldown > 0]);

  async function handleSignIn() {
    if (!consentChecked) {
      Alert.alert('Consent Required', 'Please agree to the Terms of Service and Privacy Policy to continue.');
      return;
    }
    const ok = await loginWithPassword?.(username, password);
    if (ok) {
      try {
        await api.consent.accept('1.0', '1.0');
      } catch {
        // Non-blocking
      }
      router.replace('/(tabs)' as any);
    }
  }

  function openEmailLogin() {
    setShowEmail(true);
    setTimeout(() => usernameInputRef.current?.focus(), 50);
  }

  const handleNextOtp = useCallback(async () => {
    const identifier = toPhoneIdentifier(phone);
    if (!identifier) {
      Alert.alert('Invalid phone number', 'Enter a complete phone number (example: (123) 456-7890).');
      return;
    }

    setOtpLoading(true);
    setOtpError('');
    try {
      const result = await api.auth.otpSend(identifier);
      setChallengeId(result.challengeId);
      setOtpTarget(identifier);
      setResendCooldown(result.resendAvailableInSeconds);
      setAwaitingCode(true);
      setCode('');
      setTimeout(() => codeInputRef.current?.focus(), 100);
    } catch (err: any) {
      const msg = err?.message || 'Failed to send verification code';
      setOtpError(msg);
    } finally {
      setOtpLoading(false);
    }
  }, [phone]);

  const handleVerifyCode = useCallback(async (otpCode: string) => {
    if (otpCode.length !== 6 || !challengeId) return;

    setVerifying(true);
    setOtpError('');
    try {
      const result = await api.auth.otpVerify(challengeId, otpCode);
      const ok = await loginWithOtp?.(result.accessToken, result.expiresIn, otpTarget);
      if (ok) {
        // Record consent acceptance
        try {
          await api.consent.accept('1.0', '1.0');
        } catch {
          // Non-blocking — consent will be re-prompted if needed
        }
        router.replace('/(tabs)' as any);
      } else {
        setOtpError('Sign-in failed. Please try again.');
      }
    } catch (err: any) {
      const msg = err?.message || 'Verification failed';
      const remaining = err?.remainingAttempts;
      setOtpError(remaining != null ? `${msg} (${remaining} attempt${remaining !== 1 ? 's' : ''} left)` : msg);
      setCode('');
      setTimeout(() => codeInputRef.current?.focus(), 100);
    } finally {
      setVerifying(false);
    }
  }, [challengeId, loginWithOtp, router]);

  const handleResend = useCallback(async () => {
    if (resendCooldown > 0 || !challengeId || !otpTarget) return;

    setOtpLoading(true);
    setOtpError('');
    try {
      const result = await api.auth.otpResend(challengeId, otpTarget);
      setChallengeId(result.challengeId);
      setResendCooldown(result.resendAvailableInSeconds);
      setCode('');
    } catch (err: any) {
      const msg = err?.message || 'Failed to resend code';
      setOtpError(msg);
    } finally {
      setOtpLoading(false);
    }
  }, [challengeId, otpTarget, resendCooldown]);

  function handleCodeChange(value: string) {
    const digits = value.replace(/\D/g, '').slice(0, 6);
    setCode(digits);
    if (digits.length === 6) {
      handleVerifyCode(digits);
    }
  }

  function handleBackFromOtp() {
    setAwaitingCode(false);
    setCode('');
    setChallengeId('');
    setOtpError('');
    setResendCooldown(0);
  }

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
          onPress={handleBackFromOtp}
        >
          <Ionicons name="arrow-back" size={18} color={isDark ? '#f8fafc' : '#111827'} />
        </TouchableOpacity>
        <BrandHeader isDark={isDark} />
        <Text style={[styles.helperText, styles.otpHelperText, { marginBottom: 12 }]}>
          Code was sent to {formatPhoneForDisplay(otpTarget)}
        </Text>

        {!!otpError && (
          <Text style={styles.errorText}>{otpError}</Text>
        )}

        <Pressable style={styles.codeDotsWrap} onPress={() => codeInputRef.current?.focus()}>
          {Array.from({ length: 6 }).map((_, idx) => (
            <View key={`otp-dot-${idx}`} style={[styles.codeDot, code.length === idx && styles.codeDotActive]}>
              <Text style={styles.codeDotText}>{code[idx] || '•'}</Text>
            </View>
          ))}
        </Pressable>
        <TextInput
          ref={codeInputRef}
          style={styles.hiddenCodeInput}
          value={code}
          onChangeText={handleCodeChange}
          keyboardType="number-pad"
          maxLength={6}
          autoFocus
          editable={!verifying}
        />

        {verifying && (
          <ActivityIndicator color="#10b981" style={{ marginBottom: 12 }} />
        )}

        <TouchableOpacity
          style={[styles.oauthBtn, (resendCooldown > 0 || otpLoading) && { opacity: 0.5 }]}
          onPress={handleResend}
          disabled={resendCooldown > 0 || otpLoading}
        >
          <Text style={styles.oauthText}>
            {otpLoading ? 'Sending...' : resendCooldown > 0 ? `Resend code (${resendCooldown}s)` : 'Resend code'}
          </Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <BrandHeader isDark={isDark} />

      {!!otpError && (
        <Text style={styles.errorText}>{otpError}</Text>
      )}

      <View style={styles.phoneInputWrap}>
        <Ionicons name="call-outline" size={18} color="#64748b" />
        <TextInput
          style={[styles.input, styles.phoneInput]}
          placeholder="(123) 456-7890"
          placeholderTextColor="#94a3b8"
          value={phone}
          onChangeText={(value) => { setPhone(normalizePhoneInput(value)); setOtpError(''); }}
          keyboardType="phone-pad"
          editable={!loading}
        />
      </View>
      <Text style={[styles.helperText, styles.centerText]}>A code will be sent to your phone for verification</Text>

      <TouchableOpacity
        style={styles.consentRow}
        onPress={() => setConsentChecked(!consentChecked)}
        activeOpacity={0.7}
      >
        <View style={[styles.checkbox, consentChecked && styles.checkboxChecked]}>
          {consentChecked && <Ionicons name="checkmark" size={14} color="#fff" />}
        </View>
        <Text style={styles.consentText}>
          I agree to the{' '}
          <Text style={styles.consentLink} onPress={() => Linking.openURL('https://portal.lumeopower.com/terms')}>Terms of Service</Text>
          {' '}and{' '}
          <Text style={styles.consentLink} onPress={() => Linking.openURL('https://portal.lumeopower.com/privacy')}>Privacy Policy</Text>
        </Text>
      </TouchableOpacity>

      <TouchableOpacity style={[styles.button, (loading || !consentChecked) && styles.buttonDisabled]} onPress={handleNextOtp} disabled={loading || !consentChecked}>
        {otpLoading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Next</Text>}
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
          {!!authError && <Text style={{ color: '#dc2626', marginBottom: 8 }}>{authError}</Text>}
          <TouchableOpacity style={[styles.button, styles.emailSignInButton, loading && styles.buttonDisabled]} onPress={handleSignIn} disabled={loading}>
            {authLoading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Sign In</Text>}
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

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 24 },
  card: {
    width: '100%',
    maxWidth: 420,
    alignSelf: 'center',
    paddingVertical: 8,
  },
  brandWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
    minHeight: 98,
  },
  brandLogo: {
    width: 211,
    height: 74,
    marginBottom: 4,
  },
  signInHeader: {
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
    marginTop: 6,
    letterSpacing: 0.2,
  },
  expiredBanner: {
    marginHorizontal: 16,
    marginTop: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
  expiredBannerText: {
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
  title: { fontSize: 28, fontWeight: '700', marginBottom: 12, textAlign: 'center' },
  brandTitle: { fontSize: 32, fontWeight: '800', letterSpacing: 0.4, marginBottom: 14 },
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
  phoneInputWrap: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 10,
    backgroundColor: '#f9fafb',
    marginBottom: 12,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  phoneInput: {
    flex: 1,
    marginBottom: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    paddingHorizontal: 0,
    textAlign: 'center',
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
  codeDotActive: { borderColor: '#10b981', borderWidth: 2 },
  codeDotText: { fontSize: 20, fontWeight: '700', color: '#111827' },
  errorText: { color: '#dc2626', fontSize: 13, textAlign: 'center', marginBottom: 10 },
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
    marginTop: 0,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
    backgroundColor: '#ffffff',
  },
  guestBtnText: { color: '#111827', fontWeight: '600', fontSize: 15 },
  consentRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginBottom: 14,
    paddingHorizontal: 2,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: '#cbd5e1',
    backgroundColor: '#f8fafc',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  checkboxChecked: {
    backgroundColor: '#10b981',
    borderColor: '#10b981',
  },
  consentText: {
    flex: 1,
    fontSize: 13,
    color: '#64748b',
    lineHeight: 19,
  },
  consentLink: {
    color: '#3b82f6',
    textDecorationLine: 'underline' as const,
  },
});