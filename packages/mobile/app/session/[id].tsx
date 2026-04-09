/**
 * Live session screen - polls for kWh + cost, shows Stop button.
 * After stop: shows session summary (kWh, duration, cost).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  AppState,
  Modal,
  ScrollView,
  Animated,
  PanResponder,
  Image,
} from 'react-native';
import { useLocalSearchParams, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, isDevMode, type Session } from '@/lib/api';
import { useAppTheme } from '@/theme';
import { Fonts } from '@/fonts';

const RATE_PER_KWH = 0.35;

function formatDuration(startedAt: string, endedAt?: string | null): string {
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  const totalSecs = Math.floor((end - start) / 1000);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}


function formatKwh(value: number): string {
  // up to 4 decimal places, trimming trailing zeros
  return value.toFixed(4).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function getLiveKwh(session: Session): number {
  if (session.kwhDelivered != null) return session.kwhDelivered;
  if (session.meterStop != null && session.meterStart != null) {
    return Math.max(0, (session.meterStop - session.meterStart) / 1000);
  }
  return 0;
}

function hasLiveEnergySample(session: Session): boolean {
  return session.kwhDelivered != null || (session.meterStop != null && session.meterStart != null);
}

function formatPowerKw(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '-';
  return `${value.toFixed(1)} kW`;
}

function useLivePowerKw(session: Session): number | null {
  const [powerKw, setPowerKw] = useState<number | null>(null);
  const sampleRef = useRef<{ atMs: number; kwh: number } | null>(null);

  useEffect(() => {
    if (!hasLiveEnergySample(session)) {
      sampleRef.current = null;
      setPowerKw(null);
      return;
    }

    const nowMs = Date.now();
    const kwh = getLiveKwh(session);
    const prev = sampleRef.current;
    sampleRef.current = { atMs: nowMs, kwh };

    if (!prev) return;

    const dtSeconds = (nowMs - prev.atMs) / 1000;
    if (!Number.isFinite(dtSeconds) || dtSeconds < 0.5) return;

    const deltaKwh = Math.max(0, kwh - prev.kwh);
    const instantKw = deltaKwh * (3600 / dtSeconds);
    if (!Number.isFinite(instantKw)) return;

    const boundedKw = Math.min(500, Math.max(0, instantKw));
    setPowerKw((current) => {
      if (current == null) return boundedKw;
      const smoothing = 0.35;
      return current * (1 - smoothing) + boundedKw * smoothing;
    });
  }, [session]);

  return powerKw;
}

// ── Live ticker (updates every second for duration display) ───────────────────

function useLiveDuration(startedAt: string, active: boolean): string {
  const [duration, setDuration] = useState(() => formatDuration(startedAt));
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setDuration(formatDuration(startedAt)), 1000);
    return () => clearInterval(timer);
  }, [startedAt, active]);
  return duration;
}

// ── Session Summary (completed) ───────────────────────────────────────────────

function SessionSummary({
  session,
  fallbackKwh,
}: {
  session: Session;
  fallbackKwh?: number;
}) {
  const { isDark } = useAppTheme();
  const ratePerKwh = session.ratePerKwh ?? RATE_PER_KWH;
  const meterDerivedKwh =
    session.meterStop != null ? Math.max(0, (session.meterStop - session.meterStart) / 1000) : 0;
  const sessionDerivedKwh = getLiveKwh(session);
  const effectiveDerivedCost = session.effectiveAmountCents != null ? session.effectiveAmountCents / 100 : null;
  const estimateDerivedCost =
    session.estimatedAmountCents != null
      ? session.estimatedAmountCents / 100
      : session.costEstimateCents != null
        ? session.costEstimateCents / 100
        : null;

  const breakdown = session.billingBreakdown;
  const breakdownTotals = breakdown?.totals;
  const displayEnergyUsd = breakdownTotals?.energyUsd ?? breakdown?.energy.totalUsd ?? 0;
  const displayIdleUsd = breakdownTotals?.idleUsd ?? breakdown?.idle.totalUsd ?? 0;
  const displayActivationUsd = breakdownTotals?.activationUsd ?? breakdown?.activation.totalUsd ?? 0;
  const grossSubtotalTotal = Number(displayEnergyUsd.toFixed(2)) + Number(displayIdleUsd.toFixed(2)) + Number(displayActivationUsd.toFixed(2));
  const cost =
    breakdown
      ? grossSubtotalTotal
      : (
        effectiveDerivedCost ??
        estimateDerivedCost ??
        (sessionDerivedKwh > 0 ? sessionDerivedKwh * ratePerKwh : meterDerivedKwh * ratePerKwh)
      );
  const energySegments = breakdown?.energy.segments ?? [];
  const rawIdleSegments = breakdown?.idle.segments ?? [];
  const idleSegments = rawIdleSegments.filter((segment) => (segment.minutes ?? 0) > 0);
  const gracePeriodMin = Math.max(0, breakdown?.gracePeriodMin ?? 0);
  const idleStartLabel = rawIdleSegments.length > 0 ? formatTime(rawIdleSegments[0].startedAt) : null;
  const idleEndLabel = rawIdleSegments.length > 0 ? formatTime(rawIdleSegments[rawIdleSegments.length - 1].endedAt) : null;
  const idleSubtotalLabel = 'Idle Subtotal';
  const graceLabel = gracePeriodMin > 0 ? ` (grace period is ${gracePeriodMin} mins)` : '';
  const idleGraceLabel = idleStartLabel && idleEndLabel
    ? `${idleStartLabel} to ${idleEndLabel}${graceLabel}`
    : `Idle${graceLabel}`;

  const finalKwh =
    meterDerivedKwh > 0
      ? meterDerivedKwh
      : sessionDerivedKwh > 0
        ? sessionDerivedKwh
        : (fallbackKwh ?? 0) > 0
          ? (fallbackKwh ?? 0)
          : cost > 0 && ratePerKwh > 0
            ? cost / ratePerKwh
            : 0;
  const paymentMethod = isDevMode
    ? ''
    : session.payment?.stripeCustomerId
      ? 'Card on file'
      : '-';

  return (
    <View style={styles.summaryContainer}>
      <Text style={[styles.summarySubtitle, { color: isDark ? '#cbd5e1' : '#111827' }]}>{session.connector.charger.site.name}</Text>
      <Text style={[styles.summaryAddress, { color: isDark ? '#94a3b8' : '#6b7280' }]}>{session.connector.charger.site.address}</Text>
      <Text style={[styles.summaryDetailLine, { color: isDark ? '#94a3b8' : '#6b7280' }]}>Charger S/N: {session.connector.charger.ocppId}</Text>
      <Text style={[styles.summaryDetailLine, { color: isDark ? '#94a3b8' : '#6b7280' }]}>Transaction #: {session.transactionId ?? '-'}</Text>

      <View style={styles.summaryStats}>
        <SummaryStatCard label="ENERGY (kWh)" value={formatKwh(finalKwh)} icon="⚡" isDark={isDark} />
        <SummaryStatCard
          label="DURATION"
          value={formatDuration(session.startedAt, session.endedAt)}
          icon="⏱"
          isDark={isDark}
        />
        <SummaryStatCard
          label="TOTAL COST"
          value={`$${cost.toFixed(2)}`}
          icon="money-outline"
          isDark={isDark}
        />
      </View>

      {session.amountState === 'FINAL' && (
        <View style={styles.paymentSuccess}>
          <Text style={styles.paymentSuccessText}>
            Final payment: ${cost.toFixed(2)}
          </Text>
        </View>
      )}

      {session.amountState === 'PENDING' && (
        <View style={styles.paymentPending}>
          <Text style={styles.paymentPendingText}>Stripe settlement pending · shown total is estimated.</Text>
        </View>
      )}

      <View style={[styles.summaryMeta, { backgroundColor: isDark ? '#111827' : '#f3f4f6' }]}>
        <Text style={[styles.breakdownTitle, { color: isDark ? '#e2e8f0' : '#111827' }]}>Session Detail</Text>

        <ReceiptRow
          isDark={isDark}
          label="Plug in"
          value={formatDate(session.plugInAt ?? session.startedAt)}
        />
        <ReceiptRow
          isDark={isDark}
          label="Plug out"
          value={(session.plugOutAt ?? session.endedAt) ? formatDate((session.plugOutAt ?? session.endedAt) as string) : '-'}
        />

        {energySegments.map((segment, idx) => (
          <ReceiptRow
            key={`${segment.startedAt}-${idx}`}
            isDark={isDark}
            label={`${formatTime(segment.startedAt)} to ${formatTime(segment.endedAt)} @ $${segment.pricePerKwhUsd.toFixed(2)}/kWh * ${segment.kwh.toFixed(3)} kWh`}
            value={`$${segment.energyAmountUsd.toFixed(2)}`}
            multilineLabel
          />
        ))}

        {energySegments.length === 0 && (
          <ReceiptRow
            isDark={isDark}
            label="Energy segment"
            value="-"
          />
        )}

        <ReceiptRow
          isDark={isDark}
          label="Energy Subtotal"
          value={`$${displayEnergyUsd.toFixed(2)}`}
          emphasizeValue
        />

        {idleSegments.map((segment, idx) => {
          const graceNote = idx === 0 && gracePeriodMin > 0 ? ` (grace period is ${gracePeriodMin} mins)` : '';
          return (
            <ReceiptRow
              key={`${segment.startedAt}-${segment.endedAt}-${idx}`}
              isDark={isDark}
              label={`${formatTime(segment.startedAt)} to ${formatTime(segment.endedAt)} * $${segment.idleFeePerMinUsd.toFixed(2)}/min${graceNote}`}
              value={`$${segment.amountUsd.toFixed(2)}`}
              multilineLabel
            />
          );
        })}

        {idleSegments.length === 0 && (
          <ReceiptRow
            isDark={isDark}
            label={idleGraceLabel}
            value={`$${displayIdleUsd.toFixed(2)}`}
            multilineLabel
          />
        )}

        <ReceiptRow
          isDark={isDark}
          label={idleSubtotalLabel}
          value={`$${displayIdleUsd.toFixed(2)}`}
          emphasizeValue
        />

        <ReceiptRow
          isDark={isDark}
          label="Activation fee"
          value={`$${displayActivationUsd.toFixed(2)}`}
          emphasizeValue
        />
        <ReceiptRow
          isDark={isDark}
          label="Total"
          value={`$${cost.toFixed(2)}`}
          emphasize
        />
        <ReceiptRow
          isDark={isDark}
          label="Payment card used"
          value={paymentMethod}
        />

        <View style={[styles.receiptRow, styles.receiptRowNoBorder]}>
          <Text style={[styles.receiptThanks, { color: isDark ? '#cbd5e1' : '#374151' }]}>Thank you for charging with us!</Text>
        </View>
      </View>
    </View>
  );
}

function SummaryStatCard({
  label,
  value,
  icon,
  highlight,
  isDark,
}: {
  label: string;
  value: string;
  icon: string;
  highlight?: boolean;
  isDark: boolean;
}) {
  return (
    <View style={[
      styles.statCard,
      { backgroundColor: isDark ? '#111827' : '#fff' },
      highlight && (isDark ? styles.statCardHighlightDark : styles.statCardHighlight),
    ]}>
      <View style={styles.statCardContent}>
        <View style={styles.statIconSlot}>
          {icon === 'money-outline' ? (
            <View style={[styles.moneyIconCircle, { borderColor: isDark ? '#94a3b8' : '#6b7280' }]}>
              <Text style={[styles.moneyIconText, { color: isDark ? '#e2e8f0' : '#374151' }]}>$</Text>
            </View>
          ) : (
            <Text style={styles.statIcon}>{icon}</Text>
          )}
        </View>
        <Text numberOfLines={1} style={[styles.statValue, { color: isDark ? '#f8fafc' : '#111827' }, highlight && styles.statValueHighlight]}>{value}</Text>
        <Text numberOfLines={1} style={[styles.statLabel, { color: isDark ? '#94a3b8' : '#9ca3af' }]}>{label}</Text>
      </View>
    </View>
  );
}

function ReceiptRow({
  isDark,
  label,
  value,
  multilineLabel,
  emphasize,
  emphasizeValue,
}: {
  isDark: boolean;
  label: string;
  value: string;
  multilineLabel?: boolean;
  emphasize?: boolean;
  emphasizeValue?: boolean;
}) {
  return (
    <View style={[styles.receiptRow, { borderBottomColor: isDark ? '#334155' : '#d1d5db' }]}>
      <Text
        numberOfLines={multilineLabel ? 3 : 1}
        style={[
          styles.receiptLabel,
          { color: isDark ? '#cbd5e1' : '#374151' },
          multilineLabel && styles.receiptLabelMulti,
          emphasize && styles.receiptLabelEmphasis,
        ]}
      >
        {label}
      </Text>
      <Text style={[
        styles.receiptValue,
        { color: isDark ? '#f8fafc' : '#111827' },
        (emphasize || emphasizeValue) && styles.receiptValueEmphasis,
      ]}>
        {value}
      </Text>
    </View>
  );
}

function SlideAction({
  isDark,
  disabled,
  direction,
  label,
  onComplete,
}: {
  isDark: boolean;
  disabled?: boolean;
  direction: 'right' | 'left';
  label: string;
  onComplete: () => void;
}) {
  const trackWidth = 320;
  const knobSize = 56;
  const maxX = trackWidth - knobSize;
  const x = useRef(new Animated.Value(direction === 'right' ? 0 : maxX)).current;
  const valueRef = useRef(direction === 'right' ? 0 : maxX);

  useEffect(() => {
    Animated.spring(x, { toValue: direction === 'right' ? 0 : maxX, useNativeDriver: true }).start();
  }, [direction, maxX, x]);

  useEffect(() => {
    const sub = x.addListener(({ value }) => {
      valueRef.current = value;
    });
    return () => x.removeListener(sub);
  }, [x]);

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !disabled,
        onMoveShouldSetPanResponder: () => !disabled,
        onPanResponderMove: (_, g) => {
          const base = direction === 'right' ? 0 : maxX;
          const next = Math.max(0, Math.min(maxX, base + g.dx));
          x.setValue(next);
        },
        onPanResponderRelease: () => {
          const reached = direction === 'right'
            ? valueRef.current >= maxX * 0.85
            : valueRef.current <= maxX * 0.15;
          const completedX = direction === 'right' ? maxX : 0;
          const resetX = direction === 'right' ? 0 : maxX;

          if (reached) {
            Animated.timing(x, { toValue: completedX, duration: 110, useNativeDriver: true }).start(() => {
              onComplete();
              Animated.spring(x, { toValue: resetX, useNativeDriver: true }).start();
            });
          } else {
            Animated.spring(x, { toValue: resetX, useNativeDriver: true }).start();
          }
        },
      }),
    [direction, disabled, maxX, onComplete, x],
  );

  return (
    <View style={[styles.slideTrack, { backgroundColor: isDark ? '#1f2937' : '#e5e7eb', opacity: disabled ? 0.45 : 1, width: trackWidth }]}>
      <Text style={[styles.slideLabel, { color: isDark ? '#d1d5db' : '#374151' }]}>{label}</Text>
      <Animated.View {...pan.panHandlers} style={[styles.slideKnob, { transform: [{ translateX: x }] }]}>
        <Image source={require('../../assets/branding/lumeo_logo_swirl_only.png')} style={styles.slideKnobLogo} resizeMode="contain" />
      </Animated.View>
    </View>
  );
}

// ── Stop Confirmation Modal ───────────────────────────────────────────────────

function StopModal({
  visible,
  onCancel,
  onConfirm,
  stopping,
  isDark,
}: {
  visible: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  stopping: boolean;
  isDark: boolean;
}) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onCancel}
    >
      <View style={stopModal.backdrop}>
        <View style={[stopModal.card, { backgroundColor: isDark ? '#0f172a' : '#fff' }]}>
          <Text style={[stopModal.title, { color: isDark ? '#f1f5f9' : '#111827' }]}>
            Stop Charging?
          </Text>
          <Text style={[stopModal.subtitle, { color: isDark ? '#94a3b8' : '#6b7280' }]}>
            This will end your current charging session.
          </Text>
          <TouchableOpacity
            style={[stopModal.confirmBtn, stopping && stopModal.confirmBtnDisabled]}
            onPress={onConfirm}
            disabled={stopping}
            activeOpacity={0.8}
          >
            {stopping ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={stopModal.confirmBtnText}>Stop Session</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={[stopModal.cancelBtn, { borderColor: isDark ? '#334155' : '#d1d5db' }]}
            onPress={onCancel}
            disabled={stopping}
            activeOpacity={0.7}
          >
            <Text style={[stopModal.cancelBtnText, { color: isDark ? '#94a3b8' : '#6b7280' }]}>
              Keep Charging
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// ── Live Session View ─────────────────────────────────────────────────────────

function LiveSessionView({
  session,
  onStop,
  stopping,
  showConnectorLabel,
  vehicleLabel,
}: {
  session: Session;
  onStop: () => void;
  stopping: boolean;
  showConnectorLabel: boolean;
  vehicleLabel?: string | null;
}) {
  const { isDark } = useAppTheme();
  const [showStopModal, setShowStopModal] = useState(false);
  const kwh = getLiveKwh(session);
  const liveRate = session.ratePerKwh ?? RATE_PER_KWH;
  const estimatedCost = kwh * liveRate;
  const duration = useLiveDuration(session.startedAt, true);
  const livePowerKw = useLivePowerKw(session);

  function confirmStop() {
    setShowStopModal(true);
  }

  function handleConfirmStop() {
    setShowStopModal(false);
    onStop();
  }

  return (
    <View style={[styles.liveContainer, { backgroundColor: isDark ? '#030712' : '#f9fafb' }]}>
      <StopModal
        visible={showStopModal}
        onCancel={() => setShowStopModal(false)}
        onConfirm={handleConfirmStop}
        stopping={stopping}
        isDark={isDark}
      />
      {/* Pulsing status indicator */}
      <View style={styles.liveHeader}>
        <View style={styles.liveDot} />
        <Text style={styles.liveLabel}>Charging</Text>
      </View>

      {/* Site name */}
      <Text style={[styles.liveSiteName, { color: isDark ? '#f9fafb' : '#111827' }]}>{session.connector.charger.site.name}</Text>
      <Text style={[styles.liveChargerSerial, { color: isDark ? '#94a3b8' : '#6b7280' }]}>
        Charger Serial/Name: {session.connector.charger.ocppId}
      </Text>
      {showConnectorLabel ? (
        <Text style={[styles.liveConnector, { color: isDark ? '#9ca3af' : '#6b7280' }]}>
          Connector {session.connector.connectorId}
        </Text>
      ) : null}
      {vehicleLabel ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4, marginBottom: 4 }}>
          <Ionicons name="car-sport-outline" size={14} color={isDark ? '#94a3b8' : '#6b7280'} />
          <Text style={{ fontSize: 13, fontWeight: '500', color: isDark ? '#94a3b8' : '#6b7280' }}>{vehicleLabel}</Text>
        </View>
      ) : null}

      {/* Big kWh counter */}
      <View style={styles.kwhContainer}>
        <Text style={styles.kwhValue}>{formatKwh(kwh)}</Text>
        <Text style={[styles.kwhUnit, { color: isDark ? '#94a3b8' : '#6b7280' }]}>ENERGY (kWh)</Text>
      </View>

      {/* Stats row */}
      <View style={[styles.liveStats, { backgroundColor: isDark ? '#0f172a' : '#fff', borderColor: isDark ? '#1f2937' : '#e5e7eb', borderWidth: 1 }]}>
        <View style={styles.liveStat}>
          <Text style={[styles.liveStatValue, { color: isDark ? '#f8fafc' : '#111827' }]}>{duration}</Text>
          <Text style={[styles.liveStatLabel, { color: isDark ? '#94a3b8' : '#9ca3af' }]}>Duration</Text>
        </View>
        <View style={[styles.liveStatDivider, { backgroundColor: isDark ? '#334155' : '#e5e7eb' }]} />
        <View style={styles.liveStat}>
          <Text style={[styles.liveStatValue, styles.costValue]}>
            ${estimatedCost.toFixed(2)}
          </Text>
          <Text style={[styles.liveStatLabel, { color: isDark ? '#94a3b8' : '#9ca3af' }]}>Est. Cost</Text>
        </View>
        <View style={[styles.liveStatDivider, { backgroundColor: isDark ? '#334155' : '#e5e7eb' }]} />
        <View style={styles.liveStat}>
          <Text style={[styles.liveStatValue, { color: isDark ? '#f8fafc' : '#111827' }]}>{formatPowerKw(livePowerKw)}</Text>
          <Text style={[styles.liveStatLabel, { color: isDark ? '#94a3b8' : '#9ca3af' }]}>Power</Text>
        </View>
      </View>

      <SlideAction
        isDark={isDark}
        disabled={stopping}
        direction="left"
        label={stopping ? 'Stopping…' : 'Slide left to stop'}
        onComplete={confirmStop}
      />

      <Text style={styles.pollingNote}>
        {`Rate $${liveRate.toFixed(2)}/kWh · Updating every ~1.5 seconds`}
      </Text>
    </View>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function SessionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { isDark } = useAppTheme();
  const queryClient = useQueryClient();
  const [lastObservedKwh, setLastObservedKwh] = useState(0);

  const { data: session, isLoading, refetch } = useQuery({
    queryKey: ['session', id],
    queryFn: () => api.sessions.get(id),
    staleTime: 0,
    refetchOnMount: true,
    refetchOnReconnect: true,
    refetchInterval: (query) => {
      // Poll aggressively while active for low-latency kWh updates.
      return query.state.data?.status === 'ACTIVE' ? 1_500 : false;
    },
    refetchIntervalInBackground: true,
  });

  const { data: chargerDetails } = useQuery({
    queryKey: ['charger', session?.connector.charger.id],
    queryFn: () => api.chargers.get(session!.connector.charger.id),
    enabled: Boolean(session?.connector.charger.id),
    staleTime: 30_000,
  });

  const { data: profileData } = useQuery({
    queryKey: ['me-profile'],
    queryFn: () => api.profile.get(),
    staleTime: 60_000,
  });

  const vehicleLabel = useMemo(() => {
    if (!profileData?.vehicleMake && !profileData?.vehicleModel) return null;
    const parts = [profileData.vehicleMake, profileData.vehicleModel].filter(Boolean).join(' ');
    const year = profileData.vehicleYear ? ` (${profileData.vehicleYear})` : '';
    return `${parts}${year}`;
  }, [profileData]);

  const showConnectorLabel = (chargerDetails?.connectors?.length ?? 1) > 1;
  const isLiveSession = session?.status === 'ACTIVE' && !session?.endedAt;

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void refetch();
        queryClient.invalidateQueries({ queryKey: ['sessions'] });
      }
    });
    return () => sub.remove();
  }, [queryClient, refetch]);

  useEffect(() => {
    if (!session) return;
    const observed = getLiveKwh(session);
    if (observed > lastObservedKwh) {
      setLastObservedKwh(observed);
    }

    // Keep tabs/banner cache in sync with the freshest live session payload.
    queryClient.setQueryData(['sessions'], (current: any) => {
      if (!current?.sessions || !Array.isArray(current.sessions)) return current;
      return {
        ...current,
        sessions: current.sessions.map((row: Session) => (row.id === session.id ? { ...row, ...session } : row)),
      };
    });
  }, [session, lastObservedKwh, queryClient]);

  const stopMutation = useMutation({
    mutationFn: () => api.sessions.stop(id),
    onSuccess: () => {
      // Invalidate and refetch session + list
      queryClient.invalidateQueries({ queryKey: ['session', id] });
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      // Final refetch after a moment (OCPP might take a second to close the session)
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['session', id] });
      }, 3000);
    },
    onError: (_err: Error) => {
      Alert.alert('Stop Failed', "Couldn't stop charging. Please try again or contact support.");
    },
  });

  if (isLoading) {
    return (
      <View style={[styles.centered, { backgroundColor: isDark ? '#030712' : '#f9fafb' }]}>
        <ActivityIndicator size="large" color="#10b981" />
      </View>
    );
  }

  if (!session) {
    return (
      <View style={[styles.centered, { backgroundColor: isDark ? '#030712' : '#f9fafb' }]}>
        <Text style={styles.errorText}>Session not found.</Text>
      </View>
    );
  }

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Lumeo',
          headerShown: true,
          headerStyle: {
            backgroundColor: isDark ? '#0b1220' : '#fff',
          },
          headerTintColor: isDark ? '#f9fafb' : '#111827',
          headerBackButtonDisplayMode: 'minimal',
          headerTitleStyle: {
            color: isDark ? '#ffffff' : '#000000',
            fontFamily: Fonts.light,
            letterSpacing: 1.5,
            fontSize: 22,
          } as any,
          headerShadowVisible: false,
        }}
      />
      <ScrollView contentContainerStyle={[styles.scrollContent, { backgroundColor: isDark ? '#030712' : '#f9fafb' }]}>
        {isLiveSession ? (
          <LiveSessionView
            session={session}
            onStop={() => stopMutation.mutate()}
            stopping={stopMutation.isPending}
            showConnectorLabel={showConnectorLabel}
            vehicleLabel={vehicleLabel}
          />
        ) : (
          <SessionSummary
            session={session}
            fallbackKwh={lastObservedKwh}
          />
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  scrollContent: { flexGrow: 1, backgroundColor: '#f9fafb' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#f9fafb' },
  errorText: { color: '#ef4444', fontSize: 15 },

  // ── Live view ──
  liveContainer: {
    flex: 1,
    padding: 24,
    alignItems: 'center',
    paddingTop: 32,
  },
  liveHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  liveDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#10b981',
  },
  liveLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#10b981',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  liveSiteName: {
    fontSize: 20,
    fontWeight: '700',
    color: '#111827',
    textAlign: 'center',
    marginBottom: 4,
  },
  liveConnector: {
    fontSize: 13,
    color: '#6b7280',
    textAlign: 'center',
    marginBottom: 4,
  },
  liveChargerSerial: {
    fontSize: 12,
    textAlign: 'center',
    marginBottom: 28,
  },
  kwhContainer: { alignItems: 'center', marginBottom: 32 },
  kwhValue: { fontSize: 72, fontWeight: '800', color: '#10b981', lineHeight: 80 },
  kwhUnit: { fontSize: 16, color: '#6b7280', marginTop: 4 },
  liveStats: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 20,
    width: '100%',
    marginBottom: 32,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  liveStat: { flex: 1, alignItems: 'center' },
  liveStatValue: { fontSize: 20, fontWeight: '700', color: '#111827' },
  costValue: { color: '#10b981' },
  liveStatLabel: { fontSize: 11, color: '#9ca3af', marginTop: 4, textTransform: 'uppercase' },
  liveStatDivider: { width: 1, backgroundColor: '#e5e7eb', marginVertical: 4 },
  stopButton: {
    backgroundColor: '#ef4444',
    borderRadius: 14,
    paddingVertical: 16,
    paddingHorizontal: 48,
    alignItems: 'center',
    width: '100%',
    marginBottom: 12,
  },
  stopButtonText: { color: '#fff', fontSize: 17, fontWeight: '700' },
  buttonDisabled: { opacity: 0.6 },
  pollingNote: { fontSize: 11, color: '#d1d5db' },
  slideTrack: {
    height: 56,
    borderRadius: 28,
    justifyContent: 'center',
    overflow: 'hidden',
    alignSelf: 'center',
    marginTop: 8,
    marginBottom: 8,
  },
  slideLabel: { position: 'absolute', alignSelf: 'center', fontSize: 13, fontWeight: '800' },
  slideKnob: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
    overflow: 'hidden',
  },
  slideKnobLogo: { width: 56, height: 56 },

  // ── Summary view ──
  summaryContainer: {
    flex: 1,
    padding: 24,
    alignItems: 'center',
    paddingTop: 12,
  },
  summarySubtitle: { fontSize: 18, fontWeight: '700', color: '#6b7280', marginBottom: 4, textAlign: 'center' },
  summaryAddress: { fontSize: 13, marginBottom: 4, textAlign: 'center' },
  summaryDetailLine: { fontSize: 12, marginBottom: 2, textAlign: 'center' },
  summaryStats: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 14,
    marginBottom: 20,
    width: '100%',
  },
  statCard: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'flex-start',
    minHeight: 96,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 6,
    elevation: 2,
  },
  statCardContent: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingTop: 10,
  },
  statCardHighlight: { backgroundColor: '#ecfdf5' },
  statCardHighlightDark: { backgroundColor: '#052e2b', borderWidth: 1, borderColor: '#065f46' },
  statIconSlot: {
    height: 28,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 8,
  },
  statIcon: { fontSize: 24, lineHeight: 24, marginBottom: 0 },
  moneyIconCircle: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 0,
    backgroundColor: 'transparent',
  },
  moneyIconText: {
    fontSize: 13,
    fontWeight: '700',
    lineHeight: 14,
  },
  statValue: { fontSize: 18, lineHeight: 22, fontWeight: '700', color: '#111827', textAlign: 'center', minHeight: 22 },
  statValueHighlight: { color: '#10b981' },
  statLabel: { fontSize: 10, lineHeight: 12, color: '#9ca3af', marginTop: 3, textTransform: 'none' },
  paymentSuccess: {
    backgroundColor: '#d1fae5',
    borderRadius: 10,
    padding: 10,
    width: '100%',
    marginBottom: 16,
  },
  paymentSuccessText: { color: '#065f46', fontSize: 13, textAlign: 'center', fontWeight: '600' },
  paymentPending: {
    backgroundColor: '#fef9c3',
    borderRadius: 10,
    padding: 10,
    width: '100%',
    marginBottom: 16,
  },
  paymentPendingText: { color: '#713f12', fontSize: 13, textAlign: 'center' },
  summaryMeta: {
    backgroundColor: '#f3f4f6',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    width: '100%',
    marginBottom: 24,
  },
  metaText: { fontSize: 13, color: '#6b7280' },
  breakdownTitle: { fontSize: 14, fontWeight: '700', marginBottom: 4, textAlign: 'center' },
  breakdownTotal: { marginTop: 6, fontWeight: '700' },
  receiptRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#d1d5db',
    gap: 10,
  },
  receiptRowNoBorder: { borderBottomWidth: 0, justifyContent: 'center', paddingTop: 10, paddingBottom: 2 },
  receiptLabel: { flex: 1, fontSize: 12, lineHeight: 16 },
  receiptLabelMulti: { paddingRight: 8 },
  receiptLabelEmphasis: { fontWeight: '700', fontSize: 13 },
  receiptValue: { fontSize: 12, fontWeight: '600', textAlign: 'right', minWidth: 88 },
  receiptValueEmphasis: { fontSize: 15, fontWeight: '800' },
  receiptThanks: { fontSize: 12, fontWeight: '600', textAlign: 'center' },
  doneButton: {
    backgroundColor: '#10b981',
    borderRadius: 14,
    paddingVertical: 15,
    paddingHorizontal: 40,
    alignItems: 'center',
    width: '100%',
  },
  doneButtonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});

// ── Stop Modal Styles ─────────────────────────────────────────────────────────
const stopModal = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    borderRadius: 20,
    paddingVertical: 32,
    paddingHorizontal: 28,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 20,
    elevation: 12,
  },
  title: {
    fontSize: 22,
    fontWeight: '800',
    marginBottom: 10,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 28,
    lineHeight: 20,
  },
  confirmBtn: {
    backgroundColor: '#dc2626',
    borderRadius: 12,
    paddingVertical: 15,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
    minHeight: 50,
  },
  confirmBtnDisabled: {
    opacity: 0.6,
  },
  confirmBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  cancelBtn: {
    borderWidth: 1.5,
    borderRadius: 12,
    paddingVertical: 14,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 50,
  },
  cancelBtnText: {
    fontSize: 15,
    fontWeight: '600',
  },
});
