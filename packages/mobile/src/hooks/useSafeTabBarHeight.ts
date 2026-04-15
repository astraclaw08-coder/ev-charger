import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';

/**
 * Safe wrapper around useBottomTabBarHeight that returns 0 if the hook
 * throws (e.g. when the component renders before the Bottom Tab Navigator
 * context is available). This prevents crash-on-launch in Expo Router
 * where tab screens can mount before the navigator is fully ready.
 */
export function useSafeTabBarHeight(): number {
  try {
    return useBottomTabBarHeight();
  } catch {
    return 0;
  }
}
