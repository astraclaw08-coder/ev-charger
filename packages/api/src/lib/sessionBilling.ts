type PaymentLike = {
  status?: string | null;
  amountCents?: number | null;
} | null;

export type AmountState = 'FINAL' | 'PENDING' | 'ESTIMATED' | 'UNAVAILABLE';
export type SoftwareVendorFeeMode = 'none' | 'percentage_total' | 'fixed_per_kwh' | 'fixed_per_minute';

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
  softwareFeeIncludesActivation?: boolean;
}) {
  const computedKwh = computeDeliveredKwh(session);
  const grossAmountCents =
    session.revenueUsd != null
      ? Math.round(session.revenueUsd * 100)
      : computedKwh != null && session.ratePerKwh != null
        ? Math.round(computedKwh * session.ratePerKwh * 100)
        : null;

  const durationMinutes = resolveDurationMinutes(session);
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
    amountState,
    amountLabel,
    isAmountFinal: amountState === 'FINAL',
  };
}
