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

    // Reuse existing Stripe customer — check User first, then Payment fallback
    let stripeCustomerId = user.stripeCustomerId ?? undefined;
    if (!stripeCustomerId) {
      const existingPayment = await prisma.payment.findFirst({
        where: { userId: user.id, stripeCustomerId: { not: null } },
        select: { stripeCustomerId: true },
      });
      stripeCustomerId = existingPayment?.stripeCustomerId ?? undefined;
    }

    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: user.name ?? undefined,
        metadata: { userId: user.id },
      });
      stripeCustomerId = customer.id;
    }

    // Persist stripeCustomerId on User for future lookups
    if (user.stripeCustomerId !== stripeCustomerId) {
      await prisma.user.update({
        where: { id: user.id },
        data: { stripeCustomerId },
      });
    }

    const setupIntent = await stripe.setupIntents.create({
      customer: stripeCustomerId,
      payment_method_types: ['card'],
    });

    return { clientSecret: setupIntent.client_secret, stripeCustomerId };
  });

  // GET /payments/methods — list saved payment methods from Stripe
  app.get('/payments/methods', {
    preHandler: requireAuth,
  }, async (req, reply) => {
    if (!stripeKey) {
      return reply.status(503).send({ error: 'Stripe not configured' });
    }

    const { default: Stripe } = await import('stripe');
    const stripe = new Stripe(stripeKey, { apiVersion: '2024-06-20' });
    const user = req.currentUser!;

    // Find user's Stripe customer ID — User model first, Payment fallback
    let stripeCustomerId = user.stripeCustomerId ?? undefined;
    if (!stripeCustomerId) {
      const existingPayment = await prisma.payment.findFirst({
        where: { userId: user.id, stripeCustomerId: { not: null } },
        select: { stripeCustomerId: true },
      });
      stripeCustomerId = existingPayment?.stripeCustomerId ?? undefined;
    }

    if (!stripeCustomerId) {
      return { methods: [] };
    }

    const paymentMethods = await stripe.paymentMethods.list({
      customer: stripeCustomerId,
      type: 'card',
    });

    const methods = paymentMethods.data.map((pm) => ({
      id: pm.id,
      brand: pm.card?.brand ?? 'unknown',
      last4: pm.card?.last4 ?? '????',
      expMonth: pm.card?.exp_month ?? 0,
      expYear: pm.card?.exp_year ?? 0,
    }));

    // Auto-promote first card as default if none set
    let defaultPmId = user.defaultPaymentMethodId ?? null;
    if (!defaultPmId && methods.length > 0) {
      defaultPmId = methods[0].id;
      await prisma.user.update({ where: { id: user.id }, data: { defaultPaymentMethodId: defaultPmId } });
    }

    return { methods, stripeCustomerId, defaultPaymentMethodId: defaultPmId };
  });

  // PUT /payments/methods/:id/default — set a payment method as the default
  app.put('/payments/methods/:id/default', {
    preHandler: requireAuth,
  }, async (req, reply) => {
    if (!stripeKey) {
      return reply.status(503).send({ error: 'Stripe not configured' });
    }

    const { default: Stripe } = await import('stripe');
    const stripe = new Stripe(stripeKey, { apiVersion: '2024-06-20' });
    const user = req.currentUser!;
    const { id: paymentMethodId } = req.params as { id: string };

    const stripeCustomerId = user.stripeCustomerId;
    if (!stripeCustomerId) {
      return reply.status(404).send({ error: 'No payment methods found' });
    }

    // Verify ownership
    const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
    if (pm.customer !== stripeCustomerId) {
      return reply.status(403).send({ error: 'Payment method does not belong to this user' });
    }

    // Also set as default on the Stripe customer
    await stripe.customers.update(stripeCustomerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });

    await prisma.user.update({
      where: { id: user.id },
      data: { defaultPaymentMethodId: paymentMethodId },
    });

    return { success: true, defaultPaymentMethodId: paymentMethodId };
  });

  // DELETE /payments/methods/:id — detach a payment method from Stripe customer
  app.delete('/payments/methods/:id', {
    preHandler: requireAuth,
  }, async (req, reply) => {
    if (!stripeKey) {
      return reply.status(503).send({ error: 'Stripe not configured' });
    }

    const { default: Stripe } = await import('stripe');
    const stripe = new Stripe(stripeKey, { apiVersion: '2024-06-20' });
    const user = req.currentUser!;
    const { id: paymentMethodId } = req.params as { id: string };

    // Verify the payment method belongs to this user's Stripe customer
    const stripeCustomerId = user.stripeCustomerId;
    if (!stripeCustomerId) {
      return reply.status(404).send({ error: 'No payment methods found' });
    }

    // Fetch the payment method to verify ownership
    const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
    if (pm.customer !== stripeCustomerId) {
      return reply.status(403).send({ error: 'Payment method does not belong to this user' });
    }

    await stripe.paymentMethods.detach(paymentMethodId);

    // Check if user still has cards — if not, clear paymentProfile
    const remaining = await stripe.paymentMethods.list({
      customer: stripeCustomerId,
      type: 'card',
    });
    const updateData: Record<string, any> = {};
    if (remaining.data.length === 0) {
      updateData.paymentProfile = null;
      updateData.defaultPaymentMethodId = null;
    } else if (user.defaultPaymentMethodId === paymentMethodId) {
      // Deleted card was the default — promote the first remaining card
      updateData.defaultPaymentMethodId = remaining.data[0].id;
    }
    if (Object.keys(updateData).length > 0) {
      await prisma.user.update({ where: { id: user.id }, data: updateData });
    }

    return { success: true };
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
