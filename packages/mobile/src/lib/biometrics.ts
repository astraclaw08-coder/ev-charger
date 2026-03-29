import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';

const BIOMETRIC_ENABLED_KEY = 'mobile.biometric.enabled.v1';

/** Supported biometric types on this device */
export async function getSupportedBiometricTypes() {
  const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
  return types;
}

/** Whether device has any biometric hardware enrolled */
export async function isBiometricAvailable(): Promise<boolean> {
  const compatible = await LocalAuthentication.hasHardwareAsync();
  if (!compatible) return false;
  const enrolled = await LocalAuthentication.isEnrolledAsync();
  return enrolled;
}

/** Human-readable label for the biometric type (Face ID, Touch ID, Biometrics) */
export async function getBiometricLabel(): Promise<string> {
  const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
  if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) {
    return 'Face ID';
  }
  if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) {
    return 'Touch ID';
  }
  return 'Biometrics';
}

/** Prompt the user to authenticate with biometrics */
export async function authenticateWithBiometrics(
  promptMessage?: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: promptMessage ?? 'Authenticate to sign in',
      cancelLabel: 'Cancel',
      disableDeviceFallback: false, // allow passcode fallback
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
