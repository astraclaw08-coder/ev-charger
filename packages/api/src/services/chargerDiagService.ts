import { prisma } from '@ev-charger/shared';
import type { PortalAccessClaimsV1 } from '../lib/portalAccessClaims';
import { getChargerUptime } from '../lib/uptime';

/**
 * Get charger uptime metrics — delegates to lib/uptime.ts.
 */
export async function getChargerUptimeMetrics(chargerId: string, claims: PortalAccessClaimsV1) {
  // Verify charger exists and is in scope
  const charger = await prisma.charger.findUnique({
    where: { id: chargerId },
    select: { id: true, siteId: true, ocppId: true },
  });
  if (!charger) return { error: 'Charger not found' };

  const scopedSiteIds = claims.siteIds ?? [];
  if (charger.siteId && scopedSiteIds.length > 0 && !scopedSiteIds.includes('*') && !scopedSiteIds.includes(charger.siteId)) {
    return { error: 'Site not in scope' };
  }

  const result = await getChargerUptime(chargerId);
  return result;
}

/**
 * Get site-level uptime metrics — aggregates across all chargers at a site.
 */
export async function getSiteUptimeMetrics(siteId: string, claims: PortalAccessClaimsV1) {
  const scopedSiteIds = claims.siteIds ?? [];
  if (scopedSiteIds.length > 0 && !scopedSiteIds.includes('*') && !scopedSiteIds.includes(siteId)) {
    return { error: 'Site not in scope' };
  }

  const site = await prisma.site.findUnique({
    where: { id: siteId },
    include: { chargers: { select: { id: true, ocppId: true, status: true } } },
  });
  if (!site) return { error: 'Site not found' };

  const uptimeResults = await Promise.all(
    site.chargers.map(async (c: any) => {
      try {
        const ut = await getChargerUptime(c.id);
        return { chargerId: c.id, ocppId: c.ocppId, status: c.status, ...ut };
      } catch {
        return { chargerId: c.id, ocppId: c.ocppId, status: c.status, error: 'Failed to compute uptime' };
      }
    }),
  );

  // Compute site average
  const valid = uptimeResults.filter((r: any) => r.uptimePercent30d != null);
  const avg30d = valid.length > 0
    ? Math.round(valid.reduce((s: number, r: any) => s + (r.uptimePercent30d ?? 0), 0) / valid.length * 100) / 100
    : null;

  return {
    siteId: site.id,
    siteName: site.name,
    chargerCount: site.chargers.length,
    averageUptime30d: avg30d,
    chargers: uptimeResults,
  };
}

/**
 * Get charger connection events — mirrors GET /chargers/:id/connection-events.
 */
export async function getChargerConnectionEvents(
  chargerId: string,
  params: { limit?: number },
  claims: PortalAccessClaimsV1,
) {
  const limit = Math.min(params.limit ?? 50, 200);

  const charger = await prisma.charger.findUnique({
    where: { id: chargerId },
    select: { id: true, siteId: true, ocppId: true },
  });
  if (!charger) return { error: 'Charger not found' };

  const scopedSiteIds = claims.siteIds ?? [];
  if (charger.siteId && scopedSiteIds.length > 0 && !scopedSiteIds.includes('*') && !scopedSiteIds.includes(charger.siteId)) {
    return { error: 'Site not in scope' };
  }

  const events = await prisma.chargerConnectionEvent.findMany({
    where: { chargerId: charger.id },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  return {
    chargerId: charger.id,
    ocppId: charger.ocppId,
    events: events.map((e: any) => ({
      id: e.id,
      event: e.event,
      connectedAt: e.connectedAt,
      disconnectedAt: e.disconnectedAt,
      durationMs: e.durationMs,
      closeCode: e.closeCode,
      closeReason: e.closeReason,
      createdAt: e.createdAt,
    })),
  };
}

/**
 * Search chargers by OCPP ID, serial number, or model — cross-site search within scope.
 */
export async function searchChargers(
  query: string,
  claims: PortalAccessClaimsV1,
) {
  const q = query.trim();
  if (q.length < 2) return { error: 'Query must be at least 2 characters' };

  const scopedSiteIds = claims.siteIds ?? [];
  const siteScope = scopedSiteIds.length > 0 && !scopedSiteIds.includes('*')
    ? { siteId: { in: scopedSiteIds } }
    : {};

  const chargers = await prisma.charger.findMany({
    where: {
      ...siteScope,
      OR: [
        { ocppId: { contains: q, mode: 'insensitive' } },
        { serialNumber: { contains: q, mode: 'insensitive' } },
        { model: { contains: q, mode: 'insensitive' } },
        { vendor: { contains: q, mode: 'insensitive' } },
      ],
    },
    take: 20,
    include: {
      site: { select: { id: true, name: true } },
      connectors: { select: { connectorId: true, status: true } },
    },
  });

  return chargers.map(({ password: _pw, ...c }: any) => ({
    id: c.id,
    ocppId: c.ocppId,
    serialNumber: c.serialNumber,
    model: c.model,
    vendor: c.vendor,
    status: c.status,
    lastHeartbeat: c.lastHeartbeat,
    site: c.site,
    connectors: c.connectors,
  }));
}

/**
 * Get smart charging status overview — mirrors GET /smart-charging/states.
 */
export async function getSmartChargingStatus(
  params: { siteId?: string; status?: string },
  claims: PortalAccessClaimsV1,
) {
  const scopedSiteIds = claims.siteIds ?? [];
  if (params.siteId && scopedSiteIds.length > 0 && !scopedSiteIds.includes('*') && !scopedSiteIds.includes(params.siteId)) {
    return { error: 'Site not in scope' };
  }

  const states = await prisma.smartChargingState.findMany({
    where: {
      ...(params.status ? { status: params.status } : {}),
      ...(params.siteId ? { charger: { siteId: params.siteId } } : {}),
    },
    include: {
      charger: { select: { id: true, ocppId: true, siteId: true, status: true } },
      sourceProfile: { select: { id: true, name: true, scope: true } },
    },
    orderBy: { updatedAt: 'desc' },
    take: 200,
  });

  // Filter by site scope
  const filtered = scopedSiteIds.length > 0 && !scopedSiteIds.includes('*')
    ? states.filter((s: any) => scopedSiteIds.includes(s.charger?.siteId))
    : states;

  return filtered.map((s: any) => ({
    chargerId: s.charger?.id,
    ocppId: s.charger?.ocppId,
    chargerStatus: s.charger?.status,
    effectiveLimitKw: s.effectiveLimitKw != null ? Number(s.effectiveLimitKw) : null,
    status: s.status,
    lastAppliedAt: s.lastAppliedAt,
    lastError: s.lastError,
    sourceProfile: s.sourceProfile ? { id: s.sourceProfile.id, name: s.sourceProfile.name, scope: s.sourceProfile.scope } : null,
    updatedAt: s.updatedAt,
  }));
}

/**
 * Get audit log entries — mirrors GET /admin/users/audit.
 */
export async function getAuditLog(params: { limit?: number; action?: string }) {
  const limit = Math.min(params.limit ?? 50, 200);

  const where: any = {};
  if (params.action) {
    where.action = { contains: params.action };
  }

  const events = await prisma.adminAuditEvent.findMany({
    where,
    take: limit,
    orderBy: { createdAt: 'desc' },
  });

  return events.map((e: any) => ({
    id: e.id,
    operatorId: e.operatorId,
    action: e.action,
    targetUserId: e.targetUserId,
    targetEmail: e.targetEmail,
    metadata: e.metadata,
    createdAt: e.createdAt,
  }));
}

/**
 * Get site pricing configuration — extracts pricing fields from site detail.
 */
export async function getSitePricing(siteId: string, claims: PortalAccessClaimsV1) {
  const scopedSiteIds = claims.siteIds ?? [];
  if (scopedSiteIds.length > 0 && !scopedSiteIds.includes('*') && !scopedSiteIds.includes(siteId)) {
    return { error: 'Site not in scope' };
  }

  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: {
      id: true, name: true,
      pricingMode: true, pricePerKwhUsd: true, idleFeePerMinUsd: true,
      activationFeeUsd: true, gracePeriodMin: true, touWindows: true,
      softwareVendorFeeMode: true, softwareVendorFeeValue: true,
      softwareFeeIncludesActivation: true,
      maxChargeDurationMin: true, maxIdleDurationMin: true, maxSessionCostUsd: true,
    },
  });

  if (!site) return { error: 'Site not found' };

  return {
    siteId: site.id,
    siteName: site.name,
    pricingMode: site.pricingMode,
    pricePerKwhUsd: site.pricePerKwhUsd != null ? Number(site.pricePerKwhUsd) : null,
    idleFeePerMinUsd: site.idleFeePerMinUsd != null ? Number(site.idleFeePerMinUsd) : null,
    activationFeeUsd: site.activationFeeUsd != null ? Number(site.activationFeeUsd) : null,
    gracePeriodMin: site.gracePeriodMin,
    touWindows: site.touWindows,
    softwareVendorFeeMode: site.softwareVendorFeeMode,
    softwareVendorFeeValue: site.softwareVendorFeeValue != null ? Number(site.softwareVendorFeeValue) : null,
    softwareFeeIncludesActivation: (site as any).softwareFeeIncludesActivation ?? false,
    maxChargeDurationMin: (site as any).maxChargeDurationMin ?? null,
    maxIdleDurationMin: (site as any).maxIdleDurationMin ?? null,
    maxSessionCostUsd: (site as any).maxSessionCostUsd != null ? Number((site as any).maxSessionCostUsd) : null,
  };
}
