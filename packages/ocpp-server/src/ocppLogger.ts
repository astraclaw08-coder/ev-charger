/**
 * ocppLogger — centralised OCPP message persistence.
 *
 * Every inbound (charger → server) and outbound (server → charger) message
 * is written to the OcppLog table so we always have a full audit trail,
 * including StartTransaction, StopTransaction, BootNotification, etc.
 *
 * After the OcppLog row commits, the diagnostics pipeline (TASK-0198 Phase 1)
 * runs a pure extractor against the same message and writes any emitted
 * `ChargerEvent` rows linked back to the source OcppLog id.
 *
 * Both writes are intentionally non-fatal: we log the error but never let
 * a DB write problem disrupt the OCPP protocol flow.
 */
import { prisma } from '@ev-charger/shared';
import { ingestChargerEvents } from './diagnostics/chargerEventLogger';

export type LogDirection = 'INBOUND' | 'OUTBOUND';

export async function logOcppMessage(
  chargerId: string,
  direction: LogDirection,
  action: string,
  payload: unknown,
  messageId?: string,
): Promise<void> {
  let ocppLogId: string | null = null;
  try {
    const row = await prisma.ocppLog.create({
      data: {
        chargerId,
        direction,
        messageType: direction === 'INBOUND' ? 2 : 3,
        messageId: messageId ?? `${action}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        action,
        payload: payload as object,
      },
      select: { id: true },
    });
    ocppLogId = row.id;
  } catch (err) {
    // Non-fatal — never disrupt OCPP handling
    console.error(`[OcppLogger] Failed to persist ${direction} ${action} for charger ${chargerId}:`, err);
  }

  // TASK-0198 Phase 1 — diagnostics event ingestion. Runs even if the
  // OcppLog write failed (e.g. transient DB error) so we don't lose the
  // signal entirely; sourceOcppLogId will be null in that case.
  try {
    await ingestChargerEvents({
      chargerId,
      direction,
      action,
      payload,
      sourceOcppLogId: ocppLogId,
    });
  } catch (err) {
    console.error(
      `[OcppLogger] diagnostics ingestion failed for chargerId=${chargerId} action=${action}:`,
      err,
    );
  }
}
