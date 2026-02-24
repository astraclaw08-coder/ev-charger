import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import type { Connector } from '@/lib/api';

type Status = Connector['status'];

const STATUS_CONFIG: Record<Status, { label: string; bg: string; text: string }> = {
  AVAILABLE: { label: 'Available', bg: '#d1fae5', text: '#065f46' },
  PREPARING: { label: 'Preparing', bg: '#fef9c3', text: '#713f12' },
  CHARGING: { label: 'Charging', bg: '#dbeafe', text: '#1e40af' },
  SUSPENDED_EVSE: { label: 'Paused', bg: '#f3f4f6', text: '#374151' },
  SUSPENDED_EV: { label: 'Paused', bg: '#f3f4f6', text: '#374151' },
  FINISHING: { label: 'Finishing', bg: '#fef9c3', text: '#713f12' },
  RESERVED: { label: 'Reserved', bg: '#ede9fe', text: '#5b21b6' },
  UNAVAILABLE: { label: 'Unavailable', bg: '#f3f4f6', text: '#9ca3af' },
  FAULTED: { label: 'Faulted', bg: '#fee2e2', text: '#991b1b' },
};

export function ConnectorStatusBadge({ status }: { status: Status }) {
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.UNAVAILABLE;
  return (
    <View style={[styles.badge, { backgroundColor: config.bg }]}>
      <Text style={[styles.label, { color: config.text }]}>{config.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
    alignSelf: 'flex-start',
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
  },
});
