import { prisma } from '@ev-charger/shared';
import { cancelReservation } from '../lib/ocppClient';

/**
 * Background job: expire stale reservations.
 *
 * Runs on a 30-second setInterval inside the API process.
 *
 * ── Design notes (Astra constraint #2) ─────────────────────────────────
 * - **Single-instance v1**: This job runs in-process. If the API is scaled
 *   to multiple instances, each instance will run this job independently.
 *   The updateMany WHERE clause is idempotent (only matches PENDING/CONFIRMED
 *   with holdExpiresAt in the past), so concurrent runs are safe — at worst
 *   one instance expires a reservation and the other finds zero rows.
 * - **Idempotent**: Uses status filter in WHERE, so re-running on already-
 *   expired reservations is a no-op.
 * - **OCPP CancelReservation**: Sent best-effort for reservations that had
 *   ocppSent=true. Failures are logged but don't block expiry.
 * - **Scaling follow-up**: If API scales beyond 1 instance, consider moving
 *   to a proper job queue (e.g., pg-boss, BullMQ) or a single leader-elected
 *   cron. The current approach is safe but wastes redundant DB queries.
 */

const EXPIRY_INTERVAL_MS = 30_000; // 30 seconds
const ACTIVE_STATUSES = ['PENDING', 'CONFIRMED'] as const;

let intervalHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Find and expire all reservations past their holdExpiresAt.
 * Returns the count of expired reservations.
 */
async function expireStaleReservations(): Promise<number> {
  const now = new Date();

  // Find reservations to expire (need individual records for OCPP cancel)
  const staleReservations = await prisma.reservation.findMany({
    where: {
      status: { in: [...ACTIVE_STATUSES] },
      holdExpiresAt: { lt: now },
    },
    select: {
      id: true,
      reservationId: true,
      connectorRefId: true,
      ocppSent: true,
    },
  });

  if (staleReservations.length === 0) return 0;

  // Batch update all to EXPIRED (idempotent — WHERE ensures only active ones)
  const result = await prisma.reservation.updateMany({
    where: {
      id: { in: staleReservations.map((r) => r.id) },
      status: { in: [...ACTIVE_STATUSES] },
    },
    data: {
      status: 'EXPIRED',
      updatedAt: now,
    },
  });

  // Fire-and-forget OCPP CancelReservation for each that was OCPP-sent
  for (const reservation of staleReservations) {
    if (!reservation.ocppSent) continue;

    // Look up charger ocppId for the OCPP cancel call
    sendOcppCancelForExpired(reservation).catch((err) => {
      console.error(`[ReservationExpiry] OCPP cancel failed for reservationId=${reservation.reservationId}:`, err);
    });
  }

  if (result.count > 0) {
    console.log(`[ReservationExpiry] Expired ${result.count} stale reservation(s)`);
  }

  return result.count;
}

/**
 * Send OCPP CancelReservation for an expired reservation (best-effort).
 */
async function sendOcppCancelForExpired(reservation: {
  id: string;
  reservationId: number;
  connectorRefId: string;
}): Promise<void> {
  const connector = await prisma.connector.findUnique({
    where: { id: reservation.connectorRefId },
    include: { charger: { select: { ocppId: true } } },
  });
  if (!connector) return;

  const status = await cancelReservation(connector.charger.ocppId, reservation.reservationId);
  console.log(`[ReservationExpiry] OCPP CancelReservation ${status} reservationId=${reservation.reservationId}`);
}

/**
 * Start the reservation expiry background job.
 * Call once on app ready. Safe to call multiple times (idempotent start).
 */
export function startReservationExpiryJob(): void {
  if (intervalHandle) return; // Already running

  console.log(`[ReservationExpiry] Starting background job (interval=${EXPIRY_INTERVAL_MS}ms)`);

  intervalHandle = setInterval(async () => {
    try {
      await expireStaleReservations();
    } catch (err) {
      console.error('[ReservationExpiry] Job error:', err);
    }
  }, EXPIRY_INTERVAL_MS);

  // Don't block process exit
  if (intervalHandle.unref) intervalHandle.unref();
}

/**
 * Stop the reservation expiry background job.
 * Call on graceful shutdown.
 */
export function stopReservationExpiryJob(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[ReservationExpiry] Background job stopped');
  }
}
