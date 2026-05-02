/**
 * TASK-0198 Phase 1 — ChargerEvent persistence layer.
 *
 * Wraps the pure extractor with a DB writer. Called from `ocppLogger.ts`
 * after the OcppLog row is committed; receives the ocppLogId so events can
 * link back to the source message for traceability + dedup in the PR #2
 * backfill script.
 *
 * Failures are non-fatal — a diagnostics-pipeline write failure must never
 * disrupt the OCPP protocol flow. Same posture as the OcppLog writer
 * itself.
 */

import { prisma } from '@ev-charger/shared';
import { extractChargerEvents, type OcppMessageInput } from './chargerEventExtractor';

export interface IngestChargerEventsOpts extends OcppMessageInput {
  chargerId: string;
  /** OcppLog row id this message was persisted as, when known. */
  sourceOcppLogId?: string | null;
}

/**
 * Run the extractor against a single OCPP message and persist any emitted
 * events. Idempotent only by virtue of `sourceOcppLogId` uniqueness for
 * back-fill flows; live ingestion expects the caller to never invoke twice
 * for the same OcppLog row.
 */
export async function ingestChargerEvents(opts: IngestChargerEventsOpts): Promise<void> {
  const { chargerId, sourceOcppLogId, ...messageInput } = opts;
  let events;
  try {
    events = extractChargerEvents(messageInput);
  } catch (err) {
    console.error(
      `[ChargerEventLogger] extractor threw for chargerId=${chargerId} action=${messageInput.action}:`,
      err,
    );
    return;
  }

  if (events.length === 0) return;

  await Promise.all(
    events.map(async (e) => {
      try {
        await prisma.chargerEvent.create({
          data: {
            chargerId,
            connectorId: e.connectorId,
            kind: e.kind,
            severity: e.severity,
            errorCode: e.errorCode,
            vendorErrorCode: e.vendorErrorCode,
            vendorId: e.vendorId,
            payloadSummary: e.payloadSummary as object,
            sourceOcppLogId: sourceOcppLogId ?? null,
            detectedBy: 'live',
          },
        });
      } catch (err) {
        // Non-fatal — never disrupt OCPP handling.
        console.error(
          `[ChargerEventLogger] failed to persist ${e.kind} for chargerId=${chargerId}:`,
          err,
        );
      }
    }),
  );
}
