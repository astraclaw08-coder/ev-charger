import type { ExpoConfig } from 'expo/config';

type AppEnv = 'dev' | 'rc' | 'prod';

const rawEnv = (process.env.APP_ENV || process.env.EAS_BUILD_PROFILE || 'dev').toLowerCase();
const appEnv: AppEnv = rawEnv === 'production' || rawEnv === 'prod'
  ? 'prod'
  : rawEnv === 'rc'
  ? 'rc'
  : 'dev';

const isProd = appEnv === 'prod';
const isRC = appEnv === 'rc';

const name = isProd ? 'Lumeo' : isRC ? 'Lumeo RC' : 'Lumeo Dev';
const slug = 'ev-charger';
const scheme = isProd ? 'evcharger' : isRC ? 'evcharger-rc' : 'evcharger-dev';
const bundleIdentifier = isProd ? 'app.evcharger.app' : isRC ? 'rc.evcharger.app' : 'dev.evcharger.app';
const androidPackage = isProd ? 'app.evcharger.app' : isRC ? 'rc.evcharger.app' : 'dev.evcharger.app';

const defaultApiUrl = isProd || isRC
  ? 'https://api-production-26cf.up.railway.app'
  : 'http://127.0.0.1:3001';
const apiUrl = process.env.EXPO_PUBLIC_API_URL || defaultApiUrl;
// RC/prod should never accidentally point at localhost.
const resolvedApiUrl = (isProd || isRC) && apiUrl.includes('127.0.0.1')
  ? 'https://api-production-26cf.up.railway.app'
  : apiUrl;

const iosGoogleMapsApiKey = process.env.GOOGLE_MAPS_API_KEY_IOS || '';
const androidGoogleMapsApiKey = process.env.GOOGLE_MAPS_API_KEY_ANDROID || '';

const config: ExpoConfig = {
  name,
  slug,
  version: '1.0.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  scheme,
  userInterfaceStyle: 'automatic',
  splash: {
    image: './assets/splash.png',
    resizeMode: 'contain',
    backgroundColor: '#ffffff',
  },
  ios: {
    supportsTablet: true,
    bundleIdentifier,
    config: {
      googleMapsApiKey: iosGoogleMapsApiKey,
    },
    infoPlist: {
      NSLocationWhenInUseUsageDescription: 'We use your location to show nearby chargers.',
      NSLocationAlwaysAndWhenInUseUsageDescription: 'We use your location to show nearby chargers.',
      NSCameraUsageDescription: 'We use the camera to scan charger QR codes and open the right charger.',
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#ffffff',
    },
    package: androidPackage,
    config: {
      googleMaps: {
        apiKey: androidGoogleMapsApiKey,
      },
    },
    permissions: [
      'android.permission.ACCESS_COARSE_LOCATION',
      'android.permission.ACCESS_FINE_LOCATION',
      'android.permission.CAMERA',
    ],
  },
  web: {
    bundler: 'metro',
    output: 'static',
    favicon: './assets/favicon.png',
  },
  plugins: [
    'expo-router',
    ['expo-build-properties', { newArchEnabled: false, ios: {} }],
    ['expo-location', { locationWhenInUsePermission: 'We use your location to show nearby chargers.' }],
    ['expo-camera', { cameraPermission: 'We use the camera to scan charger QR codes and open the right charger.' }],
  ],
  experiments: {
    typedRoutes: true,
  },
  extra: {
    appEnv,
    apiUrl: resolvedApiUrl,
    authMode: 'keycloak',
    envLabel: isProd ? 'PROD' : isRC ? 'RC' : 'DEV',
    eas: {
      projectId: '39b3fbf7-b459-4a59-99ad-1c224595c1a6',
    },
  },
  owner: 'astraclaw08',
};

export default config;
