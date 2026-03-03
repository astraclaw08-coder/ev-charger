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
import { isDevMode } from '@/lib/api';
import { useAppAuth } from '@/providers/AuthProvider';

export default function SignInScreen() {
  const router = useRouter();
  const { signIn } = useAppAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  // ── Dev mode: skip auth ───────────────────────────────────────────────────
  if (isDevMode) {
    return (
      <View style={styles.container}>
        <View style={styles.card}>
          <Text style={styles.title}>EV Charger</Text>
          <Text style={styles.subtitle}>Dev Mode — No Clerk Key Set</Text>
          <Text style={styles.devNote}>
            Authenticated automatically as{'\n'}test driver (user-test-driver-001)
          </Text>
          <TouchableOpacity
            style={styles.button}
            onPress={() => {
              signIn?.();
              router.replace('/(tabs)/index' as any);
            }}
          >
            <Text style={styles.buttonText}>Continue to App</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // ── Clerk sign-in ─────────────────────────────────────────────────────────
  async function handleSignIn() {
    if (!email || !password) {
      Alert.alert('Error', 'Please enter your email and password.');
      return;
    }
    setLoading(true);
    try {
      const { useSignIn } = require('@clerk/clerk-expo');
      // This component is only rendered inside ClerkProvider so hooks are safe
      Alert.alert('Sign In', 'Use the Clerk hook inside a component that has access to useSignIn.');
    } catch (err: unknown) {
      Alert.alert('Sign In Failed', (err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={styles.card}>
        <Text style={styles.title}>Sign In</Text>
        <Text style={styles.subtitle}>Charge smarter, not harder.</Text>

        <TextInput
          style={styles.input}
          placeholder="Email"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
          autoComplete="email"
        />
        <TextInput
          style={styles.input}
          placeholder="Password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete="password"
        />

        <TouchableOpacity
          style={[styles.button, loading && styles.buttonDisabled]}
          onPress={handleSignIn}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>Sign In</Text>
          )}
        </TouchableOpacity>

        <Link href="/(auth)/sign-up" style={styles.link}>
          Don't have an account? Sign up
        </Link>
      </View>
    </KeyboardAvoidingView>
  );
}

// ── Clerk sign-in inner component (used when Clerk is configured) ─────────────
export function ClerkSignInForm() {
  const { signIn, setActive, isLoaded } = require('@clerk/clerk-expo').useSignIn();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSignIn() {
    if (!isLoaded) return;
    setLoading(true);
    try {
      const result = await signIn.create({ identifier: email, password });
      if (result.status === 'complete') {
        await setActive({ session: result.createdSessionId });
        router.replace('/(tabs)/index' as any);
      }
    } catch (err: unknown) {
      Alert.alert('Sign In Failed', (err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Sign In</Text>
      <TextInput
        style={styles.input}
        placeholder="Email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        keyboardType="email-address"
      />
      <TextInput
        style={styles.input}
        placeholder="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
      />
      <TouchableOpacity
        style={[styles.button, loading && styles.buttonDisabled]}
        onPress={handleSignIn}
        disabled={loading}
      >
        {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Sign In</Text>}
      </TouchableOpacity>
      <Link href="/(auth)/sign-up" style={styles.link}>
        Don't have an account? Sign up
      </Link>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f0fdf4',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 28,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 4,
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
  link: {
    marginTop: 16,
    textAlign: 'center',
    color: '#10b981',
    fontSize: 14,
  },
});
