import React from 'react';
import { Stack, useRouter } from 'expo-router';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useChargingNotifications } from '@/providers/ChargingNotificationsProvider';
import { useAppTheme } from '@/theme';

function timeAgo(iso: string): string {
  const diff = Math.max(1, Date.now() - new Date(iso).getTime());
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export default function NotificationsScreen() {
  const router = useRouter();
  const { isDark } = useAppTheme();
  const { notifications, markAsRead, markAllAsRead } = useChargingNotifications();

  return (
    <View style={[styles.container, { backgroundColor: isDark ? '#030712' : '#f8fafc' }]}>
      <Stack.Screen
        options={{
          headerShown: true,
          title: 'Charging Alerts',
          headerStyle: { backgroundColor: isDark ? '#0b1220' : '#ffffff' },
          headerTintColor: isDark ? '#f8fafc' : '#111827',
          headerRight: () => (
            <TouchableOpacity onPress={markAllAsRead}>
              <Text style={{ color: isDark ? '#93c5fd' : '#1d4ed8', fontWeight: '700' }}>Mark all read</Text>
            </TouchableOpacity>
          ),
        }}
      />

      <ScrollView contentContainerStyle={{ padding: 14, gap: 10 }}>
        {notifications.length === 0 ? (
          <View style={[styles.emptyCard, { backgroundColor: isDark ? '#111827' : '#ffffff', borderColor: isDark ? '#1f2937' : '#e2e8f0' }]}>
            <Text style={{ color: isDark ? '#cbd5e1' : '#475569' }}>No charging notifications yet.</Text>
          </View>
        ) : notifications.map((item) => (
          <TouchableOpacity
            key={item.id}
            activeOpacity={0.9}
            onPress={() => {
              markAsRead(item.id);
              router.push(`/session/${item.sessionId}` as any);
            }}
            style={[
              styles.card,
              {
                backgroundColor: isDark ? '#111827' : '#ffffff',
                borderColor: item.read ? (isDark ? '#1f2937' : '#e2e8f0') : (isDark ? '#1d4ed8' : '#93c5fd'),
              },
            ]}
          >
            <View style={styles.row}>
              <Text style={{ color: isDark ? '#f8fafc' : '#0f172a', fontWeight: '800', flex: 1 }}>{item.title}</Text>
              <Text style={{ color: isDark ? '#94a3b8' : '#64748b', fontSize: 12 }}>{timeAgo(item.createdAt)}</Text>
            </View>
            <Text style={{ color: isDark ? '#cbd5e1' : '#334155', marginTop: 4 }}>{item.body}</Text>
            {!item.read ? <Text style={{ color: isDark ? '#93c5fd' : '#2563eb', marginTop: 6, fontSize: 12, fontWeight: '700' }}>New</Text> : null}
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  emptyCard: { borderWidth: 1, borderRadius: 12, padding: 14 },
  card: { borderWidth: 1, borderRadius: 12, padding: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
