import { prisma } from '@ev-charger/shared';
import { recordUptimeEvent } from '../uptimeEvents';
import { enqueueOcppEvent } from '../outbox';
import { clientRegistry } from '../clientRegistry';
import type { BootNotificationRequest, BootNotificationResponse } from '@ev-charger/shared';
import { onBoot as fleetSchedulerOnBoot } from '../fleet/fleetScheduler';

function fleetFlagEnabled(): boolean {
  return process.env.FLEET_GATED_SESSIONS_ENABLED === 'true';
}

export async function handleBootNotification(
  _client: any,
  chargerId: string,
  params: BootNotificationRequest,
): Promise<BootNotificationResponse> {
  console.log(`[BootNotification] chargerId=${chargerId} vendor=${params.chargePointVendor} model=${params.chargePointModel}`);

  // Track boot receipt for connection stability instrumentation
  const ocppId = (await prisma.charger.findUnique({ where: { id: chargerId }, select: { ocppId: true } }))?.ocppId;
  if (ocppId) clientRegistry.markBoot(ocppId);

  await prisma.$transaction(async (tx: any) => {
    await tx.charger.update({
      where: { id: chargerId },
      data: {
        status: 'ONLINE',
        vendor: params.chargePointVendor,
        model: params.chargePointModel,
      },
    });

    await enqueueOcppEvent(tx, {
      chargerId,
      eventType: 'BootNotification',
      payload: params,
      idempotencyKey: `${chargerId}:BootNotification:${params.chargePointVendor}:${params.chargePointModel}`,
    });
  });

  await recordUptimeEvent(chargerId, 'ONLINE', { reason: 'BootNotification accepted' });

  // Configure charger's WS ping interval to 30s so the charger sends WS-level
  // pings to the server. This keeps the connection alive through Railway's ~60s
  // idle proxy timeout. The server never sends pings (charger firmware doesn't
  // pong), so keepalive is entirely charger-initiated.
  if (ocppId) {
    const client = clientRegistry.get(ocppId);
    if (client) {
      try {
        const result = await client.call('ChangeConfiguration', {
          key: 'WebSocketPingInterval',
          value: '30',
        });
        console.log(`[BootNotification] ChangeConfiguration WebSocketPingInterval=30 for ${ocppId}: ${result?.status ?? 'no response'}`);
      } catch (err: any) {
        console.warn(`[BootNotification] Failed to set WebSocketPingInterval for ${ocppId}: ${err?.message ?? err}`);
      }
    }
  }

  // Reset smart charging state to PENDING_OFFLINE on boot so the heartbeat gate
  // forces a fresh GetConfiguration-style re-apply cycle after the charger reboots.
  // Without this, the idempotency check sees status=APPLIED from the prior session
  // and skips re-applying — even though the charger's in-memory profile was wiped on reboot.
  await prisma.smartChargingState.updateMany({
    where: { chargerId },
    data: { status: 'PENDING_OFFLINE' },
  });

  // ── Fleet re-apply on boot (TASK-0208 Phase 2 PR-d) ───────────────────
  // Hard rule #2: profiles live in charger RAM and are wiped on reboot.
  // Re-assert the current gate state for any ACTIVE fleet session on this
  // charger. Flag-gated + non-fatal. Fire-and-forget: BootNotification must
  // respond promptly; scheduler work runs in the background.
  if (fleetFlagEnabled()) {
    fleetSchedulerOnBoot(chargerId).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[BootNotification] fleet scheduler onBoot failed (non-fatal): chargerId=${chargerId} err=${msg}`,
      );
    });
  }

  return {
    currentTime: new Date().toISOString(),
    // 900s OCPP heartbeat interval. The WebSocket is kept alive by charger-side
    // WS pings (WebSocketPingInterval=30s, set above via ChangeConfiguration).
    // OCPP Heartbeat is only for application-level liveness — not keepalive.
    interval: 900,
    status: 'Accepted',
  };
}
