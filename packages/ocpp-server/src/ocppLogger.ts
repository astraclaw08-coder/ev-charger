/**
 * ocppLogger — centralised OCPP message persistence.
 *
 * Every inbound (charger → server) and outbound (server → charger) message
 * is written to the OcppLog table so we always have a full audit trail,
 * including StartTransaction, StopTransaction, BootNotification, etc.
 *
 * Write failures are intentionally non-fatal: we log the error but never
 * let a DB write problem disrupt the OCPP protocol flow.
 */
import { prisma } from '@ev-charger/shared';

export type LogDirection = 'INBOUND' | 'OUTBOUND';

export async function logOcppMessage(
  chargerId: string,
  direction: LogDirection,
  action: string,
  payload: unknown,
  messageId?: string,
): Promise<void> {
  try {
    await prisma.ocppLog.create({
      data: {
        chargerId,
        direction,
        messageType: direction === 'INBOUND' ? 2 : 3,
        messageId: messageId ?? `${action}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        action,
        payload: payload as object,
      },
    });
  } catch (err) {
    // Non-fatal — never disrupt OCPP handling
    console.error(`[OcppLogger] Failed to persist ${direction} ${action} for charger ${chargerId}:`, err);
  }
}
