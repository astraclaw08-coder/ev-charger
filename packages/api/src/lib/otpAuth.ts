import crypto from 'crypto';
import { prisma } from '@ev-charger/shared';
import { createAuthSession } from './authSession';

type OtpChannel = 'email' | 'sms';
const db = prisma as any;

type IssueBucket = {
  startedAt: number;
  count: number;
  blockedUntil: number;
};

const issueByIp = new Map<string, IssueBucket>();
const issueByIdentifier = new Map<string, IssueBucket>();

function readNumberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function config() {
  return {
    otpDigits: 6,
    ttlSeconds: readNumberEnv('AUTH_OTP_TTL_SECONDS', 300),
    resendCooldownSeconds: readNumberEnv('AUTH_OTP_RESEND_COOLDOWN_SECONDS', 30),
    maxVerifyAttempts: readNumberEnv('AUTH_OTP_MAX_VERIFY_ATTEMPTS', 5),
    issueWindowSeconds: readNumberEnv('AUTH_OTP_ISSUE_WINDOW_SECONDS', 900),
    issueBlockSeconds: readNumberEnv('AUTH_OTP_ISSUE_BLOCK_SECONDS', 900),
    issueMaxByIp: readNumberEnv('AUTH_OTP_ISSUE_MAX_BY_IP', 15),
    issueMaxByIdentifier: readNumberEnv('AUTH_OTP_ISSUE_MAX_BY_IDENTIFIER', 6),
  };
}

function hashOtp(challengeId: string, code: string) {
  return crypto.createHash('sha256').update(`${challengeId}:${code}`).digest('hex');
}

function maskIdentifier(channel: OtpChannel, identifier: string) {
  if (channel === 'email') {
    const [local, domain] = identifier.split('@');
    const localPrefix = local.slice(0, 2);
    return `${localPrefix}${'*'.repeat(Math.max(1, local.length - 2))}@${domain}`;
  }
  const digits = identifier.replace(/\D/g, '');
  const suffix = digits.slice(-2);
  return `***${suffix}`;
}

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function normalizePhone(value: string) {
  const withPlus = value.trim().replace(/[\s()-]/g, '');
  if (!withPlus.startsWith('+')) {
    throw Object.assign(new Error('Phone must include country code (for example +14155550100)'), { code: 'INVALID_PHONE_FORMAT' });
  }
  const normalized = `+${withPlus.slice(1).replace(/\D/g, '')}`;
  if (!/^\+[1-9][0-9]{7,14}$/.test(normalized)) {
    throw Object.assign(new Error('Phone must be E.164 format, such as +14155550100'), { code: 'INVALID_PHONE_FORMAT' });
  }
  return normalized;
}

export function normalizeOtpIdentifier(channel: OtpChannel, raw: string) {
  if (!raw?.trim()) {
    throw Object.assign(new Error('identifier is required'), { code: 'IDENTIFIER_REQUIRED' });
  }

  if (channel === 'email') {
    const normalized = normalizeEmail(raw);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      throw Object.assign(new Error('Valid email is required'), { code: 'INVALID_EMAIL_FORMAT' });
    }
    return normalized;
  }

  return normalizePhone(raw);
}

function consumeIssueQuota(input: { ip: string; identifier: string }) {
  const cfg = config();
  const now = Date.now();

  function updateBucket(map: Map<string, IssueBucket>, key: string, limit: number) {
    const existing = map.get(key);
    if (!existing || now - existing.startedAt > cfg.issueWindowSeconds * 1000) {
      map.set(key, { startedAt: now, count: 1, blockedUntil: 0 });
      return { blocked: false } as const;
    }

    if (existing.blockedUntil > now) {
      return {
        blocked: true,
        retryAfterSeconds: Math.ceil((existing.blockedUntil - now) / 1000),
      } as const;
    }

    existing.count += 1;
    if (existing.count > limit) {
      existing.blockedUntil = now + cfg.issueBlockSeconds * 1000;
      map.set(key, existing);
      return {
        blocked: true,
        retryAfterSeconds: cfg.issueBlockSeconds,
      } as const;
    }

    map.set(key, existing);
    return { blocked: false } as const;
  }

  const byIp = updateBucket(issueByIp, input.ip || 'unknown', cfg.issueMaxByIp);
  if (byIp.blocked) return byIp;

  const byIdentifier = updateBucket(issueByIdentifier, input.identifier, cfg.issueMaxByIdentifier);
  if (byIdentifier.blocked) return byIdentifier;

  return { blocked: false } as const;
}

function randomOtpCode() {
  const { otpDigits } = config();
  const max = 10 ** otpDigits;
  const number = crypto.randomInt(0, max);
  return String(number).padStart(otpDigits, '0');
}

async function createOrUpdateChallenge(input: {
  existingId?: string;
  channel: OtpChannel;
  identifier: string;
  ip?: string;
}) {
  const cfg = config();
  const otpCode = randomOtpCode();

  if (input.existingId) {
    const existing = await db.authOtpChallenge.findUnique({ where: { id: input.existingId } });
    if (!existing) {
      throw Object.assign(new Error('OTP challenge is not valid'), { code: 'OTP_CHALLENGE_INVALID', statusCode: 404 });
    }
    if (existing.consumedAt) {
      throw Object.assign(new Error('OTP challenge already used'), { code: 'OTP_CHALLENGE_USED', statusCode: 409 });
    }
    if (existing.expiresAt.getTime() <= Date.now()) {
      throw Object.assign(new Error('OTP challenge expired; request a new code'), { code: 'OTP_CHALLENGE_EXPIRED', statusCode: 410 });
    }
    const cooldownMs = cfg.resendCooldownSeconds * 1000;
    const availableAt = existing.lastSentAt.getTime() + cooldownMs;
    if (availableAt > Date.now()) {
      throw Object.assign(new Error('Please wait before requesting another code'), {
        code: 'OTP_RESEND_COOLDOWN',
        statusCode: 429,
        retryAfterSeconds: Math.ceil((availableAt - Date.now()) / 1000),
      });
    }

    const codeHash = hashOtp(existing.id, otpCode);
    const expiresAt = new Date(Date.now() + cfg.ttlSeconds * 1000);
    const updated = await db.authOtpChallenge.update({
      where: { id: existing.id },
      data: {
        channel: input.channel === 'email' ? 'EMAIL' : 'SMS',
        identifier: input.identifier,
        codeHash,
        expiresAt,
        lastSentAt: new Date(),
        attemptCount: 0,
        maxAttempts: cfg.maxVerifyAttempts,
      },
    });
    return { challenge: updated, otpCode };
  }

  const challenge = await db.authOtpChallenge.create({
    data: {
      channel: input.channel === 'email' ? 'EMAIL' : 'SMS',
      identifier: input.identifier,
      codeHash: '',
      maxAttempts: cfg.maxVerifyAttempts,
      issuedIp: input.ip,
      expiresAt: new Date(Date.now() + cfg.ttlSeconds * 1000),
    },
  });

  const withHash = await db.authOtpChallenge.update({
    where: { id: challenge.id },
    data: {
      codeHash: hashOtp(challenge.id, otpCode),
      lastSentAt: new Date(),
    },
  });

  return { challenge: withHash, otpCode };
}

export async function issueOtpChallenge(input: {
  channel: OtpChannel;
  identifier: string;
  challengeId?: string;
  ip?: string;
}) {
  const normalizedIdentifier = normalizeOtpIdentifier(input.channel, input.identifier);
  const quota = consumeIssueQuota({ ip: input.ip ?? 'unknown', identifier: `${input.channel}:${normalizedIdentifier}` });
  if (quota.blocked) {
    throw Object.assign(new Error('Too many OTP requests; please try again later'), {
      code: 'OTP_ISSUE_RATE_LIMIT',
      statusCode: 429,
      retryAfterSeconds: quota.retryAfterSeconds,
    });
  }

  const { challenge, otpCode } = await createOrUpdateChallenge({
    existingId: input.challengeId,
    channel: input.channel,
    identifier: normalizedIdentifier,
    ip: input.ip,
  });

  const cfg = config();
  return {
    challengeId: challenge.id,
    expiresInSeconds: Math.max(1, Math.ceil((challenge.expiresAt.getTime() - Date.now()) / 1000)),
    resendAvailableInSeconds: cfg.resendCooldownSeconds,
    destinationHint: maskIdentifier(input.channel, normalizedIdentifier),
    devOtpCode: process.env.NODE_ENV === 'production' && process.env.AUTH_OTP_DEBUG_CODE_EXPOSE !== '1'
      ? undefined
      : otpCode,
  };
}

async function ensureOtpUser(input: { channel: OtpChannel; identifier: string }) {
  if (input.channel === 'email') {
    const byEmail = await prisma.user.findUnique({ where: { email: input.identifier } });
    if (byEmail) return byEmail;

    const identityHash = crypto.createHash('sha256').update(`email:${input.identifier}`).digest('hex').slice(0, 24);
    return prisma.user.create({
      data: {
        clerkId: `otp:email:${identityHash}`,
        email: input.identifier,
        idTag: await generateUniqueIdTag('EM'),
      },
    });
  }

  const byPhone = await prisma.user.findFirst({ where: { phone: input.identifier } });
  if (byPhone) return byPhone;

  const identityHash = crypto.createHash('sha256').update(`sms:${input.identifier}`).digest('hex').slice(0, 24);
  const email = `sms-${identityHash}@otp.local`;

  return prisma.user.create({
    data: {
      clerkId: `otp:sms:${identityHash}`,
      email,
      phone: input.identifier,
      idTag: await generateUniqueIdTag('SM'),
    },
  });
}

async function generateUniqueIdTag(prefix: string) {
  for (let i = 0; i < 5; i += 1) {
    const candidate = `${prefix}${crypto.randomBytes(9).toString('hex')}`.slice(0, 20).toUpperCase();
    const found = await prisma.user.findUnique({ where: { idTag: candidate } });
    if (!found) return candidate;
  }
  throw new Error('Failed to generate unique ID tag');
}

export async function verifyOtpChallenge(input: {
  challengeId: string;
  code: string;
  ip?: string;
  userAgent?: string;
}) {
  if (!/^\d{6}$/.test(input.code.trim())) {
    throw Object.assign(new Error('Verification code must be a 6-digit number'), {
      code: 'OTP_CODE_FORMAT_INVALID',
      statusCode: 400,
    });
  }

  const challenge = await db.authOtpChallenge.findUnique({ where: { id: input.challengeId } });
  if (!challenge) {
    throw Object.assign(new Error('OTP challenge is not valid'), { code: 'OTP_CHALLENGE_INVALID', statusCode: 404 });
  }

  if (challenge.consumedAt) {
    throw Object.assign(new Error('OTP code already used. Request a new one.'), { code: 'OTP_CHALLENGE_USED', statusCode: 409 });
  }

  if (challenge.expiresAt.getTime() <= Date.now()) {
    throw Object.assign(new Error('OTP code has expired. Request a new code.'), { code: 'OTP_CODE_EXPIRED', statusCode: 410 });
  }

  if (challenge.attemptCount >= challenge.maxAttempts) {
    throw Object.assign(new Error('Too many incorrect attempts. Request a new code.'), {
      code: 'OTP_VERIFY_ATTEMPTS_EXCEEDED',
      statusCode: 429,
    });
  }

  const expected = Buffer.from(challenge.codeHash, 'hex');
  const actual = Buffer.from(hashOtp(challenge.id, input.code.trim()), 'hex');
  const codeValid = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);

  if (!codeValid) {
    const updated = await db.authOtpChallenge.update({
      where: { id: challenge.id },
      data: { attemptCount: { increment: 1 } },
    });

    const remainingAttempts = Math.max(0, updated.maxAttempts - updated.attemptCount);
    throw Object.assign(new Error('Verification code is invalid'), {
      code: 'OTP_CODE_INVALID',
      statusCode: 401,
      remainingAttempts,
    });
  }

  const consumedAt = new Date();
  await db.authOtpChallenge.update({ where: { id: challenge.id }, data: { consumedAt } });

  const channel = challenge.channel === 'EMAIL' ? 'email' : 'sms';
  const user = await ensureOtpUser({ channel, identifier: challenge.identifier });

  if (channel === 'sms' && !user.phone) {
    await prisma.user.update({ where: { id: user.id }, data: { phone: challenge.identifier } });
  }

  const session = await createAuthSession({
    userId: user.id,
    provider: channel === 'email' ? 'otp-email' : 'otp-sms',
    ip: input.ip,
    userAgent: input.userAgent,
  });

  return {
    user,
    session,
  };
}
