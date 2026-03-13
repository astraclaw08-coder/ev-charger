#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const Module = require('module');

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

const store = {
  challenges: [],
  users: [],
  sessions: [],
};

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

const prismaMock = {
  authOtpChallenge: {
    async findUnique({ where: { id } }) {
      return store.challenges.find((c) => c.id === id) || null;
    },
    async create({ data }) {
      const row = {
        id: `challenge_${store.challenges.length + 1}`,
        channel: data.channel,
        identifier: data.identifier,
        codeHash: data.codeHash,
        maxAttempts: data.maxAttempts,
        attemptCount: data.attemptCount ?? 0,
        issuedIp: data.issuedIp ?? null,
        expiresAt: data.expiresAt,
        consumedAt: null,
        lastSentAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      store.challenges.push(row);
      return row;
    },
    async update({ where: { id }, data }) {
      const row = store.challenges.find((c) => c.id === id);
      if (!row) throw new Error(`challenge not found: ${id}`);
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === 'object' && 'increment' in v) {
          row[k] = Number(row[k] || 0) + Number(v.increment || 0);
        } else {
          row[k] = v;
        }
      }
      row.updatedAt = new Date();
      return row;
    },
  },
  user: {
    async findUnique({ where }) {
      if (where.email) return store.users.find((u) => u.email === where.email) || null;
      if (where.idTag) return store.users.find((u) => u.idTag === where.idTag) || null;
      if (where.id) return store.users.find((u) => u.id === where.id) || null;
      return null;
    },
    async findFirst({ where }) {
      if (where.phone) return store.users.find((u) => u.phone === where.phone) || null;
      return null;
    },
    async create({ data }) {
      const row = {
        id: `user_${store.users.length + 1}`,
        clerkId: data.clerkId,
        email: data.email,
        phone: data.phone ?? null,
        name: data.name ?? null,
        idTag: data.idTag,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      store.users.push(row);
      return row;
    },
    async update({ where: { id }, data }) {
      const row = store.users.find((u) => u.id === id);
      if (!row) throw new Error(`user not found: ${id}`);
      Object.assign(row, data);
      row.updatedAt = new Date();
      return row;
    },
  },
  authSession: {
    async create({ data }) {
      const row = {
        id: `session_${store.sessions.length + 1}`,
        userId: data.userId,
        tokenHash: data.tokenHash,
        provider: data.provider,
        issuedIp: data.issuedIp ?? null,
        userAgent: data.userAgent ?? null,
        expiresAt: data.expiresAt,
        revokedAt: null,
        lastUsedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      store.sessions.push(row);
      return row;
    },
    async findUnique({ where: { tokenHash }, include }) {
      const session = store.sessions.find((s) => s.tokenHash === tokenHash);
      if (!session) return null;
      if (include?.user) {
        const user = store.users.find((u) => u.id === session.userId) || null;
        return { ...session, user };
      }
      return session;
    },
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === '@ev-charger/shared') {
    return { prisma: prismaMock };
  }
  return originalLoad.apply(this, arguments);
};

process.env.NODE_ENV = 'test';
process.env.AUTH_OTP_TTL_SECONDS = '1';
process.env.AUTH_OTP_RESEND_COOLDOWN_SECONDS = '2';
process.env.AUTH_OTP_MAX_VERIFY_ATTEMPTS = '3';
process.env.AUTH_OTP_ISSUE_MAX_BY_IP = '20';
process.env.AUTH_OTP_ISSUE_MAX_BY_IDENTIFIER = '2';
process.env.AUTH_OTP_ISSUE_BLOCK_SECONDS = '2';
process.env.AUTH_OTP_ISSUE_WINDOW_SECONDS = '60';

const otpAuth = require('../../packages/api/dist/lib/otpAuth.js');

async function expectThrows(fn, expectedCode) {
  try {
    await fn();
    throw new Error(`Expected error code ${expectedCode}`);
  } catch (err) {
    assert.strictEqual(err.code, expectedCode, `Expected ${expectedCode}, got ${err.code || 'unknown'}`);
    return err;
  }
}

(async function run() {
  console.log('[TASK-0077][CHECK] Starting OTP runtime validation (email + SMS)');

  const emailIssue = await otpAuth.issueOtpChallenge({
    channel: 'email',
    identifier: 'Driver@Test.EVCharger.dev',
    ip: '10.0.0.10',
  });
  assert.ok(emailIssue.challengeId);
  assert.ok(/^dr\*+@test\.evcharger\.dev$/.test(emailIssue.destinationHint));
  assert.ok(/^\d{6}$/.test(emailIssue.devOtpCode));
  console.log('[TASK-0077][CHECK] Email issue: PASS');

  const badEmailVerify = await expectThrows(
    () => otpAuth.verifyOtpChallenge({ challengeId: emailIssue.challengeId, code: '000000', ip: '10.0.0.10' }),
    'OTP_CODE_INVALID',
  );
  assert.strictEqual(Number(badEmailVerify.remainingAttempts), 2);

  const emailVerify = await otpAuth.verifyOtpChallenge({
    challengeId: emailIssue.challengeId,
    code: emailIssue.devOtpCode,
    ip: '10.0.0.10',
    userAgent: 'task-0077-check',
  });
  assert.ok(emailVerify.session.accessToken);
  assert.strictEqual(emailVerify.session.tokenType, 'Bearer');
  const emailSession = store.sessions.find((s) => s.userId === emailVerify.user.id);
  assert.ok(emailSession);
  assert.notStrictEqual(emailSession.tokenHash, emailVerify.session.accessToken);
  assert.strictEqual(emailSession.tokenHash, hashToken(emailVerify.session.accessToken));
  console.log('[TASK-0077][CHECK] Email verify/session: PASS');

  const smsIssue = await otpAuth.issueOtpChallenge({
    channel: 'sms',
    identifier: '+1 (415) 555-0100',
    ip: '10.0.0.11',
  });
  assert.ok(smsIssue.destinationHint.endsWith('00'));
  assert.ok(/^\d{6}$/.test(smsIssue.devOtpCode));

  await expectThrows(
    () => otpAuth.issueOtpChallenge({
      channel: 'sms',
      identifier: '+14155550100',
      challengeId: smsIssue.challengeId,
      ip: '10.0.0.11',
    }),
    'OTP_RESEND_COOLDOWN',
  );
  console.log('[TASK-0077][CHECK] SMS resend cooldown: PASS');

  await new Promise((r) => setTimeout(r, 1200));
  await expectThrows(
    () => otpAuth.verifyOtpChallenge({ challengeId: smsIssue.challengeId, code: smsIssue.devOtpCode, ip: '10.0.0.11' }),
    'OTP_CODE_EXPIRED',
  );
  console.log('[TASK-0077][CHECK] Expired-code fallback path: PASS');

  const smsIssue2 = await otpAuth.issueOtpChallenge({
    channel: 'sms',
    identifier: '+14155550199',
    ip: '10.0.0.12',
  });
  const smsVerify = await otpAuth.verifyOtpChallenge({
    challengeId: smsIssue2.challengeId,
    code: smsIssue2.devOtpCode,
    ip: '10.0.0.12',
    userAgent: 'task-0077-check',
  });
  assert.ok(smsVerify.user.phone === '+14155550199');
  const smsSession = store.sessions.find((s) => s.userId === smsVerify.user.id);
  assert.ok(smsSession && smsSession.provider === 'otp-sms');
  console.log('[TASK-0077][CHECK] SMS verify/session: PASS');

  await otpAuth.issueOtpChallenge({ channel: 'email', identifier: 'limit@test.dev', ip: '10.0.0.99' });
  await otpAuth.issueOtpChallenge({ channel: 'email', identifier: 'limit@test.dev', ip: '10.0.0.99' });
  await expectThrows(
    () => otpAuth.issueOtpChallenge({ channel: 'email', identifier: 'limit@test.dev', ip: '10.0.0.99' }),
    'OTP_ISSUE_RATE_LIMIT',
  );
  console.log('[TASK-0077][CHECK] OTP issue rate-limit guardrail: PASS');

  const summary = {
    users: store.users.length,
    challenges: store.challenges.length,
    sessions: store.sessions.length,
    sample: clone({
      emailUser: store.users.find((u) => u.email === 'driver@test.evcharger.dev'),
      smsUser: store.users.find((u) => u.phone === '+14155550199'),
      lastSession: store.sessions.at(-1),
    }),
  };

  console.log('[TASK-0077][CHECK] Data summary:', JSON.stringify(summary, null, 2));
  console.log('[TASK-0077][CHECK] PASS');
})().catch((err) => {
  console.error('[TASK-0077][CHECK] FAIL', err);
  process.exit(1);
});
