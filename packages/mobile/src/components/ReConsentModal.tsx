import React, { useEffect, useState } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Linking,
  ActivityIndicator,
} from 'react-native';
import { api } from '@/lib/api';

const CURRENT_TOS_VERSION = '1.0';
const CURRENT_PRIVACY_VERSION = '1.0';

export default function ReConsentModal() {
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void checkConsent();
  }, []);

  async function checkConsent() {
    try {
      const status = await api.consent.status();
      if (status.tosVersion !== CURRENT_TOS_VERSION || status.privacyVersion !== CURRENT_PRIVACY_VERSION) {
        setVisible(true);
      }
    } catch {
      // Don't block guests / failed checks
    }
  }

  async function handleAccept() {
    setLoading(true);
    try {
      await api.consent.accept(CURRENT_TOS_VERSION, CURRENT_PRIVACY_VERSION);
      setVisible(false);
    } catch {
      setVisible(false);
    } finally {
      setLoading(false);
    }
  }

  if (!visible) return null;

  return (
    <Modal visible transparent animationType="fade">
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.eyebrow}>Action required</Text>
          <Text style={styles.title}>Updated legal terms</Text>
          <Text style={styles.body}>
            We updated the Terms of Service and Privacy Policy. Please review and accept them to continue using Lumeo.
          </Text>

          <View style={styles.links}>
            <TouchableOpacity onPress={() => Linking.openURL('https://portal.lumeopower.com/terms')}>
              <Text style={styles.link}>Terms of Service ↗</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => Linking.openURL('https://portal.lumeopower.com/privacy')}>
              <Text style={styles.link}>Privacy Policy ↗</Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity style={[styles.acceptBtn, loading && { opacity: 0.6 }]} onPress={handleAccept} disabled={loading}>
            {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.acceptText}>I Agree</Text>}
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(2, 6, 23, 0.68)',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 20,
    padding: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.18,
    shadowRadius: 16,
    elevation: 10,
  },
  eyebrow: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: '#2563eb',
    marginBottom: 8,
  },
  title: {
    fontSize: 22,
    fontWeight: '800',
    color: '#111827',
    marginBottom: 10,
  },
  body: {
    fontSize: 15,
    color: '#4b5563',
    lineHeight: 22,
    marginBottom: 18,
  },
  links: {
    gap: 10,
    marginBottom: 20,
  },
  link: {
    fontSize: 15,
    color: '#2563eb',
    fontWeight: '600',
  },
  acceptBtn: {
    backgroundColor: '#059669',
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
  },
  acceptText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '800',
  },
});
