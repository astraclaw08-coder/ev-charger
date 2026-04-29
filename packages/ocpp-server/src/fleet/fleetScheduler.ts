/**
 * TASK-0208 Phase 2 (PR-d) — fleet window scheduler + enforcement driver.
 *
 * Single source of truth for calling applyFleetPolicyProfile() from the
 * runtime. Drives two kinds of events:
 *
 *   1. Per-charger edge timers — fire exactly at the next fleet-window
 *      transition (windowStart or windowEnd) for that charger's ACTIVE
 *      fleet session. Fresh policy read on each event (pin #1).
 *   2. Periodic reconciliation tick — default 5 min, env-tunable via
 *      `FLEET_SCHEDULER_RECONCILE_MS`. Enumerates all ACTIVE fleet sessions
 *      and re-asserts correct gate state. Backstops edge-timer drift and
 *      heals from process restarts.
 *
 * Pins (approved 2026-04-24):
 *   1. Policy + site timezone re-read fresh on every event/tick.
 *   2. Release is time-based only; energy-based early release deferred.
 *   3. Boot re-apply: ALL ACTIVE fleet sessions on the booting charger.
 *   4. Reconcile cadence env-tunable (FLEET_SCHEDULER_RECONCILE_MS),
 *      5 min default.
 *   5. sendProfile failure → wait for next tick. No inline retry.
 *   6. >1 ACTIVE fleet session on same charger → warn + skip enforcement
 *      for that charger this cycle. Never silently first-wins.
 *   7. start/stop idempotent.
 *   8. Non-fatal enforcement error logs include sessionId, chargerId,
 *      fleetPolicyId, intendedMode.
 *
 * RAM state lives inside applyFleetPolicyProfile; this module owns only
 * the timer + started-flag state.
 */

import { prisma } from '@ev-charger/shared';
import { evaluateFleetWindowAt } from '@ev-charger/shared';
import { applyFleetPolicyProfile, type FleetGateMode } from './applyFleetPolicyProfile';

export const DEFAULT_RECONCILE_MS = 5 * 60_000;
/** Guard: refuse reconcile ticks faster than 10 s — avoid accidental hot loops. */
export const MIN_RECONCILE_MS = 10_000;

/** Guard: don't schedule edge timers farther than 7 days out. Reconcile will pick up drift. */
export const MAX_EDGE_DELAY_MS = 7 * 24 * 60 * 60_000;
/** Guard: floor edge-timer delay at 1 s to avoid immediate re-fire storms. */
export const MIN_EDGE_DELAY_MS = 1_000;

/** Shape the scheduler needs for each ACTIVE fleet session. */
export interface SessionForSchedule {
  sessionId: string;
  chargerId: string;
  ocppId: string;
  fleetPolicyId: string;
  maxAmps: number;
  windowsJson: unknown;
  siteTimeZone: string | null;
  /**
   * Mirrors `FleetPolicy.alwaysOn`. When true the engine treats the policy as
   * permanently in-window — gate is GATE_RELEASED at all times regardless of
   * `windowsJson`. (TASK-0208 Phase 3 alwaysOn engine fix.)
   */
  alwaysOn: boolean;
}

export type FetchActiveFleetSessions = () => Promise<SessionForSchedule[]>;
export type FetchActiveFleetSessionsForCharger = (chargerId: string) => Promise<SessionForSchedule[]>;

export interface FleetSchedulerOpts {
  /** Seam for tests. Default: Date-based. */
  now?: () => Date;
  /** Seam for tests. Default: real prisma-backed fetch. */
  fetchAll?: FetchActiveFleetSessions;
  /** Seam for tests. Default: real prisma-backed fetch. */
  fetchForCharger?: FetchActiveFleetSessionsForCharger;
  /** Seam for tests. Default: real applyFleetPolicyProfile. */
  applyProfile?: typeof applyFleetPolicyProfile;
  /** Seam for tests. Default: process.env read. */
  flagEnabled?: () => boolean;
  /** Seam for tests. Default: Number(process.env.FLEET_SCHEDULER_RECONCILE_MS) || DEFAULT_RECONCILE_MS. */
  reconcileMs?: number;
  /** Seam for tests. Defaults to setTimeout/clearTimeout/setInterval/clearInterval. */
  timers?: TimerFns;
}

export interface TimerFns {
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  setInterval: (cb: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

const realTimers: TimerFns = {
  setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as NodeJS.Timeout),
  setInterval: (cb, ms) => globalThis.setInterval(cb, ms),
  clearInterval: (h) => globalThis.clearInterval(h as NodeJS.Timeout),
};

interface InternalState {
  started: boolean;
  reconcileHandle: unknown | null;
  /** Per-charger edge-transition timer. Keyed by chargerId. */
  edgeTimers: Map<string, unknown>;
  cfg: Required<Pick<FleetSchedulerOpts, 'now' | 'flagEnabled' | 'reconcileMs'>> & {
    fetchAll: FetchActiveFleetSessions;
    fetchForCharger: FetchActiveFleetSessionsForCharger;
    applyProfile: typeof applyFleetPolicyProfile;
    timers: TimerFns;
  };
}

function defaultFlagEnabled(): boolean {
  return process.env.FLEET_GATED_SESSIONS_ENABLED === 'true';
}

function defaultReconcileMs(): number {
  const raw = Number(process.env.FLEET_SCHEDULER_RECONCILE_MS);
  if (Number.isFinite(raw) && raw >= MIN_RECONCILE_MS) return raw;
  return DEFAULT_RECONCILE_MS;
}

// NOTE: Session.fleetPolicyId is intentionally FK-less (design note rule 3 —
// policy edits/deletions must never corrupt session history). We fetch
// sessions + policies separately and join in-memory. Rows whose
// fleetPolicyId no longer resolves to an existing FleetPolicy are dropped
// from scheduling with a warning; they remain valid sessions and continue
// to stop/bill normally, they just can't be enforced.

async function hydrateSessions(
  sessions: Array<{ id: string; fleetPolicyId: string | null; connector: { charger: { id: string; ocppId: string } } }>,
): Promise<SessionForSchedule[]> {
  const policyIds = Array.from(
    new Set(sessions.map((r) => r.fleetPolicyId).filter((x): x is string => typeof x === 'string')),
  );
  if (policyIds.length === 0) return [];
  const policies = await prisma.fleetPolicy.findMany({
    where: { id: { in: policyIds } },
    select: { id: true, maxAmps: true, windowsJson: true, alwaysOn: true, site: { select: { timeZone: true } } },
  });
  const byId = new Map<string, (typeof policies)[number]>(policies.map((p: any) => [p.id as string, p]));
  const out: SessionForSchedule[] = [];
  for (const r of sessions) {
    if (!r.fleetPolicyId) continue;
    const pol = byId.get(r.fleetPolicyId);
    if (!pol) {
      console.warn(
        `[FleetScheduler] dropping session with unresolvable fleetPolicyId: sessionId=${r.id} fleetPolicyId=${r.fleetPolicyId}`,
      );
      continue;
    }
    out.push({
      sessionId: r.id,
      chargerId: r.connector.charger.id,
      ocppId: r.connector.charger.ocppId,
      fleetPolicyId: pol.id,
      maxAmps: pol.maxAmps,
      windowsJson: pol.windowsJson,
      siteTimeZone: (pol.site?.timeZone as string | null) ?? null,
      alwaysOn: Boolean((pol as any).alwaysOn),
    });
  }
  return out;
}

async function defaultFetchAll(): Promise<SessionForSchedule[]> {
  const rows = await prisma.session.findMany({
    where: { status: 'ACTIVE', fleetPolicyId: { not: null } },
    select: {
      id: true,
      fleetPolicyId: true,
      connector: { select: { charger: { select: { id: true, ocppId: true } } } },
    },
  });
  return hydrateSessions(rows as any);
}

async function defaultFetchForCharger(chargerId: string): Promise<SessionForSchedule[]> {
  const rows = await prisma.session.findMany({
    where: {
      status: 'ACTIVE',
      fleetPolicyId: { not: null },
      connector: { chargerId },
    },
    select: {
      id: true,
      fleetPolicyId: true,
      connector: { select: { charger: { select: { id: true, ocppId: true } } } },
    },
  });
  return hydrateSessions(rows as any);
}

// Module-level singleton. `startFleetScheduler` is idempotent; second call
// with new opts is a no-op (the first-caller's config wins). Callers wanting
// to reconfigure must stop first.
let state: InternalState | null = null;

export function startFleetScheduler(opts: FleetSchedulerOpts = {}): void {
  if (state?.started) {
    return; // idempotent: already running
  }

  const cfg = {
    now: opts.now ?? (() => new Date()),
    flagEnabled: opts.flagEnabled ?? defaultFlagEnabled,
    reconcileMs: Math.max(MIN_RECONCILE_MS, opts.reconcileMs ?? defaultReconcileMs()),
    fetchAll: opts.fetchAll ?? defaultFetchAll,
    fetchForCharger: opts.fetchForCharger ?? defaultFetchForCharger,
    applyProfile: opts.applyProfile ?? applyFleetPolicyProfile,
    timers: opts.timers ?? realTimers,
  };

  state = {
    started: true,
    reconcileHandle: null,
    edgeTimers: new Map(),
    cfg,
  };

  // Kick off the periodic reconcile. First tick does NOT fire immediately —
  // caller can invoke reconcileAll() themselves if they want an immediate pass.
  state.reconcileHandle = cfg.timers.setInterval(() => {
    reconcileAll().catch((err) => {
      console.warn(
        `[FleetScheduler] reconcile tick threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }, cfg.reconcileMs);

  console.log(`[FleetScheduler] started (reconcile=${cfg.reconcileMs}ms)`);
}

export function stopFleetScheduler(): void {
  if (!state) return; // idempotent
  const s = state;
  if (s.reconcileHandle != null) s.cfg.timers.clearInterval(s.reconcileHandle);
  for (const handle of s.edgeTimers.values()) s.cfg.timers.clearTimeout(handle);
  s.edgeTimers.clear();
  state = null;
  console.log('[FleetScheduler] stopped');
}

/** Intended gate mode for a given policy at a given instant. */
export function intendedModeAt(
  windowsJson: unknown,
  timeZone: string | null,
  at: Date,
  alwaysOn: boolean = false,
): { mode: FleetGateMode; nextTransitionAt: Date | null } {
  const evalResult = evaluateFleetWindowAt({ at, windows: windowsJson, timeZone, alwaysOn });
  return {
    mode: evalResult.active ? 'GATE_RELEASED' : 'GATE_ACTIVE',
    nextTransitionAt: evalResult.nextTransitionAt,
  };
}

/**
 * Reconcile a single charger. Exposed for direct call from Boot / Start /
 * Stop paths and for tests. Safe to call if scheduler hasn't started —
 * uses defaults when state is null.
 */
export async function reconcileCharger(chargerId: string): Promise<void> {
  const s = state;
  if (!s) {
    // Not started — build a one-shot config from defaults.
    const cfg = {
      now: () => new Date(),
      flagEnabled: defaultFlagEnabled,
      fetchForCharger: defaultFetchForCharger,
      applyProfile: applyFleetPolicyProfile,
      timers: realTimers,
    };
    if (!cfg.flagEnabled()) return;
    const sessions = await cfg.fetchForCharger(chargerId);
    await driveCharger(chargerId, sessions, cfg.now(), cfg.applyProfile, /* scheduleEdge */ false, null);
    return;
  }

  if (!s.cfg.flagEnabled()) {
    // Flag off — clear any lingering edge timer.
    clearEdgeTimer(s, chargerId);
    return;
  }

  const sessions = await s.cfg.fetchForCharger(chargerId);
  await driveCharger(chargerId, sessions, s.cfg.now(), s.cfg.applyProfile, true, s);
}

/**
 * Reconcile ALL ACTIVE fleet sessions. Called by the periodic interval and
 * available for manual invocation (e.g. on startup).
 */
export async function reconcileAll(): Promise<void> {
  const s = state;
  if (!s || !s.cfg.flagEnabled()) return;

  const all = await s.cfg.fetchAll();
  // Group by chargerId so the duplicate-skip rule sees all co-located sessions.
  const byCharger = new Map<string, SessionForSchedule[]>();
  for (const row of all) {
    const bucket = byCharger.get(row.chargerId);
    if (bucket) bucket.push(row);
    else byCharger.set(row.chargerId, [row]);
  }

  const now = s.cfg.now();
  for (const [chargerId, sessions] of byCharger) {
    try {
      await driveCharger(chargerId, sessions, now, s.cfg.applyProfile, true, s);
    } catch (err) {
      console.warn(
        `[FleetScheduler] reconcileCharger threw: chargerId=${chargerId} reason=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

// ─── Session/boot event handlers (called from OCPP handlers) ─────────────

export async function onSessionStart(chargerId: string): Promise<void> {
  // Flag-gated, non-fatal. Handlers wrap in try/catch anyway for belt-and-braces.
  await reconcileCharger(chargerId);
}

export function onSessionEnd(chargerId: string): void {
  // Clear the per-charger edge timer. The next reconcile tick will re-evaluate
  // if there are still other active fleet sessions on this charger.
  if (!state) return;
  clearEdgeTimer(state, chargerId);
}

export async function onBoot(chargerId: string): Promise<void> {
  // Pin #3: re-apply for ALL ACTIVE fleet sessions on this charger.
  // driveCharger already enumerates and applies duplicate-skip, so onBoot is
  // just a reconcileCharger call.
  await reconcileCharger(chargerId);
}

// ─── Internals ──────────────────────────────────────────────────────────

async function driveCharger(
  chargerId: string,
  sessions: SessionForSchedule[],
  now: Date,
  applyProfile: typeof applyFleetPolicyProfile,
  scheduleEdge: boolean,
  s: InternalState | null,
): Promise<void> {
  if (sessions.length === 0) {
    if (s) clearEdgeTimer(s, chargerId);
    return;
  }

  if (sessions.length > 1) {
    // Pin #6: NEVER silently first-wins. Warn and skip enforcement this cycle.
    const ids = sessions.map((x) => `${x.sessionId}(policy=${x.fleetPolicyId})`).join(',');
    console.warn(
      `[FleetScheduler] skipping enforcement: >1 ACTIVE fleet session on chargerId=${chargerId} sessions=[${ids}] — manual intervention required`,
    );
    // Do not schedule a new edge timer — next reconcile will re-check.
    if (s) clearEdgeTimer(s, chargerId);
    return;
  }

  const session = sessions[0];
  const intent = intendedModeAt(session.windowsJson, session.siteTimeZone, now, session.alwaysOn);

  const result = await applyProfile({
    chargerId: session.chargerId,
    ocppId: session.ocppId,
    policy: { id: session.fleetPolicyId, maxAmps: session.maxAmps },
    mode: intent.mode,
  });

  if (!result.ok) {
    // Pin #8: full context in non-fatal error log.
    const suffix =
      'skipped' in result
        ? `skipped=${result.skipped}`
        : `error=${result.error}`;
    console.warn(
      `[FleetScheduler] enforcement error: sessionId=${session.sessionId} chargerId=${session.chargerId} fleetPolicyId=${session.fleetPolicyId} intendedMode=${intent.mode} ${suffix} reason=${result.reason}`,
    );
    // Pin #5: wait for next tick, no inline retry. Still schedule next edge.
  }

  if (scheduleEdge && s) {
    scheduleEdgeTimer(s, chargerId, intent.nextTransitionAt, now);
  }
}

function clearEdgeTimer(s: InternalState, chargerId: string): void {
  const h = s.edgeTimers.get(chargerId);
  if (h != null) {
    s.cfg.timers.clearTimeout(h);
    s.edgeTimers.delete(chargerId);
  }
}

function scheduleEdgeTimer(
  s: InternalState,
  chargerId: string,
  nextTransitionAt: Date | null,
  now: Date,
): void {
  clearEdgeTimer(s, chargerId);
  if (!nextTransitionAt) return; // permanently active/inactive — reconcile still runs

  const rawDelay = nextTransitionAt.getTime() - now.getTime();
  if (!Number.isFinite(rawDelay)) return;
  const delay = Math.max(MIN_EDGE_DELAY_MS, Math.min(MAX_EDGE_DELAY_MS, rawDelay));

  const handle = s.cfg.timers.setTimeout(() => {
    // Edge fired — reconcile this charger. Errors are logged inside.
    reconcileCharger(chargerId).catch((err) => {
      console.warn(
        `[FleetScheduler] edge-timer reconcile threw: chargerId=${chargerId} reason=${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }, delay);
  s.edgeTimers.set(chargerId, handle);
}

// ─── Test helpers ──────────────────────────────────────────────────────

export function __getFleetSchedulerStateForTests(): {
  started: boolean;
  edgeTimerKeys: string[];
} {
  if (!state) return { started: false, edgeTimerKeys: [] };
  return { started: state.started, edgeTimerKeys: [...state.edgeTimers.keys()] };
}

export function __resetFleetSchedulerForTests(): void {
  if (state) {
    for (const h of state.edgeTimers.values()) state.cfg.timers.clearTimeout(h);
    if (state.reconcileHandle != null) state.cfg.timers.clearInterval(state.reconcileHandle);
  }
  state = null;
}
