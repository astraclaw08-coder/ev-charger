import { splitTouDuration } from '@ev-charger/shared';

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
  softwareFeeIncludesActivation?: boolean;
}) {
  const computedKwh = computeDeliveredKwh(session);
  const durationMinutes = resolveDurationMinutes(session);
  const pricingMode = session.pricingMode === 'tou' ? 'tou' : 'flat';
  const pricePerKwhUsd = Math.max(0, toFiniteNumber(session.ratePerKwh) ?? toFiniteNumber(session.pricePerKwhUsd) ?? 0);
  const idleFeePerMinUsd = Math.max(0, toFiniteNumber(session.idleFeePerMinUsd) ?? 0);
  const gracePeriodMin = Math.max(0, toFiniteNumber(session.gracePeriodMin) ?? 0);
  const deliveredKwh = Math.max(0, toFiniteNumber(computedKwh) ?? 0);
  const durationForBreakdown = Math.max(0, toFiniteNumber(durationMinutes) ?? 0);

  const rawSegments = durationMinutes != null && session.startedAt && session.stoppedAt
    ? splitTouDuration({
        startedAt: session.startedAt,
        stoppedAt: session.stoppedAt,
        pricingMode,
        defaultPricePerKwhUsd: pricePerKwhUsd,
        defaultIdleFeePerMinUsd: idleFeePerMinUsd,
        touWindows: session.touWindows,
      })
    : [];

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
  const billableIdleMinutes = Math.max(0, durationForBreakdown - gracePeriodMin);
  const detailedSegments: BillingSegment[] = fallbackSegment.map((seg) => {
    const ratio = segmentMinutesTotal > 0 ? seg.minutes / segmentMinutesTotal : (fallbackSegment.length > 0 ? 1 / fallbackSegment.length : 0);
    const kwh = deliveredKwh * ratio;
    const idleMinutes = billableIdleMinutes * ratio;
    const energyAmountUsd = kwh * seg.pricePerKwhUsd;
    const idleAmountUsd = idleMinutes * seg.idleFeePerMinUsd;
    return {
      ...seg,
      kwh: Number(kwh.toFixed(6)),
      energyAmountUsd: Number(energyAmountUsd.toFixed(6)),
      idleMinutes: Number(idleMinutes.toFixed(6)),
      idleAmountUsd: Number(idleAmountUsd.toFixed(6)),
    };
  });

  const energyTotalUsd = detailedSegments.reduce((sum, seg) => sum + seg.energyAmountUsd, 0);
  const idleTotalUsd = detailedSegments.reduce((sum, seg) => sum + seg.idleAmountUsd, 0);
  const activationTotalUsd = Math.max(0, toFiniteNumber(session.activationFeeUsd) ?? 0);
  const breakdownGrossUsd = energyTotalUsd + idleTotalUsd + activationTotalUsd;

  const breakdown: BillingBreakdown = {
    pricingMode,
    durationMinutes: Number(durationForBreakdown.toFixed(6)),
    gracePeriodMin: Number(gracePeriodMin.toFixed(6)),
    energy: {
      kwhDelivered: Number(deliveredKwh.toFixed(6)),
      totalUsd: Number(energyTotalUsd.toFixed(6)),
      segments: detailedSegments,
    },
    idle: {
      minutes: Number(billableIdleMinutes.toFixed(6)),
      totalUsd: Number(idleTotalUsd.toFixed(6)),
      segments: detailedSegments.map((seg) => ({
        startedAt: seg.startedAt,
        endedAt: seg.endedAt,
        minutes: seg.idleMinutes,
        idleFeePerMinUsd: seg.idleFeePerMinUsd,
        amountUsd: seg.idleAmountUsd,
        source: seg.source,
      })),
    },
    activation: {
      totalUsd: Number(activationTotalUsd.toFixed(6)),
    },
    grossTotalUsd: Number(breakdownGrossUsd.toFixed(6)),
  };

  const hasBillableSignal = session.revenueUsd != null
    || computedKwh != null
    || durationMinutes != null
    || (toFiniteNumber(session.activationFeeUsd) ?? 0) > 0;
  const grossAmountCents = session.revenueUsd != null
    ? Math.round(session.revenueUsd * 100)
    : hasBillableSignal
      ? Math.round(breakdown.grossTotalUsd * 100)
      : null;

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

  const effectiveAmountCents = isFinal
    ? finalPaymentAmountCents
    : estimatedAmountCents ?? finalPaymentAmountCents;

  const amountState: AmountState = isFinal
    ? 'FINAL'
    : isPending
      ? (effectiveAmountCents != null ? 'PENDING' : 'UNAVAILABLE')
      : (effectiveAmountCents != null ? 'ESTIMATED' : 'UNAVAILABLE');

  const amountLabel =
    amountState === 'FINAL'
      ? 'Final total'
      : amountState === 'PENDING'
        ? 'Pending (estimated)'
        : amountState === 'ESTIMATED'
          ? 'Estimated total'
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
        grossUsd: Number((((grossAmountCents ?? 0)) / 100).toFixed(6)),
        vendorFeeUsd: Number(vendorFeeUsd.toFixed(6)),
        netUsd: Number(((effectiveAmountCents ?? 0) / 100).toFixed(6)),
      },
    },
    amountState,
    amountLabel,
    isAmountFinal: amountState === 'FINAL',
  };
}
