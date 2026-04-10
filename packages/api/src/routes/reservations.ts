import type { FastifyInstance } from 'fastify';
import { prisma } from '@ev-charger/shared';
import { requireAuth } from '../plugins/auth';
import { requireOperator } from '../plugins/auth';
import { reserveNow, cancelReservation } from '../lib/ocppClient';

// Active statuses where a reservation is still "live"
const ACTIVE_STATUSES = ['PENDING', 'CONFIRMED'] as const;

export async function reservationRoutes(app: FastifyInstance) {

  // ── Driver endpoints ─────────────────────────────────────────────────

  /**
   * POST /reservations — Create a reservation
   * Body: { connectorId: string (Prisma UUID), holdMinutes?: number }
   */
  app.post<{
    Body: { connectorId: string; holdMinutes?: number };
  }>('/reservations', {
    preHandler: requireAuth,
  }, async (req, reply) => {
    const user = req.currentUser!;
    const { connectorId, holdMinutes } = req.body;

    // Load connector with charger + site
    const connector = await prisma.connector.findUnique({
      where: { id: connectorId },
      include: {
        charger: { include: { site: true } },
      },
    });

    if (!connector) {
      return reply.status(404).send({ error: 'Connector not found' });
    }

    const site = connector.charger.site;
    if (!site) {
      return reply.status(400).send({ error: 'Connector has no associated site' });
    }

    if (!site.reservationEnabled) {
      return reply.status(403).send({ error: 'Reservations are not enabled at this site' });
    }

    // Validate connector is available
    if (connector.status !== 'AVAILABLE') {
      return reply.status(409).send({
        error: `Connector is ${connector.status}, must be AVAILABLE to reserve`,
      });
    }

    // Cap hold duration
    const maxMin = site.reservationMaxDurationMin;
    const requestedMin = Math.max(1, Math.min(holdMinutes ?? 30, maxMin));

    // Atomic check: one active reservation per user, one per connector
    try {
      const reservation = await prisma.$transaction(async (tx) => {
        // Check user doesn't have an active reservation
        const existingUser = await tx.reservation.findFirst({
          where: { userId: user.id, status: { in: [...ACTIVE_STATUSES] } },
        });
        if (existingUser) {
          throw new ConflictError('You already have an active reservation');
        }

        // Check connector doesn't have an active reservation
        const existingConnector = await tx.reservation.findFirst({
          where: { connectorRefId: connectorId, status: { in: [...ACTIVE_STATUSES] } },
        });
        if (existingConnector) {
          throw new ConflictError('This connector is already reserved');
        }

        const holdExpiresAt = new Date(Date.now() + requestedMin * 60_000);
        return tx.reservation.create({
          data: {
            userId: user.id,
            connectorRefId: connectorId,
            siteId: site.id,
            status: 'CONFIRMED', // software-confirmed immediately
            holdStartsAt: new Date(),
            holdExpiresAt,
          },
        });
      });

      // Fire-and-forget OCPP ReserveNow (best effort)
      sendOcppReserveNow(
        reservation.id,
        connector.charger.ocppId,
        connector.connectorId,
        reservation.holdExpiresAt.toISOString(),
        user.idTag,
        reservation.reservationId,
      );

      console.log(`[Reservation] created id=${reservation.id} reservationId=${reservation.reservationId} user=${user.id} connector=${connectorId} expiresAt=${reservation.holdExpiresAt.toISOString()}`);

      return reply.status(201).send({
        id: reservation.id,
        reservationId: reservation.reservationId,
        status: reservation.status,
        holdStartsAt: reservation.holdStartsAt,
        holdExpiresAt: reservation.holdExpiresAt,
        connectorRefId: reservation.connectorRefId,
        siteId: reservation.siteId,
      });
    } catch (err) {
      if (err instanceof ConflictError) {
        return reply.status(409).send({ error: err.message });
      }
      throw err;
    }
  });

  /**
   * GET /reservations/active — Driver's active reservation (at most 1)
   */
  app.get('/reservations/active', {
    preHandler: requireAuth,
  }, async (req, reply) => {
    const user = req.currentUser!;
    const reservation = await prisma.reservation.findFirst({
      where: { userId: user.id, status: { in: [...ACTIVE_STATUSES] } },
      include: {
        connector: {
          include: {
            charger: { select: { id: true, ocppId: true, serialNumber: true } },
          },
        },
        site: { select: { id: true, name: true, address: true } },
      },
    });

    if (!reservation) {
      return reply.send({ reservation: null });
    }
    return reply.send({ reservation });
  });

  /**
   * GET /reservations — Driver's reservation history
   */
  app.get<{
    Querystring: { limit?: string; offset?: string };
  }>('/reservations', {
    preHandler: requireAuth,
  }, async (req, reply) => {
    const user = req.currentUser!;
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const offset = Number(req.query.offset) || 0;

    const [reservations, total] = await Promise.all([
      prisma.reservation.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        include: {
          site: { select: { id: true, name: true } },
          connector: {
            include: {
              charger: { select: { ocppId: true, serialNumber: true } },
            },
          },
        },
      }),
      prisma.reservation.count({ where: { userId: user.id } }),
    ]);

    return reply.send({ reservations, total, limit, offset });
  });

  /**
   * POST /reservations/:id/cancel — Driver cancels their reservation
   */
  app.post<{
    Params: { id: string };
  }>('/reservations/:id/cancel', {
    preHandler: requireAuth,
  }, async (req, reply) => {
    const user = req.currentUser!;
    const { id } = req.params;

    const reservation = await prisma.reservation.findUnique({ where: { id } });
    if (!reservation) {
      return reply.status(404).send({ error: 'Reservation not found' });
    }
    if (reservation.userId !== user.id) {
      return reply.status(403).send({ error: 'Not your reservation' });
    }
    if (!ACTIVE_STATUSES.includes(reservation.status as any)) {
      return reply.status(409).send({ error: `Reservation is ${reservation.status}, cannot cancel` });
    }

    await prisma.reservation.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledBy: 'driver', updatedAt: new Date() },
    });

    // Send OCPP CancelReservation if we sent ReserveNow
    if (reservation.ocppSent) {
      sendOcppCancelReservation(reservation);
    }

    console.log(`[Reservation] cancelled id=${id} by=driver`);
    return reply.send({ ok: true });
  });

  // ── Operator endpoints ───────────────────────────────────────────────

  /**
   * GET /admin/reservations — List reservations (filterable)
   */
  app.get<{
    Querystring: { siteId?: string; status?: string; limit?: string; offset?: string };
  }>('/admin/reservations', {
    preHandler: requireOperator,
  }, async (req, reply) => {
    const { siteId, status } = req.query;
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const offset = Number(req.query.offset) || 0;

    const where: any = {};
    if (siteId) where.siteId = siteId;
    if (status) where.status = status;

    const [reservations, total] = await Promise.all([
      prisma.reservation.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        include: {
          user: { select: { id: true, email: true, name: true } },
          site: { select: { id: true, name: true } },
          connector: {
            include: {
              charger: { select: { id: true, ocppId: true, serialNumber: true } },
            },
          },
        },
      }),
      prisma.reservation.count({ where }),
    ]);

    return reply.send({ reservations, total, limit, offset });
  });

  /**
   * POST /admin/reservations/:id/cancel — Operator cancels a reservation
   */
  app.post<{
    Params: { id: string };
  }>('/admin/reservations/:id/cancel', {
    preHandler: requireOperator,
  }, async (req, reply) => {
    const { id } = req.params;

    const reservation = await prisma.reservation.findUnique({ where: { id } });
    if (!reservation) {
      return reply.status(404).send({ error: 'Reservation not found' });
    }
    if (!ACTIVE_STATUSES.includes(reservation.status as any)) {
      return reply.status(409).send({ error: `Reservation is ${reservation.status}, cannot cancel` });
    }

    await prisma.reservation.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledBy: 'operator', updatedAt: new Date() },
    });

    if (reservation.ocppSent) {
      sendOcppCancelReservation(reservation);
    }

    console.log(`[Reservation] cancelled id=${id} by=operator`);
    return reply.send({ ok: true });
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────

class ConflictError extends Error {
  constructor(message: string) { super(message); this.name = 'ConflictError'; }
}

/**
 * Fire-and-forget OCPP ReserveNow. Updates reservation row with result.
 */
async function sendOcppReserveNow(
  reservationDbId: string,
  ocppId: string,
  connectorId: number,
  expiryDate: string,
  idTag: string,
  reservationId: number,
): Promise<void> {
  try {
    const status = await reserveNow(ocppId, connectorId, expiryDate, idTag, reservationId);
    const accepted = status === 'Accepted';
    await prisma.reservation.update({
      where: { id: reservationDbId },
      data: {
        ocppSent: true,
        ocppAccepted: accepted,
        // If charger rejected, keep CONFIRMED (software-only enforcement still works)
        status: accepted ? 'CONFIRMED' : 'CONFIRMED',
      },
    });
    console.log(`[Reservation] OCPP ReserveNow ${status} reservationId=${reservationId} ocppId=${ocppId}`);
  } catch (err) {
    console.error(`[Reservation] OCPP ReserveNow failed reservationId=${reservationId}:`, err);
    // Reservation remains CONFIRMED — software-only enforcement
  }
}

/**
 * Fire-and-forget OCPP CancelReservation.
 */
async function sendOcppCancelReservation(reservation: { id: string; reservationId: number; connectorRefId: string }): Promise<void> {
  try {
    const connector = await prisma.connector.findUnique({
      where: { id: reservation.connectorRefId },
      include: { charger: { select: { ocppId: true } } },
    });
    if (!connector) return;

    const status = await cancelReservation(connector.charger.ocppId, reservation.reservationId);
    console.log(`[Reservation] OCPP CancelReservation ${status} reservationId=${reservation.reservationId}`);
  } catch (err) {
    console.error(`[Reservation] OCPP CancelReservation failed reservationId=${reservation.reservationId}:`, err);
  }
}
