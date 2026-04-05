import type { FastifyInstance } from 'fastify';
import { prisma } from '@ev-charger/shared';
import { requireAuth } from '../plugins/auth';
import { sendDeletionConfirmationEmail } from '../lib/email';

function trimOrNull(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function validateEmail(value: unknown): string {
  const email = trimOrNull(value, 200);
  if (!email) {
    throw new Error('Email is required');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Email must be a valid email address');
  }
  return email.toLowerCase();
}

function validateState(value: unknown): string | null {
  const state = trimOrNull(value, 2);
  if (!state) return null;
  const upper = state.toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper)) {
    throw new Error('State must be a 2-letter code');
  }
  return upper;
}

function validateZip(value: unknown): string | null {
  const zip = trimOrNull(value, 10);
  if (!zip) return null;
  if (!/^\d{5}(-\d{4})?$/.test(zip)) {
    throw new Error('Zip code must be 5 digits or ZIP+4 format');
  }
  return zip;
}

function hasSensitiveCardData(input: string): boolean {
  const digitsOnly = input.replace(/\D/g, '');
  if (digitsOnly.length >= 13 && digitsOnly.length <= 19) return true;
  if (/\b(cvv|cvc|security code)\b/i.test(input)) return true;
  if (/^\d{3,4}$/.test(input.trim())) return true;
  return false;
}

function validatePaymentReference(value: unknown): string | null {
  const ref = trimOrNull(value, 120);
  if (!ref) return null;
  if (hasSensitiveCardData(ref)) {
    throw new Error('Payment method reference must not contain card PAN/CVV data');
  }
  return ref;
}

export async function profileRoutes(app: FastifyInstance) {
  app.get('/me/profile', { preHandler: requireAuth }, async (req) => {
    const user = req.currentUser!;
    const fresh = await prisma.user.findUnique({ where: { id: user.id } });
    return {
      id: fresh!.id,
      name: fresh!.name,
      email: fresh!.email,
      phone: fresh!.phone,
      homeAddress: fresh!.homeAddress,
      homeSiteAddress: fresh!.homeSiteAddress,
      homeCity: fresh!.homeCity,
      homeState: fresh!.homeState,
      homeZipCode: fresh!.homeZipCode,
      paymentProfile: fresh!.paymentProfile,
    };
  });

  app.put<{
    Body: {
      name?: string;
      email?: string;
      phone?: string | null;
      homeAddress?: string | null;
      homeSiteAddress?: string | null;
      homeCity?: string | null;
      homeState?: string | null;
      homeZipCode?: string | null;
      paymentProfile?: string | null;
    };
  }>('/me/profile', { preHandler: requireAuth }, async (req, reply) => {
    const user = req.currentUser!;
    const body = req.body ?? {};

    let validated: {
      name?: string | null;
      email?: string;
      phone?: string | null;
      homeAddress?: string | null;
      homeSiteAddress?: string | null;
      homeCity?: string | null;
      homeState?: string | null;
      homeZipCode?: string | null;
      paymentProfile?: string | null;
    };

    try {
      validated = {
        name: body.name !== undefined ? trimOrNull(body.name, 120) : undefined,
        email: body.email !== undefined ? validateEmail(body.email) : undefined,
        phone: body.phone !== undefined ? trimOrNull(body.phone, 40) : undefined,
        homeAddress: body.homeAddress !== undefined ? trimOrNull(body.homeAddress, 250) : undefined,
        homeSiteAddress: body.homeSiteAddress !== undefined ? trimOrNull(body.homeSiteAddress, 250) : undefined,
        homeCity: body.homeCity !== undefined ? trimOrNull(body.homeCity, 120) : undefined,
        homeState: body.homeState !== undefined ? validateState(body.homeState) : undefined,
        homeZipCode: body.homeZipCode !== undefined ? validateZip(body.homeZipCode) : undefined,
        paymentProfile: body.paymentProfile !== undefined ? validatePaymentReference(body.paymentProfile) : undefined,
      };
    } catch (err) {
      return reply.status(400).send({
        error: err instanceof Error ? err.message : 'Invalid profile payload',
      });
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        name: validated.name,
        email: validated.email,
        phone: validated.phone,
        homeAddress: validated.homeAddress,
        homeSiteAddress: validated.homeSiteAddress,
        homeCity: validated.homeCity,
        homeState: validated.homeState,
        homeZipCode: validated.homeZipCode,
        paymentProfile: validated.paymentProfile,
      },
    });

    return {
      id: updated.id,
      name: updated.name,
      email: updated.email,
      phone: updated.phone,
      homeAddress: updated.homeAddress,
      homeSiteAddress: updated.homeSiteAddress,
      homeCity: updated.homeCity,
      homeState: updated.homeState,
      homeZipCode: updated.homeZipCode,
      paymentProfile: updated.paymentProfile,
    };
  });

  // Record consent acceptance (ToS + Privacy Policy)
  app.post<{
    Body: {
      tosVersion: string;
      privacyVersion: string;
    };
  }>('/me/consent', { preHandler: requireAuth }, async (req, reply) => {
    const user = req.currentUser!;
    const { tosVersion, privacyVersion } = req.body ?? {};

    if (!tosVersion || !privacyVersion) {
      return reply.status(400).send({ error: 'tosVersion and privacyVersion are required' });
    }

    const now = new Date();
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        tosAcceptedAt: now,
        tosVersion: String(tosVersion).slice(0, 20),
        privacyAcceptedAt: now,
        privacyVersion: String(privacyVersion).slice(0, 20),
      },
    });

    return {
      tosAcceptedAt: updated.tosAcceptedAt,
      tosVersion: updated.tosVersion,
      privacyAcceptedAt: updated.privacyAcceptedAt,
      privacyVersion: updated.privacyVersion,
    };
  });

  // Get consent status
  app.get('/me/consent', { preHandler: requireAuth }, async (req) => {
    const user = req.currentUser!;
    const fresh = await prisma.user.findUnique({ where: { id: user.id } });
    return {
      tosAcceptedAt: fresh!.tosAcceptedAt,
      tosVersion: fresh!.tosVersion,
      privacyAcceptedAt: fresh!.privacyAcceptedAt,
      privacyVersion: fresh!.privacyVersion,
    };
  });

  // Request account deletion (soft delete — sets deletionRequestedAt)
  app.delete('/me', { preHandler: requireAuth }, async (req) => {
    const user = req.currentUser!;
    const now = new Date();

    const fresh = await prisma.user.update({
      where: { id: user.id },
      data: {
        deletionRequestedAt: now,
      },
    });

    // Send confirmation email (non-blocking)
    sendDeletionConfirmationEmail(fresh.email, now).catch(() => {});

    return {
      message: 'Account deletion requested. Your data will be permanently removed after 30 days. Contact privacy@lumeopower.com to cancel.',
      deletionRequestedAt: now,
    };
  });
}
