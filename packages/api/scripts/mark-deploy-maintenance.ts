#!/usr/bin/env npx tsx
/**
 * Pre-deploy maintenance marker
 * =============================
 *
 * Inserts a `SCHEDULED_MAINTENANCE` UptimeEvent for every currently-ONLINE
 * charger so the WebSocket disconnect window during an OCPP server restart
 * is excluded from uptime calculations (treated as scheduled maintenance
 * under current platform policy).
 *
 * Invocation:
 *   npm run deploy:mark-maintenance -- --reason "ocpp <commit-sha>"
 *
 * Normally you don't call this directly — use `npm run deploy:ocpp`, which
 * chains this script with `railway up` and stops the deploy if the DB
 * prerequisite isn't met.
 *
 * Operational prerequisite
 * ------------------------
 * DATABASE_URL must point at the **prod** Railway Postgres. Manual shell
 * deploys often don't have prod creds loaded; configure once via `~/.env`
 * or source a `.envrc` before running. The script fails hard (exit 1)
 * before any write if DATABASE_URL is missing or the connection fails.
 * The wrapper's `&&` chain prevents the Railway upload from starting.
 *
 * Idempotency
 * -----------
 * For each ONLINE charger we fetch the LATEST UptimeEvent (charger-level).
 * Skip insertion iff that latest event is already `SCHEDULED_MAINTENANCE`.
 * This is deterministic and has no time threshold — a retried deploy an
 * hour later, after the charger has reconnected, correctly re-marks; two
 * invocations of this script with no reconnect in between correctly no-op
 * the second one.
 *
 * Query cardinality
 * -----------------
 * One `findFirst` per ONLINE charger. Acceptable because the affected
 * charger count is small (single-digit to low tens) and runs are rare
 * (per deploy, not per request). If N ever grows into the hundreds, swap
 * to a single groupBy+DISTINCT-ON query.
 *
 * connectorId filter: null OR 0
 * -----------------------------
 * Charger-level UptimeEvent rows have connectorId = null by convention,
 * but the OCPP 1.6 spec treats connectorId=0 as "the whole charger" and
 * some handlers persist 0 instead of null. The existing uptimeMaterializer
 * (workers/uptimeMaterializer.ts:80, 91) and lib/uptime.ts:175 already
 * treat both as charger-level — we match that convention here to stay
 * consistent with the materializer that consumes these events.
 *
 * Operational responsibility
 * --------------------------
 * After every deploy that uses this wrapper, ops must verify each marked
 * charger reconnects within ~5 minutes (check /status or UptimeEvent for
 * the closing ONLINE row from BootNotification). If any charger has not
 * reconnected, investigate immediately because the still-open maintenance
 * segment may over-exclude downtime beyond the intended deploy window.
 */
import 'dotenv/config';
import { prisma } from '@ev-charger/shared';

function getReason(argv: string[]): string {
  const reasonIndex = argv.findIndex((arg) => arg === '--reason');
  if (reasonIndex === -1) {
    throw new Error('Missing required --reason argument (e.g. --reason "ocpp abc1234")');
  }
  const reason = argv[reasonIndex + 1]?.trim();
  if (!reason) {
    throw new Error('Missing value for --reason');
  }
  return reason;
}

async function main() {
  // Prerequisite 1: env var present.
  if (!process.env.DATABASE_URL) {
    console.error('[deploy-maintenance] DATABASE_URL required — aborting');
    process.exit(1);
  }

  // Prerequisite 2: connection actually works. Fail fast before any writes
  // so a misconfigured shell never partially runs the wrapper chain.
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    console.error('[deploy-maintenance] DB connection failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }

  const reason = getReason(process.argv.slice(2));

  // Only ONLINE chargers can have availability affected by an OCPP server
  // restart. OFFLINE / FAULTED chargers already aren't counted as UP, so
  // marking them would retroactively exclude a real outage the deploy
  // isn't responsible for.
  const chargers = await prisma.charger.findMany({
    where: { status: 'ONLINE' },
    select: { id: true, ocppId: true },
    orderBy: { ocppId: 'asc' },
  });

  if (chargers.length === 0) {
    console.log('[deploy-maintenance] no ONLINE chargers — nothing to mark');
    console.log(`[deploy-maintenance] reason: ${reason}`);
    return;
  }

  const marked: string[] = [];
  const skipped: string[] = [];

  for (const charger of chargers) {
    // State-based idempotency: the latest charger-level UptimeEvent tells
    // us the current tracked status. If it's already SCHEDULED_MAINTENANCE,
    // the previous marker hasn't been closed by a reconnect yet — inserting
    // another would be a no-op for the materializer but adds noise to the
    // event log. Skip.
    const latest = await prisma.uptimeEvent.findFirst({
      where: {
        chargerId: charger.id,
        OR: [{ connectorId: null }, { connectorId: 0 }],
      },
      orderBy: { createdAt: 'desc' },
      select: { event: true },
    });

    if (latest?.event === 'SCHEDULED_MAINTENANCE') {
      skipped.push(charger.ocppId);
      continue;
    }

    await prisma.uptimeEvent.create({
      data: {
        chargerId: charger.id,
        connectorId: null,
        event: 'SCHEDULED_MAINTENANCE',
        reason,
      },
    });
    marked.push(charger.ocppId);
  }

  console.log(
    `[deploy-maintenance] marked ${marked.length} online charger(s)${
      marked.length > 0 ? `: ${marked.join(', ')}` : ''
    }`,
  );
  if (skipped.length > 0) {
    console.log(
      `[deploy-maintenance] skipped (already in SCHEDULED_MAINTENANCE): ${skipped.join(', ')}`,
    );
  }
  console.log(`[deploy-maintenance] reason: ${reason}`);
  console.log(
    '[deploy-maintenance] IMPORTANT: verify each charger reconnects within 5 minutes post-deploy.',
  );
  console.log(
    '[deploy-maintenance] If any charger has not reconnected, investigate immediately because the still-open maintenance segment may over-exclude downtime beyond the intended deploy window.',
  );
}

main()
  .catch((err) => {
    console.error('[deploy-maintenance] fatal error:', err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
