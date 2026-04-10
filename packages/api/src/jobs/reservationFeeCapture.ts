import { prisma } from '@ev-charger/shared';

/**
 * Background job: capture authorized reservation fees after grace period.
 *
 * Runs on a 30-second setInterval inside the API process.
 *
 * After a driver creates a paid reservation, the fee is authorized
 * (Stripe PaymentIntent with capture_method='manual'). During the
 * cancellation grace period, the driver can cancel and we void the
 * authorization. After the grace period expires, this job captures
 * the authorized amount so the site host gets paid.
 *
 * Idempotent: only processes reservations with feeStatus='PENDING'
 * and feeCancelGraceExpiresAt in the past. Safe for concurrent runs
 * across multiple API instances (same pattern as reservationExpiry).
 */

const CAPTURE_INTERVAL_MS = 30_000; // 30 seconds

let intervalHandle: ReturnType<typeof setInterval> | null = null;

async function captureAuthorizedFees(): Promise<number> {
  const now = new Date();

  // Find reservations where:
  // - Fee was authorized (feeStatus = PENDING)
  // - Grace period has expired
  // - Reservation is NOT cancelled (cancelled ones should have been voided)
  const pendingCaptures = await prisma.reservation.findMany({
    where: {
      feeStatus: 'PENDING',
      feeCancelGraceExpiresAt: { lt: now },
      status: { notIn: ['CANCELLED'] },
      feeStripePaymentIntentId: { not: null },
    },
    select: {
      id: true,
      reservationId: true,
      feeStripePaymentIntentId: true,
      feeAmountCents: true,
    },
  });

  if (pendingCaptures.length === 0) return 0;

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    console.warn('[ReservationFeeCapture] STRIPE_SECRET_KEY not set, skipping capture');
    return 0;
  }

  const { default: Stripe } = await import('stripe');
  const stripe = new Stripe(stripeKey, { apiVersion: '2024-06-20' as any });

  let capturedCount = 0;

  for (const reservation of pendingCaptures) {
    try {
      await stripe.paymentIntents.capture(reservation.feeStripePaymentIntentId!);

      await prisma.reservation.updateMany({
        where: { id: reservation.id, feeStatus: 'PENDING' },
        data: { feeStatus: 'CAPTURED', updatedAt: now },
      });

      capturedCount++;
      console.log(`[ReservationFeeCapture] Captured $${((reservation.feeAmountCents ?? 0) / 100).toFixed(2)} for reservationId=${reservation.reservationId}`);
    } catch (err: any) {
      // PI might have been cancelled by a race with driver cancel
      if (err?.code === 'payment_intent_unexpected_state') {
        await prisma.reservation.updateMany({
          where: { id: reservation.id, feeStatus: 'PENDING' },
          data: { feeStatus: 'VOIDED', updatedAt: now },
        });
        console.warn(`[ReservationFeeCapture] PI already cancelled/voided for reservationId=${reservation.reservationId}`);
      } else {
        console.error(`[ReservationFeeCapture] Failed to capture reservationId=${reservation.reservationId}:`, err);
        await prisma.reservation.updateMany({
          where: { id: reservation.id, feeStatus: 'PENDING' },
          data: { feeStatus: 'FAILED', updatedAt: now },
        });
      }
    }
  }

  if (capturedCount > 0) {
    console.log(`[ReservationFeeCapture] Captured ${capturedCount} reservation fee(s)`);
  }

  return capturedCount;
}

export function startReservationFeeCaptureJob(): void {
  if (intervalHandle) return;

  console.log(`[ReservationFeeCapture] Starting background job (interval=${CAPTURE_INTERVAL_MS}ms)`);

  intervalHandle = setInterval(async () => {
    try {
      await captureAuthorizedFees();
    } catch (err) {
      console.error('[ReservationFeeCapture] Job error:', err);
    }
  }, CAPTURE_INTERVAL_MS);

  if (intervalHandle.unref) intervalHandle.unref();
}

export function stopReservationFeeCaptureJob(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[ReservationFeeCapture] Background job stopped');
  }
}
