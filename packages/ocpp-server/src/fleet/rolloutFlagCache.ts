/**
 * Two-tier Fleet-Auto rollout flag cache (TASK-0208 Phase 3 Slice C).
 *
 * Resolves the effective per-connector rollout enable, taking the
 * Connector-level override when present and falling back to the Site
 * default. Mirrors the runtime decision matrix from the redesign doc:
 *
 *     env(FLEET_GATED_SESSIONS_ENABLED) === true                    (env tier)
 *     AND (connector.fleetAutoRolloutEnabled === true               (DB tier)
 *          OR (connector.fleetAutoRolloutEnabled IS NULL            ↓
 *              AND site.fleetAutoRolloutEnabled === true))          ↓
 *
 * This module owns ONLY the DB tier (the "pilot rollout") side. The env
 * tier is a process.env read in `fleetAutoStart.ts` — restart-flip-only,
 * no caching needed there.
 *
 * Caching:
 *   - In-memory Map keyed by Connector.id (DB row id).
 *   - TTL 30 s default, env-tunable via `FLEET_ROLLOUT_CACHE_TTL_MS`.
 *   - Operator portal toggles writes to the DB; cache picks up on next
 *     read after TTL elapses. Per design doc §0 #5: ≤30 s flip latency.
 *   - Process restart clears the map; first read after restart eats one
 *     DB query per connector (cold-start cost is fine — restarts are rare).
 *
 * Access pattern (mirrors `applyFleetPolicyProfile.ts`):
 *   - Read: `isRolloutEnabled({ connectorId, siteId })` returns boolean.
 *   - Reset: `__resetRolloutCacheForTests()` for selftest use.
 *
 * Pre-warm / invalidation:
 *   Not needed for V1. The portal write path doesn't have a way to talk
 *   to the OCPP process anyway, so we'd have to over-engineer to support
 *   instant invalidation. 30s TTL is the design contract.
 */

import { prisma } from '@ev-charger/shared';

const DEFAULT_TTL_MS = 30_000;
const MIN_TTL_MS = 1_000; // floor so hot loops don't melt the DB
const MAX_TTL_MS = 5 * 60_000;

function ttlMs(): number {
  const raw = process.env.FLEET_ROLLOUT_CACHE_TTL_MS;
  if (!raw) return DEFAULT_TTL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_TTL_MS;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, n));
}

type CacheEntry = {
  /** Effective rollout enable: connector override if non-null, else site flag. */
  enabled: boolean;
  /** When this entry expires and a fresh DB read is required. */
  expiresAt: number;
};

const cache = new Map<string, CacheEntry>();

/**
 * Lookup the effective rollout flag for a connector.
 *
 * Cache miss / TTL expired → fresh DB read of:
 *   - Connector.fleetAutoRolloutEnabled (boolean | null)
 *   - Site.fleetAutoRolloutEnabled      (boolean)
 *
 * Effective value:
 *   connector override if non-null, else site value.
 *
 * Failure (DB error) → returns `false` (fail-closed). Auto-start is the
 * sensitive direction; better to skip an auto-start than to fire one
 * during transient DB issues. Caller logs the skip reason.
 */
export async function isRolloutEnabled(
  args: { connectorId: string; siteId: string | null },
): Promise<boolean> {
  if (!args.siteId) return false; // chargers without a site can't be in a rollout pilot
  const now = Date.now();
  const cacheKey = args.connectorId;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.enabled;
  }

  let enabled = false;
  try {
    const [connectorRow, siteRow] = await Promise.all([
      (prisma as any).connector.findUnique({
        where: { id: args.connectorId },
        select: { fleetAutoRolloutEnabled: true },
      }) as Promise<{ fleetAutoRolloutEnabled: boolean | null } | null>,
      (prisma as any).site.findUnique({
        where: { id: args.siteId },
        select: { fleetAutoRolloutEnabled: true },
      }) as Promise<{ fleetAutoRolloutEnabled: boolean } | null>,
    ]);

    if (connectorRow?.fleetAutoRolloutEnabled === true) {
      enabled = true;
    } else if (connectorRow?.fleetAutoRolloutEnabled === false) {
      enabled = false; // explicit override wins
    } else {
      // null → inherit from site
      enabled = siteRow?.fleetAutoRolloutEnabled === true;
    }
  } catch (err) {
    // Fail-closed. Log via console for ops visibility; no logger imported
    // here to keep this module dependency-light.
    console.warn(
      `[fleet.rollout-cache] DB read failed (fail-closed → false): connectorId=${args.connectorId} siteId=${args.siteId} err=${err instanceof Error ? err.message : String(err)}`,
    );
    enabled = false;
  }

  cache.set(cacheKey, { enabled, expiresAt: now + ttlMs() });
  return enabled;
}

/** Test seam — drops all cached entries. Use only from selftests. */
export function __resetRolloutCacheForTests(): void {
  cache.clear();
}

/**
 * Optional manual invalidation. Reserved for a future cross-process
 * notification channel (e.g. Postgres LISTEN/NOTIFY) if the 30-s TTL
 * proves too slow. Currently no callers; kept exported for forward use.
 */
export function invalidateRolloutCacheForConnector(connectorId: string): void {
  cache.delete(connectorId);
}
