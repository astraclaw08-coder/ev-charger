import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  TouchableWithoutFeedback,
  Pressable,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { AntDesign, Ionicons } from '@expo/vector-icons';
import { isDevMode } from '@/lib/api';
import { useAppAuth } from '@/providers/AuthProvider';

type SignUpMethod = 'email' | 'phone';
type VerifyMethod = 'email_code' | 'phone_code';

export default function SignUpScreen() {
  const router = useRouter();
  const { signIn } = useAppAuth();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [method, setMethod] = useState<SignUpMethod>('email');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [pendingVerify, setPendingVerify] = useState(false);
  const [verifyMethod, setVerifyMethod] = useState<VerifyMethod>('email_code');
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

  const primaryIdentifier = useMemo(() => (method === 'email' ? email.trim() : phone.trim()), [method, email, phone]);

  async function handleSignUp() {
    if (isDevMode) {
      signIn?.();
      router.replace('/' as any);
      return;
    }

    if (!isLoaded || !signUp) {
      Alert.alert('Error', 'Clerk is not configured. Set EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY.');
      return;
    }
    if (!primaryIdentifier || !password) {
      Alert.alert('Error', method === 'email' ? 'Email and password are required.' : 'Phone and password are required.');
      return;
    }

    if (method === 'phone' && !/^\+?[0-9]{8,15}$/.test(primaryIdentifier.replace(/[\s()-]/g, ''))) {
      Alert.alert('Invalid phone', 'Use a valid phone number (include country code, e.g. +13105551234).');
      return;
    }

    setLoading(true);
    try {
      await signUp.create({
        firstName,
        lastName,
        ...(method === 'email'
          ? { emailAddress: primaryIdentifier }
          : { phoneNumber: primaryIdentifier }),
        password,
      });

      if (method === 'email') {
        await signUp.prepareEmailAddressVerification({ strategy: 'email_code' });
        setVerifyMethod('email_code');
      } else {
        await signUp.preparePhoneNumberVerification({ strategy: 'phone_code' });
        setVerifyMethod('phone_code');
      }

      setVerifyTargetLabel(primaryIdentifier);
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
      } else {
        Alert.alert('Sign up incomplete', 'Additional verification may be required in your auth provider settings.');
      }
    } catch (err: unknown) {
      Alert.alert('SSO Sign Up Failed', (err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const goToSignIn = () => router.replace('/(auth)/sign-in' as any);

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <Pressable style={styles.backdrop} onPress={goToSignIn}>
        <TouchableWithoutFeedback>
          <View style={styles.card}>
            <TouchableOpacity style={styles.closeBtn} onPress={goToSignIn} hitSlop={10}>
              <Text style={styles.closeBtnText}>×</Text>
            </TouchableOpacity>
            {pendingVerify ? (
              <>
                <Text style={styles.title}>Verify {verifyMethod === 'email_code' ? 'Email' : 'Phone'}</Text>
                <Text style={styles.subtitle}>Enter the code sent to {verifyTargetLabel}</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Verification code"
                  placeholderTextColor="#6b7280"
                  value={code}
                  onChangeText={setCode}
                  keyboardType="number-pad"
                />
                <TouchableOpacity
                  style={[styles.button, loading && styles.buttonDisabled]}
                  onPress={handleVerify}
                  disabled={loading}
                >
                  {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Verify</Text>}
                </TouchableOpacity>
              </>
            ) : (
              <>
                <Text style={styles.title}>Create Account</Text>
                <Text style={styles.subtitle}>Sign up with phone, email, or SSO.</Text>

                <View style={styles.methodSwitch}>
                  <TouchableOpacity
                    style={[styles.methodBtn, method === 'email' && styles.methodBtnActive]}
                    onPress={() => setMethod('email')}
                  >
                    <Text style={[styles.methodText, method === 'email' && styles.methodTextActive]}>Email</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.methodBtn, method === 'phone' && styles.methodBtnActive]}
                    onPress={() => setMethod('phone')}
                  >
                    <Text style={[styles.methodText, method === 'phone' && styles.methodTextActive]}>Phone</Text>
                  </TouchableOpacity>
                </View>

                <View style={styles.row}>
                  <TextInput
                    style={[styles.input, styles.halfInput]}
                    placeholder="First name"
                    placeholderTextColor="#6b7280"
                    value={firstName}
                    onChangeText={setFirstName}
                  />
                  <TextInput
                    style={[styles.input, styles.halfInput]}
                    placeholder="Last name"
                    placeholderTextColor="#6b7280"
                    value={lastName}
                    onChangeText={setLastName}
                  />
                </View>

                {method === 'email' ? (
                  <TextInput
                    style={styles.input}
                    placeholder="Email"
                    placeholderTextColor="#6b7280"
                    value={email}
                    onChangeText={setEmail}
                    autoCapitalize="none"
                    keyboardType="email-address"
                    autoComplete="email"
                  />
                ) : (
                  <TextInput
                    style={styles.input}
                    placeholder="Phone (+1...)"
                    placeholderTextColor="#6b7280"
                    value={phone}
                    onChangeText={setPhone}
                    keyboardType="phone-pad"
                    autoComplete="tel"
                  />
                )}

                <TextInput
                  style={styles.input}
                  placeholder="Password"
                  placeholderTextColor="#6b7280"
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry
                />

                <TouchableOpacity
                  style={[styles.button, loading && styles.buttonDisabled]}
                  onPress={handleSignUp}
                  disabled={loading}
                >
                  {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Create Account</Text>}
                </TouchableOpacity>

                <View style={styles.dividerWrap}>
                  <View style={styles.dividerLine} />
                  <Text style={styles.dividerText}>OR</Text>
                  <View style={styles.dividerLine} />
                </View>

                <TouchableOpacity style={styles.oauthBtn} onPress={() => handleOAuth('google')} disabled={loading}>
                  <AntDesign name="google" size={18} color="#ffffff" />
                  <Text style={styles.oauthText}>Continue with Google</Text>
                </TouchableOpacity>

                <TouchableOpacity style={styles.oauthBtn} onPress={() => handleOAuth('apple')} disabled={loading}>
                  <Ionicons name="logo-apple" size={18} color="#ffffff" />
                  <Text style={styles.oauthText}>Continue with Apple</Text>
                </TouchableOpacity>

                <TouchableOpacity onPress={goToSignIn} style={styles.signInLinkBtn}>
                  <Text style={styles.link}>Already have an account? Sign in</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </TouchableWithoutFeedback>
      </Pressable>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0b1220',
  },
  backdrop: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
    backgroundColor: 'rgba(2, 6, 23, 0.8)',
  },
  card: {
    backgroundColor: '#111827',
    borderRadius: 16,
    padding: 28,
    shadowColor: '#000',
    shadowOpacity: 0.28,
    shadowRadius: 12,
    elevation: 6,
    borderWidth: 1,
    borderColor: '#1f2937',
    position: 'relative',
  },
  closeBtn: {
    position: 'absolute',
    top: 10,
    right: 10,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#1f2937',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 5,
  },
  closeBtnText: {
    color: '#f9fafb',
    fontSize: 22,
    lineHeight: 22,
    fontWeight: '500',
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#f9fafb',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: '#9ca3af',
    marginBottom: 16,
  },
  methodSwitch: {
    flexDirection: 'row',
    backgroundColor: '#1f2937',
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
    color: '#d1d5db',
    fontWeight: '600',
  },
  methodTextActive: {
    color: '#ffffff',
  },
  row: {
    flexDirection: 'row',
    gap: 10,
  },
  input: {
    borderWidth: 1,
    borderColor: '#374151',
    borderRadius: 10,
    padding: 14,
    fontSize: 15,
    marginBottom: 12,
    backgroundColor: '#0f172a',
    color: '#f9fafb',
  },
  halfInput: {
    flex: 1,
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
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  dividerWrap: {
    marginTop: 14,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: '#374151',
  },
  dividerText: {
    color: '#9ca3af',
    fontSize: 12,
    fontWeight: '700',
  },
  oauthBtn: {
    borderWidth: 1,
    borderColor: '#374151',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
    backgroundColor: '#1f2937',
  },
  oauthText: {
    color: '#f9fafb',
    fontSize: 15,
    fontWeight: '600',
  },
  signInLinkBtn: {
    marginTop: 10,
  },
  link: {
    textAlign: 'center',
    color: '#34d399',
    fontSize: 14,
  },
});
