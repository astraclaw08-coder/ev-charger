/**
 * TASK-0208 Phase 2 — Authorize → StartTransaction linkage cache.
 *
 * When Authorize matches a fleet policy for an idTag on a charger, we stash
 * the linkage (policyId + wall-clock plug-in time) here so the subsequent
 * StartTransaction can attach it to the Session row without re-querying the
 * policy set (policies may be edited between the two calls — Authorize is
 * the canonical match point).
 *
 * Design:
 *   - In-memory only (single OCPP-server process assumption, documented).
 *   - Keyed by `${chargerId}:${idTag}`. chargerId not ocppId because
 *     FleetPolicy and Session both relate via chargerId-adjacent entities.
 *   - TTL = 10 min. Most plug→start delays are < 30 s in practice; 10 min
 *     is generous enough to tolerate driver hesitation and short WS blips
 *     while still bounding cache lifetime.
 *   - Consume-on-read: StartTransaction deletes the entry. If the session
 *     doesn't start (driver walks away), the entry expires naturally.
 *   - Bounded to 1,000 entries with LRU eviction on insert. Under a flood
 *     of Authorize spam, oldest entries drop rather than OOM.
 *   - Flag-gated by FLEET_GATED_SESSIONS_ENABLED: when off, put() is a
 *     no-op and consume() returns null. No external side-effects at all.
 *
 * Clustering note: multi-process OCPP servers would lose Authorize→Start
 * linkage if those CALLs land on different pods. Phase 2 assumes single
 * process. Clustering support would require a shared cache (Redis) or
 * persistence to a short-lived DB table.
 */

export interface FleetAuthorizeCacheEntry {
  fleetPolicyId: string;
  plugInAt: Date;
  expiresAt: Date;
}

const TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ENTRIES = 1000;

// Map preserves insertion order → we use that as LRU ordering: on access
// we delete+reinsert to move to tail; on eviction we drop the head.
const cache = new Map<string, FleetAuthorizeCacheEntry>();

function cacheKey(chargerId: string, idTag: string): string {
  return `${chargerId}:${idTag}`;
}

function isFlagEnabled(): boolean {
  return process.env.FLEET_GATED_SESSIONS_ENABLED === 'true';
}

/**
 * Lazily prune expired entries. Called from put/consume so we don't need
 * a background timer.
 */
function pruneExpired(now: number): void {
  for (const [k, v] of cache) {
    if (v.expiresAt.getTime() <= now) {
      cache.delete(k);
    } else {
      // Map iteration is insertion-ordered; once we hit a non-expired entry,
      // everything after it was inserted later and is also non-expired
      // (because expiresAt is monotonic with put-time for fixed TTL).
      break;
    }
  }
}

export interface PutOpts {
  chargerId: string;
  idTag: string;
  fleetPolicyId: string;
  plugInAt?: Date; // defaults to now()
  flagEnabled?: () => boolean; // test seam
  now?: () => number; // test seam
}

/**
 * Insert or replace the linkage entry. Flag-off → no-op.
 *
 * Returns the stored entry on insert, or null when the flag is off.
 */
export function putFleetAuthorize(opts: PutOpts): FleetAuthorizeCacheEntry | null {
  const {
    chargerId,
    idTag,
    fleetPolicyId,
    plugInAt,
    flagEnabled = isFlagEnabled,
    now = Date.now,
  } = opts;

  if (!flagEnabled()) return null;

  const nowMs = now();
  pruneExpired(nowMs);

  const entry: FleetAuthorizeCacheEntry = {
    fleetPolicyId,
    plugInAt: plugInAt ?? new Date(nowMs),
    expiresAt: new Date(nowMs + TTL_MS),
  };

  const key = cacheKey(chargerId, idTag);
  // Replace semantics: delete-then-set to move to tail (most-recently-used).
  cache.delete(key);
  cache.set(key, entry);

  // Capacity enforcement: drop oldest entries until we fit.
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }

  return entry;
}

export interface ConsumeOpts {
  chargerId: string;
  idTag: string;
  flagEnabled?: () => boolean;
  now?: () => number;
}

/**
 * Fetch and DELETE the linkage entry in one step. Returns null when:
 *   - the flag is off
 *   - no entry exists
 *   - the entry has expired (also cleans it up)
 *
 * StartTransaction calls this exactly once per transaction.
 */
export function consumeFleetAuthorize(opts: ConsumeOpts): FleetAuthorizeCacheEntry | null {
  const { chargerId, idTag, flagEnabled = isFlagEnabled, now = Date.now } = opts;

  if (!flagEnabled()) return null;

  const nowMs = now();
  const key = cacheKey(chargerId, idTag);
  const entry = cache.get(key);
  if (!entry) return null;

  cache.delete(key);

  if (entry.expiresAt.getTime() <= nowMs) {
    return null;
  }

  return entry;
}

// --- diagnostics / tests ---

export function getFleetAuthorizeCacheSize(): number {
  return cache.size;
}

export function __resetFleetAuthorizeCacheForTests(): void {
  cache.clear();
}

export const FLEET_AUTHORIZE_CACHE_LIMITS = Object.freeze({
  ttlMs: TTL_MS,
  maxEntries: MAX_ENTRIES,
});
