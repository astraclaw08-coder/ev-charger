/**
 * TASK-0198 Phase 1 — historical OcppLog → ChargerEvent backfill.
 *
 * One-shot script (no cron). Walks OcppLog rows in time order for one
 * charger or many, runs the per-message extractor and the cross-message
 * window detectors, and writes the resulting ChargerEvent rows with
 * detectedBy='backfill'.
 *
 * SAFETY:
 *   - Default mode is DRY-RUN. No DB writes happen unless `--apply` is
 *     passed explicitly. Dry-run prints a per-kind count summary so an
 *     operator can review before committing.
 *   - Idempotent for per-message events: skipped when a ChargerEvent
 *     already exists with the same `sourceOcppLogId`.
 *   - Idempotent for window-derived events: skipped when a ChargerEvent
 *     already exists with the same kind for the same chargerId
 *     overlapping the same time window (rough but sufficient — re-runs
 *     don't accumulate duplicates).
 *   - Errors per row are logged and skipped; one bad row never aborts
 *     the run. Final summary reports skipped + error counts.
 *
 * USAGE:
 *   # dry-run, all chargers, all history
 *   npx ts-node packages/ocpp-server/src/scripts/backfill-charger-events.ts
 *
 *   # dry-run, single charger, last 7 days
 *   BACKFILL_CHARGER_ID=charger-1A32-1-2010-00008 \
 *     BACKFILL_FROM=2026-04-25T00:00:00Z \
 *     npx ts-node packages/ocpp-server/src/scripts/backfill-charger-events.ts
 *
 *   # actually write
 *   BACKFILL_APPLY=true npx ts-node packages/ocpp-server/src/scripts/backfill-charger-events.ts
 *
 * No prod-affecting deploy: script lives in packages/ocpp-server/src/scripts
 * and is not wired into the runtime. Operator invokes manually.
 */

import 'dotenv/config';
import { prisma } from '@ev-charger/shared';
import { extractChargerEvents } from '../diagnostics/chargerEventExtractor';
import {
  detectFaultLoops,
  detectHeartbeatGaps,
  detectMeterAnomalies,
  detectSessionStateMismatches,
  type ExtractedChargerEvent,
  type FaultEventTick,
  type HeartbeatTick,
  type MeterFrame,
  type StatusTick,
} from '../diagnostics/chargerWindowDetectors';

// ─── CLI / env config ──────────────────────────────────────────────

const BATCH_SIZE = Number(process.env.BACKFILL_BATCH_SIZE ?? '500');
const APPLY = process.env.BACKFILL_APPLY === 'true' || process.argv.includes('--apply');
const ARG_CHARGER = process.env.BACKFILL_CHARGER_ID
  ?? argFlag('--charger')
  ?? null;
const ARG_FROM = process.env.BACKFILL_FROM ?? argFlag('--from') ?? null;
const ARG_TO = process.env.BACKFILL_TO ?? argFlag('--to') ?? null;

function argFlag(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  if (i === -1) return null;
  return process.argv[i + 1] ?? null;
}

function parseDate(raw: string | null, label: string): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    console.error(`[backfill] invalid ${label}: ${raw}`);
    process.exit(1);
  }
  return d;
}

// ─── Aggregation helpers ──────────────────────────────────────────

interface Counts {
  perMessageProposed: Record<string, number>;
  perMessageWritten: number;
  perMessageSkippedDup: number;
  perMessageErrors: number;
  windowProposed: Record<string, number>;
  windowWritten: number;
  windowSkippedDup: number;
  windowErrors: number;
  rowsScanned: number;
  chargersProcessed: number;
}

function emptyCounts(): Counts {
  return {
    perMessageProposed: {},
    perMessageWritten: 0,
    perMessageSkippedDup: 0,
    perMessageErrors: 0,
    windowProposed: {},
    windowWritten: 0,
    windowSkippedDup: 0,
    windowErrors: 0,
    rowsScanned: 0,
    chargersProcessed: 0,
  };
}

function bumpKind(map: Record<string, number>, kind: string) {
  map[kind] = (map[kind] ?? 0) + 1;
}

// ─── Main flow ────────────────────────────────────────────────────

async function main() {
  const fromDate = parseDate(ARG_FROM, '--from');
  const toDate = parseDate(ARG_TO, '--to');

  console.log('========================================');
  console.log('  TASK-0198 ChargerEvent backfill');
  console.log('========================================');
  console.log(`  mode        : ${APPLY ? 'APPLY (writes)' : 'DRY-RUN (no writes)'}`);
  console.log(`  charger     : ${ARG_CHARGER ?? '(all)'}`);
  console.log(`  from        : ${fromDate?.toISOString() ?? '(beginning)'}`);
  console.log(`  to          : ${toDate?.toISOString() ?? '(now)'}`);
  console.log(`  batch size  : ${BATCH_SIZE}`);
  console.log('----------------------------------------');

  const counts = emptyCounts();

  // Determine which chargers to process. We page through chargers that
  // actually have OcppLog rows in the requested window — avoids touching
  // every Charger row when the user only cares about a few active ones.
  const chargerIds = await listChargersWithLogs({ from: fromDate, to: toDate, only: ARG_CHARGER });
  console.log(`  chargers    : ${chargerIds.length}`);

  for (const chargerId of chargerIds) {
    counts.chargersProcessed++;
    await processCharger(chargerId, fromDate, toDate, counts);
  }

  console.log('----------------------------------------');
  console.log('  SUMMARY');
  console.log('----------------------------------------');
  console.log(`  chargers processed   : ${counts.chargersProcessed}`);
  console.log(`  OcppLog rows scanned : ${counts.rowsScanned}`);
  console.log();
  console.log('  per-message events (extractor):');
  for (const [k, v] of Object.entries(counts.perMessageProposed)) {
    console.log(`    ${k.padEnd(24)} proposed=${v}`);
  }
  if (Object.keys(counts.perMessageProposed).length === 0) {
    console.log('    (none)');
  }
  console.log(`    written              : ${counts.perMessageWritten}`);
  console.log(`    skipped (dup)        : ${counts.perMessageSkippedDup}`);
  console.log(`    errors               : ${counts.perMessageErrors}`);
  console.log();
  console.log('  window-derived events (detectors):');
  for (const [k, v] of Object.entries(counts.windowProposed)) {
    console.log(`    ${k.padEnd(24)} proposed=${v}`);
  }
  if (Object.keys(counts.windowProposed).length === 0) {
    console.log('    (none)');
  }
  console.log(`    written              : ${counts.windowWritten}`);
  console.log(`    skipped (dup)        : ${counts.windowSkippedDup}`);
  console.log(`    errors               : ${counts.windowErrors}`);
  console.log('----------------------------------------');
  if (!APPLY) {
    console.log('  DRY-RUN: no rows written. Re-run with --apply (or BACKFILL_APPLY=true) to commit.');
  } else {
    console.log('  APPLY: rows committed to ChargerEvent.');
  }
}

async function listChargersWithLogs(opts: {
  from: Date | null;
  to: Date | null;
  only: string | null;
}): Promise<string[]> {
  if (opts.only) return [opts.only];
  const where: Record<string, unknown> = {};
  if (opts.from || opts.to) {
    where.createdAt = {
      ...(opts.from ? { gte: opts.from } : {}),
      ...(opts.to ? { lt: opts.to } : {}),
    };
  }
  const rows = await prisma.ocppLog.findMany({
    where,
    select: { chargerId: true },
    distinct: ['chargerId'],
  });
  return rows.map((r) => r.chargerId);
}

async function processCharger(
  chargerId: string,
  from: Date | null,
  to: Date | null,
  counts: Counts,
): Promise<void> {
  console.log(`\n[charger=${chargerId}]`);

  // ─── Pass A: per-message extractor over historical OcppLog rows ────
  let cursor: { createdAt: Date; id: string } | null = null;
  // Buffers for window detection (Pass B). Filled while we scan.
  const heartbeats: HeartbeatTick[] = [];
  const faultsByConnector: FaultEventTick[] = [];
  // Status & meter buffers per connectorId (1..N). null connector skipped
  // for window detectors that need a connector context.
  const statusesByConnector = new Map<number, StatusTick[]>();
  const meterFramesByConnector = new Map<number, MeterFrame[]>();

  while (true) {
    const where: Record<string, unknown> = { chargerId };
    if (from || to || cursor) {
      where.createdAt = {
        ...(from ? { gte: from } : {}),
        ...(to ? { lt: to } : {}),
        ...(cursor ? { gte: cursor.createdAt } : {}),
      };
    }
    const batch: Array<{ id: string; createdAt: Date; direction: 'INBOUND' | 'OUTBOUND'; action: string | null; payload: unknown }>
      = await prisma.ocppLog.findMany({
        where,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        ...(cursor ? { skip: 1, cursor: { id: cursor.id } } : {}),
        take: BATCH_SIZE,
        select: { id: true, createdAt: true, direction: true, action: true, payload: true },
      });
    if (batch.length === 0) break;
    counts.rowsScanned += batch.length;

    // Pre-fetch existing ChargerEvent rows for these source ids so we can
    // dedup on per-message events without per-row roundtrips.
    const sourceIds = batch.map((r) => r.id);
    const existingForBatch = await prisma.chargerEvent.findMany({
      where: { sourceOcppLogId: { in: sourceIds } },
      select: { sourceOcppLogId: true, kind: true },
    });
    const dupSet = new Set(
      existingForBatch.map((e) => `${e.sourceOcppLogId}:${e.kind}`),
    );

    for (const row of batch) {
      // Buffer for window detectors regardless of per-message extraction.
      bufferForWindowDetectors(row, heartbeats, faultsByConnector, statusesByConnector, meterFramesByConnector);

      if (!row.action) continue;
      let extracted: ExtractedChargerEvent[];
      try {
        extracted = extractChargerEvents({
          action: row.action,
          direction: row.direction,
          payload: row.payload,
        });
      } catch (err) {
        counts.perMessageErrors++;
        console.error(`  [extract-error] row=${row.id}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (extracted.length === 0) continue;

      for (const e of extracted) {
        bumpKind(counts.perMessageProposed, e.kind);
        if (dupSet.has(`${row.id}:${e.kind}`)) {
          counts.perMessageSkippedDup++;
          continue;
        }
        if (!APPLY) continue;
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
              sourceOcppLogId: row.id,
              detectedBy: 'backfill',
              detectedAt: row.createdAt,
            },
          });
          counts.perMessageWritten++;
        } catch (err) {
          counts.perMessageErrors++;
          console.error(`  [write-error] kind=${e.kind} row=${row.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    cursor = { createdAt: batch[batch.length - 1].createdAt, id: batch[batch.length - 1].id };
    if (batch.length < BATCH_SIZE) break;
  }

  // ─── Pass B: window-derived detectors ─────────────────────────────
  // HEARTBEAT_GAP — charger-wide
  await emitWindowEvents(
    chargerId,
    detectHeartbeatGaps(heartbeats),
    counts,
  );

  // FAULT_LOOP — across all faults (detector groups by connector internally)
  await emitWindowEvents(
    chargerId,
    detectFaultLoops(faultsByConnector),
    counts,
  );

  // METER_ANOMALY — per connector
  for (const frames of meterFramesByConnector.values()) {
    await emitWindowEvents(
      chargerId,
      detectMeterAnomalies(frames),
      counts,
    );
  }

  // SESSION_STATE_MISMATCH — per connector. We need to know whether the
  // backfill window saw an active session. For backfill purposes, use a
  // conservative proxy: an ACTIVE Session row at any point with `connectorId`
  // matching during the run window. Cheaper than per-status correlation.
  for (const [connId, statuses] of statusesByConnector.entries()) {
    const meterFrames = meterFramesByConnector.get(connId) ?? [];
    const hasActiveSession = await chargerHadActiveSessionForConnector(chargerId, connId, from, to);
    await emitWindowEvents(
      chargerId,
      detectSessionStateMismatches({ statuses, meterFrames, hasActiveSession }),
      counts,
    );
  }
}

function bufferForWindowDetectors(
  row: { createdAt: Date; direction: 'INBOUND' | 'OUTBOUND'; action: string | null; payload: unknown },
  heartbeats: HeartbeatTick[],
  faults: FaultEventTick[],
  statusesByConnector: Map<number, StatusTick[]>,
  meterFramesByConnector: Map<number, MeterFrame[]>,
): void {
  if (row.direction !== 'INBOUND' || !row.action) return;
  const p = row.payload as Record<string, unknown> | null;
  if (!p || typeof p !== 'object') return;

  if (row.action === 'Heartbeat') {
    heartbeats.push({ ts: row.createdAt });
    return;
  }

  if (row.action === 'StatusNotification') {
    const status = typeof p.status === 'string' ? p.status : null;
    const errorCode = typeof p.errorCode === 'string' ? p.errorCode : null;
    const connectorId = typeof p.connectorId === 'number' && p.connectorId >= 1 && p.connectorId <= 32
      ? Math.floor(p.connectorId) : null;

    if (status) {
      const arr = connectorId !== null ? (statusesByConnector.get(connectorId) ?? []) : [];
      if (connectorId !== null) {
        arr.push({ ts: row.createdAt, connectorId, status });
        statusesByConnector.set(connectorId, arr);
      }
    }
    if (status === 'Faulted' || (errorCode && errorCode !== 'NoError')) {
      faults.push({
        ts: row.createdAt,
        connectorId,
        errorCode,
        vendorErrorCode: typeof p.vendorErrorCode === 'string' ? p.vendorErrorCode : null,
        vendorId: typeof p.vendorId === 'string' ? p.vendorId : null,
      });
    }
    return;
  }

  if (row.action === 'MeterValues') {
    const connectorId = typeof p.connectorId === 'number' && p.connectorId >= 1 && p.connectorId <= 32
      ? Math.floor(p.connectorId) : null;
    if (connectorId === null) return;
    const meterValueArr = Array.isArray(p.meterValue) ? p.meterValue : [];
    for (const mv of meterValueArr) {
      if (!mv || typeof mv !== 'object') continue;
      const mvObj = mv as Record<string, unknown>;
      const ts = typeof mvObj.timestamp === 'string' ? new Date(mvObj.timestamp) : row.createdAt;
      const samples = Array.isArray(mvObj.sampledValue) ? mvObj.sampledValue : [];
      let registerWh: number | null = null;
      let currentImportA: number | null = null;
      let currentOfferedA: number | null = null;
      let powerActiveImportW: number | null = null;
      let isPeriodic = false;
      for (const s of samples) {
        if (!s || typeof s !== 'object') continue;
        const sObj = s as Record<string, unknown>;
        const measurand = typeof sObj.measurand === 'string' ? sObj.measurand : 'Energy.Active.Import.Register';
        const context = typeof sObj.context === 'string' ? sObj.context : '';
        const valueRaw = sObj.value;
        const value = typeof valueRaw === 'number' ? valueRaw : Number(valueRaw);
        if (!Number.isFinite(value)) continue;
        if (context === 'Sample.Periodic') isPeriodic = true;
        if (measurand === 'Energy.Active.Import.Register') registerWh = value;
        else if (measurand === 'Current.Import') currentImportA = value;
        else if (measurand === 'Current.Offered') currentOfferedA = value;
        else if (measurand === 'Power.Active.Import') powerActiveImportW = value;
      }
      if (!isPeriodic) continue; // only Sample.Periodic feeds the anomaly detector
      const arr = meterFramesByConnector.get(connectorId) ?? [];
      arr.push({ ts, registerWh, currentImportA, currentOfferedA, powerActiveImportW });
      meterFramesByConnector.set(connectorId, arr);
    }
  }
}

async function chargerHadActiveSessionForConnector(
  chargerId: string,
  connectorId: number,
  from: Date | null,
  to: Date | null,
): Promise<boolean> {
  const where: Record<string, unknown> = {
    status: 'ACTIVE',
    connector: { chargerId, connectorId },
  };
  if (from || to) {
    where.OR = [
      { startedAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } },
      { stoppedAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } },
    ];
  }
  const count = await prisma.session.count({ where });
  return count > 0;
}

async function emitWindowEvents(
  chargerId: string,
  events: ExtractedChargerEvent[],
  counts: Counts,
): Promise<void> {
  for (const e of events) {
    bumpKind(counts.windowProposed, e.kind);
    // Dedup: a ChargerEvent of the same kind already on the same charger
    // overlapping this event's window → skip.
    const summary = e.payloadSummary as Record<string, unknown>;
    const firstAt = typeof summary.firstAt === 'string' ? new Date(summary.firstAt as string)
      : typeof summary.prevHeartbeatAt === 'string' ? new Date(summary.prevHeartbeatAt as string)
      : typeof summary.chargingAt === 'string' ? new Date(summary.chargingAt as string)
      : typeof summary.availableAt === 'string' ? new Date(summary.availableAt as string)
      : new Date();
    const lastAt = typeof summary.lastAt === 'string' ? new Date(summary.lastAt as string)
      : typeof summary.nextHeartbeatAt === 'string' ? new Date(summary.nextHeartbeatAt as string)
      : firstAt;
    const dupExists = await prisma.chargerEvent.count({
      where: {
        chargerId,
        kind: e.kind,
        connectorId: e.connectorId,
        detectedAt: { gte: firstAt, lte: lastAt.getTime() === firstAt.getTime() ? new Date(firstAt.getTime() + 1) : lastAt },
      },
    });
    if (dupExists > 0) {
      counts.windowSkippedDup++;
      continue;
    }
    if (!APPLY) continue;
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
          sourceOcppLogId: null, // window-derived, no single source row
          detectedBy: 'backfill',
          detectedAt: firstAt,
        },
      });
      counts.windowWritten++;
    } catch (err) {
      counts.windowErrors++;
      console.error(`  [window-write-error] kind=${e.kind}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[backfill] fatal:', err);
    process.exit(1);
  });
