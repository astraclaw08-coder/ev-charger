/**
 * Core billing engine — shared across API, OCPP server, and snapshot capture.
 * Lives in @ev-charger/shared so all packages can compute billing consistently.
 */
import { splitTouDuration } from '../touPricing';

type PaymentLike = {
  status?: string | null;
  amountCents?: number | null;
} | null;

export type AmountState = 'FINAL' | 'PENDING' | 'ESTIMATED' | 'UNAVAILABLE';
export type SoftwareVendorFeeMode = 'none' | 'percentage_total' | 'fixed_per_kwh' | 'fixed_per_minute';
export type BillingSegment = {
  startedAt: string;
  endedAt: string;
  minutes: number;
  source: 'flat' | 'tou';
  pricePerKwhUsd: number;
  idleFeePerMinUsd: number;
  kwh: number;
  energyAmountUsd: number;
  idleMinutes: number;
  idleAmountUsd: number;
};
export type BillingBreakdown = {
  pricingMode: 'flat' | 'tou';
  durationMinutes: number;
  gracePeriodMin: number;
  energy: {
    kwhDelivered: number;
    totalUsd: number;
    segments: BillingSegment[];
  };
  idle: {
    minutes: number;
    totalUsd: number;
    segments: Array<{
      startedAt: string;
      endedAt: string;
      minutes: number;
      idleFeePerMinUsd: number;
      amountUsd: number;
      source: 'flat' | 'tou';
    }>;
  };
  activation: {
    totalUsd: number;
  };
  grossTotalUsd: number;
};

const FINAL_PAYMENT_STATUSES = new Set(['CAPTURED', 'REFUNDED']);
const PENDING_PAYMENT_STATUSES = new Set(['PENDING', 'AUTHORIZED']);

function toFiniteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function resolveDurationMinutes(input: {
  durationMinutes?: number | null;
  startedAt?: Date | string | null;
  stoppedAt?: Date | string | null;
}): number | null {
  const direct = toFiniteNumber(input.durationMinutes);
  if (direct != null && direct >= 0) return direct;
  if (!input.startedAt || !input.stoppedAt) return null;
  const start = new Date(input.startedAt).getTime();
  const stop = new Date(input.stoppedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(stop) || stop <= start) return null;
  return (stop - start) / 60000;
}

export function computeVendorFeeUsd(input: {
  grossAmountUsd: number;
  kwhDelivered?: number | null;
  durationMinutes?: number | null;
  softwareVendorFeeMode?: string | null;
  softwareVendorFeeValue?: number | null;
  activationFeeUsd?: number | null;
  softwareFeeIncludesActivation?: boolean;
}): number {
  const grossAmountUsd = Math.max(0, toFiniteNumber(input.grossAmountUsd) ?? 0);
  const activationFeeUsd = Math.max(0, toFiniteNumber(input.activationFeeUsd) ?? 0);
  const energyIdleBaseUsd = Math.max(0, grossAmountUsd - activationFeeUsd);
  const mode = (input.softwareVendorFeeMode ?? 'none') as SoftwareVendorFeeMode;
  const value = Math.max(0, toFiniteNumber(input.softwareVendorFeeValue) ?? 0);

  if (mode === 'percentage_total') {
    const pctFee = energyIdleBaseUsd * (value / 100);
    const activationPassThrough = input.softwareFeeIncludesActivation ? activationFeeUsd : 0;
    return Math.min(grossAmountUsd, pctFee + activationPassThrough);
  }
  if (mode === 'fixed_per_kwh') {
    const kwh = Math.max(0, toFiniteNumber(input.kwhDelivered) ?? 0);
    const baseFee = kwh * value;
    const activationPassThrough = input.softwareFeeIncludesActivation ? activationFeeUsd : 0;
    return Math.min(grossAmountUsd, baseFee + activationPassThrough);
  }
  if (mode === 'fixed_per_minute') {
    const mins = Math.max(0, toFiniteNumber(input.durationMinutes) ?? 0);
    const baseFee = mins * value;
    const activationPassThrough = input.softwareFeeIncludesActivation ? activationFeeUsd : 0;
    return Math.min(grossAmountUsd, baseFee + activationPassThrough);
  }
  return input.softwareFeeIncludesActivation ? Math.min(grossAmountUsd, activationFeeUsd) : 0;
}

export function computeDeliveredKwh(session: {
  meterStart?: number | null;
  meterStop?: number | null;
  kwhDelivered?: number | null;
}) {
  const meterDerivedKwh =
    session.meterStop != null && session.meterStart != null
      ? Math.max(0, (session.meterStop - session.meterStart) / 1000)
      : null;
  if (meterDerivedKwh == null) return session.kwhDelivered ?? null;
  return Math.max(session.kwhDelivered ?? 0, meterDerivedKwh);
}

/**
 * Derive charging windows by subtracting idle windows from the session timespan.
 * Returns the time periods the charger was actively delivering power.
 */
export function deriveChargingWindows(
  sessionStart: Date | null,
  sessionStop: Date | null,
  idleWindows: Array<{ startedAt: Date | string; stoppedAt: Date | string }>,
): Array<{ startedAt: Date; stoppedAt: Date }> {
  if (!sessionStart || !sessionStop) return [];
  const startMs = sessionStart.getTime();
  const stopMs = sessionStop.getTime();
  if (stopMs <= startMs) return [];
  if (idleWindows.length === 0) return [{ startedAt: sessionStart, stoppedAt: sessionStop }];

  // Sort idle windows chronologically
  const sorted = [...idleWindows]
    .map((w) => ({
      startMs: new Date(w.startedAt).getTime(),
      stopMs: new Date(w.stoppedAt).getTime(),
    }))
    .filter((w) => w.stopMs > w.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  const windows: Array<{ startedAt: Date; stoppedAt: Date }> = [];
  let cursor = startMs;

  for (const idle of sorted) {
    const idleStart = Math.max(idle.startMs, startMs);
    const idleStop = Math.min(idle.stopMs, stopMs);
    if (idleStart >= idleStop) continue; // idle window outside session
    if (cursor < idleStart) {
      windows.push({ startedAt: new Date(cursor), stoppedAt: new Date(idleStart) });
    }
    cursor = Math.max(cursor, idleStop);
  }

  // Remaining charging after last idle window
  if (cursor < stopMs) {
    windows.push({ startedAt: new Date(cursor), stoppedAt: new Date(stopMs) });
  }

  return windows;
}

export function computeSessionAmounts(session: {
  meterStart?: number | null;
  meterStop?: number | null;
  kwhDelivered?: number | null;
  ratePerKwh?: number | null;
  payment?: PaymentLike;
  revenueUsd?: number | null;
  durationMinutes?: number | null;
  startedAt?: Date | string | null;
  stoppedAt?: Date | string | null;
  softwareVendorFeeMode?: string | null;
  softwareVendorFeeValue?: number | null;
  activationFeeUsd?: number | null;
  pricingMode?: string | null;
  pricePerKwhUsd?: number | null;
  idleFeePerMinUsd?: number | null;
  gracePeriodMin?: number | null;
  touWindows?: unknown;
  siteTimeZone?: string | null;
  softwareFeeIncludesActivation?: boolean;
  idleStartedAt?: Date | string | null;
  idleStoppedAt?: Date | string | null;
  idleWindows?: Array<{ startedAt: Date | string; stoppedAt: Date | string }> | null;
  segmentKwhOverrides?: number[] | null;
}) {
  const computedKwh = computeDeliveredKwh(session);
  const durationMinutes = resolveDurationMinutes(session);
  const pricingMode = session.pricingMode === 'tou' ? 'tou' : 'flat';
  const pricePerKwhUsd = Math.max(0, toFiniteNumber(session.ratePerKwh) ?? toFiniteNumber(session.pricePerKwhUsd) ?? 0);
  const idleFeePerMinUsd = Math.max(0, toFiniteNumber(session.idleFeePerMinUsd) ?? 0);
  const gracePeriodMin = Math.max(0, toFiniteNumber(session.gracePeriodMin) ?? 0);
  const deliveredKwh = Math.max(0, toFiniteNumber(computedKwh) ?? 0);
  const durationForBreakdown = Math.max(0, toFiniteNumber(durationMinutes) ?? 0);

  const billingTimeZone = session.siteTimeZone ?? process.env.EV_TOU_TIMEZONE ?? 'America/Los_Angeles';

  // ── Derive charging windows (session span minus idle windows) ───────────
  // This ensures energy segments only cover periods the charger was actually
  // delivering power, not idle gaps where the EV wasn't drawing current.
  const resolvedIdleWindowsForCharging = (session.idleWindows && session.idleWindows.length > 0)
    ? session.idleWindows
    : (session.idleStartedAt && session.idleStoppedAt
        ? [{ startedAt: session.idleStartedAt, stoppedAt: session.idleStoppedAt }]
        : []);

  const chargingWindows = deriveChargingWindows(
    session.startedAt ? new Date(session.startedAt) : null,
    session.stoppedAt ? new Date(session.stoppedAt) : null,
    resolvedIdleWindowsForCharging,
  );

  const rawSegments: Array<{
    startedAt: string; endedAt: string; minutes: number;
    pricePerKwhUsd: number; idleFeePerMinUsd: number; source: 'flat' | 'tou';
  }> = [];

  if (chargingWindows.length > 0) {
    for (const cw of chargingWindows) {
      const windowSegs = splitTouDuration({
        startedAt: cw.startedAt,
        stoppedAt: cw.stoppedAt,
        pricingMode,
        defaultPricePerKwhUsd: pricePerKwhUsd,
        defaultIdleFeePerMinUsd: idleFeePerMinUsd,
        touWindows: session.touWindows,
        timeZone: billingTimeZone,
      });
      rawSegments.push(...windowSegs);
    }
  } else if (durationMinutes != null && session.startedAt && session.stoppedAt) {
    // No idle windows — full session is charging
    rawSegments.push(...splitTouDuration({
      startedAt: session.startedAt,
      stoppedAt: session.stoppedAt,
      pricingMode,
      defaultPricePerKwhUsd: pricePerKwhUsd,
      defaultIdleFeePerMinUsd: idleFeePerMinUsd,
      touWindows: session.touWindows,
      timeZone: billingTimeZone,
    }));
  }

  const fallbackSegment = rawSegments.length > 0
    ? rawSegments
    : [{
        startedAt: session.startedAt ? new Date(session.startedAt).toISOString() : new Date(0).toISOString(),
        endedAt: session.stoppedAt ? new Date(session.stoppedAt).toISOString() : (session.startedAt ? new Date(session.startedAt).toISOString() : new Date(0).toISOString()),
        minutes: durationForBreakdown,
        pricePerKwhUsd,
        idleFeePerMinUsd,
        source: 'flat' as const,
      }];

  const segmentMinutesTotal = fallbackSegment.reduce((sum, seg) => sum + seg.minutes, 0);

  // ── Multi-window idle billing ───────────────────────────────────────────
  // Resolve idle windows: prefer array, fall back to single idleStartedAt/StoppedAt pair.
  const resolvedIdleWindows = (session.idleWindows && session.idleWindows.length > 0)
    ? session.idleWindows
    : (session.idleStartedAt && session.idleStoppedAt
        ? [{ startedAt: session.idleStartedAt, stoppedAt: session.idleStoppedAt }]
        : []);

  // Collect TOU-split idle segments from all windows
  const idleSegmentsBase: Array<{
    startedAt: string; endedAt: string; minutes: number;
    pricePerKwhUsd: number; idleFeePerMinUsd: number; source: 'flat' | 'tou';
  }> = [];
  for (const window of resolvedIdleWindows) {
    const windowMinutes = resolveDurationMinutes({ startedAt: window.startedAt, stoppedAt: window.stoppedAt }) ?? 0;
    if (windowMinutes <= 0) continue;
    const windowSegments = splitTouDuration({
      startedAt: window.startedAt,
      stoppedAt: window.stoppedAt,
      pricingMode,
      defaultPricePerKwhUsd: pricePerKwhUsd,
      defaultIdleFeePerMinUsd: idleFeePerMinUsd,
      touWindows: session.touWindows,
      timeZone: billingTimeZone,
    });
    if (windowSegments.length > 0) {
      idleSegmentsBase.push(...windowSegments);
    } else {
      idleSegmentsBase.push({
        startedAt: new Date(window.startedAt).toISOString(),
        endedAt: new Date(window.stoppedAt).toISOString(),
        minutes: windowMinutes,
        pricePerKwhUsd,
        idleFeePerMinUsd,
        source: 'flat' as const,
      });
    }
  }

  const detailedSegments: BillingSegment[] = fallbackSegment.map((seg, idx) => {
    const kwh = session.segmentKwhOverrides?.[idx] != null
      ? session.segmentKwhOverrides[idx]
      : deliveredKwh * (segmentMinutesTotal > 0 ? seg.minutes / segmentMinutesTotal : (fallbackSegment.length > 0 ? 1 / fallbackSegment.length : 0));
    const energyAmountUsd = kwh * seg.pricePerKwhUsd;
    return {
      ...seg,
      kwh: Number(kwh.toFixed(4)),
      energyAmountUsd: Math.round(energyAmountUsd * 100) / 100,
      idleMinutes: 0,
      idleAmountUsd: 0,
    };
  });

  // Apply grace period chronologically: subtract from the first idle segment,
  // spilling remainder to subsequent segments if the first is shorter than grace.
  const sortedIdleSegments = [...idleSegmentsBase].sort(
    (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime(),
  );
  let remainingGrace = gracePeriodMin;
  const idleBreakdownSegments = sortedIdleSegments.map((seg) => {
    const segMinutesAfterGrace = Math.max(0, seg.minutes - remainingGrace);
    remainingGrace = Math.max(0, remainingGrace - seg.minutes);
    const amountUsd = segMinutesAfterGrace * seg.idleFeePerMinUsd;
    return {
      startedAt: seg.startedAt,
      endedAt: seg.endedAt,
      minutes: Math.round(segMinutesAfterGrace * 100) / 100,
      idleFeePerMinUsd: seg.idleFeePerMinUsd,
      amountUsd: Math.round(amountUsd * 100) / 100,
      source: seg.source,
    };
  });

  // Sum already-rounded segment values so line items always add up to subtotals.
  const energyTotalUsd = Math.round(detailedSegments.reduce((sum, seg) => sum + seg.energyAmountUsd, 0) * 100) / 100;
  const idleTotalUsd = Math.round(idleBreakdownSegments.reduce((sum, seg) => sum + seg.amountUsd, 0) * 100) / 100;
  const totalBillableIdleMinutes = Math.round(idleBreakdownSegments.reduce((sum, seg) => sum + seg.minutes, 0) * 100) / 100;
  const activationTotalUsd = Math.round(Math.max(0, toFiniteNumber(session.activationFeeUsd) ?? 0) * 100) / 100;
  const breakdownGrossUsd = Math.round((energyTotalUsd + idleTotalUsd + activationTotalUsd) * 100) / 100;

  const breakdown: BillingBreakdown = {
    pricingMode,
    durationMinutes: Math.round(durationForBreakdown * 100) / 100,
    gracePeriodMin,
    energy: {
      kwhDelivered: Number(deliveredKwh.toFixed(4)),
      totalUsd: energyTotalUsd,
      segments: detailedSegments,
    },
    idle: {
      minutes: totalBillableIdleMinutes,
      totalUsd: idleTotalUsd,
      segments: idleBreakdownSegments,
    },
    activation: { totalUsd: activationTotalUsd },
    grossTotalUsd: breakdownGrossUsd,
  };

  const hasBillableSignal = session.revenueUsd != null || computedKwh != null || durationMinutes != null || (toFiniteNumber(session.activationFeeUsd) ?? 0) > 0;
  const grossAmountCents = session.revenueUsd != null
    ? Math.round(session.revenueUsd * 100)
    : hasBillableSignal ? Math.round(breakdown.grossTotalUsd * 100) : null;

  const vendorFeeUsd = computeVendorFeeUsd({
    grossAmountUsd: (grossAmountCents ?? 0) / 100,
    kwhDelivered: computedKwh,
    durationMinutes,
    softwareVendorFeeMode: session.softwareVendorFeeMode,
    softwareVendorFeeValue: session.softwareVendorFeeValue,
    activationFeeUsd: session.activationFeeUsd,
    softwareFeeIncludesActivation: session.softwareFeeIncludesActivation,
  });
  const vendorFeeCents = Math.round(vendorFeeUsd * 100);
  const estimatedAmountCents = grossAmountCents != null ? Math.max(0, grossAmountCents - vendorFeeCents) : null;

  const paymentStatus = String(session.payment?.status ?? '').toUpperCase();
  const paymentAmountCents = session.payment?.amountCents ?? null;
  const finalPaymentAmountCents = paymentAmountCents != null ? Math.max(0, paymentAmountCents - vendorFeeCents) : null;

  const isFinal = FINAL_PAYMENT_STATUSES.has(paymentStatus) && finalPaymentAmountCents != null;
  const isPending = PENDING_PAYMENT_STATUSES.has(paymentStatus);

  const effectiveAmountCents = isFinal ? finalPaymentAmountCents : estimatedAmountCents ?? finalPaymentAmountCents;

  const amountState: AmountState = isFinal
    ? 'FINAL'
    : isPending
      ? (effectiveAmountCents != null ? 'PENDING' : 'UNAVAILABLE')
      : (effectiveAmountCents != null ? 'ESTIMATED' : 'UNAVAILABLE');

  const amountLabel = amountState === 'FINAL' ? 'Final total'
    : amountState === 'PENDING' ? 'Pending (estimated)'
    : amountState === 'ESTIMATED' ? 'Estimated total'
    : 'Total unavailable';

  return {
    kwhDelivered: computedKwh,
    durationMinutes,
    costEstimateCents: estimatedAmountCents,
    estimatedAmountCents,
    effectiveAmountCents,
    grossAmountCents,
    vendorFeeCents,
    vendorFeeUsd,
    billingBreakdown: {
      ...breakdown,
      totals: {
        energyUsd: breakdown.energy.totalUsd,
        idleUsd: breakdown.idle.totalUsd,
        activationUsd: breakdown.activation.totalUsd,
        grossUsd: Number(((grossAmountCents ?? 0) / 100).toFixed(6)),
        vendorFeeUsd: Number(vendorFeeUsd.toFixed(6)),
        netUsd: Number(((effectiveAmountCents ?? 0) / 100).toFixed(6)),
      },
    },
    amountState,
    amountLabel,
    isAmountFinal: amountState === 'FINAL',
  };
}
