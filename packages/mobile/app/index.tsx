import React from 'react';
import { Redirect } from 'expo-router';
import { useAppAuth } from '@/providers/AuthProvider';

export default function RootIndex() {
  const { isGuest } = useAppAuth();

  if (isGuest) {
    return <Redirect href={'/(tabs)/index' as any} />;
  }

  return <Redirect href={'/(tabs)' as any} />;
}
