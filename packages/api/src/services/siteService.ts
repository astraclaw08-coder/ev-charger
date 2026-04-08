import { prisma } from '@ev-charger/shared';
import type { PortalAccessClaimsV1 } from '../lib/portalAccessClaims';
import { computeSessionAmounts } from '../lib/sessionBilling';

/**
 * List all sites accessible to the current operator (mirrors GET /sites logic).
 */
export async function listSites(claims: PortalAccessClaimsV1) {
  const scopedSiteIds = claims.siteIds ?? [];
  const isOwner = claims.roles.some(r => r === 'owner' || r === 'super_admin');

  const sites = await prisma.site.findMany({
    where: scopedSiteIds.length > 0 && !scopedSiteIds.includes('*')
      ? { id: { in: scopedSiteIds } }
      : (isOwner ? {} : undefined),
    include: {
      chargers: {
        select: {
          status: true,
          _count: { select: { connectors: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return (sites as any[]).map((site: any) => ({
    id: site.id,
    name: site.name,
    address: site.address,
    lat: site.lat,
    lng: site.lng,
    pricingMode: site.pricingMode,
    pricePerKwhUsd: site.pricePerKwhUsd,
    organizationName: site.organizationName,
    portfolioName: site.portfolioName,
    createdAt: site.createdAt,
    chargerCount: site.chargers.length,
    connectorCount: site.chargers.reduce((sum: number, c: any) => sum + (c._count?.connectors ?? 0), 0),
    statusSummary: {
      online: site.chargers.filter((c: any) => c.status === 'ONLINE').length,
      offline: site.chargers.filter((c: any) => c.status === 'OFFLINE').length,
      faulted: site.chargers.filter((c: any) => c.status === 'FAULTED').length,
    },
  }));
}

/**
 * Get site detail with chargers (mirrors GET /sites/:id logic).
 */
export async function getSiteDetail(siteId: string, claims: PortalAccessClaimsV1) {
  const scopedSiteIds = claims.siteIds ?? [];
  if (scopedSiteIds.length > 0 && !scopedSiteIds.includes('*') && !scopedSiteIds.includes(siteId)) {
    return { error: 'Site not in scope' };
  }

  const site = await prisma.site.findUnique({
    where: { id: siteId },
    include: {
      chargers: {
        orderBy: { createdAt: 'asc' },
        include: { connectors: true },
      },
    },
  });

  if (!site) return { error: 'Site not found' };

  return {
    id: site.id,
    name: site.name,
    address: site.address,
    lat: site.lat,
    lng: site.lng,
    pricingMode: site.pricingMode,
    pricePerKwhUsd: site.pricePerKwhUsd,
    idleFeePerMinUsd: site.idleFeePerMinUsd,
    activationFeeUsd: site.activationFeeUsd,
    gracePeriodMin: site.gracePeriodMin,
    organizationName: site.organizationName,
    portfolioName: site.portfolioName,
    createdAt: site.createdAt,
    chargers: site.chargers.map(({ password: _pw, ...c }: any) => c),
  };
}

/**
 * Get site analytics for a given period (mirrors GET /sites/:id/analytics logic).
 */
export async function getSiteAnalytics(siteId: string, periodDays: number) {
  const site = await prisma.site.findUnique({
    where: { id: siteId },
    include: { chargers: { include: { connectors: true } } },
  });

  if (!site) return { error: 'Site not found' };

  const clampedDays = Math.min(Math.max(periodDays, 1), 120);
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - (clampedDays - 1) * 24 * 60 * 60 * 1000);

  const connectorIds = site.chargers.flatMap((c: any) => c.connectors.map((cn: any) => cn.id));

  const sessions = await prisma.session.findMany({
    where: {
      connectorId: { in: connectorIds },
      startedAt: { lte: endDate },
      OR: [
        { stoppedAt: { gte: startDate } },
        { stoppedAt: null, status: 'ACTIVE' },
      ],
    },
    include: { payment: true },
  });

  const getEffectiveAmountCents = (s: any) => (
    computeSessionAmounts({
      ...s,
      pricingMode: site.pricingMode,
      pricePerKwhUsd: site.pricePerKwhUsd,
      idleFeePerMinUsd: site.idleFeePerMinUsd,
      gracePeriodMin: site.gracePeriodMin,
      touWindows: site.touWindows,
      softwareVendorFeeMode: site.softwareVendorFeeMode,
      softwareVendorFeeValue: site.softwareVendorFeeValue,
      activationFeeUsd: site.activationFeeUsd,
      softwareFeeIncludesActivation: (site as any).softwareFeeIncludesActivation ?? false,
    } as any).effectiveAmountCents ?? 0
  );

  const sessionsCount = sessions.length;
  const kwhDelivered = sessions.reduce((sum: number, s: any) => sum + (s.kwhDelivered ?? 0), 0);
  const revenueCents = sessions.reduce((sum: number, s: any) => sum + getEffectiveAmountCents(s), 0);

  // Utilization
  const periodSeconds = clampedDays * 24 * 60 * 60;
  const availableConnectorSeconds = connectorIds.length * periodSeconds;
  const now = new Date();
  const activeChargingSeconds = sessions.reduce((sum: number, s: any) => {
    const sessionEnd = s.stoppedAt ?? (s.status === 'ACTIVE' ? now : null);
    if (!sessionEnd) return sum;
    const startedMs = Math.max(s.startedAt.getTime(), startDate.getTime());
    const stoppedMs = Math.min(sessionEnd.getTime(), endDate.getTime(), now.getTime());
    if (stoppedMs <= startedMs) return sum;
    return sum + Math.floor((stoppedMs - startedMs) / 1000);
  }, 0);
  const utilizationRatePct = availableConnectorSeconds > 0
    ? Math.round((activeChargingSeconds / availableConnectorSeconds) * 10000) / 100
    : 0;

  return {
    siteId: site.id,
    siteName: site.name,
    periodDays: clampedDays,
    sessionsCount,
    kwhDelivered: Math.round(kwhDelivered * 1000) / 1000,
    revenueCents,
    revenueUsd: revenueCents / 100,
    utilizationRatePct,
  };
}
