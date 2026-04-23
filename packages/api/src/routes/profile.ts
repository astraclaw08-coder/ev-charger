import type { FastifyInstance } from 'fastify';
import { prisma } from '@ev-charger/shared';
import { requireAuth } from '../plugins/auth';

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

function validateVehicleYear(value: unknown): string | null {
  const year = trimOrNull(value, 4);
  if (!year) return null;
  if (!/^\d{4}$/.test(year)) throw new Error('Vehicle year must be 4 digits');
  return year;
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
      stripeCustomerId: fresh!.stripeCustomerId, // read-only — set by payment flows, not profile update
      vehicleName: fresh!.vehicleName,
      vehicleMake: fresh!.vehicleMake,
      vehicleModel: fresh!.vehicleModel,
      vehicleYear: fresh!.vehicleYear,
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
      vehicleName?: string | null;
      vehicleMake?: string | null;
      vehicleModel?: string | null;
      vehicleYear?: string | null;
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
      vehicleName?: string | null;
      vehicleMake?: string | null;
      vehicleModel?: string | null;
      vehicleYear?: string | null;
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
        vehicleName: body.vehicleName !== undefined ? trimOrNull(body.vehicleName, 120) : undefined,
        vehicleMake: body.vehicleMake !== undefined ? trimOrNull(body.vehicleMake, 80) : undefined,
        vehicleModel: body.vehicleModel !== undefined ? trimOrNull(body.vehicleModel, 80) : undefined,
        vehicleYear: body.vehicleYear !== undefined ? validateVehicleYear(body.vehicleYear) : undefined,
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
        vehicleName: validated.vehicleName,
        vehicleMake: validated.vehicleMake,
        vehicleModel: validated.vehicleModel,
        vehicleYear: validated.vehicleYear,
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
      stripeCustomerId: updated.stripeCustomerId,
      vehicleName: updated.vehicleName,
      vehicleMake: updated.vehicleMake,
      vehicleModel: updated.vehicleModel,
      vehicleYear: updated.vehicleYear,
    };
  });

  // Consent persistence is temporarily unavailable in the current Prisma schema.
  // Keep the routes alive for local dev so clients can still boot without a DB schema mismatch.
  app.post<{
    Body: {
      tosVersion: string;
      privacyVersion: string;
    };
  }>('/me/consent', { preHandler: requireAuth }, async (req, reply) => {
    const { tosVersion, privacyVersion } = req.body ?? {};

    if (!tosVersion || !privacyVersion) {
      return reply.status(400).send({ error: 'tosVersion and privacyVersion are required' });
    }

    const now = new Date().toISOString();
    return {
      tosAcceptedAt: now,
      tosVersion: String(tosVersion).slice(0, 20),
      privacyAcceptedAt: now,
      privacyVersion: String(privacyVersion).slice(0, 20),
      persisted: false,
    };
  });

  app.get('/me/consent', { preHandler: requireAuth }, async () => {
    return {
      tosAcceptedAt: null,
      tosVersion: null,
      privacyAcceptedAt: null,
      privacyVersion: null,
      persisted: false,
    };
  });

  // Account deletion soft-delete fields are not present in the current Prisma schema.
  app.delete('/me', { preHandler: requireAuth }, async (req, reply) => {
    const user = req.currentUser!;
    return reply.status(501).send({
      error: 'Account deletion is not available in this environment until the user deletion schema is restored.',
      email: user.email,
    });
  });
}
