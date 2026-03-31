/**
 * Session Safety Enforcement Loop
 *
 * Periodically checks active sessions against site-level limits:
 * - maxChargeDurationMin: auto-stop after N minutes of active charging
 * - maxIdleDurationMin: auto-stop after N minutes idle (no energy flow change)
 * - maxSessionCostUsd: auto-stop when estimated cost reaches threshold
 *
 * Sends RemoteStopTransaction to the charger when a limit is breached.
 */

import { prisma } from '@ev-charger/shared';
import { remoteStopTransaction } from './remote';

const CHECK_INTERVAL_MS = 60_000; // Check every 60 seconds

// Track last known meterStop per session to detect idle (no energy flow)
const lastKnownMeter = new Map<string, { wh: number; since: Date }>();

export function startSessionSafetyLoop(): void {
  console.log('[SessionSafety] Enforcement loop started (interval: 60s)');

  setInterval(async () => {
    try {
      await checkSessionLimits();
    } catch (err) {
      console.error('[SessionSafety] Error in enforcement loop:', err);
    }
  }, CHECK_INTERVAL_MS);
}

async function checkSessionLimits(): Promise<void> {
  const sessions = await prisma.session.findMany({
    where: { status: 'ACTIVE' },
    select: {
      id: true,
      transactionId: true,
      startedAt: true,
      meterStart: true,
      meterStop: true,
      kwhDelivered: true,
      ratePerKwh: true,
      updatedAt: true,
      connector: {
        select: {
          charger: {
            select: {
              ocppId: true,
              site: {
                select: {
                  maxChargeDurationMin: true,
                  maxIdleDurationMin: true,
                  maxSessionCostUsd: true,
                  pricePerKwhUsd: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (sessions.length === 0) {
    // Clean up stale idle tracking entries
    lastKnownMeter.clear();
    return;
  }

  const now = new Date();
  const activeIds = new Set(sessions.map((s: any) => s.id));

  // Clean up tracking for sessions that are no longer active
  for (const key of lastKnownMeter.keys()) {
    if (!activeIds.has(key)) lastKnownMeter.delete(key);
  }

  for (const session of sessions) {
    const site = session.connector.charger.site;
    if (!site) continue;
    if (!session.transactionId) continue;

    const hasAnyLimit = site.maxChargeDurationMin || site.maxIdleDurationMin || site.maxSessionCostUsd;
    if (!hasAnyLimit) continue;

    const ocppId = session.connector.charger.ocppId;
    const durationMin = (now.getTime() - session.startedAt.getTime()) / 60_000;

    // 1. Max charging duration
    if (site.maxChargeDurationMin && durationMin >= site.maxChargeDurationMin) {
      console.log(
        `[SessionSafety] DURATION LIMIT — session ${session.id} on ${ocppId}: ` +
        `${durationMin.toFixed(1)}min >= ${site.maxChargeDurationMin}min limit. Sending RemoteStop.`,
      );
      await safeRemoteStop(ocppId, session.transactionId, 'duration_limit');
      lastKnownMeter.delete(session.id);
      continue;
    }

    // 2. Max idle duration (meterStop hasn't changed for N minutes)
    if (site.maxIdleDurationMin && session.meterStop != null) {
      const currentWh = session.meterStop;
      const tracked = lastKnownMeter.get(session.id);

      if (!tracked || tracked.wh !== currentWh) {
        // Energy is flowing or first observation — reset idle timer
        lastKnownMeter.set(session.id, { wh: currentWh, since: now });
      } else {
        // Energy hasn't changed since last check
        const idleMin = (now.getTime() - tracked.since.getTime()) / 60_000;
        if (idleMin >= site.maxIdleDurationMin) {
          console.log(
            `[SessionSafety] IDLE LIMIT — session ${session.id} on ${ocppId}: ` +
            `idle ${idleMin.toFixed(1)}min (no energy flow) >= ${site.maxIdleDurationMin}min limit. Sending RemoteStop.`,
          );
          await safeRemoteStop(ocppId, session.transactionId, 'idle_limit');
          lastKnownMeter.delete(session.id);
          continue;
        }
      }
    }

    // 3. Max session cost
    if (site.maxSessionCostUsd && session.kwhDelivered != null) {
      const rate = session.ratePerKwh ?? site.pricePerKwhUsd;
      const estimatedCost = session.kwhDelivered * rate;

      if (estimatedCost >= site.maxSessionCostUsd) {
        console.log(
          `[SessionSafety] COST LIMIT — session ${session.id} on ${ocppId}: ` +
          `$${estimatedCost.toFixed(2)} >= $${site.maxSessionCostUsd.toFixed(2)} cap. Sending RemoteStop.`,
        );
        await safeRemoteStop(ocppId, session.transactionId, 'cost_limit');
        lastKnownMeter.delete(session.id);
        continue;
      }
    }
  }
}

async function safeRemoteStop(
  ocppId: string,
  transactionId: number,
  reason: string,
): Promise<void> {
  try {
    const result = await remoteStopTransaction(ocppId, transactionId);
    console.log(`[SessionSafety] RemoteStop for ${ocppId} (txn ${transactionId}, reason: ${reason}): ${result}`);
  } catch (err) {
    console.error(`[SessionSafety] Failed RemoteStop for ${ocppId} (txn ${transactionId}, reason: ${reason}):`, err);
  }
}
