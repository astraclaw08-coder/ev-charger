import type { FastifyInstance } from 'fastify';
import { prisma } from '@ev-charger/shared';
import { requireAuth } from '../plugins/auth';

export async function paymentRoutes(app: FastifyInstance) {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!stripeKey) {
    app.log.warn('STRIPE_SECRET_KEY not set — payment endpoints disabled');
  }

  // POST /payments/setup-intent — create a Stripe SetupIntent to save a card
  app.post('/payments/setup-intent', {
    preHandler: requireAuth,
  }, async (req, reply) => {
    if (!stripeKey) {
      return reply.status(503).send({ error: 'Stripe not configured' });
    }

    const { default: Stripe } = await import('stripe');
    const stripe = new Stripe(stripeKey, { apiVersion: '2024-06-20' });
    const user = req.currentUser!;

    // Reuse existing Stripe customer if we have one
    let stripeCustomerId: string | undefined;
    const existingPayment = await prisma.payment.findFirst({
      where: { userId: user.id, stripeCustomerId: { not: null } },
      select: { stripeCustomerId: true },
    });
    stripeCustomerId = existingPayment?.stripeCustomerId ?? undefined;

    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: user.name ?? undefined,
        metadata: { userId: user.id },
      });
      stripeCustomerId = customer.id;
    }

    const setupIntent = await stripe.setupIntents.create({
      customer: stripeCustomerId,
      payment_method_types: ['card'],
    });

    return { clientSecret: setupIntent.client_secret, stripeCustomerId };
  });

  // POST /payments/webhook — Stripe event delivery endpoint
  app.post('/payments/webhook', async (req, reply) => {
    if (!stripeKey || !webhookSecret) {
      return reply.status(503).send({ error: 'Stripe not configured' });
    }

    const sig = req.headers['stripe-signature'] as string | undefined;
    if (!sig) {
      return reply.status(400).send({ error: 'Missing stripe-signature header' });
    }

    const { default: Stripe } = await import('stripe');
    const stripe = new Stripe(stripeKey, { apiVersion: '2024-06-20' });

    let event: import('stripe').Stripe.Event;
    try {
      // rawBody is set by the content-type parser in server.ts
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

    return { received: true };
  });
}
