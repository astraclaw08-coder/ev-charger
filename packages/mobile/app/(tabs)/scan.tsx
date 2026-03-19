import React from 'react';
import { useFocusEffect, useRouter } from 'expo-router';

export default function ScanPlaceholderScreen() {
  const router = useRouter();

  useFocusEffect(
    React.useCallback(() => {
      router.replace('/(tabs)/index?openScanner=1' as any);
      return undefined;
    }, [router]),
  );

  return null;
}
