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
const slug = isProd ? 'ev-charger' : 'ev-charger-dev';
const scheme = isProd ? 'evcharger' : isRC ? 'evcharger-rc' : 'evcharger-dev';
const bundleIdentifier = isProd ? 'app.evcharger.app' : isRC ? 'rc.evcharger.app' : 'dev.evcharger.app';
const androidPackage = isProd ? 'app.evcharger.app' : isRC ? 'rc.evcharger.app' : 'dev.evcharger.app';

const devApiUrl = process.env.EXPO_PUBLIC_API_URL_DEV || 'http://127.0.0.1:3001';
const prodApiUrl = process.env.EXPO_PUBLIC_API_URL_PROD || 'https://api-production-26cf.up.railway.app';
const authMode = 'keycloak';
const googleMapsApiKey = isProd
  ? (
    process.env.GOOGLE_MAPS_API_KEY_PROD
    || process.env.GOOGLE_MAPS_API_KEY
    || process.env.GOOGLE_MAPS_API_KEY_IOS_PROD
    || process.env.GOOGLE_MAPS_API_KEY_ANDROID_PROD
    || ''
  )
  : (
    process.env.GOOGLE_MAPS_API_KEY_DEV
    || process.env.GOOGLE_MAPS_API_KEY
    || process.env.GOOGLE_MAPS_API_KEY_IOS_DEV
    || process.env.GOOGLE_MAPS_API_KEY_ANDROID_DEV
    || ''
  );

const iosGoogleMapsApiKey = isProd
  ? (process.env.GOOGLE_MAPS_API_KEY_IOS_PROD || process.env.GOOGLE_MAPS_API_KEY_IOS || googleMapsApiKey)
  : (process.env.GOOGLE_MAPS_API_KEY_IOS_DEV || process.env.GOOGLE_MAPS_API_KEY_IOS || googleMapsApiKey);

const androidGoogleMapsApiKey = isProd
  ? (process.env.GOOGLE_MAPS_API_KEY_ANDROID_PROD || process.env.GOOGLE_MAPS_API_KEY_ANDROID || googleMapsApiKey)
  : (process.env.GOOGLE_MAPS_API_KEY_ANDROID_DEV || process.env.GOOGLE_MAPS_API_KEY_ANDROID || googleMapsApiKey);

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
    ['expo-build-properties', { ios: {} }],
    ['expo-location', { locationWhenInUsePermission: 'We use your location to show nearby chargers.' }],
    ['expo-camera', { cameraPermission: 'We use the camera to scan charger QR codes and open the right charger.' }],
  ],
  experiments: {
    typedRoutes: true,
  },
  extra: {
    appEnv,
    apiUrl: isProd || isRC ? prodApiUrl : devApiUrl,
    authMode,
    envLabel: isProd ? 'PROD' : isRC ? 'RC' : 'DEV',
    eas: {
      projectId: '39b3fbf7-b459-4a59-99ad-1c224595c1a6',
    },
  },
  owner: 'astraclaw08',
};

export default config;
