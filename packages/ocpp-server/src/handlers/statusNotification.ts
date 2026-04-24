import { prisma, splitTouDuration, captureSessionBillingSnapshot } from '@ev-charger/shared';
import { recordUptimeEvent, toUptimeEvent } from '../uptimeEvents';
import { enqueueOcppEvent } from '../outbox';
import type { StatusNotificationRequest, ChargerStatus, ConnectorStatus } from '@ev-charger/shared';
import { clearPriorEnergy } from '../fleet/priorEnergyState';
import { onSessionEnd as fleetSchedulerOnSessionEnd } from '../fleet/fleetScheduler';

function fleetFlagEnabled(): boolean {
  return process.env.FLEET_GATED_SESSIONS_ENABLED === 'true';
}

// Map OCPP ChargePointStatus to Prisma ConnectorStatus
function toConnectorStatus(ocppStatus: string): ConnectorStatus {
  const map: Record<string, ConnectorStatus> = {
    Available:     'AVAILABLE',
    Preparing:     'PREPARING',
    Charging:      'CHARGING',
    SuspendedEVSE: 'SUSPENDED_EVSE',
    SuspendedEV:   'SUSPENDED_EV',
    Finishing:     'FINISHING',
    Reserved:      'RESERVED',
    Unavailable:   'UNAVAILABLE',
    Faulted:       'FAULTED',
  };
  return map[ocppStatus] ?? 'UNAVAILABLE';
}

// Map OCPP status for the charger-level (connectorId=0)
function toChargerStatus(ocppStatus: string): ChargerStatus {
  if (ocppStatus === 'Faulted') return 'FAULTED';
  if (ocppStatus === 'Unavailable') return 'OFFLINE';
  return 'ONLINE';
}

export async function handleStatusNotification(
  _client: any,
  chargerId: string,
  params: StatusNotificationRequest,
): Promise<Record<string, never>> {
  const { connectorId, status, errorCode } = params;
  console.log(`[StatusNotification] chargerId=${chargerId} connector=${connectorId} status=${status} error=${errorCode}`);

  let orphanSessionIdToSnapshot: string | null = null;

  await prisma.$transaction(async (tx: any) => {
    if (connectorId === 0) {
      // ConnectorId 0 = the charger itself
      const mapped = toChargerStatus(status);
      await tx.charger.update({
        where: { id: chargerId },
        data: { status: mapped },
      });
    } else {
      const nextStatus = toConnectorStatus(status);
      const previous = await tx.connector.findUnique({
        where: { chargerId_connectorId: { chargerId, connectorId } },
        select: { id: true, status: true },
      });

      const connector = await tx.connector.upsert({
        where: {
          chargerId_connectorId: { chargerId, connectorId },
        },
        update: { status: nextStatus },
        create: {
          chargerId,
          connectorId,
          status: nextStatus,
        },
        select: { id: true },
      });

      const prevStatus = previous?.status;
      if (prevStatus && prevStatus !== nextStatus) {
        const transitionType = (() => {
          if (prevStatus === 'AVAILABLE' && nextStatus === 'PREPARING') return 'PLUG_IN';
          if (
            (prevStatus === 'FINISHING' || prevStatus === 'SUSPENDED_EV' || prevStatus === 'SUSPENDED_EVSE' || prevStatus === 'CHARGING')
            && nextStatus === 'AVAILABLE'
          ) return 'PLUG_OUT';
          if (prevStatus === 'CHARGING' && (nextStatus === 'SUSPENDED_EV' || nextStatus === 'SUSPENDED_EVSE')) return 'IDLE_START';
          if (
            (prevStatus === 'FINISHING' || prevStatus === 'SUSPENDED_EV' || prevStatus === 'SUSPENDED_EVSE')
            && nextStatus === 'AVAILABLE'
          ) return 'IDLE_END';
          return 'STATUS_CHANGE';
        })();

        const payloadTs = params.timestamp ? new Date(params.timestamp) : null;
        const occurredAt = payloadTs && Number.isFinite(payloadTs.getTime()) ? payloadTs : new Date();

        await tx.connectorStateTransition.create({
          data: {
            chargerId,
            connectorRefId: connector.id,
            connectorId,
            fromStatus: prevStatus,
            toStatus: nextStatus,
            transitionType,
            occurredAt,
            payloadTs: payloadTs && Number.isFinite(payloadTs.getTime()) ? payloadTs : null,
          },
        });
      }

      // ── Auto-close orphaned ACTIVE sessions ──────────────────────────
      // When connector reaches Available or Preparing there cannot be a live
      // charging session.  If StopTransaction was lost, finalize here using
      // whatever meter data we have on the session row.
      const SESSION_CLOSE_STATUSES: ConnectorStatus[] = ['AVAILABLE', 'PREPARING'];
      if (SESSION_CLOSE_STATUSES.includes(nextStatus)) {
        const orphan = await tx.session.findFirst({
          where: {
            connector: { chargerId, connectorId },
            status: 'ACTIVE',
          },
          include: {
            connector: {
              include: {
                charger: {
                  include: {
                    site: {
                      select: {
                        pricingMode: true,
                        pricePerKwhUsd: true,
                        idleFeePerMinUsd: true,
                        touWindows: true,
                        timeZone: true,
                      },
                    },
                  },
                },
              },
            },
          },
        });

        if (orphan) {
          const payloadTs = params.timestamp ? new Date(params.timestamp) : null;
          const closedAt = payloadTs && Number.isFinite(payloadTs.getTime()) ? payloadTs : new Date();

          // Use best available meter data for kWh
          const meterStart = orphan.meterStart ?? 0;
          const meterStop = orphan.meterStop ?? meterStart;
          const kwhDelivered = Math.max(0, (meterStop - meterStart) / 1000);

          // Compute billing rate
          const site = orphan.connector.charger.site;
          const durationSegments = splitTouDuration({
            startedAt: orphan.startedAt,
            stoppedAt: closedAt.toISOString(),
            pricingMode: site.pricingMode,
            defaultPricePerKwhUsd: site.pricePerKwhUsd,
            defaultIdleFeePerMinUsd: site.idleFeePerMinUsd,
            touWindows: site.touWindows,
            timeZone: site.timeZone ?? 'America/Los_Angeles',
          });
          const totalSegMinutes = durationSegments.reduce((s, seg) => s + seg.minutes, 0);
          const weightedRate =
            totalSegMinutes > 0
              ? durationSegments.reduce((s, seg) => s + (seg.minutes / totalSegMinutes) * seg.pricePerKwhUsd, 0)
              : (orphan.ratePerKwh ?? site.pricePerKwhUsd ?? 0);

          await tx.session.update({
            where: { id: orphan.id },
            data: {
              status: 'COMPLETED',
              stoppedAt: closedAt,
              kwhDelivered,
              ratePerKwh: weightedRate,
            },
          });

          console.log(
            `[StatusNotification] Auto-closed orphan session ${orphan.id} (txn=${orphan.transactionId}) on connector ${connectorId} → ${nextStatus}. kWh=${kwhDelivered.toFixed(3)} rate=$${weightedRate.toFixed(4)}/kWh`,
          );

          // Queue billing snapshot outside the tx (non-blocking)
          orphanSessionIdToSnapshot = orphan.id;
        }
      }
    }

    await enqueueOcppEvent(tx, {
      chargerId,
      eventType: 'StatusNotification',
      payload: params,
      idempotencyKey: `${chargerId}:StatusNotification:${connectorId}:${status}:${params.timestamp ?? 'na'}`,
    });
  });

  // Capture billing snapshot for auto-closed orphan session (non-blocking, outside tx)
  if (orphanSessionIdToSnapshot) {
    try {
      await captureSessionBillingSnapshot(orphanSessionIdToSnapshot);
    } catch (snapErr) {
      console.error(`[StatusNotification] Failed to capture billing snapshot for auto-closed session ${orphanSessionIdToSnapshot}:`, snapErr);
    }
    // Clear any in-memory fleet prior-energy state for the closed session
    // (TASK-0208 Phase 2 PR-c). Idempotent delete — safe if absent.
    clearPriorEnergy(orphanSessionIdToSnapshot);

    // Clear fleet scheduler edge timer for this charger (PR-d). Flag-gated
    // and non-fatal. Next reconcile will re-evaluate remaining fleet
    // sessions (if any) for this charger.
    if (fleetFlagEnabled()) {
      try {
        fleetSchedulerOnSessionEnd(chargerId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[StatusNotification] fleet scheduler onSessionEnd failed (non-fatal): sessionId=${orphanSessionIdToSnapshot} chargerId=${chargerId} err=${msg}`,
        );
      }
    }
  }

  if (connectorId === 0) {
    await recordUptimeEvent(chargerId, toUptimeEvent(status), { reason: `StatusNotification connector=0 status=${status}`, errorCode });
  } else if (status === 'Faulted' || status === 'Unavailable') {
    // Record connector-level down signal; uptime math later applies >1s persistence filter.
    await recordUptimeEvent(chargerId, status === 'Faulted' ? 'FAULTED' : 'OFFLINE', {
      connectorId,
      reason: `StatusNotification connector=${connectorId} status=${status}`,
      errorCode,
    });
  } else {
    // Record connector recovery only if last connector-level signal was down.
    const last = await prisma.uptimeEvent.findFirst({
      where: { chargerId, connectorId },
      orderBy: { createdAt: 'desc' },
      select: { event: true },
    });
    if (last && (last.event === 'FAULTED' || last.event === 'OFFLINE')) {
      await recordUptimeEvent(chargerId, 'RECOVERED', {
        connectorId,
        reason: `StatusNotification connector=${connectorId} status=${status}`,
      });
    }
  }

  return {};
}
