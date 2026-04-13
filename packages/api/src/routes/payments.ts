import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { prisma } from '@ev-charger/shared';
import { requireAuth } from '../plugins/auth';

/**
 * Resolve the Stripe customer ID for a user.
 * Reads from User.stripeCustomerId (canonical), falls back to Payment table
 * for legacy rows, and creates a new Stripe customer if needed.
 * Always persists the resolved ID back to User.stripeCustomerId.
 */
async function resolveStripeCustomer(
  stripe: import('stripe').Stripe,
  user: { id: string; email: string; name: string | null; stripeCustomerId: string | null },
): Promise<string> {
  let stripeCustomerId: string | undefined = user.stripeCustomerId ?? undefined;

  // Fallback: check Payment table for legacy data (pre-Phase 0 rows)
  if (!stripeCustomerId) {
    const legacyPayment = await prisma.payment.findFirst({
      where: { userId: user.id, stripeCustomerId: { startsWith: 'cus_' } },
      select: { stripeCustomerId: true },
      orderBy: { createdAt: 'desc' },
    });
    stripeCustomerId = legacyPayment?.stripeCustomerId ?? undefined;
  }

  if (!stripeCustomerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      name: user.name ?? undefined,
      metadata: { userId: user.id },
    });
    stripeCustomerId = customer.id;
  }

  // Persist canonical source
  if (user.stripeCustomerId !== stripeCustomerId) {
    await prisma.user.update({
      where: { id: user.id },
      data: { stripeCustomerId },
    });
  }

  return stripeCustomerId;
}

export async function paymentRoutes(app: FastifyInstance) {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!stripeKey) {
    app.log.warn('STRIPE_SECRET_KEY not set — payment endpoints disabled');
  }

  // Lazy Stripe init (shared across routes)
  let _stripe: import('stripe').Stripe | null = null;
  function getStripe(): import('stripe').Stripe {
    if (!_stripe) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Stripe = require('stripe').default || require('stripe');
      _stripe = new Stripe(stripeKey!, { apiVersion: '2024-06-20' });
    }
    return _stripe!;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // POST /payments/setup-intent — save a card via Stripe SetupIntent
  // ═══════════════════════════════════════════════════════════════════════
  app.post('/payments/setup-intent', {
    preHandler: requireAuth,
  }, async (req, reply) => {
    if (!stripeKey) {
      return reply.status(503).send({ error: 'Stripe not configured' });
    }

    const stripe = getStripe();
    const user = req.currentUser!;
    const stripeCustomerId = await resolveStripeCustomer(stripe, user);

    const setupIntent = await stripe.setupIntents.create({
      customer: stripeCustomerId,
      payment_method_types: ['card'],
    });

    return { clientSecret: setupIntent.client_secret, stripeCustomerId };
  });

  // ═══════════════════════════════════════════════════════════════════════
  // POST /payments/preauth — create a preauthorization hold before charging
  // ═══════════════════════════════════════════════════════════════════════
  app.post<{
    Body: { connectorRefId: string };
  }>('/payments/preauth', {
    preHandler: requireAuth,
  }, async (req, reply) => {
    if (!stripeKey) {
      return reply.status(503).send({ error: 'Stripe not configured' });
    }

    const stripe = getStripe();
    const user = req.currentUser!;
    const { connectorRefId } = req.body;

    if (!connectorRefId) {
      return reply.status(400).send({ error: 'connectorRefId is required' });
    }

    // Resolve connector and site to get preauth amount
    const connector = await prisma.connector.findUnique({
      where: { id: connectorRefId },
      include: { charger: { include: { site: { select: { id: true, preauthAmountCents: true } } } } },
    });

    if (!connector) {
      return reply.status(404).send({ error: 'Connector not found' });
    }

    const site = connector.charger.site;
    if (!site) {
      return reply.status(400).send({ error: 'Charger is not assigned to a site' });
    }

    const holdAmountCents = site.preauthAmountCents;

    // Enforce: only one active AUTHORIZED preauth per (userId, connectorRefId)
    const existingAuth = await prisma.payment.findFirst({
      where: {
        userId: user.id,
        connectorRefId,
        purpose: 'CHARGING',
        status: 'AUTHORIZED',
      },
    });

    if (existingAuth) {
      // Return existing preauth instead of creating a duplicate
      return {
        paymentId: existingAuth.id,
        preauthToken: existingAuth.preauthToken,
        authorizedCents: existingAuth.authorizedCents,
        status: existingAuth.status,
        alreadyExists: true,
      };
    }

    // Resolve Stripe customer + default payment method
    const stripeCustomerId = await resolveStripeCustomer(stripe, user);

    const paymentMethods = await stripe.paymentMethods.list({
      customer: stripeCustomerId,
      type: 'card',
      limit: 1,
    });

    if (paymentMethods.data.length === 0) {
      return reply.status(402).send({ error: 'No saved payment method. Please add a card first.' });
    }

    const defaultPM = paymentMethods.data[0];
    const preauthToken = randomUUID();

    // Create PaymentIntent with manual capture (preauth hold)
    let intent: import('stripe').Stripe.PaymentIntent;
    try {
      intent = await stripe.paymentIntents.create({
        amount: holdAmountCents,
        currency: 'usd',
        customer: stripeCustomerId,
        payment_method: defaultPM.id,
        capture_method: 'manual',
        confirm: true,
        metadata: {
          userId: user.id,
          connectorRefId,
          preauthToken,
          siteId: site.id,
        },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      app.log.error({ msg, userId: user.id }, 'Stripe preauth failed');
      return reply.status(402).send({ error: `Payment authorization failed: ${msg}` });
    }

    // Determine initial status based on Stripe response
    let paymentStatus: 'AUTHORIZED' | 'REQUIRES_ACTION' | 'FAILED';
    if (intent.status === 'requires_capture') {
      paymentStatus = 'AUTHORIZED';
    } else if (intent.status === 'requires_action') {
      paymentStatus = 'REQUIRES_ACTION';
    } else {
      paymentStatus = 'FAILED';
    }

    // Persist payment record
    const payment = await prisma.payment.create({
      data: {
        userId: user.id,
        purpose: 'CHARGING',
        connectorRefId,
        preauthToken,
        stripeIntentId: intent.id,
        stripeCustomerId,
        authorizedCents: holdAmountCents,
        status: paymentStatus,
      },
    });

    const response: Record<string, unknown> = {
      paymentId: payment.id,
      preauthToken,
      authorizedCents: holdAmountCents,
      status: paymentStatus,
    };

    // If 3DS/SCA is required, return the client secret for mobile to complete
    if (paymentStatus === 'REQUIRES_ACTION') {
      response.clientSecret = intent.client_secret;
    }

    return response;
  });

  // ═══════════════════════════════════════════════════════════════════════
  // POST /payments/:id/cancel — void an unused preauth hold
  // ═══════════════════════════════════════════════════════════════════════
  app.post<{
    Params: { id: string };
  }>('/payments/:id/cancel', {
    preHandler: requireAuth,
  }, async (req, reply) => {
    if (!stripeKey) {
      return reply.status(503).send({ error: 'Stripe not configured' });
    }

    const stripe = getStripe();
    const user = req.currentUser!;

    const payment = await prisma.payment.findFirst({
      where: {
        id: req.params.id,
        userId: user.id,
        status: { in: ['AUTHORIZED', 'REQUIRES_ACTION'] },
      },
    });

    if (!payment) {
      // Check if already canceled — idempotent response
      const existing = await prisma.payment.findFirst({
        where: { id: req.params.id, userId: user.id, status: 'CANCELED' },
      });
      if (existing) {
        return { status: 'CANCELED', alreadyCanceled: true };
      }
      return reply.status(404).send({ error: 'No cancellable preauth found' });
    }

    if (payment.stripeIntentId) {
      try {
        await stripe.paymentIntents.cancel(payment.stripeIntentId);
      } catch (err: unknown) {
        // If Stripe says it's already canceled/captured, proceed with local state update
        const msg = err instanceof Error ? err.message : String(err);
        app.log.warn({ msg, paymentId: payment.id }, 'Stripe cancel returned error — updating local state anyway');
      }
    }

    await prisma.payment.update({
      where: { id: payment.id },
      data: { status: 'CANCELED' },
    });

    return { status: 'CANCELED' };
  });

  // ═══════════════════════════════════════════════════════════════════════
  // POST /payments/webhook — Stripe event delivery
  // ═══════════════════════════════════════════════════════════════════════
  app.post('/payments/webhook', async (req, reply) => {
    if (!stripeKey || !webhookSecret) {
      return reply.status(503).send({ error: 'Stripe not configured' });
    }

    const sig = req.headers['stripe-signature'] as string | undefined;
    if (!sig) {
      return reply.status(400).send({ error: 'Missing stripe-signature header' });
    }

    const stripe = getStripe();

    let event: import('stripe').Stripe.Event;
    try {
      const rawBody = (req as unknown as { rawBody: Buffer }).rawBody;
      event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      app.log.error({ msg }, 'Stripe signature verification failed');
      return reply.status(400).send({ error: `Webhook error: ${msg}` });
    }

    if (event.type === 'payment_intent.succeeded') {
      const intent = event.data.object as import('stripe').Stripe.PaymentIntent;
      await prisma.payment.updateMany({
        where: { stripeIntentId: intent.id },
        data: { status: 'CAPTURED', amountCents: intent.amount_received },
      });
    }

    if (event.type === 'payment_intent.payment_failed') {
      const intent = event.data.object as import('stripe').Stripe.PaymentIntent;
      await prisma.payment.updateMany({
        where: { stripeIntentId: intent.id },
        data: { status: 'FAILED' },
      });
    }

    if (event.type === 'payment_intent.canceled') {
      const intent = event.data.object as import('stripe').Stripe.PaymentIntent;
      await prisma.payment.updateMany({
        where: { stripeIntentId: intent.id, status: { in: ['AUTHORIZED', 'REQUIRES_ACTION', 'PENDING'] } },
        data: { status: 'CANCELED' },
      });
    }

    return { received: true };
  });

  // ═══════════════════════════════════════════════════════════════════════
  // POST /internal/payments/:sessionId/capture — capture the preauth hold
  // Called by: OCPP server (StopTransaction), stale session cleanup, admin force-stop
  // No user auth — internal-only (callers are trusted backend services)
  // Race-safe: uses CAS pattern with CAPTURE_IN_PROGRESS transient state
  // ═══════════════════════════════════════════════════════════════════════
  app.post<{
    Params: { sessionId: string };
  }>('/internal/payments/:sessionId/capture', async (req, reply) => {
    if (!stripeKey) {
      return reply.status(503).send({ error: 'Stripe not configured' });
    }

    const stripe = getStripe();
    const { sessionId } = req.params;

    // Load session + billing snapshot to determine final amount
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: {
        billingSnapshot: { select: { grossAmountUsd: true } },
        connector: { include: { charger: { include: { site: { select: { pricePerKwhUsd: true } } } } } },
      },
    });

    if (!session) {
      return reply.status(404).send({ ok: false, reason: 'session_not_found' });
    }

    // ── CAS: atomically claim the payment for capture ──────────────────
    // Uses raw SQL with FOR UPDATE SKIP LOCKED to prevent race conditions
    // when multiple close paths converge simultaneously.
    const claimedRows: { id: string; stripeIntentId: string | null; authorizedCents: number | null }[] =
      await prisma.$queryRaw`
        UPDATE "Payment"
        SET status = 'CAPTURE_IN_PROGRESS'::"PaymentStatus", "updatedAt" = NOW()
        WHERE id = (
          SELECT id FROM "Payment"
          WHERE "sessionId" = ${sessionId}
            AND status = 'AUTHORIZED'::"PaymentStatus"
            AND purpose = 'CHARGING'::"PaymentPurpose"
          ORDER BY "createdAt" DESC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, "stripeIntentId", "authorizedCents"
      `;

    if (claimedRows.length === 0) {
      // Check if already captured — idempotent response
      const existing = await prisma.payment.findFirst({
        where: { sessionId, status: { in: ['CAPTURED', 'PARTIAL_CAPTURED'] }, purpose: 'CHARGING' },
        select: { status: true, amountCents: true },
      });
      if (existing) {
        return { ok: true, status: existing.status, amountCents: existing.amountCents, alreadySettled: true };
      }
      return { ok: false, reason: 'no_authorized_payment' };
    }

    const claimed = claimedRows[0];

    if (!claimed.stripeIntentId) {
      // No Stripe intent — can't capture. Revert to FAILED.
      await prisma.payment.update({
        where: { id: claimed.id },
        data: { status: 'FAILED' },
      });
      return { ok: false, reason: 'no_stripe_intent' };
    }

    // ── Determine final billing amount ─────────────────────────────────
    let billingAmountCents: number;

    if (session.billingSnapshot?.grossAmountUsd != null) {
      billingAmountCents = Math.round(Number(session.billingSnapshot.grossAmountUsd) * 100);
    } else {
      // Fallback: compute from kWh × rate
      const kwh = session.kwhDelivered ?? 0;
      const rate = session.ratePerKwh ?? session.connector?.charger?.site?.pricePerKwhUsd ?? 0.35;
      billingAmountCents = Math.round(kwh * rate * 100);
    }

    // Ensure non-negative and at least 1 cent if energy was delivered
    billingAmountCents = Math.max(0, billingAmountCents);
    if (billingAmountCents === 0 && (session.kwhDelivered ?? 0) > 0) {
      billingAmountCents = 1; // Stripe requires amount > 0 for capture
    }

    const authorizedCents = claimed.authorizedCents ?? 0;

    // ── Overflow policy ────────────────────────────────────────────────
    // If final > authorized: capture up to authorized amount, record deficit
    const captureAmount = billingAmountCents === 0
      ? 0 // Zero-cost session (e.g., free charging) — void instead
      : Math.min(billingAmountCents, authorizedCents);

    const isOverflow = billingAmountCents > authorizedCents;
    const deficitCents = isOverflow ? billingAmountCents - authorizedCents : null;

    try {
      if (captureAmount === 0) {
        // Zero-cost: cancel the preauth hold instead of capturing $0
        await stripe.paymentIntents.cancel(claimed.stripeIntentId);
        await prisma.payment.update({
          where: { id: claimed.id },
          data: { status: 'CANCELED', amountCents: 0 },
        });
        return { ok: true, status: 'CANCELED', amountCents: 0, reason: 'zero_amount' };
      }

      // Capture the final amount (or max authorized if overflow)
      const captured = await stripe.paymentIntents.capture(claimed.stripeIntentId, {
        amount_to_capture: captureAmount,
      });

      const finalStatus = isOverflow ? 'PARTIAL_CAPTURED' : 'CAPTURED';

      await prisma.payment.update({
        where: { id: claimed.id },
        data: {
          status: finalStatus,
          amountCents: captureAmount,
          deficitCents,
        },
      });

      app.log.info({
        sessionId,
        paymentId: claimed.id,
        billingAmountCents,
        captureAmount,
        deficitCents,
        status: finalStatus,
      }, 'Payment captured');

      return { ok: true, status: finalStatus, amountCents: captureAmount, deficitCents };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      app.log.error({ msg, sessionId, paymentId: claimed.id }, 'Stripe capture failed');

      // Check Stripe intent state — may have already been captured
      try {
        const intent = await stripe.paymentIntents.retrieve(claimed.stripeIntentId);
        if (intent.status === 'succeeded') {
          await prisma.payment.update({
            where: { id: claimed.id },
            data: { status: 'CAPTURED', amountCents: intent.amount_received },
          });
          return { ok: true, status: 'CAPTURED', amountCents: intent.amount_received, alreadySettled: true };
        }
      } catch { /* Stripe unreachable — fall through to FAILED */ }

      // Revert to AUTHORIZED so it can be retried (FAILED is terminal per-attempt,
      // but the original AUTHORIZED state allows a new capture attempt)
      await prisma.payment.update({
        where: { id: claimed.id },
        data: { status: 'AUTHORIZED' },
      });

      return reply.status(502).send({ ok: false, reason: 'capture_failed', error: msg });
    }
  });
}
