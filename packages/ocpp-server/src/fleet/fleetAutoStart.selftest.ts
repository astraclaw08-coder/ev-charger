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
  consumeFleetAutoStartPending,
  evaluateFleetAutoStartReadiness,
  __resetFleetAutoStartForTests,
  __setPendingForTests,
  type AutoStartConnector,
  type AutoStartDeps,
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

  // ─── consumeFleetAutoStartPending ───────────────────────────────────
  console.log('\n--- consumeFleetAutoStartPending verify-and-consume ---');
  {
    __resetFleetAutoStartForTests();

    // No pending entry → returns false (and no harm).
    const r0 = consumeFleetAutoStartPending({
      chargerId: 'c1', connectorId: 1, fleetPolicyId: 'p1', idTag: 'TAG',
    });
    assert(r0 === false, 'no pending entry → false');

    // Seed a fresh entry via the test seam.
    __setPendingForTests({ chargerId: 'c1', connectorId: 1, fleetPolicyId: 'p1', idTag: 'TAG' });

    // Wrong policy id → false, entry preserved for the legitimate consumer.
    const rWrongPolicy = consumeFleetAutoStartPending({
      chargerId: 'c1', connectorId: 1, fleetPolicyId: 'p-OTHER', idTag: 'TAG',
    });
    assert(rWrongPolicy === false, 'wrong policyId → false');

    // Wrong idTag → false, entry still preserved.
    const rWrongTag = consumeFleetAutoStartPending({
      chargerId: 'c1', connectorId: 1, fleetPolicyId: 'p1', idTag: 'NOT-IT',
    });
    assert(rWrongTag === false, 'wrong idTag → false');

    // Correct match → true, entry consumed.
    const rOk = consumeFleetAutoStartPending({
      chargerId: 'c1', connectorId: 1, fleetPolicyId: 'p1', idTag: 'TAG',
    });
    assert(rOk === true, 'matching args → true');

    // Second call → false (entry was consumed).
    const rOk2 = consumeFleetAutoStartPending({
      chargerId: 'c1', connectorId: 1, fleetPolicyId: 'p1', idTag: 'TAG',
    });
    assert(rOk2 === false, 'second consume → false');

    // Stale entry (long-ago startedAt) → false even on exact match.
    __setPendingForTests({
      chargerId: 'c2', connectorId: 1, fleetPolicyId: 'p2', idTag: 'TAG2',
      startedAtMs: Date.now() - 10 * 60_000, // 10 min ago, past 2-min TTL
    });
    const rStale = consumeFleetAutoStartPending({
      chargerId: 'c2', connectorId: 1, fleetPolicyId: 'p2', idTag: 'TAG2',
    });
    assert(rStale === false, 'stale pending entry → false');

    __resetFleetAutoStartForTests();
  }

  // ─── deeper decision-matrix coverage via dep injection ──────────────
  // Build a base "happy path" deps object; each test perturbs one knob.
  console.log('\n--- decision matrix via DI seams ---');
  {
    const enabledPolicy = {
      id: 'policy-x',
      name: 'Test Fleet',
      status: 'ENABLED' as const,
      autoStartIdTag: 'FLEET-AUTO-X',
      siteId: 'site-1',
    };
    const fleetAutoConnector: AutoStartConnector = {
      id: 'conn-1',
      chargingMode: 'FLEET_AUTO',
      fleetPolicyId: enabledPolicy.id,
      fleetPolicy: enabledPolicy,
      charger: { id: 'charger-1', ocppId: 'CP-1', siteId: 'site-1' },
    };
    const trigger = {
      chargerId: 'charger-1',
      ocppId: 'CP-1',
      connectorId: 1,
      newStatus: 'Preparing',
      prevStatus: 'Available',
    };
    const happyDeps: Partial<AutoStartDeps> = {
      envFlagOn: () => true,
      loadConnector: async () => fleetAutoConnector,
      isRolloutEnabled: async () => true,
      readinessCheck: async () => ({ ready: true, reason: 'ok' }),
      loadActiveSession: async () => null,
      ensureSyntheticUser: async () => ({ id: 'user-synth' }),
      remoteStart: async () => 'Accepted',
      delayMs: async () => undefined,
      now: () => 1_000_000_000_000,
    };

    // (a) happy path → started
    {
      __resetFleetAutoStartForTests();
      const r = await maybeAutoStartFleet(trigger, happyDeps);
      assert(r.ok === true, 'happy path → started');
    }

    // (b) PUBLIC mode → mode-public
    {
      __resetFleetAutoStartForTests();
      const r = await maybeAutoStartFleet(trigger, {
        ...happyDeps,
        loadConnector: async () => ({ ...fleetAutoConnector, chargingMode: 'PUBLIC' }),
      });
      assert(r.ok === false && (r as any).reason === 'mode-public', 'PUBLIC mode → mode-public');
    }

    // (c) rollout disabled → rollout-disabled (and no RemoteStart fired)
    {
      __resetFleetAutoStartForTests();
      let remoteStartCalls = 0;
      const r = await maybeAutoStartFleet(trigger, {
        ...happyDeps,
        isRolloutEnabled: async () => false,
        remoteStart: async () => { remoteStartCalls++; return 'Accepted'; },
      });
      assert(r.ok === false && (r as any).reason === 'rollout-disabled',
        'rollout disabled → rollout-disabled');
      assert(remoteStartCalls === 0, 'rollout disabled → remoteStart NOT called');
    }

    // (d) charger not ready → charger-not-ready (no RemoteStart)
    {
      __resetFleetAutoStartForTests();
      let remoteStartCalls = 0;
      const r = await maybeAutoStartFleet(trigger, {
        ...happyDeps,
        readinessCheck: async () => ({ ready: false, reason: 'no-boot' }),
        remoteStart: async () => { remoteStartCalls++; return 'Accepted'; },
      });
      assert(r.ok === false && (r as any).reason === 'charger-not-ready',
        'no-boot readiness → charger-not-ready');
      assert(remoteStartCalls === 0, 'not-ready → remoteStart NOT called');
    }

    // (d.2) readiness via historical-boot fallback → ready (proves the new
    //       async signature + chargerId arg flow through correctly and
    //       that 'ok-via-historical-boot' is treated as ready by the
    //       decision matrix).
    {
      __resetFleetAutoStartForTests();
      let receivedOcppId: string | null = null;
      let receivedChargerId: string | null = null;
      const r = await maybeAutoStartFleet(trigger, {
        ...happyDeps,
        readinessCheck: async (ocppId, chargerId) => {
          receivedOcppId = ocppId;
          receivedChargerId = chargerId;
          return { ready: true, reason: 'ok-via-historical-boot' };
        },
      });
      assert(r.ok === true, 'historical-boot fallback → ready');
      assert(receivedOcppId === trigger.ocppId, 'readinessCheck received ocppId arg');
      assert(receivedChargerId === trigger.chargerId, 'readinessCheck received chargerId arg');
    }

    // (e) active session → active-session (no RemoteStart)
    {
      __resetFleetAutoStartForTests();
      let remoteStartCalls = 0;
      const r = await maybeAutoStartFleet(trigger, {
        ...happyDeps,
        loadActiveSession: async () => ({ id: 'session-pre-existing' }),
        remoteStart: async () => { remoteStartCalls++; return 'Accepted'; },
      });
      assert(r.ok === false && (r as any).reason === 'active-session',
        'active session present → active-session');
      assert(remoteStartCalls === 0, 'active-session → remoteStart NOT called');
    }

    // (f) policy DRAFT → policy-not-enabled
    {
      __resetFleetAutoStartForTests();
      const r = await maybeAutoStartFleet(trigger, {
        ...happyDeps,
        loadConnector: async () => ({
          ...fleetAutoConnector,
          fleetPolicy: { ...enabledPolicy, status: 'DRAFT' as const },
        }),
      });
      assert(r.ok === false && (r as any).reason === 'policy-not-enabled',
        'DRAFT policy → policy-not-enabled');
    }

    // (g) autoStartIdTag null → autoStartIdTag-null
    {
      __resetFleetAutoStartForTests();
      const r = await maybeAutoStartFleet(trigger, {
        ...happyDeps,
        loadConnector: async () => ({
          ...fleetAutoConnector,
          fleetPolicy: { ...enabledPolicy, autoStartIdTag: null },
        }),
      });
      assert(r.ok === false && (r as any).reason === 'autoStartIdTag-null',
        'null autoStartIdTag → autoStartIdTag-null');
    }

    // (h) no fleetPolicyId on connector → no-policy-assigned
    {
      __resetFleetAutoStartForTests();
      const r = await maybeAutoStartFleet(trigger, {
        ...happyDeps,
        loadConnector: async () => ({
          ...fleetAutoConnector,
          fleetPolicyId: null,
          fleetPolicy: null,
        }),
      });
      assert(r.ok === false && (r as any).reason === 'no-policy-assigned',
        'no policy → no-policy-assigned');
    }

    // (i) pending duplicate → pending-attempt; second fire is suppressed
    {
      __resetFleetAutoStartForTests();
      __setPendingForTests({
        chargerId: trigger.chargerId,
        connectorId: trigger.connectorId,
        fleetPolicyId: enabledPolicy.id,
        idTag: enabledPolicy.autoStartIdTag,
      });
      let remoteStartCalls = 0;
      const r = await maybeAutoStartFleet(trigger, {
        ...happyDeps,
        remoteStart: async () => { remoteStartCalls++; return 'Accepted'; },
      });
      assert(r.ok === false && (r as any).reason === 'pending-attempt',
        'fresh pending → pending-attempt');
      assert(remoteStartCalls === 0, 'pending-attempt → remoteStart NOT called');
    }

    // (j) RemoteStart Rejected on first attempt, Accepted on retry
    {
      __resetFleetAutoStartForTests();
      let calls = 0;
      let delays = 0;
      const r = await maybeAutoStartFleet(trigger, {
        ...happyDeps,
        delayMs: async () => { delays++; },
        remoteStart: async () => {
          calls++;
          return calls === 1 ? 'Rejected' : 'Accepted';
        },
      });
      assert(r.ok === true, 'retry succeeded → started');
      assert(calls === 2, 'remoteStart called twice on retry');
      assert(delays === 1, 'one delay between attempts');
    }

    // (k) RemoteStart Rejected on both → remote-start-rejected, pending cleared
    {
      __resetFleetAutoStartForTests();
      const r = await maybeAutoStartFleet(trigger, {
        ...happyDeps,
        delayMs: async () => undefined,
        remoteStart: async () => 'Rejected',
      });
      assert(r.ok === false && (r as any).reason === 'remote-start-rejected',
        'both rejects → remote-start-rejected');
      // Pending should be cleared so a re-fire on next plug-in can retry.
      const consumed = consumeFleetAutoStartPending({
        chargerId: trigger.chargerId,
        connectorId: trigger.connectorId,
        fleetPolicyId: enabledPolicy.id,
        idTag: enabledPolicy.autoStartIdTag,
      });
      assert(consumed === false, 'pending cleared after both retries fail');
    }
  }

  // ─── evaluateFleetAutoStartReadiness — pure decision branches ──────
  // Tests the actual readiness logic, NOT just the DI plumbing above.
  // Covers every branch the post-redeploy historical-boot fallback adds.
  console.log('\n--- evaluateFleetAutoStartReadiness pure decision branches ---');
  {
    // Required user-listed cases:

    // (1) active WS + current heartbeat + historical BootNotification → ready
    {
      const r = evaluateFleetAutoStartReadiness({
        stats: { bootReceived: false, heartbeatCount: 1 },
        hasLiveClient: true,
        hasHistoricalBoot: true,
      });
      assert(r.ready === true, '(1) WS + heartbeat + historical Boot → ready');
      assert(r.reason === 'ok-via-historical-boot', '(1) reason=ok-via-historical-boot');
    }

    // (2) active WS + current heartbeat + NO historical BootNotification → no-boot
    {
      const r = evaluateFleetAutoStartReadiness({
        stats: { bootReceived: false, heartbeatCount: 1 },
        hasLiveClient: true,
        hasHistoricalBoot: false,
      });
      assert(r.ready === false, '(2) WS + heartbeat + no historical Boot → not ready');
      assert(r.reason === 'no-boot', '(2) reason=no-boot');
    }

    // (3) active WS + historical BootNotification + heartbeatCount=0 → no-heartbeat
    //     CRITICAL: historical Boot alone must NOT bypass the heartbeat
    //     gate. Heartbeat proves "currently alive on this process",
    //     historical Boot only proves "has booted before in lifetime".
    //     Both are required.
    {
      const r = evaluateFleetAutoStartReadiness({
        stats: { bootReceived: false, heartbeatCount: 0 },
        hasLiveClient: true,
        hasHistoricalBoot: true,
      });
      assert(r.ready === false, '(3) WS + historical Boot + heartbeatCount=0 → not ready');
      assert(r.reason === 'no-heartbeat', '(3) reason=no-heartbeat (historical Boot does NOT bypass heartbeat)');
    }

    // Sanity coverage of the other early-exit branches so they don't
    // regress while we tinker with the historical-boot logic.

    // null stats → no-live-ws
    {
      const r = evaluateFleetAutoStartReadiness({
        stats: null,
        hasLiveClient: false,
        hasHistoricalBoot: true,
      });
      assert(!r.ready && r.reason === 'no-live-ws', 'null stats → no-live-ws');
    }

    // stats present but client evicted by registry stale check → ws-stale
    {
      const r = evaluateFleetAutoStartReadiness({
        stats: { bootReceived: true, heartbeatCount: 5 },
        hasLiveClient: false,
        hasHistoricalBoot: true,
      });
      assert(!r.ready && r.reason === 'ws-stale', 'stats but no live client → ws-stale');
    }

    // In-process bootReceived true short-circuits to ok (no DB lookup
    // needed at runtime — pure function path doesn't even consult
    // hasHistoricalBoot in this branch).
    {
      const r = evaluateFleetAutoStartReadiness({
        stats: { bootReceived: true, heartbeatCount: 1 },
        hasLiveClient: true,
        hasHistoricalBoot: false,
      });
      assert(r.ready && r.reason === 'ok', 'in-memory bootReceived → ok');
    }
  }

  console.log(`\n\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
