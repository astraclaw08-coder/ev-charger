import { prisma } from '@ev-charger/shared';
import type { PortalAccessClaimsV1 } from '../lib/portalAccessClaims';

/**
 * List chargers with optional filters (mirrors GET /chargers logic, scoped to operator).
 */
export async function listChargers(
  filters: { siteId?: string; limit?: number },
  claims: PortalAccessClaimsV1,
) {
  const scopedSiteIds = claims.siteIds ?? [];
  const limit = Math.min(filters.limit ?? 50, 50);

  const where: any = {};

  // Apply site scope from claims
  if (scopedSiteIds.length > 0 && !scopedSiteIds.includes('*')) {
    where.siteId = { in: scopedSiteIds };
  }

  // Further filter by specific siteId if provided
  if (filters.siteId) {
    if (scopedSiteIds.length > 0 && !scopedSiteIds.includes('*') && !scopedSiteIds.includes(filters.siteId)) {
      return { error: 'Site not in scope' };
    }
    where.siteId = filters.siteId;
  }

  const chargers = await prisma.charger.findMany({
    where,
    take: limit,
    include: {
      site: {
        select: {
          id: true,
          name: true,
          address: true,
        },
      },
      connectors: { select: { id: true, connectorId: true, status: true } },
    },
  });

  return chargers.map(({ password: _pw, ...c }: any) => c);
}

/**
 * Get charger real-time status (mirrors GET /chargers/:id/status logic).
 */
export async function getChargerStatus(chargerId: string) {
  const charger = await prisma.charger.findUnique({
    where: { id: chargerId },
    include: {
      connectors: {
        include: {
          sessions: {
            where: { status: 'ACTIVE' },
            take: 1,
            include: { user: { select: { id: true, name: true, email: true } } },
          },
        },
      },
      site: { select: { id: true, name: true } },
    },
  });

  if (!charger) return { error: 'Charger not found' };

  return {
    id: charger.id,
    ocppId: charger.ocppId,
    serialNumber: charger.serialNumber,
    model: charger.model,
    vendor: charger.vendor,
    status: charger.status,
    lastHeartbeat: charger.lastHeartbeat,
    site: charger.site,
    connectors: charger.connectors.map((c: any) => ({
      connectorId: c.connectorId,
      status: c.status,
      activeSession: c.sessions[0] ?? null,
    })),
  };
}
