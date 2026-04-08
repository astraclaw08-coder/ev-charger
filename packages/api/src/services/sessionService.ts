import { prisma } from '@ev-charger/shared';
import { computeSessionAmounts } from '../lib/sessionBilling';
import type { PortalAccessClaimsV1 } from '../lib/portalAccessClaims';

/**
 * List enriched transactions (operator view) — mirrors GET /transactions/enriched.
 * Uses SessionFact materialized view for fast querying.
 */
export async function listTransactions(
  params: {
    siteId?: string;
    chargerId?: string;
    status?: string;
    startDate?: string;
    endDate?: string;
    limit?: number;
    offset?: number;
  },
  claims: PortalAccessClaimsV1,
) {
  const scopedSiteIds = claims.siteIds ?? [];
  const limit = Math.min(params.limit ?? 50, 200);
  const offset = params.offset ?? 0;

  // Default range: last 30 days
  const end = params.endDate ? new Date(`${params.endDate}T23:59:59.999Z`) : new Date();
  const start = params.startDate
    ? new Date(`${params.startDate}T00:00:00.000Z`)
    : new Date(end.getTime() - 29 * 24 * 60 * 60 * 1000);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    return { error: 'Invalid date range' };
  }

  // Site scope check
  if (params.siteId && scopedSiteIds.length > 0 && !scopedSiteIds.includes('*') && !scopedSiteIds.includes(params.siteId)) {
    return { error: 'Site not in scope' };
  }

  const where: any = {
    startedAt: { gte: start, lte: end },
    ...(params.siteId ? { siteId: params.siteId } : {}),
    ...(params.chargerId ? { chargerId: params.chargerId } : {}),
    ...(params.status ? { status: params.status } : {}),
    ...(scopedSiteIds.length > 0 && !scopedSiteIds.includes('*') ? { siteId: { in: scopedSiteIds } } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.sessionFact.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      take: limit,
      skip: offset,
      include: {
        site: {
          select: {
            id: true, name: true, organizationName: true, portfolioName: true,
            pricingMode: true, pricePerKwhUsd: true, idleFeePerMinUsd: true,
            activationFeeUsd: true, gracePeriodMin: true, touWindows: true,
            softwareVendorFeeMode: true, softwareVendorFeeValue: true,
            softwareFeeIncludesActivation: true,
          },
        },
        charger: { select: { id: true, ocppId: true, serialNumber: true, model: true, vendor: true } },
        session: {
          select: {
            id: true, transactionId: true, idTag: true, meterStart: true, meterStop: true,
            kwhDelivered: true, ratePerKwh: true,
            connector: { select: { connectorId: true } },
            payment: { select: { status: true, amountCents: true } },
            billingSnapshot: {
              select: {
                billingBreakdownJson: true, grossAmountUsd: true, netAmountUsd: true,
                vendorFeeUsd: true, kwhDelivered: true, capturedAt: true,
              },
            },
          },
        },
      },
    }),
    prisma.sessionFact.count({ where }),
  ]);

  const transactions = rows.map((row: any) => {
    const session = row.session;
    const site = row.site;
    const snap = session?.billingSnapshot;

    // Use billing snapshot if available (FINAL), otherwise compute estimate
    let amountUsd: number | null = null;
    let amountState = 'UNKNOWN';
    if (snap?.grossAmountUsd != null) {
      amountUsd = Number(snap.grossAmountUsd);
      amountState = 'FINAL';
    } else if (session && site) {
      try {
        const amounts = computeSessionAmounts({
          meterStart: session.meterStart,
          meterStop: session.meterStop,
          kwhDelivered: session.kwhDelivered ?? row.energyKwh ?? 0,
          ratePerKwh: session.ratePerKwh,
          payment: session.payment ?? { status: 'none', amountCents: 0 },
          durationMinutes: row.durationMinutes ?? 0,
          startedAt: row.startedAt,
          stoppedAt: row.stoppedAt,
          pricingMode: site.pricingMode,
          pricePerKwhUsd: Number(site.pricePerKwhUsd ?? 0),
          idleFeePerMinUsd: Number(site.idleFeePerMinUsd ?? 0),
          activationFeeUsd: Number(site.activationFeeUsd ?? 0),
          gracePeriodMin: site.gracePeriodMin ?? 0,
          touWindows: site.touWindows,
          softwareVendorFeeMode: site.softwareVendorFeeMode,
          softwareVendorFeeValue: Number(site.softwareVendorFeeValue ?? 0),
          softwareFeeIncludesActivation: site.softwareFeeIncludesActivation ?? false,
        } as any);
        amountUsd = (amounts as any).effectiveAmountCents / 100;
        amountState = 'ESTIMATED';
      } catch { /* billing computation failed — leave null */ }
    }

    return {
      sessionFactId: row.id,
      sessionId: session?.id ?? null,
      transactionId: session?.transactionId ?? null,
      status: row.status,
      startedAt: row.startedAt,
      stoppedAt: row.stoppedAt,
      durationMinutes: row.durationMinutes,
      energyKwh: row.energyKwh != null ? Number(row.energyKwh) : null,
      amountUsd,
      amountState,
      paymentStatus: session?.payment?.status ?? null,
      charger: row.charger ? { id: row.charger.id, ocppId: row.charger.ocppId, model: row.charger.model } : null,
      site: site ? { id: site.id, name: site.name } : null,
      connectorId: session?.connector?.connectorId ?? null,
      idTag: session?.idTag ?? null,
    };
  });

  return { transactions, total, limit, offset };
}

/**
 * List sessions for a specific charger — mirrors GET /chargers/:id/sessions.
 */
export async function listSessionsByCharger(
  chargerId: string,
  params: { limit?: number },
  claims: PortalAccessClaimsV1,
) {
  const limit = Math.min(params.limit ?? 20, 100);

  const charger = await prisma.charger.findUnique({
    where: { id: chargerId },
    include: {
      connectors: { select: { id: true } },
      site: {
        select: {
          id: true, name: true, pricingMode: true, pricePerKwhUsd: true,
          idleFeePerMinUsd: true, activationFeeUsd: true, gracePeriodMin: true,
          touWindows: true, softwareVendorFeeMode: true, softwareVendorFeeValue: true,
          softwareFeeIncludesActivation: true,
        },
      },
    },
  });

  if (!charger) return { error: 'Charger not found' };

  // Site scope check
  const scopedSiteIds = claims.siteIds ?? [];
  if (charger.siteId && scopedSiteIds.length > 0 && !scopedSiteIds.includes('*') && !scopedSiteIds.includes(charger.siteId)) {
    return { error: 'Site not in scope' };
  }

  const connectorIds = charger.connectors.map((c: any) => c.id);
  if (connectorIds.length === 0) return { sessions: [], total: 0 };

  const sessions = await prisma.session.findMany({
    where: { connectorId: { in: connectorIds } },
    orderBy: { startedAt: 'desc' },
    take: limit,
    include: {
      connector: { select: { connectorId: true } },
      user: { select: { name: true, email: true } },
      payment: { select: { status: true, amountCents: true } },
      billingSnapshot: { select: { kwhDelivered: true, grossAmountUsd: true, billingBreakdownJson: true } },
    },
  });

  return {
    charger: { id: charger.id, ocppId: (charger as any).ocppId, site: charger.site },
    sessions: sessions.map((s: any) => ({
      id: s.id,
      transactionId: s.transactionId,
      status: s.status,
      startedAt: s.startedAt,
      stoppedAt: s.stoppedAt,
      kwhDelivered: s.billingSnapshot?.kwhDelivered != null ? Number(s.billingSnapshot.kwhDelivered) : (s.kwhDelivered ?? null),
      amountUsd: s.billingSnapshot?.grossAmountUsd != null ? Number(s.billingSnapshot.grossAmountUsd) : (s.payment?.amountCents ? s.payment.amountCents / 100 : null),
      paymentStatus: s.payment?.status ?? null,
      connectorId: s.connector?.connectorId ?? null,
      user: s.user ? { name: s.user.name, email: s.user.email } : null,
    })),
    total: sessions.length,
  };
}

/**
 * Get single session detail — mirrors GET /sessions/:id (operator perspective).
 */
export async function getSessionDetail(sessionId: string, claims: PortalAccessClaimsV1) {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: {
      connector: {
        include: {
          charger: {
            select: {
              id: true, ocppId: true, model: true, vendor: true, siteId: true,
              site: { select: { id: true, name: true, pricingMode: true, pricePerKwhUsd: true } },
            },
          },
        },
      },
      user: { select: { id: true, name: true, email: true, phone: true } },
      payment: { select: { id: true, status: true, amountCents: true, stripeIntentId: true } },
      billingSnapshot: {
        select: {
          billingBreakdownJson: true, grossAmountUsd: true, netAmountUsd: true,
          vendorFeeUsd: true, kwhDelivered: true, capturedAt: true,
        },
      },
    },
  });

  if (!session) return { error: 'Session not found' };

  // Site scope check
  const siteId = (session as any).connector?.charger?.siteId;
  const scopedSiteIds = claims.siteIds ?? [];
  if (siteId && scopedSiteIds.length > 0 && !scopedSiteIds.includes('*') && !scopedSiteIds.includes(siteId)) {
    return { error: 'Site not in scope' };
  }

  const charger = (session as any).connector?.charger;
  const snap = (session as any).billingSnapshot;

  return {
    id: session.id,
    transactionId: (session as any).transactionId,
    status: session.status,
    startedAt: session.startedAt,
    stoppedAt: session.stoppedAt,
    idTag: (session as any).idTag,
    meterStart: (session as any).meterStart,
    meterStop: (session as any).meterStop,
    kwhDelivered: snap?.kwhDelivered != null ? Number(snap.kwhDelivered) : ((session as any).kwhDelivered ?? null),
    amountUsd: snap?.grossAmountUsd != null ? Number(snap.grossAmountUsd) : null,
    netAmountUsd: snap?.netAmountUsd != null ? Number(snap.netAmountUsd) : null,
    vendorFeeUsd: snap?.vendorFeeUsd != null ? Number(snap.vendorFeeUsd) : null,
    billingBreakdown: snap?.billingBreakdownJson ?? null,
    payment: (session as any).payment ?? null,
    user: (session as any).user ?? null,
    charger: charger ? { id: charger.id, ocppId: charger.ocppId, model: charger.model, vendor: charger.vendor } : null,
    site: charger?.site ?? null,
    connectorId: (session as any).connector?.connectorId ?? null,
  };
}
