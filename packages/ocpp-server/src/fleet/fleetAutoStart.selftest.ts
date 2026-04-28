/**
 * fleetAutoStart — Self-Tests (TASK-0208 Phase 3 Slice C)
 * Run: npx ts-node packages/ocpp-server/src/fleet/fleetAutoStart.selftest.ts
 *
 * Scope:
 *   - Trigger filter (pure)
 *   - Env-flag short-circuit
 *   - connectorId-zero short-circuit
 *   - Pending-attempt map (mark + reset)
 *
 * NOT covered (would require DI or test-DB harness — deferred to a future
 * test-infrastructure pass):
 *   - The full decision matrix beyond the pure short-circuits
 *     (rollout-disabled, mode-public, no-policy, autoStartIdTag-null,
 *     charger-not-ready, active-session)
 *   - RemoteStart retry behavior
 *   - Synthetic fleet user upsert
 *
 * The matrix branches we DON'T test here are reached only after live
 * Prisma queries succeed; testing them in-process would require either
 * dependency injection (refactor) or a real Postgres connection (CI
 * harness). Slice C ships without that scaffolding; Slice E (dev/staging
 * rehearsal) will exercise the full matrix end-to-end against a real
 * simulator + DB.
 */

import {
  isPlugInTrigger,
  maybeAutoStartFleet,
  markFleetAutoStartResolved,
  __resetFleetAutoStartForTests,
} from './fleetAutoStart';

let passed = 0;
let failed = 0;
function assert(c: boolean, name: string) {
  if (c) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.error(`  ❌ ${name}`);
  }
}

async function main() {
  // ─── isPlugInTrigger ────────────────────────────────────────────────
  console.log('\n--- isPlugInTrigger pure logic ---');
  assert(isPlugInTrigger('Preparing', 'Available'), 'Available→Preparing fires');
  assert(isPlugInTrigger('Preparing', null), 'null→Preparing fires (cold connector)');
  assert(isPlugInTrigger('Preparing', 'Charging'), 'Charging→Preparing fires (defensive)');
  assert(
    isPlugInTrigger('SuspendedEVSE', 'Available'),
    'Available→SuspendedEVSE fires (firmware that skips Preparing)',
  );
  assert(
    isPlugInTrigger('SuspendedEV', 'Available'),
    'Available→SuspendedEV fires (firmware that skips Preparing)',
  );
  assert(
    !isPlugInTrigger('SuspendedEVSE', 'Charging'),
    'Charging→SuspendedEVSE does NOT fire (mid-session 0A blip is not plug-in)',
  );
  assert(
    !isPlugInTrigger('SuspendedEV', 'Preparing'),
    'Preparing→SuspendedEV does NOT fire (already past plug-in)',
  );
  assert(!isPlugInTrigger('Available', 'Charging'), 'Plug-out does NOT fire');
  assert(!isPlugInTrigger('Charging', 'Preparing'), 'Charging start does NOT fire');
  assert(!isPlugInTrigger('Faulted', 'Available'), 'Faulted does NOT fire');
  assert(!isPlugInTrigger('Available', null), 'Cold Available does NOT fire');

  // ─── env flag off short-circuit ─────────────────────────────────────
  console.log('\n--- env flag off → maybeAutoStartFleet returns flag-off ---');
  {
    const prev = process.env.FLEET_GATED_SESSIONS_ENABLED;
    delete process.env.FLEET_GATED_SESSIONS_ENABLED;
    try {
      const r = await maybeAutoStartFleet({
        chargerId: 'charger-test',
        ocppId: 'CP-TEST',
        connectorId: 1,
        newStatus: 'Preparing',
        prevStatus: 'Available',
      });
      assert(r.ok === false, 'returns ok=false');
      if (!r.ok) assert(r.reason === 'flag-off', 'reason=flag-off');
    } finally {
      if (prev === undefined) delete process.env.FLEET_GATED_SESSIONS_ENABLED;
      else process.env.FLEET_GATED_SESSIONS_ENABLED = prev;
    }
  }

  // ─── connectorId 0 short-circuit ────────────────────────────────────
  console.log('\n--- connectorId 0 (whole charger) → connector-zero ---');
  {
    const prev = process.env.FLEET_GATED_SESSIONS_ENABLED;
    process.env.FLEET_GATED_SESSIONS_ENABLED = 'true';
    try {
      const r = await maybeAutoStartFleet({
        chargerId: 'charger-test',
        ocppId: 'CP-TEST',
        connectorId: 0,
        newStatus: 'Preparing',
        prevStatus: 'Available',
      });
      assert(r.ok === false, 'returns ok=false');
      if (!r.ok) assert(r.reason === 'connector-zero', 'reason=connector-zero');
    } finally {
      if (prev === undefined) delete process.env.FLEET_GATED_SESSIONS_ENABLED;
      else process.env.FLEET_GATED_SESSIONS_ENABLED = prev;
    }
  }

  // ─── not-plug-in short-circuit ──────────────────────────────────────
  console.log('\n--- non-plug-in transition → not-plug-in ---');
  {
    const prev = process.env.FLEET_GATED_SESSIONS_ENABLED;
    process.env.FLEET_GATED_SESSIONS_ENABLED = 'true';
    try {
      const r = await maybeAutoStartFleet({
        chargerId: 'charger-test',
        ocppId: 'CP-TEST',
        connectorId: 1,
        newStatus: 'Available', // plug-out
        prevStatus: 'Charging',
      });
      assert(r.ok === false, 'returns ok=false');
      if (!r.ok) assert(r.reason === 'not-plug-in', 'reason=not-plug-in');
    } finally {
      if (prev === undefined) delete process.env.FLEET_GATED_SESSIONS_ENABLED;
      else process.env.FLEET_GATED_SESSIONS_ENABLED = prev;
    }
  }

  // ─── pending-map mark+reset ─────────────────────────────────────────
  console.log('\n--- pending-state bookkeeping ---');
  {
    __resetFleetAutoStartForTests();
    // markFleetAutoStartResolved on an empty map is a safe no-op.
    let threw = false;
    try {
      markFleetAutoStartResolved({ chargerId: 'charger-x', connectorId: 1 });
    } catch {
      threw = true;
    }
    assert(!threw, 'markFleetAutoStartResolved on empty map does not throw');

    // Reset is idempotent.
    __resetFleetAutoStartForTests();
    __resetFleetAutoStartForTests();
    assert(true, 'reset is idempotent');
  }

  console.log(`\n\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
