/**
 * Orphan preauth cleanup job.
 *
 * Runs every 5 minutes. Finds AUTHORIZED payments that were never linked to a session
 * (sessionId is null) and are older than 15 minutes → voids the Stripe hold and marks CANCELED.
 *
 * Also recovers stuck CAPTURE_IN_PROGRESS payments older than 2 minutes by checking
 * Stripe intent state and resolving to the correct terminal state.
 */
import { prisma } from '@ev-charger/shared';

const ORPHAN_TTL_MS = 15 * 60 * 1000; // 15 minutes
const CIP_TTL_MS = 2 * 60 * 1000; // 2 minutes for stuck CAPTURE_IN_PROGRESS

let stripeInstance: import('stripe').Stripe | null = null;

function getStripe(): import('stripe').Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  if (!stripeInstance) {
    const Stripe = require('stripe').default || require('stripe');
    stripeInstance = new Stripe(key, { apiVersion: '2024-06-20' });
  }
  return stripeInstance;
}

async function cleanupOrphanPreauths() {
  const stripe = getStripe();
  if (!stripe) return;

  const cutoff = new Date(Date.now() - ORPHAN_TTL_MS);

  // Find orphan AUTHORIZED payments with no session, older than TTL
  const orphans = await prisma.payment.findMany({
    where: {
      status: 'AUTHORIZED',
      purpose: 'CHARGING',
      sessionId: null,
      createdAt: { lt: cutoff },
    },
    select: { id: true, stripeIntentId: true },
    take: 50, // batch limit
  });

  for (const orphan of orphans) {
    try {
      if (orphan.stripeIntentId) {
        await stripe.paymentIntents.cancel(orphan.stripeIntentId);
      }
      await prisma.payment.update({
        where: { id: orphan.id },
        data: { status: 'CANCELED' },
      });
      console.log(`[PreauthCleanup] Voided orphan preauth ${orphan.id} (intent=${orphan.stripeIntentId})`);
    } catch (err) {
      console.error(`[PreauthCleanup] Failed to void orphan ${orphan.id}:`, err);
      // Still mark as CANCELED locally — the Stripe hold will auto-expire
      try {
        await prisma.payment.update({
          where: { id: orphan.id },
          data: { status: 'CANCELED' },
        });
      } catch { /* ignore */ }
    }
  }

  if (orphans.length > 0) {
    console.log(`[PreauthCleanup] Voided ${orphans.length} orphan preauths`);
  }
}

async function recoverStuckCaptures() {
  const stripe = getStripe();
  if (!stripe) return;

  const cutoff = new Date(Date.now() - CIP_TTL_MS);

  const stuck = await prisma.payment.findMany({
    where: {
      status: 'CAPTURE_IN_PROGRESS',
      updatedAt: { lt: cutoff },
    },
    select: { id: true, stripeIntentId: true },
    take: 20,
  });

  for (const payment of stuck) {
    try {
      if (!payment.stripeIntentId) {
        await prisma.payment.update({ where: { id: payment.id }, data: { status: 'FAILED' } });
        continue;
      }

      const intent = await stripe.paymentIntents.retrieve(payment.stripeIntentId);

      if (intent.status === 'succeeded') {
        await prisma.payment.update({
          where: { id: payment.id },
          data: { status: 'CAPTURED', amountCents: intent.amount_received },
        });
        console.log(`[PreauthCleanup] Recovered stuck payment ${payment.id} → CAPTURED`);
      } else if (intent.status === 'requires_capture') {
        // Still authorized — revert to AUTHORIZED so capture can retry
        await prisma.payment.update({
          where: { id: payment.id },
          data: { status: 'AUTHORIZED' },
        });
        console.log(`[PreauthCleanup] Reverted stuck payment ${payment.id} → AUTHORIZED`);
      } else {
        await prisma.payment.update({
          where: { id: payment.id },
          data: { status: 'FAILED' },
        });
        console.log(`[PreauthCleanup] Marked stuck payment ${payment.id} → FAILED (intent status: ${intent.status})`);
      }
    } catch (err) {
      console.error(`[PreauthCleanup] Failed to recover stuck payment ${payment.id}:`, err);
    }
  }
}

export function startPreauthCleanupJob() {
  const INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

  async function run() {
    try {
      await cleanupOrphanPreauths();
      await recoverStuckCaptures();
    } catch (err) {
      console.error('[PreauthCleanup] Job failed:', err);
    }
  }

  // Run once on startup (after a short delay)
  setTimeout(run, 30_000);
  // Then every 5 minutes
  setInterval(run, INTERVAL_MS);
  console.log('[PreauthCleanup] Scheduled every 5 minutes');
}
