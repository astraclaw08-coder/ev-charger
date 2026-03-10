import { prisma } from '@ev-charger/shared';

type OutboxRow = {
  id: string;
  chargerId: string;
  eventType: string;
  payload: unknown;
  attempts: number;
};

const POLL_INTERVAL_MS = Number(process.env.EVC_PLATFORM_POLL_INTERVAL_MS ?? 1500);
const BATCH_SIZE = Number(process.env.EVC_PLATFORM_BATCH_SIZE ?? 100);
const MAX_ATTEMPTS = Number(process.env.EVC_PLATFORM_MAX_ATTEMPTS ?? 12);

function backoffMs(attempt: number): number {
  const base = 1000;
  return Math.min(300000, base * 2 ** Math.max(0, attempt));
}

async function claimBatch(limit: number): Promise<OutboxRow[]> {
  return prisma.$queryRaw<OutboxRow[]>`
    WITH next_jobs AS (
      SELECT id
      FROM "OcppEventOutbox"
      WHERE status IN ('PENDING', 'FAILED')
        AND "nextAttemptAt" <= NOW()
      ORDER BY "createdAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "OcppEventOutbox" o
    SET status = 'PROCESSING'
    FROM next_jobs
    WHERE o.id = next_jobs.id
    RETURNING o.id, o."chargerId", o."eventType", o.payload, o.attempts;
  `;
}

async function processEvent(row: OutboxRow): Promise<void> {
  // Phase B2 skeleton: classify events and no-op process hook.
  switch (row.eventType) {
    case 'BootNotification':
    case 'Heartbeat':
    case 'StatusNotification':
    case 'StartTransaction':
    case 'MeterValues':
    case 'StopTransaction':
      return;
    default:
      throw new Error(`Unsupported eventType: ${row.eventType}`);
  }
}

async function markDone(id: string): Promise<void> {
  await prisma.ocppEventOutbox.update({
    where: { id },
    data: { status: 'DONE', processedAt: new Date(), lastError: null },
  });
}

async function markFailed(id: string, attempts: number, err: unknown): Promise<void> {
  const nextAttempts = attempts + 1;
  const terminal = nextAttempts >= MAX_ATTEMPTS;
  await prisma.ocppEventOutbox.update({
    where: { id },
    data: {
      attempts: nextAttempts,
      status: 'FAILED',
      lastError: err instanceof Error ? err.message : String(err),
      nextAttemptAt: terminal ? new Date(Date.now() + 300000) : new Date(Date.now() + backoffMs(nextAttempts)),
    },
  });
}

async function tick(): Promise<void> {
  const rows = await claimBatch(BATCH_SIZE);
  if (rows.length === 0) return;

  for (const row of rows) {
    try {
      await processEvent(row);
      await markDone(row.id);
    } catch (err) {
      await markFailed(row.id, row.attempts, err);
    }
  }

  console.log(`[EVC Platform] processed batch=${rows.length}`);
}

async function main(): Promise<void> {
  console.log('[EVC Platform] worker started', {
    pollIntervalMs: POLL_INTERVAL_MS,
    batchSize: BATCH_SIZE,
    maxAttempts: MAX_ATTEMPTS,
  });

  while (true) {
    try {
      await tick();
    } catch (err) {
      console.error('[EVC Platform] tick failed', err);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

void main();
