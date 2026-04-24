/**
 * TASK-0208 Phase 2 — fleet-policy match resolution for Authorize.
 *
 * Given a site and a driver idTag, pick the single matching FleetPolicy to
 * associate with the session, or null if none apply.
 *
 * Selection rules (in order):
 *   1. Only ENABLED policies on the given site (DRAFT/DISABLED excluded).
 *   2. Prefix match via shared matchesFleetPolicy (case-sensitive).
 *   3. Longest prefix wins.
 *   4. On same-length prefix tie, newest updatedAt wins AND a warning is
 *      logged so the ambiguity is visible.
 *
 * Note: the FleetPolicy schema carries @@unique([siteId, idTagPrefix]), so
 * same-site identical-prefix collisions are impossible at the DB layer.
 * Same-length different-prefix collisions are also logically impossible
 * (two strings of equal length that are both prefixes of the same idTag
 * must be identical). Rule 4 is therefore defensive and will normally
 * never fire — but we implement it anyway so future schema relaxations
 * can't silently produce non-deterministic matching.
 */

import { matchesFleetPolicy } from '@ev-charger/shared';

export interface FleetPolicyForMatch {
  id: string;
  siteId: string;
  name: string;
  status: 'DRAFT' | 'ENABLED' | 'DISABLED';
  idTagPrefix: string;
  maxAmps: number;
  updatedAt: Date;
}

export interface MatchFleetPolicyOpts {
  siteId: string;
  idTag: string;
  /**
   * Policy source. Default queries Prisma; tests inject a fake list.
   * Must return ENABLED policies for the site — callers may pre-filter.
   */
  fetchPolicies: (siteId: string) => Promise<FleetPolicyForMatch[]>;
  /**
   * Logger seam for tests. Default is console.warn.
   */
  warn?: (msg: string) => void;
}

export async function matchFleetPolicy(
  opts: MatchFleetPolicyOpts,
): Promise<FleetPolicyForMatch | null> {
  const { siteId, idTag, fetchPolicies, warn = (m: string) => console.warn(m) } = opts;

  const all = await fetchPolicies(siteId);
  const enabled = all.filter((p) => p.status === 'ENABLED');
  if (enabled.length === 0) return null;

  const matches = enabled.filter((p) => matchesFleetPolicy(idTag, p.idTagPrefix));
  if (matches.length === 0) return null;

  // Sort: longest prefix first, then newest updatedAt first (descending).
  matches.sort((a, b) => {
    if (b.idTagPrefix.length !== a.idTagPrefix.length) {
      return b.idTagPrefix.length - a.idTagPrefix.length;
    }
    return b.updatedAt.getTime() - a.updatedAt.getTime();
  });

  // Detect same-length ambiguity at the top of the sorted list.
  if (matches.length > 1 && matches[0].idTagPrefix.length === matches[1].idTagPrefix.length) {
    warn(
      `[fleet] ambiguous policy match for siteId=${siteId} idTag=${idTag}: ` +
        `policies ${matches
          .filter((p) => p.idTagPrefix.length === matches[0].idTagPrefix.length)
          .map((p) => `${p.id}(prefix='${p.idTagPrefix}',updatedAt=${p.updatedAt.toISOString()})`)
          .join(', ')} — using newest updatedAt`,
    );
  }

  return matches[0];
}

/**
 * Default Prisma-backed policy fetcher. Kept as a separate export so
 * callers can pass a typed prisma client without the match helper
 * having a hard dependency on any particular prisma instance.
 */
export function makePrismaFleetPolicyFetcher(prisma: {
  fleetPolicy: {
    findMany: (args: {
      where: { siteId: string; status: 'ENABLED' };
      select: { id: true; siteId: true; name: true; status: true; idTagPrefix: true; maxAmps: true; updatedAt: true };
    }) => Promise<FleetPolicyForMatch[]>;
  };
}): (siteId: string) => Promise<FleetPolicyForMatch[]> {
  return async (siteId) =>
    prisma.fleetPolicy.findMany({
      where: { siteId, status: 'ENABLED' },
      select: {
        id: true,
        siteId: true,
        name: true,
        status: true,
        idTagPrefix: true,
        maxAmps: true,
        updatedAt: true,
      },
    });
}
