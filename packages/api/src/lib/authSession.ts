import crypto from 'crypto';
import { prisma } from '@ev-charger/shared';

const db = prisma as any;

function sessionTtlSeconds() {
  const parsed = Number(process.env.AUTH_SESSION_TTL_SECONDS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 12 * 60 * 60;
}

function hashToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function createAuthSession(input: {
  userId: string;
  provider: 'otp-email' | 'otp-sms' | 'keycloak-password';
  ip?: string;
  userAgent?: string;
}) {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const expiresInSeconds = sessionTtlSeconds();
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);

  await db.authSession.create({
    data: {
      userId: input.userId,
      tokenHash: hashToken(rawToken),
      provider: input.provider,
      issuedIp: input.ip,
      userAgent: input.userAgent,
      expiresAt,
    },
  });

  return {
    accessToken: rawToken,
    expiresIn: expiresInSeconds,
    tokenType: 'Bearer' as const,
  };
}

export async function findUserBySessionToken(token: string) {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const session = await db.authSession.findUnique({
    where: { tokenHash },
    include: { user: true },
  });
  if (!session) return null;
  if (session.revokedAt || session.expiresAt.getTime() <= Date.now()) return null;

  return session.user;
}
