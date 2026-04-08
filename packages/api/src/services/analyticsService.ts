import { prisma } from '@ev-charger/shared';
import type { PortalAccessClaimsV1 } from '../lib/portalAccessClaims';

function toNumber(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number.parseFloat(value);
  if (typeof value === 'object' && value && 'toString' in value) return Number.parseFloat(String(value));
  return 0;
}

/**
 * Get portfolio summary from SiteDailyFact (mirrors GET /analytics/portfolio-summary logic).
 */
export async function getPortfolioSummary(
  params: { startDate?: string; endDate?: string; siteId?: string },
  claims: PortalAccessClaimsV1,
) {
  const scopedSiteIds = claims.siteIds ?? [];

  // Parse date range
  const hasCustomRange = Boolean(params.startDate || params.endDate);
  if (hasCustomRange && (!params.startDate || !params.endDate)) {
    return { error: 'startDate and endDate are required together' };
  }

  const end = params.endDate ? new Date(`${params.endDate}T23:59:59.999Z`) : new Date();
  const start = params.startDate
    ? new Date(`${params.startDate}T00:00:00.000Z`)
    : new Date(end.getTime() - 29 * 24 * 60 * 60 * 1000);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    return { error: 'Invalid date range' };
  }

  // Check site access
  if (params.siteId && scopedSiteIds.length > 0 && !scopedSiteIds.includes('*') && !scopedSiteIds.includes(params.siteId)) {
    return { error: 'Site not in scope' };
  }

  const rows = await prisma.siteDailyFact.findMany({
    where: {
      day: { gte: start, lte: end },
      ...(params.siteId ? { siteId: params.siteId } : {}),
      ...(scopedSiteIds.length > 0 && !scopedSiteIds.includes('*') ? { siteId: { in: scopedSiteIds } } : {}),
    },
    include: {
      site: {
        select: {
          id: true,
          name: true,
          organizationName: true,
          portfolioName: true,
        },
      },
    },
    orderBy: [{ day: 'asc' }],
  });

  const siteMap = new Map<string, {
    siteId: string;
    siteName: string;
    organizationName: string | null;
    portfolioName: string | null;
    sessionsCount: number;
    totalEnergyKwh: number;
    totalRevenueUsd: number;
  }>();

  for (const row of rows) {
    const existing = siteMap.get(row.siteId) ?? {
      siteId: row.siteId,
      siteName: row.site.name,
      organizationName: row.site.organizationName,
      portfolioName: row.site.portfolioName,
      sessionsCount: 0,
      totalEnergyKwh: 0,
      totalRevenueUsd: 0,
    };

    existing.sessionsCount += row.sessionsCount;
    existing.totalEnergyKwh += toNumber(row.totalEnergyKwh);
    existing.totalRevenueUsd += toNumber(row.totalRevenueUsd);
    siteMap.set(row.siteId, existing);
  }

  const sites = Array.from(siteMap.values()).map((site) => ({
    ...site,
    totalEnergyKwh: Number(site.totalEnergyKwh.toFixed(6)),
    totalRevenueUsd: Number(site.totalRevenueUsd.toFixed(6)),
  }));

  const totals = sites.reduce((acc, site) => ({
    siteCount: acc.siteCount + 1,
    sessionsCount: acc.sessionsCount + site.sessionsCount,
    totalEnergyKwh: acc.totalEnergyKwh + site.totalEnergyKwh,
    totalRevenueUsd: acc.totalRevenueUsd + site.totalRevenueUsd,
  }), { siteCount: 0, sessionsCount: 0, totalEnergyKwh: 0, totalRevenueUsd: 0 });

  return {
    range: {
      startDate: start.toISOString().slice(0, 10),
      endDate: end.toISOString().slice(0, 10),
    },
    totals: {
      ...totals,
      totalEnergyKwh: Number(totals.totalEnergyKwh.toFixed(6)),
      totalRevenueUsd: Number(totals.totalRevenueUsd.toFixed(6)),
    },
    sites,
  };
}
