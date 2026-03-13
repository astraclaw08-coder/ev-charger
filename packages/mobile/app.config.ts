import type { ExpoConfig } from 'expo/config';

type AppEnv = 'dev' | 'prod';

const appEnv = ((process.env.APP_ENV || process.env.EAS_BUILD_PROFILE || 'dev').toLowerCase() === 'production'
  ? 'prod'
  : (process.env.APP_ENV || process.env.EAS_BUILD_PROFILE || 'dev').toLowerCase()) as AppEnv;

const isProd = appEnv === 'prod';

const name = isProd ? 'EV Charger' : 'EV Charger Dev';
const slug = isProd ? 'ev-charger' : 'ev-charger-dev';
const scheme = isProd ? 'evcharger' : 'evcharger-dev';
const bundleIdentifier = isProd ? 'app.evcharger.app' : 'dev.evcharger.app';
const androidPackage = isProd ? 'app.evcharger.app' : 'dev.evcharger.app';

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
    infoPlist: {
      NSLocationWhenInUseUsageDescription: 'We use your location to show nearby chargers.',
      NSLocationAlwaysAndWhenInUseUsageDescription: 'We use your location to show nearby chargers.',
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#ffffff',
    },
    package: androidPackage,
    permissions: ['android.permission.ACCESS_COARSE_LOCATION', 'android.permission.ACCESS_FINE_LOCATION'],
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
  ],
  experiments: {
    typedRoutes: true,
  },
  extra: {
    appEnv,
    apiUrl: process.env.EXPO_PUBLIC_API_URL,
    envLabel: isProd ? 'PROD' : 'DEV',
    eas: {
      projectId: '39b3fbf7-b459-4a59-99ad-1c224595c1a6',
    },
  },
  owner: 'astraclaw08',
};

export default config;
