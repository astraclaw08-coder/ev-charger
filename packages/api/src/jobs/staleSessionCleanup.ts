import { prisma } from '@ev-charger/shared';

/**
 * Background job: auto-close stale ACTIVE sessions.
 *
 * Catches sessions that the OCPP-side reactive cleanup (StatusNotification
 * handler, CLAUDE.md rule #4) can't reach — e.g. charger went completely
 * silent, never sent a status transition, or was disconnected without
 * reconnecting.
 *
 * ── Design notes ──────────────────────────────────────────────────────────
 * - **Threshold**: Sessions ACTIVE for > 6 hours with no updatedAt change
 *   are considered stale. Real sessions rarely exceed 4-6 hours for L2;
 *   DC fast chargers finish in < 1 hour.
 * - **Idempotent**: WHERE clause filters only ACTIVE sessions past the
 *   threshold, so concurrent instances are safe.
 * - **Conservative**: We set kwhDelivered from whatever meter data exists
 *   on the row (meterStop - meterStart). If both are 0, kWh = 0.
 * - **No OCPP interaction**: Unlike reservation expiry, this job doesn't
 *   need to send OCPP commands — the charger is presumed unreachable.
 * - **Connector reset**: If the connector is still stuck in CHARGING,
 *   reset it to AVAILABLE so it's not permanently blocked.
 */

const INTERVAL_MS = 60_000; // every 60 seconds
const STALE_THRESHOLD_HOURS = 6;

let intervalHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Find and close all ACTIVE sessions that haven't been updated in > STALE_THRESHOLD_HOURS.
 */
async function closeStaleActiveSessions(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_THRESHOLD_HOURS * 60 * 60 * 1000);

  const staleSessions = await prisma.session.findMany({
    where: {
      status: 'ACTIVE',
      updatedAt: { lt: cutoff },
    },
    select: {
      id: true,
      transactionId: true,
      meterStart: true,
      meterStop: true,
      startedAt: true,
      connectorId: true,
    },
  });

  if (staleSessions.length === 0) return 0;

  let closedCount = 0;
  const now = new Date();

  for (const session of staleSessions) {
    try {
      const meterStart = session.meterStart ?? 0;
      const meterStop = session.meterStop ?? meterStart;
      const kwhDelivered = Math.max(0, (meterStop - meterStart) / 1000);

      await prisma.$transaction(async (tx) => {
        // Close the session
        await tx.session.update({
          where: { id: session.id, status: 'ACTIVE' }, // idempotent guard
          data: {
            status: 'COMPLETED',
            stoppedAt: now,
            kwhDelivered,
          },
        });

        // Reset connector if stuck in CHARGING
        if (session.connectorId) {
          await tx.connector.updateMany({
            where: {
              id: session.connectorId,
              status: 'CHARGING',
            },
            data: {
              status: 'AVAILABLE',
              updatedAt: now,
            },
          });
        }
      });

      closedCount++;
      console.log(
        `[StaleSessionCleanup] Auto-closed session ${session.id} (txn=${session.transactionId}) — ` +
        `stale since ${session.startedAt.toISOString()}, kWh=${kwhDelivered.toFixed(3)}`,
      );
    } catch (err) {
      // Likely a concurrent update (another instance closed it first) — safe to skip
      console.error(`[StaleSessionCleanup] Failed to close session ${session.id}:`, err);
    }
  }

  if (closedCount > 0) {
    console.log(`[StaleSessionCleanup] Closed ${closedCount} stale session(s)`);
  }

  return closedCount;
}

/**
 * Start the stale session cleanup background job.
 * Call once on app ready. Safe to call multiple times (idempotent start).
 */
export function startStaleSessionCleanupJob(): void {
  if (intervalHandle) return;

  console.log(`[StaleSessionCleanup] Starting background job (interval=${INTERVAL_MS}ms, threshold=${STALE_THRESHOLD_HOURS}h)`);

  intervalHandle = setInterval(async () => {
    try {
      await closeStaleActiveSessions();
    } catch (err) {
      console.error('[StaleSessionCleanup] Job error:', err);
    }
  }, INTERVAL_MS);

  if (intervalHandle.unref) intervalHandle.unref();
}

/**
 * Stop the stale session cleanup background job.
 */
export function stopStaleSessionCleanupJob(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[StaleSessionCleanup] Background job stopped');
  }
}
