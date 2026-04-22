import { prisma, resolveTouRateAt } from '@ev-charger/shared';
import { enqueueOcppEvent } from '../outbox';
import type { StartTransactionRequest, StartTransactionResponse } from '@ev-charger/shared';

const DEFAULT_RATE_PER_KWH = 0.35; // USD fallback when site pricing is missing
const TX_ID_MIN = 10000;
const TX_ID_MAX = 99999;
const TX_ID_MAX_ATTEMPTS = 30;

function randomFiveDigitTransactionId(): number {
  return Math.floor(Math.random() * (TX_ID_MAX - TX_ID_MIN + 1)) + TX_ID_MIN;
}

/**
 * ── Reservation enforcement mapping (TASK-0199, Astra constraint #1) ──────
 *
 * When a StartTransaction arrives, we check for active reservations on the
 * connector to enforce the reservation system. Three scenarios:
 *
 * 1. **reservationId present in params** (charger includes it):
 *    - Look up the Reservation by reservationId (integer).
 *    - If found and status is CONFIRMED → fulfill it (status → FULFILLED,
 *      set fulfilledSessionId after session creation).
 *    - If not found or already fulfilled/expired → accept the transaction
 *      anyway (software-only; charger already started).
 *
 * 2. **No reservationId, but connector has an active reservation for this idTag**:
 *    - This is the "holder idTag match fallback" — the charger didn't send
 *      reservationId (common with firmware that doesn't support ReserveNow)
 *      but the user who reserved is the one starting the session.
 *    - Fulfill the reservation (same as scenario 1).
 *
 * 3. **No reservationId, connector has an active reservation for a DIFFERENT user**:
 *    - Reject the transaction (idTagInfo.status = 'Invalid').
 *    - This prevents non-holders from starting on a reserved connector.
 *    - Note: if the site has reservationEnabled=false, no reservations exist
 *      and this path is never reached — zero regression for existing flows.
 *
 * Important: Sessions without any reservation continue to work identically.
 * The reservation check only activates when active reservations exist on the
 * connector. This ensures zero regression for existing production flows.
 */
export async function handleStartTransaction(
  _client: any,
  chargerId: string,
  params: StartTransactionRequest,
): Promise<StartTransactionResponse> {
  const { connectorId, idTag, meterStart, timestamp, reservationId: ocppReservationId } = params;
  console.log(`[StartTransaction] chargerId=${chargerId} connector=${connectorId} idTag=${idTag} meterStart=${meterStart} reservationId=${ocppReservationId ?? 'none'}`);

  // Resolve user and connector
  // eslint-disable-next-line prefer-const
  let [user, connector] = await Promise.all([
    prisma.user.findUnique({ where: { idTag } }),
    prisma.connector.findUnique({
      where: { chargerId_connectorId: { chargerId, connectorId } },
      include: {
        charger: {
          include: {
            site: {
              select: {
                pricingMode: true,
                pricePerKwhUsd: true,
                idleFeePerMinUsd: true,
                touWindows: true,
                timeZone: true,
                reservationEnabled: true,
              },
            },
          },
        },
      },
    }),
  ]);

  // ── Fleet allowlist (TASK-0208 F5c — TEMPORARY, env-flag gated) ──────────
  // Single-tag allowlist that bypasses the User.idTag lookup for one specific
  // fleet idTag and attributes the session to a pre-seeded synthetic User.
  // Strictly a lifecycle-verification shim — NOT the production architecture.
  //
  // Preconditions to activate (all required):
  //   - FLEET_MODE_ENABLED=true
  //   - FLEET_ALLOW_TAG=<exact idTag to accept>
  //   - FLEET_SYSTEM_USER_ID=<uuid of synthetic User in DB>
  //
  // Revert: unset FLEET_MODE_ENABLED (or any of the three vars) and restart.
  // Remove this block once FleetIdTag / FleetChargerPolicy schema lands.
  // See: tasks/task-0208-f5-server-gate-firmware-check.md (F5c).
  if (
    !user &&
    process.env.FLEET_MODE_ENABLED === 'true' &&
    process.env.FLEET_ALLOW_TAG &&
    process.env.FLEET_SYSTEM_USER_ID &&
    idTag === process.env.FLEET_ALLOW_TAG
  ) {
    user = await prisma.user.findUnique({
      where: { id: process.env.FLEET_SYSTEM_USER_ID },
    });
    if (user) {
      console.log(
        `[StartTransaction] [FLEET-F5C] idTag=${idTag} accepted via fleet allowlist; attributed to user=${user.id}`,
      );
    } else {
      console.error(
        `[StartTransaction] [FLEET-F5C] FLEET_SYSTEM_USER_ID=${process.env.FLEET_SYSTEM_USER_ID} not found in User table — falling through to reject`,
      );
    }
  }

  if (!user) {
    console.warn(`[StartTransaction] Unknown idTag=${idTag}, rejecting`);
    return {
      idTagInfo: { status: 'Invalid' },
      transactionId: 0,
    };
  }

  if (!connector) {
    console.warn(`[StartTransaction] Connector not found chargerId=${chargerId} connectorId=${connectorId}`);
    return {
      idTagInfo: { status: 'Invalid' },
      transactionId: 0,
    };
  }

  // ── Reservation enforcement ──────────────────────────────────────────
  // Only check if the site has reservations enabled (zero regression otherwise).
  let reservationToFulfill: { id: string; reservationId: number; userId: string } | null = null;
  const site = connector.charger.site;

  if (site?.reservationEnabled) {
    const ACTIVE_RESERVATION_STATUSES: ('PENDING' | 'CONFIRMED')[] = ['PENDING', 'CONFIRMED'];

    // Scenario 1: charger sent reservationId in StartTransaction
    if (ocppReservationId != null) {
      const reservation = await prisma.reservation.findUnique({
        where: { reservationId: ocppReservationId },
        select: { id: true, reservationId: true, userId: true, status: true, connectorRefId: true },
      });
      if (reservation && (ACTIVE_RESERVATION_STATUSES as readonly string[]).includes(reservation.status)) {
        // Verify this user is the reservation holder
        if (reservation.userId === user.id) {
          reservationToFulfill = reservation;
          console.log(`[StartTransaction] Reservation ${reservation.reservationId} matched by reservationId for user=${user.id}`);
        } else {
          // Non-holder sent a reservationId — reject
          console.warn(`[StartTransaction] REJECTED: idTag=${idTag} sent reservationId=${ocppReservationId} but reservation belongs to userId=${reservation.userId}`);
          return { idTagInfo: { status: 'Invalid' }, transactionId: 0 };
        }
      }
      // If reservation not found or already fulfilled/expired, proceed (charger already started)
    }

    // Scenario 2 & 3: no reservationId from charger — check connector for active reservations
    if (!reservationToFulfill && ocppReservationId == null) {
      const activeReservation = await prisma.reservation.findFirst({
        where: {
          connectorRefId: connector.id,
          status: { in: ACTIVE_RESERVATION_STATUSES },
        },
        select: { id: true, reservationId: true, userId: true },
      });

      if (activeReservation) {
        if (activeReservation.userId === user.id) {
          // Scenario 2: holder idTag match fallback — fulfill
          reservationToFulfill = activeReservation;
          console.log(`[StartTransaction] Reservation ${activeReservation.reservationId} matched by idTag fallback for user=${user.id}`);
        } else {
          // Scenario 3: non-holder trying to start on reserved connector — reject
          console.warn(`[StartTransaction] REJECTED: idTag=${idTag} (user=${user.id}) tried to start on connector reserved by userId=${activeReservation.userId} (reservation=${activeReservation.reservationId})`);
          return { idTagInfo: { status: 'Invalid' }, transactionId: 0 };
        }
      }
    }
  }

  let session = null as Awaited<ReturnType<typeof prisma.session.create>> | null;
  let transactionId = 0;

  for (let attempt = 1; attempt <= TX_ID_MAX_ATTEMPTS; attempt++) {
    transactionId = randomFiveDigitTransactionId();
    try {
      const cSite = connector.charger.site;
      const resolvedRate = resolveTouRateAt({
        at: timestamp,
        pricingMode: cSite?.pricingMode,
        defaultPricePerKwhUsd: cSite?.pricePerKwhUsd ?? DEFAULT_RATE_PER_KWH,
        defaultIdleFeePerMinUsd: cSite?.idleFeePerMinUsd ?? 0,
        touWindows: cSite?.touWindows,
        timeZone: cSite?.timeZone ?? 'America/Los_Angeles',
      });
      session = await prisma.session.create({
        data: {
          connectorId: connector.id,
          userId: user.id,
          transactionId,
          idTag,
          startedAt: new Date(timestamp),
          meterStart,
          ratePerKwh: resolvedRate.pricePerKwhUsd,
          status: 'ACTIVE',
        },
      });
      break;
    } catch (err: any) {
      // Prisma unique constraint violation => collision, retry with new random id
      if (err?.code === 'P2002') continue;
      throw err;
    }
  }

  if (!session) {
    throw new Error('Failed to allocate unique 5-digit transactionId after retries');
  }

  // Mark connector as Charging and enqueue OCPP event for downstream processing.
  await prisma.$transaction(async (tx: any) => {
    await tx.connector.update({
      where: { id: connector.id },
      data: { status: 'CHARGING' },
    });

    await enqueueOcppEvent(tx, {
      chargerId,
      eventType: 'StartTransaction',
      payload: params,
      idempotencyKey: `${chargerId}:StartTransaction:${transactionId}:${timestamp}`,
    });
  });

  // ── Fulfill reservation if matched ────────────────────────────────────
  if (reservationToFulfill) {
    try {
      await prisma.reservation.update({
        where: { id: reservationToFulfill.id },
        data: {
          status: 'FULFILLED',
          fulfilledSessionId: session.id,
          updatedAt: new Date(),
        },
      });
      console.log(`[StartTransaction] Reservation ${reservationToFulfill.reservationId} FULFILLED by session=${session.id}`);
    } catch (err) {
      // Non-fatal — session already started, log and continue
      console.error(`[StartTransaction] Failed to fulfill reservation ${reservationToFulfill.reservationId}:`, err);
    }
  }

  console.log(`[StartTransaction] Session ${session.id} started, transactionId=${transactionId}`);

  return { idTagInfo: { status: 'Accepted' }, transactionId };
}
