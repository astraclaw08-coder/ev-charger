type PaymentLike = {
  status?: string | null;
  amountCents?: number | null;
} | null;

export type AmountState = 'FINAL' | 'PENDING' | 'ESTIMATED' | 'UNAVAILABLE';

const FINAL_PAYMENT_STATUSES = new Set(['CAPTURED', 'REFUNDED']);
const PENDING_PAYMENT_STATUSES = new Set(['PENDING', 'AUTHORIZED']);

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
}) {
  const computedKwh = computeDeliveredKwh(session);
  const estimatedAmountCents =
    session.revenueUsd != null
      ? Math.round(session.revenueUsd * 100)
      : computedKwh != null && session.ratePerKwh != null
        ? Math.round(computedKwh * session.ratePerKwh * 100)
        : null;

  const paymentStatus = String(session.payment?.status ?? '').toUpperCase();
  const paymentAmountCents = session.payment?.amountCents ?? null;

  const isFinal = FINAL_PAYMENT_STATUSES.has(paymentStatus) && paymentAmountCents != null;
  const isPending = PENDING_PAYMENT_STATUSES.has(paymentStatus);

  const effectiveAmountCents = isFinal
    ? paymentAmountCents
    : estimatedAmountCents ?? paymentAmountCents;

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
    costEstimateCents: estimatedAmountCents,
    estimatedAmountCents,
    effectiveAmountCents,
    amountState,
    amountLabel,
    isAmountFinal: amountState === 'FINAL',
  };
}
