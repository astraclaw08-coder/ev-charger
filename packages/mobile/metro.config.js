const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

// Monorepo root (two levels up from packages/mobile)
const monorepoRoot = path.resolve(__dirname, '../..');

const config = getDefaultConfig(__dirname);

// Watch the entire monorepo so Metro finds workspace packages
config.watchFolders = [monorepoRoot];

// Resolve from mobile package first, then monorepo root
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];

// Force a single copy of React/React Native — prevents the "React is null" crash
// caused by duplicate React instances from root + package node_modules
config.resolver.extraNodeModules = {
  'react': path.resolve(__dirname, 'node_modules/react'),
  'react-native': path.resolve(__dirname, 'node_modules/react-native'),
};

module.exports = config;
