import React from 'react';
import { Redirect } from 'expo-router';
import { isDevMode } from '@/lib/api';
import { useAppAuth } from '@/providers/AuthProvider';

export default function RootIndex() {
  const { isGuest } = useAppAuth();

  if (isDevMode) {
    return <Redirect href={isGuest ? '/(auth)/sign-in' : '/'} />;
  }

  return <Redirect href={isGuest ? '/(auth)/sign-in' : '/'} />;
}
