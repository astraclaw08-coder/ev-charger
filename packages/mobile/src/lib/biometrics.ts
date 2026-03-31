import * as SecureStore from 'expo-secure-store';
import { NativeModules, Platform } from 'react-native';

const BIOMETRIC_ENABLED_KEY = 'mobile.biometric.enabled.v1';

// Check if the native module exists BEFORE importing expo-local-authentication.
// On dev builds compiled before expo-local-authentication was added, the native
// module won't exist and importing it throws a fatal error that crashes the tree.
function hasNativeModule(): boolean {
  return !!NativeModules.ExpoLocalAuthentication;
}

// Cache the module once loaded
let _cachedLA: typeof import('expo-local-authentication') | null = null;

function getLocalAuth(): typeof import('expo-local-authentication') | null {
  if (_cachedLA) return _cachedLA;
  if (!hasNativeModule()) return null;
  try {
    _cachedLA = require('expo-local-authentication');
    return _cachedLA;
  } catch {
    return null;
  }
}

/** Whether device has any biometric hardware enrolled */
export async function isBiometricAvailable(): Promise<boolean> {
  const LA = getLocalAuth();
  if (!LA) return false;
  try {
    const compatible = await LA.hasHardwareAsync();
    if (!compatible) return false;
    const enrolled = await LA.isEnrolledAsync();
    return enrolled;
  } catch {
    return false;
  }
}

/** Human-readable label for the biometric type (Face ID, Touch ID, Biometrics) */
export async function getBiometricLabel(): Promise<string> {
  const LA = getLocalAuth();
  if (!LA) return 'Biometrics';
  try {
    const types = await LA.supportedAuthenticationTypesAsync();
    if (types.includes(LA.AuthenticationType.FACIAL_RECOGNITION)) {
      return 'Face ID';
    }
    if (types.includes(LA.AuthenticationType.FINGERPRINT)) {
      return 'Touch ID';
    }
  } catch {}
  return 'Biometrics';
}

/** Prompt the user to authenticate with biometrics */
export async function authenticateWithBiometrics(
  promptMessage?: string,
): Promise<{ success: boolean; error?: string }> {
  const LA = getLocalAuth();
  if (!LA) return { success: false, error: 'Biometrics not available' };
  try {
    const result = await LA.authenticateAsync({
      promptMessage: promptMessage ?? 'Authenticate to sign in',
      cancelLabel: 'Cancel',
      disableDeviceFallback: false,
      fallbackLabel: 'Use Passcode',
    });
    if (result.success) {
      return { success: true };
    }
    return { success: false, error: result.error ?? 'Authentication failed' };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Biometric error' };
  }
}

/** Check if user has opted into biometric unlock */
export async function isBiometricEnabled(): Promise<boolean> {
  try {
    const value = await SecureStore.getItemAsync(BIOMETRIC_ENABLED_KEY);
    return value === 'true';
  } catch {
    return false;
  }
}

/** Enable biometric unlock (stores preference in secure store) */
export async function setBiometricEnabled(enabled: boolean): Promise<void> {
  if (enabled) {
    await SecureStore.setItemAsync(BIOMETRIC_ENABLED_KEY, 'true');
  } else {
    await SecureStore.deleteItemAsync(BIOMETRIC_ENABLED_KEY).catch(() => {});
  }
}
