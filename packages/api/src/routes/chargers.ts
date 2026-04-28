import type { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { prisma, resolveSessionStatusTimings } from '@ev-charger/shared';
import { requireOperator } from '../plugins/auth';
import { requirePolicy } from '../plugins/authorization';
import { remoteReset, remoteStart, triggerHeartbeat, getConfiguration } from '../lib/ocppClient';
import { getChargerUptime } from '../lib/uptime';
import { computeSessionAmounts } from '../lib/sessionBilling';
import { assessChargerHealth } from '../lib/chargerHealthAgent';
import { writeFleetRolloutAudit, writeFleetConnectorConfigAudit } from '../lib/fleetRolloutAudit';

function hasSiteAccess(siteId: string | null, siteIds: string[] | undefined) {
  if (!siteIds || siteIds.length === 0) return true;
  if (siteIds.includes('*')) return true;
  if (!siteId) return true; // unassigned chargers are accessible to any scoped operator
  return siteIds.includes(siteId);
}

/**
 * Resolve a charger by exact UUID, exact ocppId/serialNumber,
 * or partial prefix match on id/ocppId/serialNumber.
 */
async function resolveChargerId(param: string): Promise<string | null> {
  // 1. Exact UUID match
  if (param.length === 36) {
    const c = await prisma.charger.findUnique({ where: { id: param }, select: { id: true } });
    if (c) return c.id;
  }

  // 2. Exact ocppId match
  const byOcpp = await prisma.charger.findUnique({ where: { ocppId: param }, select: { id: true } });
  if (byOcpp) return byOcpp.id;

  // 3. Exact serialNumber match
  const bySerial = await prisma.charger.findUnique({ where: { serialNumber: param }, select: { id: true } });
  if (bySerial) return bySerial.id;

  // 4. Partial prefix match on id, ocppId, or serialNumber (case-insensitive)
  const byPartial = await prisma.charger.findFirst({
    where: {
      OR: [
        { id: { startsWith: param } },
        { ocppId: { startsWith: param, mode: 'insensitive' } },
        { serialNumber: { startsWith: param, mode: 'insensitive' } },
      ],
    },
    select: { id: true },
  });
  return byPartial?.id ?? null;
}

export async function chargerRoutes(app: FastifyInstance) {
  // GET /chargers/search?q=... — partial match on ocppId, serialNumber, or site name
  app.get<{ Querystring: { q?: string; limit?: string } }>('/chargers/search', async (req) => {
    const q = (req.query.q ?? '').trim();
    const limit = Math.min(parseInt(req.query.limit ?? '10', 10) || 10, 25);
    if (q.length < 2) return [];

    const chargers = await prisma.charger.findMany({
      where: {
        OR: [
          { ocppId: { contains: q, mode: 'insensitive' } },
          { serialNumber: { contains: q, mode: 'insensitive' } },
          { site: { name: { contains: q, mode: 'insensitive' } } },
        ],
      },
      take: limit,
      include: {
        site: { select: { id: true, name: true, address: true } },
        connectors: { select: { id: true, connectorId: true, status: true, chargingMode: true } },
      },
    });

    return chargers.map(({ password: _pw, ...c }: { password: unknown;[k: string]: unknown }) => c);
  });

  // GET /chargers — list chargers with optional bbox filter
  app.get<{
    Querystring: { minLat?: string; maxLat?: string; minLng?: string; maxLng?: string };
  }>('/chargers', async (req) => {
    const { minLat, maxLat, minLng, maxLng } = req.query;
    const hasBbox = minLat && maxLat && minLng && maxLng;

    const chargers = await prisma.charger.findMany({
      where: hasBbox
        ? {
            site: {
              lat: { gte: parseFloat(minLat!), lte: parseFloat(maxLat!) },
              lng: { gte: parseFloat(minLng!), lte: parseFloat(maxLng!) },
            },
          }
        : undefined,
      include: {
        site: {
          select: {
            id: true,
            name: true,
            address: true,
            lat: true,
            lng: true,
            pricingMode: true,
            pricePerKwhUsd: true,
            idleFeePerMinUsd: true,
            activationFeeUsd: true,
            gracePeriodMin: true,
            touWindows: true,
          },
        },
        connectors: { select: { id: true, connectorId: true, status: true, chargingMode: true } },
      },
    });

    return chargers.map(({ password: _pw, ...c }: { password: string; [k: string]: unknown }) => c);
  });

  // GET /chargers/:id — full charger detail
  app.get<{ Params: { id: string } }>('/chargers/:id', async (req, reply) => {
    const resolvedId = await resolveChargerId(req.params.id);
    if (!resolvedId) return reply.status(404).send({ error: 'Charger not found' });

    const charger = await prisma.charger.findUnique({
      where: { id: resolvedId },
      include: {
        // Explicit select instead of `site: true` so operator-only Site
        // columns never leak through this mobile-facing route. Anything
        // added to the Site model in the future has to be opted in here
        // explicitly. Public-safe set — driver/mobile reads these for
        // map/detail/pricing/reservation UI:
        site: {
          select: {
            id: true,
            name: true,
            address: true,
            lat: true,
            lng: true,
            pricingMode: true,
            pricePerKwhUsd: true,
            idleFeePerMinUsd: true,
            activationFeeUsd: true,
            gracePeriodMin: true,
            timeZone: true,
            touWindows: true,
            reservationEnabled: true,
            reservationMaxDurationMin: true,
            reservationFeeUsd: true,
            reservationCancelGraceMin: true,
            // Intentionally NOT selected (operator-only / would leak to
            // mobile): fleetAutoRolloutEnabled, organization*, portfolio*,
            // softwareVendorFee*, max*Duration*, operatorId,
            // maxSessionCostUsd, softwareFeeIncludesActivation.
          },
        },
        connectors: {
          include: {
            sessions: { where: { status: 'ACTIVE' }, take: 1 },
            reservations: {
              where: { status: { in: ['PENDING', 'CONFIRMED'] } },
              take: 1,
              select: {
                id: true,
                reservationId: true,
                userId: true,
                status: true,
                holdStartsAt: true,
                holdExpiresAt: true,
                // Fee fields — mobile's ConnectorActiveReservation type declares
                // these as optional and the Reservation Details modal needs
                // them to render the Fee row, fee-status row, and the grace
                // subline. Without this select they were silently undefined →
                // modal showed "Fee: None" even on fee-bearing reservations.
                feeAmountCents: true,
                feeStatus: true,
                feeCancelGraceExpiresAt: true,
              },
            },
          },
        },
      },
    });

    if (!charger) return reply.status(404).send({ error: 'Charger not found' });

    // Fetch latest PLUG_OUT transition per connector so mobile can detect
    // session-end even before the session API catches up.
    const plugOutTransitions = await prisma.connectorStateTransition.findMany({
      where: {
        chargerId: resolvedId,
        transitionType: 'PLUG_OUT',
      },
      orderBy: { occurredAt: 'desc' },
      distinct: ['connectorId'],
      select: { connectorId: true, occurredAt: true },
    });
    const plugOutMap = new Map(plugOutTransitions.map((t) => [t.connectorId, t.occurredAt]));

    const { password: _pw, ...safeCharger } = charger;
    return {
      ...safeCharger,
      connectors: safeCharger.connectors.map((c: any) => {
        // GET /chargers/:id is mobile-facing / unauthenticated. Phase 3
        // Slice D needs `chargingMode` exposed (driver mobile app shows
        // FLEET_AUTO connectors as informational/unavailable, no Start
        // button, not reservable). The other two fleet fields stay stripped:
        //   - fleetPolicyId         (operator-internal: which policy is bound)
        //   - fleetAutoRolloutEnabled (operator pilot rollout flag)
        // Operator portal uses the protected GET /chargers/:id/fleet-config
        // below for the full set.
        const {
          fleetPolicyId: _fp,
          fleetAutoRolloutEnabled: _frol,
          ...publicConnector
        } = c;
        return {
          ...publicConnector,
          lastPlugOutAt: plugOutMap.get(c.connectorId)?.toISOString() ?? null,
          activeReservation: c.reservations?.[0] ?? null,
        };
      }),
    };
  });

  // ─── GET /chargers/:id/fleet-config ──────────────────────────────────
  // TASK-0208 Phase 3 Slice B (operator-only). Returns Fleet-Auto config
  // for every connector on the charger. Used by the operator portal's
  // ChargerFleetConfig panel. NEVER call this from mobile or unauthenticated
  // contexts — fleet policy assignment is operator-internal information.
  app.get<{ Params: { id: string } }>('/chargers/:id/fleet-config', {
    preHandler: [requireOperator, requirePolicy('fleet.policy.read')],
  }, async (req, reply) => {
    const charger = await prisma.charger.findUnique({
      where: { id: req.params.id },
      include: {
        connectors: {
          select: {
            id: true,
            connectorId: true,
            chargingMode: true,
            fleetPolicyId: true,
            fleetAutoRolloutEnabled: true,
          },
          orderBy: { connectorId: 'asc' },
        },
      },
    });
    if (!charger) return reply.status(404).send({ error: 'Charger not found' });
    if (!hasSiteAccess(charger.siteId, req.currentOperator?.claims?.siteIds)) {
      return reply.status(403).send({
        error: 'Forbidden',
        denyReason: {
          code: 'SITE_OUT_OF_SCOPE',
          reason: `Site ${charger.siteId} is not in granted siteIds`,
          policy: 'fleet.policy.read',
        },
      });
    }
    return {
      chargerId: charger.id,
      ocppId: charger.ocppId,
      siteId: charger.siteId,
      connectors: charger.connectors,
    };
  });

  // GET /chargers/:id/status — real-time state (operator only)
  app.get<{ Params: { id: string } }>('/chargers/:id/status', {
    preHandler: [requireOperator, requirePolicy('charger.status.read')],
  }, async (req, reply) => {
    const resolvedStatusId = await resolveChargerId(req.params.id);
    if (!resolvedStatusId) return reply.status(404).send({ error: 'Charger not found' });

    const charger = await prisma.charger.findUnique({
      where: { id: resolvedStatusId },
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
      },
    });

    if (!charger) return reply.status(404).send({ error: 'Charger not found' });
    if (!hasSiteAccess(charger.siteId, req.currentOperator?.claims?.siteIds)) {
      return reply.status(403).send({
        error: 'Forbidden',
        denyReason: { code: 'SITE_OUT_OF_SCOPE', reason: `Site ${charger.siteId} is not in granted siteIds`, policy: 'charger.status.read' },
      });
    }

    return {
      id: charger.id,
      ocppId: charger.ocppId,
      status: charger.status,
      lastHeartbeat: charger.lastHeartbeat,
      connectors: charger.connectors.map((c: { connectorId: number; status: string; sessions: Array<unknown> }) => ({
        connectorId: c.connectorId,
        status: c.status,
        activeSession: c.sessions[0] ?? null,
      })),
    };
  });

  // POST /chargers — register a charger to a site (operator only)
  app.post<{
    Body: { siteId: string; ocppId: string; serialNumber: string; model: string; vendor: string };
  }>('/chargers', {
    preHandler: [requireOperator, requirePolicy('charger.register')],
  }, async (req, reply) => {
    const { siteId, ocppId, serialNumber, model, vendor } = req.body;

    const site = await prisma.site.findUnique({ where: { id: siteId } });
    if (!site) return reply.status(404).send({ error: 'Site not found' });
    if (!hasSiteAccess(site.id, req.currentOperator?.claims?.siteIds)) {
      return reply.status(403).send({
        error: 'Forbidden',
        denyReason: { code: 'SITE_OUT_OF_SCOPE', reason: `Site ${site.id} is not in granted siteIds`, policy: 'charger.register' },
      });
    }

    const existing = await prisma.charger.findFirst({ where: { ocppId } });
    if (existing) return reply.status(409).send({ error: `ocppId "${ocppId}" is already registered` });

    const rawPassword = crypto.randomBytes(16).toString('hex');
    const hashedPassword = crypto.createHash('sha256').update(rawPassword).digest('hex');

    const charger = await prisma.charger.create({
      data: {
        siteId,
        ocppId,
        serialNumber,
        model,
        vendor,
        password: hashedPassword,
        connectors: { create: [{ connectorId: 1 }] },
      },
    });

    const ocppEndpoint = `${process.env.OCPP_WS_URL ?? 'ws://localhost:9000'}/${ocppId}`;

    return reply.status(201).send({
      id: charger.id,
      ocppId: charger.ocppId,
      serialNumber: charger.serialNumber,
      ocppEndpoint,
      password: rawPassword, // shown once — store it on the charger
    });
  });

  // POST /chargers/:id/unassign — remove charger from its site (preserves all historical sessions)
  app.post<{
    Params: { id: string };
    Body: { reason?: string };
  }>('/chargers/:id/unassign', {
    preHandler: [requireOperator, requirePolicy('charger.register')],
  }, async (req, reply) => {
    const resolvedId = await resolveChargerId(req.params.id);
    if (!resolvedId) return reply.status(404).send({ error: 'Charger not found' });

    const charger = await prisma.charger.findUnique({
      where: { id: resolvedId },
      select: { id: true, ocppId: true, siteId: true, site: { select: { name: true } } },
    });
    if (!charger) return reply.status(404).send({ error: 'Charger not found' });
    if (!charger.siteId) return reply.status(400).send({ error: 'Charger is not assigned to any site' });

    if (!hasSiteAccess(charger.siteId, req.currentOperator?.claims?.siteIds)) {
      return reply.status(403).send({
        error: 'Forbidden',
        denyReason: { code: 'SITE_OUT_OF_SCOPE', reason: `Site ${charger.siteId} is not in granted siteIds`, policy: 'charger.register' },
      });
    }

    const previousSiteId = charger.siteId;
    const previousSiteName = charger.site?.name ?? previousSiteId;

    // Unassign: set siteId to null — sessions linked via Connector are preserved
    await prisma.charger.update({
      where: { id: resolvedId },
      data: { siteId: null },
    });

    // Audit log
    await prisma.adminAuditEvent.create({
      data: {
        operatorId: req.currentOperator?.id ?? 'unknown',
        action: 'charger.unassign',
        metadata: {
          chargerId: resolvedId,
          ocppId: charger.ocppId,
          previousSiteId,
          previousSiteName,
          reason: req.body?.reason ?? null,
        },
      },
    });

    return {
      unassigned: true,
      chargerId: resolvedId,
      ocppId: charger.ocppId,
      previousSiteId,
      previousSiteName,
    };
  });

  // GET /chargers/:id/sessions — recent sessions on this charger (operator only)
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/chargers/:id/sessions', {
    preHandler: [requireOperator, requirePolicy('charger.sessions.read')],
  }, async (req, reply) => {
    const charger = await prisma.charger.findUnique({
      where: { id: req.params.id },
      include: { connectors: { select: { id: true } } },
    });
    if (!charger) return reply.status(404).send({ error: 'Charger not found' });
    if (!hasSiteAccess(charger.siteId, req.currentOperator?.claims?.siteIds)) {
      return reply.status(403).send({
        error: 'Forbidden',
        denyReason: { code: 'SITE_OUT_OF_SCOPE', reason: `Site ${charger.siteId} is not in granted siteIds`, policy: 'charger.sessions.read' },
      });
    }

    const connectorIds = charger.connectors.map((c: { id: string }) => c.id);
    const limit = Math.min(parseInt(req.query.limit ?? '20', 10), 100);
    const site = charger.siteId ? await prisma.site.findUnique({
      where: { id: charger.siteId },
      select: {
        pricingMode: true,
        pricePerKwhUsd: true,
        idleFeePerMinUsd: true,
        activationFeeUsd: true,
        gracePeriodMin: true,
        touWindows: true,
        softwareVendorFeeMode: true,
        softwareVendorFeeValue: true,
        softwareFeeIncludesActivation: true,
      },
    }) : null;

    const sessions = await prisma.session.findMany({
      where: { connectorId: { in: connectorIds } },
      orderBy: { startedAt: 'desc' },
      take: limit,
      include: {
        connector: {
          select: {
            connectorId: true,
            charger: { select: { id: true } },
          },
        },
        user: { select: { name: true, email: true } },
        payment: { select: { status: true, amountCents: true } },
        billingSnapshot: {
          select: {
            kwhDelivered: true,
            grossAmountUsd: true,
            billingBreakdownJson: true,
          },
        },
      },
    });

    const chargerStatusLogs = await prisma.ocppLog.findMany({
      where: {
        chargerId: charger.id,
        action: 'StatusNotification',
      },
      orderBy: { createdAt: 'desc' },
      take: 10000,
    });

    return sessions.map((s: any) => {
      const sessionTimings = resolveSessionStatusTimings(s, chargerStatusLogs);
      const amounts = computeSessionAmounts({
        ...s,
        startedAt: sessionTimings.plugOutAt ? s.startedAt : s.startedAt,
        stoppedAt: sessionTimings.plugOutAt ? new Date(sessionTimings.plugOutAt) : s.stoppedAt,
        plugOutAt: sessionTimings.plugOutAt ? new Date(sessionTimings.plugOutAt) : undefined,
        pricingMode: site?.pricingMode,
        pricePerKwhUsd: site?.pricePerKwhUsd,
        idleFeePerMinUsd: site?.idleFeePerMinUsd,
        activationFeeUsd: site?.activationFeeUsd,
        gracePeriodMin: site?.gracePeriodMin,
        touWindows: site?.touWindows,
        softwareVendorFeeMode: site?.softwareVendorFeeMode,
        softwareVendorFeeValue: site?.softwareVendorFeeValue,
        softwareFeeIncludesActivation: site?.softwareFeeIncludesActivation,
      });
      const snapshot = s.billingSnapshot;
      const snapshotGrossCents = snapshot?.grossAmountUsd != null ? Math.round(Number(snapshot.grossAmountUsd) * 100) : null;
      return {
        ...s,
        plugInAt: sessionTimings.plugInAt ?? s.startedAt,
        plugOutAt: sessionTimings.plugOutAt ?? s.stoppedAt,
        kwhDelivered: snapshot?.kwhDelivered ?? amounts.kwhDelivered,
        effectiveAmountCents: snapshotGrossCents ?? amounts.effectiveAmountCents,
        estimatedAmountCents: snapshotGrossCents ?? amounts.estimatedAmountCents,
        amountState: snapshot ? 'FINAL' : amounts.amountState,
        amountLabel: snapshot ? 'Final' : amounts.amountLabel,
        isAmountFinal: snapshot ? true : amounts.isAmountFinal,
        billingBreakdown: snapshot?.billingBreakdownJson ?? amounts.billingBreakdown,
      };
    });
  });



  // GET /chargers/:id/uptime — rolling uptime windows + incidents
  app.get<{ Params: { id: string } }>('/chargers/:id/uptime', {
    preHandler: [requireOperator, requirePolicy('charger.uptime.read')],
  }, async (req, reply) => {
    const charger = await prisma.charger.findUnique({ where: { id: req.params.id }, select: { siteId: true } });
    if (!charger) return reply.status(404).send({ error: 'Charger not found' });
    if (!hasSiteAccess(charger.siteId, req.currentOperator?.claims?.siteIds)) {
      return reply.status(403).send({
        error: 'Forbidden',
        denyReason: { code: 'SITE_OUT_OF_SCOPE', reason: `Site ${charger.siteId} is not in granted siteIds`, policy: 'charger.uptime.read' },
      });
    }

    const uptime = await getChargerUptime(req.params.id);
    if (!uptime) return reply.status(404).send({ error: 'Charger not found' });
    return uptime;
  });

  // GET /chargers/:id/connection-events — recent transport lifecycle events (operator only)
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/chargers/:id/connection-events', {
    preHandler: [requireOperator, requirePolicy('charger.uptime.read')],
  }, async (req, reply) => {
    const resolvedId = await resolveChargerId(req.params.id);
    if (!resolvedId) return reply.status(404).send({ error: 'Charger not found' });

    const charger = await prisma.charger.findUnique({
      where: { id: resolvedId },
      select: { id: true, ocppId: true, siteId: true },
    });
    if (!charger) return reply.status(404).send({ error: 'Charger not found' });
    if (!hasSiteAccess(charger.siteId, req.currentOperator?.claims?.siteIds)) {
      return reply.status(403).send({
        error: 'Forbidden',
        denyReason: { code: 'SITE_OUT_OF_SCOPE', reason: `Site ${charger.siteId} is not in granted siteIds`, policy: 'charger.uptime.read' },
      });
    }

    const limit = Math.min(parseInt(req.query.limit ?? '50', 10) || 50, 200);
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
        sessionId: e.sessionId,
        connectedAt: e.connectedAt?.toISOString() ?? null,
        disconnectedAt: e.disconnectedAt?.toISOString() ?? null,
        durationMs: e.durationMs,
        closeCode: e.closeCode,
        closeReason: e.closeReason,
        remoteAddress: e.remoteAddress,
        host: e.host,
        path: e.path,
        userAgent: e.userAgent,
        transportMeta: e.transportMeta,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  });

  // GET /chargers/:id/health-assessment — AI-powered charger health diagnostic (operator only)
  app.get<{
    Params: { id: string };
    Querystring: { connectorId?: string };
  }>('/chargers/:id/health-assessment', {
    preHandler: [requireOperator, requirePolicy('charger.status.read')],
  }, async (req, reply) => {
    const resolvedId = await resolveChargerId(req.params.id);
    if (!resolvedId) return reply.status(404).send({ error: 'Charger not found' });

    const charger = await prisma.charger.findUnique({
      where: { id: resolvedId },
      select: { siteId: true },
    });
    if (!charger) return reply.status(404).send({ error: 'Charger not found' });
    if (!hasSiteAccess(charger.siteId, req.currentOperator?.claims?.siteIds)) {
      return reply.status(403).send({
        error: 'Forbidden',
        denyReason: { code: 'SITE_OUT_OF_SCOPE', reason: `Site ${charger.siteId} is not in granted siteIds`, policy: 'charger.status.read' },
      });
    }

    const connectorId = req.query.connectorId ? parseInt(req.query.connectorId, 10) : undefined;

    try {
      const report = await assessChargerHealth(resolvedId, connectorId);

      // Persist assessment for audit trail
      await prisma.chargerHealthAssessment.create({
        data: {
          chargerId: resolvedId,
          connectorId: connectorId ?? null,
          overallScore: report.overallScore,
          overallStatus: report.overallStatus,
          reportJson: report as any,
          requestedBy: req.currentOperator?.id ?? 'unknown',
        },
      });

      return report;
    } catch (err: any) {
      req.log.error({ err, chargerId: resolvedId }, 'Health assessment failed');
      return reply.status(500).send({ error: 'Health assessment failed', detail: err?.message });
    }
  });

  // POST /chargers/:id/reset — operator reboots a charger
  app.post<{
    Params: { id: string };
    Body: { type?: 'Soft' | 'Hard' };
  }>('/chargers/:id/reset', {
    preHandler: [requireOperator, requirePolicy('charger.reset')],
  }, async (req, reply) => {
    const charger = await prisma.charger.findUnique({ where: { id: req.params.id } });
    if (!charger) return reply.status(404).send({ error: 'Charger not found' });
    if (!hasSiteAccess(charger.siteId, req.currentOperator?.claims?.siteIds)) {
      return reply.status(403).send({
        error: 'Forbidden',
        denyReason: { code: 'SITE_OUT_OF_SCOPE', reason: `Site ${charger.siteId} is not in granted siteIds`, policy: 'charger.reset' },
      });
    }

    const type = req.body?.type ?? 'Soft';
    const status = await remoteReset(charger.ocppId, type);
    return { status };
  });

  // POST /chargers/:id/remote-start — operator initiates remote start
  app.post<{
    Params: { id: string };
    Body: { connectorId: number; idTag?: string };
  }>('/chargers/:id/remote-start', {
    preHandler: [requireOperator],
  }, async (req, reply) => {
    const charger = await prisma.charger.findUnique({
      where: { id: req.params.id },
      include: { connectors: { where: { connectorId: req.body.connectorId } } },
    });
    if (!charger) return reply.status(404).send({ error: 'Charger not found' });
    if (!hasSiteAccess(charger.siteId, req.currentOperator?.claims?.siteIds)) {
      return reply.status(403).send({
        error: 'Forbidden',
        denyReason: { code: 'SITE_OUT_OF_SCOPE', reason: `Site ${charger.siteId} is not in granted siteIds`, policy: 'charger.remote_start' },
      });
    }

    const connector = charger.connectors[0];
    if (!connector) return reply.status(404).send({ error: 'Connector not found' });

    const idTag = req.body.idTag ?? 'TESTDRIVER0001';
    const status = await remoteStart(charger.ocppId, req.body.connectorId, idTag);

    if (status !== 'Accepted') {
      return reply.status(503).send({ error: 'Charger rejected the start request', status });
    }

    return { status };
  });

  // POST /chargers/:id/trigger-heartbeat — operator requests immediate heartbeat
  app.post<{ Params: { id: string } }>('/chargers/:id/trigger-heartbeat', {
    preHandler: [requireOperator],
  }, async (req, reply) => {
    const charger = await prisma.charger.findUnique({ where: { id: req.params.id } });
    if (!charger) return reply.status(404).send({ error: 'Charger not found' });
    if (!hasSiteAccess(charger.siteId, req.currentOperator?.claims?.siteIds)) {
      return reply.status(403).send({
        error: 'Forbidden',
        denyReason: { code: 'SITE_OUT_OF_SCOPE', reason: `Site ${charger.siteId} is not in granted siteIds`, policy: 'charger.trigger_heartbeat' },
      });
    }

    const result = await triggerHeartbeat(charger.ocppId);
    if (result.status !== 'Accepted') {
      return reply.status(503).send({ error: 'Charger rejected heartbeat trigger', ...result });
    }
    return result;
  });

  // POST /chargers/:id/get-configuration — operator requests current config keys
  app.post<{ Params: { id: string } }>('/chargers/:id/get-configuration', {
    preHandler: [requireOperator],
  }, async (req, reply) => {
    const charger = await prisma.charger.findUnique({ where: { id: req.params.id } });
    if (!charger) return reply.status(404).send({ error: 'Charger not found' });
    if (!hasSiteAccess(charger.siteId, req.currentOperator?.claims?.siteIds)) {
      return reply.status(403).send({
        error: 'Forbidden',
        denyReason: { code: 'SITE_OUT_OF_SCOPE', reason: `Site ${charger.siteId} is not in granted siteIds`, policy: 'charger.get_configuration' },
      });
    }

    const response = await getConfiguration(charger.ocppId);
    return response;
  });

  // ─── PATCH /chargers/:chargerId/connectors/:connectorId ───────────────────
  // TASK-0208 Phase 3 Slice B — Fleet-Auto operator config UX.
  // Lets operators set per-connector chargingMode, assign a FleetPolicy by
  // direct FK (not idTag prefix), and override the site rollout flag.
  // No runtime auto-start side-effects from this route — that's Slice C.
  app.patch<{
    Params: { chargerId: string; connectorId: string };
    Body: {
      chargingMode?: 'PUBLIC' | 'FLEET_AUTO';
      // null clears assignment; undefined leaves untouched.
      fleetPolicyId?: string | null;
      // null = inherit Site.fleetAutoRolloutEnabled; true/false = explicit override.
      fleetAutoRolloutEnabled?: boolean | null;
    };
  }>('/chargers/:chargerId/connectors/:connectorId', {
    // Reuses fleet.policy.write because every field this route can change
    // (chargingMode, fleetPolicyId, fleetAutoRolloutEnabled) is fleet-scoped
    // config, not general charger metadata. Avoids a new policy key.
    preHandler: [requireOperator, requirePolicy('fleet.policy.write')],
  }, async (req, reply) => {
    const operator = req.currentOperator!;

    // Connectors are addressed by `Charger.id` + `Connector.connectorId` (the
    // OCPP 1-indexed number on the charger), not by `Connector.id`. This is
    // the same shape the rest of the API uses for charger health / remote-start.
    //
    // OCPP semantics: connectorId=0 means "the whole charger" — it is NOT
    // a per-physical-connector target. Per-connector fleet config is only
    // meaningful for connectorId >= 1, so reject 0.
    const connectorIdInt = Number.parseInt(req.params.connectorId, 10);
    if (!Number.isInteger(connectorIdInt) || connectorIdInt < 1) {
      return reply.status(400).send({
        error: 'connectorId must be an integer >= 1 (OCPP connector 0 represents the whole charger and is not a valid per-connector config target)',
      });
    }

    const charger = await prisma.charger.findUnique({
      where: { id: req.params.chargerId },
      include: {
        connectors: {
          where: { connectorId: connectorIdInt },
          select: {
            id: true,
            connectorId: true,
            chargingMode: true,
            fleetPolicyId: true,
            fleetAutoRolloutEnabled: true,
          },
        },
      },
    });
    if (!charger) return reply.status(404).send({ error: 'Charger not found' });
    if (!hasSiteAccess(charger.siteId, operator.claims?.siteIds)) {
      return reply.status(403).send({
        error: 'Forbidden',
        denyReason: {
          code: 'SITE_OUT_OF_SCOPE',
          reason: `Site ${charger.siteId} is not in granted siteIds`,
          policy: 'charger.update',
        },
      });
    }

    const connector = charger.connectors[0];
    if (!connector) return reply.status(404).send({ error: 'Connector not found' });

    const body = req.body ?? {};
    const errors: Array<{ field: string; code: string; message: string }> = [];

    // chargingMode: validate enum literal.
    if (body.chargingMode !== undefined
        && body.chargingMode !== 'PUBLIC'
        && body.chargingMode !== 'FLEET_AUTO') {
      errors.push({
        field: 'chargingMode',
        code: 'INVALID_FORMAT',
        message: 'chargingMode must be "PUBLIC" or "FLEET_AUTO"',
      });
    }

    // fleetPolicyId: validate ownership (same site as charger) when non-null.
    // Capture the loaded policy so we don't re-fetch for the resulting-state
    // ENABLED check below.
    let loadedRequestedPolicy:
      | { id: string; siteId: string; status: 'DRAFT' | 'ENABLED' | 'DISABLED' }
      | null
      | undefined; // undefined = not requested in body, null = explicit clear
    if (body.fleetPolicyId !== undefined) {
      if (body.fleetPolicyId === null) {
        loadedRequestedPolicy = null;
      } else if (typeof body.fleetPolicyId !== 'string' || body.fleetPolicyId.length === 0) {
        errors.push({
          field: 'fleetPolicyId',
          code: 'INVALID_FORMAT',
          message: 'fleetPolicyId must be a non-empty string or null',
        });
      } else {
        const policy = await prisma.fleetPolicy.findUnique({
          where: { id: body.fleetPolicyId },
          select: { id: true, siteId: true, status: true },
        });
        if (!policy) {
          errors.push({
            field: 'fleetPolicyId',
            code: 'NOT_FOUND',
            message: 'FleetPolicy not found',
          });
        } else if (policy.siteId !== charger.siteId) {
          // Cross-site assignment forbidden; prevents accidental mis-binding.
          errors.push({
            field: 'fleetPolicyId',
            code: 'CROSS_SITE',
            message: 'FleetPolicy belongs to a different site than this charger',
          });
        } else {
          loadedRequestedPolicy = policy as typeof loadedRequestedPolicy;
        }
      }
    }

    // fleetAutoRolloutEnabled: must be boolean or null.
    if (body.fleetAutoRolloutEnabled !== undefined
        && body.fleetAutoRolloutEnabled !== null
        && typeof body.fleetAutoRolloutEnabled !== 'boolean') {
      errors.push({
        field: 'fleetAutoRolloutEnabled',
        code: 'INVALID_FORMAT',
        message: 'fleetAutoRolloutEnabled must be true, false, or null',
      });
    }

    if (errors.length > 0) {
      return reply.status(400).send({ error: 'ValidationError', errors });
    }

    // ── Resulting-state invariant: FLEET_AUTO requires ENABLED policy ──
    // Compute what the connector will look like AFTER this PATCH applies,
    // then enforce the design rule: "Fleet mode requires an ENABLED
    // FleetPolicy at the charger's site." Switching back to PUBLIC and/or
    // clearing the policy is always allowed (canonical rollback path).
    const resultingChargingMode =
      body.chargingMode !== undefined ? body.chargingMode : connector.chargingMode;
    const resultingFleetPolicyId =
      body.fleetPolicyId !== undefined ? body.fleetPolicyId : connector.fleetPolicyId;

    if (resultingChargingMode === 'FLEET_AUTO') {
      if (!resultingFleetPolicyId) {
        return reply.status(400).send({
          error: 'ValidationError',
          errors: [{
            field: 'fleetPolicyId',
            code: 'REQUIRED_FOR_FLEET_AUTO',
            message: 'A FLEET_AUTO connector must have an assigned, ENABLED fleet policy',
          }],
        });
      }
      // Resolve the policy that will actually be in effect after this PATCH.
      // Three sources, in order of preference:
      //   1) the policy loaded above (when body.fleetPolicyId was provided)
      //   2) the connector's existing policy (when body left fleetPolicyId unchanged)
      let effectivePolicy: { id: string; siteId: string; status: 'DRAFT' | 'ENABLED' | 'DISABLED' } | null = null;
      if (loadedRequestedPolicy) {
        effectivePolicy = loadedRequestedPolicy;
      } else if (resultingFleetPolicyId === connector.fleetPolicyId) {
        const existing = await prisma.fleetPolicy.findUnique({
          where: { id: resultingFleetPolicyId },
          select: { id: true, siteId: true, status: true },
        });
        effectivePolicy = existing as typeof effectivePolicy;
      }
      if (!effectivePolicy) {
        return reply.status(400).send({
          error: 'ValidationError',
          errors: [{
            field: 'fleetPolicyId',
            code: 'NOT_FOUND',
            message: 'Resolved FleetPolicy for FLEET_AUTO assignment not found',
          }],
        });
      }
      if (effectivePolicy.siteId !== charger.siteId) {
        return reply.status(400).send({
          error: 'ValidationError',
          errors: [{
            field: 'fleetPolicyId',
            code: 'CROSS_SITE',
            message: 'FleetPolicy belongs to a different site than this charger',
          }],
        });
      }
      if (effectivePolicy.status !== 'ENABLED') {
        return reply.status(400).send({
          error: 'ValidationError',
          errors: [{
            field: 'fleetPolicyId',
            code: 'POLICY_NOT_ENABLED',
            message:
              `Cannot assign a ${effectivePolicy.status} fleet policy to a FLEET_AUTO connector — ` +
              'fleet mode requires an ENABLED policy. Enable the policy first, or set chargingMode back to PUBLIC.',
            detail: { policyStatus: effectivePolicy.status },
          }],
        });
      }
    }

    const data: any = {};
    if (body.chargingMode !== undefined) data.chargingMode = body.chargingMode;
    if (body.fleetPolicyId !== undefined) data.fleetPolicyId = body.fleetPolicyId;
    if (body.fleetAutoRolloutEnabled !== undefined) {
      data.fleetAutoRolloutEnabled = body.fleetAutoRolloutEnabled;
    }

    const updated = await prisma.connector.update({
      where: { id: connector.id },
      data,
      select: {
        id: true,
        connectorId: true,
        chargingMode: true,
        fleetPolicyId: true,
        fleetAutoRolloutEnabled: true,
      },
    });

    // Audit channel 1: rollout-flag flip (kill-switch semantics).
    // Audit channel 2: chargingMode / fleetPolicyId config diff.
    // Both are conditional on actual value changes (re-saving the same
    // value does not pollute the log). Both swallow failures so audit
    // infra hiccups don't fail the operator's config write.
    if (body.fleetAutoRolloutEnabled !== undefined
        && body.fleetAutoRolloutEnabled !== connector.fleetAutoRolloutEnabled) {
      try {
        await writeFleetRolloutAudit({
          operatorId: operator.id,
          scope: 'connector',
          scopeId: connector.id,
          chargerId: charger.id,
          siteId: charger.siteId ?? undefined,
          oldValue: connector.fleetAutoRolloutEnabled,
          newValue: body.fleetAutoRolloutEnabled,
        });
      } catch (auditErr) {
        req.log.error({ auditErr, scope: 'connector', scopeId: connector.id },
          'fleet rollout audit write failed (connector)');
      }
    }

    // Connector config audit: chargingMode + fleetPolicyId diff. Only
    // emit when at least one of the two actually changed.
    const configChanges: Parameters<typeof writeFleetConnectorConfigAudit>[0]['changes'] = {};
    if (body.chargingMode !== undefined
        && body.chargingMode !== connector.chargingMode) {
      configChanges.chargingMode = {
        old: connector.chargingMode as 'PUBLIC' | 'FLEET_AUTO',
        new: body.chargingMode,
      };
    }
    if (body.fleetPolicyId !== undefined
        && (body.fleetPolicyId ?? null) !== (connector.fleetPolicyId ?? null)) {
      configChanges.fleetPolicyId = {
        old: connector.fleetPolicyId ?? null,
        new: body.fleetPolicyId ?? null,
      };
    }
    if (configChanges.chargingMode || configChanges.fleetPolicyId) {
      try {
        await writeFleetConnectorConfigAudit({
          operatorId: operator.id,
          connectorId: connector.id,
          chargerId: charger.id,
          siteId: charger.siteId ?? undefined,
          changes: configChanges,
        });
      } catch (auditErr) {
        req.log.error({ auditErr, scope: 'connector', scopeId: connector.id },
          'fleet connector config audit write failed');
      }
    }

    return updated;
  });
}
