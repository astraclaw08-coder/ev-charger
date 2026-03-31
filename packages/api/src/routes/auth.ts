import type { FastifyInstance } from 'fastify';
import { getKeycloakAdminClient } from '../lib/keycloakAdmin';
import { keycloakPasswordAuthEnabled, passwordGrantLogin, refreshGrantLogin } from '../lib/keycloakOidc';
import { isBlocked, recordAuthFailure, recordAuthSuccess } from '../lib/authProtection';
import { issueOtpChallenge, verifyOtpChallenge } from '../lib/otpAuth';

type PasswordLoginBody = {
  username: string;
  password: string;
};

type PasswordRefreshBody = {
  refreshToken: string;
};

type PasswordResetRequestBody = {
  identifier: string;
};

type BootstrapSuperAdminBody = {
  bootstrapSecret: string;
  username: string;
  email: string;
  password: string;
  firstName?: string;
  lastName?: string;
};

let superAdminBootstrapUsed = false;

function requiredOwnerRoles() {
  const raw = process.env.KEYCLOAK_OWNER_ROLES ?? 'owner,operator';
  return raw.split(',').map((v) => v.trim()).filter(Boolean);
}

function assertStrongBootstrapPassword(password: string) {
  if (password.length < 14) {
    throw new Error('password must be at least 14 characters');
  }
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
    throw new Error('password must include upper, lower, number, and symbol');
  }
}

export async function authRoutes(app: FastifyInstance) {
  app.post<{ Body: PasswordLoginBody }>('/auth/password-login', async (req, reply) => {
    const blocked = isBlocked({ ip: req.ip, routeScope: 'password-login' });
    if (blocked.blocked) {
      reply.header('Retry-After', String(blocked.retryAfterSeconds));
      return reply.status(429).send({ error: 'Too many failed auth attempts', retryAfterSeconds: blocked.retryAfterSeconds });
    }

    if (!keycloakPasswordAuthEnabled()) {
      return reply.status(503).send({ error: 'Password auth is not configured' });
    }

    const username = req.body?.username?.trim();
    const password = req.body?.password;
    if (!username || !password) {
      return reply.status(400).send({ error: 'username and password are required' });
    }

    try {
      const session = await passwordGrantLogin({ username, password });
      recordAuthSuccess({ ip: req.ip, routeScope: 'password-login' });
      req.log.info({ event: 'portal-password-login-success', username, ip: req.ip }, 'Password login success');
      return {
        ok: true,
        provider: 'keycloak-password',
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        tokenType: session.tokenType,
        expiresIn: session.expiresIn,
        refreshExpiresIn: session.refreshExpiresIn,
      };
    } catch {
      recordAuthFailure({ ip: req.ip, routeScope: 'password-login' });
      req.log.warn({ event: 'portal-password-login-failed', username, ip: req.ip }, 'Password login failed');
      return reply.status(401).send({ error: 'Invalid username or password' });
    }
  });

  app.post<{ Body: PasswordRefreshBody }>('/auth/password-refresh', async (req, reply) => {
    if (!keycloakPasswordAuthEnabled()) {
      return reply.status(503).send({ error: 'Password auth is not configured' });
    }

    const refreshToken = req.body?.refreshToken?.trim();
    if (!refreshToken) {
      return reply.status(400).send({ error: 'refreshToken is required' });
    }

    try {
      const session = await refreshGrantLogin({ refreshToken });
      return {
        ok: true,
        provider: 'keycloak-password',
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        tokenType: session.tokenType,
        expiresIn: session.expiresIn,
        refreshExpiresIn: session.refreshExpiresIn,
      };
    } catch {
      return reply.status(401).send({ error: 'Refresh token is invalid or expired' });
    }
  });

  app.post<{ Body: PasswordResetRequestBody }>('/auth/password-reset-request', async (req, reply) => {
    if (!keycloakPasswordAuthEnabled()) {
      return reply.status(503).send({ error: 'Password reset is not configured' });
    }

    const identifier = req.body?.identifier?.trim();
    if (!identifier) {
      return reply.status(400).send({ error: 'identifier is required' });
    }

    const normalized = identifier.toLowerCase();

    try {
      const kc = getKeycloakAdminClient();
      const matches = await kc.listUsers({ search: identifier, max: 10 });
      const user = matches.find((u) => (u.email ?? '').toLowerCase() === normalized)
        ?? matches.find((u) => (u.username ?? '').toLowerCase() === normalized)
        ?? null;

      if (user?.id) {
        await kc.executeActionsEmail(user.id, ['UPDATE_PASSWORD']);
      }

      req.log.info({ event: 'portal-password-reset-request', identifier, ip: req.ip }, 'Password reset requested');
      return reply.status(202).send({
        ok: true,
        message: 'If an account exists for that email/username, a password reset email has been sent.',
      });
    } catch (error) {
      req.log.error({ event: 'portal-password-reset-request-failed', identifier, ip: req.ip, err: error }, 'Password reset request failed');
      return reply.status(500).send({ error: 'Unable to process password reset right now' });
    }
  });

  app.post<{ Body: BootstrapSuperAdminBody }>('/auth/bootstrap-super-admin', async (req, reply) => {
    const blocked = isBlocked({ ip: req.ip, routeScope: 'bootstrap-super-admin' });
    if (blocked.blocked) {
      reply.header('Retry-After', String(blocked.retryAfterSeconds));
      return reply.status(429).send({ error: 'Too many failed auth attempts', retryAfterSeconds: blocked.retryAfterSeconds });
    }

    if (!keycloakPasswordAuthEnabled()) {
      return reply.status(503).send({ error: 'Keycloak is not configured' });
    }

    const expectedSecret = process.env.SUPER_ADMIN_BOOTSTRAP_SECRET;
    if (!expectedSecret) {
      return reply.status(503).send({ error: 'Bootstrap secret is not configured' });
    }
    if (superAdminBootstrapUsed) {
      return reply.status(409).send({ error: 'Bootstrap secret already used; rotate SUPER_ADMIN_BOOTSTRAP_SECRET to run again' });
    }

    const providedSecret = req.body?.bootstrapSecret?.trim();
    if (!providedSecret || providedSecret !== expectedSecret) {
      recordAuthFailure({ ip: req.ip, routeScope: 'bootstrap-super-admin' });
      req.log.warn({ event: 'bootstrap-super-admin-secret-mismatch', ip: req.ip }, 'Bootstrap secret mismatch');
      return reply.status(403).send({ error: 'Invalid bootstrap secret' });
    }

    const username = req.body?.username?.trim();
    const email = req.body?.email?.trim().toLowerCase();
    const password = req.body?.password;

    if (!username || !email || !password) {
      return reply.status(400).send({ error: 'username, email, and password are required' });
    }

    try {
      assertStrongBootstrapPassword(password);
      const kc = getKeycloakAdminClient();
      const found = await kc.listUsers({ search: email, max: 10 });
      const existing = found.find((u) => (u.email ?? '').toLowerCase() === email || (u.username ?? '').toLowerCase() === username.toLowerCase());

      let userId = existing?.id;
      if (!userId) {
        const created = await kc.createUser({
          email,
          firstName: req.body.firstName,
          lastName: req.body.lastName,
        });
        userId = created.id;
      }

      await kc.updateUser(userId!, {
        username,
        email,
        firstName: req.body.firstName,
        lastName: req.body.lastName,
        enabled: true,
        requiredActions: [],
      });
      await kc.setPassword(userId!, password, false);

      const roles = requiredOwnerRoles();
      const currentRoles = await kc.listRealmRolesForUser(userId!);
      const currentNames = new Set(currentRoles.map((r) => r.name));
      for (const role of roles) {
        if (!currentNames.has(role)) {
          await kc.addRealmRole(userId!, role);
        }
      }

      superAdminBootstrapUsed = true;
      recordAuthSuccess({ ip: req.ip, routeScope: 'bootstrap-super-admin' });
      req.log.info({ event: 'bootstrap-super-admin-success', userId, email, roles, ip: req.ip }, 'Super admin bootstrap success');

      return {
        ok: true,
        userId,
        email,
        username,
        assignedRoles: roles,
        temporaryPassword: false,
        forcePasswordChange: false,
        nextSteps: [
          'Log in through portal or API using the provided email/password immediately.',
          'Change your password on first login — this initial password is for bootstrapping only.',
          'Rotate SUPER_ADMIN_BOOTSTRAP_SECRET immediately after successful bootstrap.',
        ],
      };
    } catch (error) {
      recordAuthFailure({ ip: req.ip, routeScope: 'bootstrap-super-admin' });
      req.log.error({ event: 'bootstrap-super-admin-failed', ip: req.ip, err: error }, 'Super admin bootstrap failed');
      const message = error instanceof Error ? error.message : 'Bootstrap failed';
      return reply.status(400).send({ error: message });
    }
  });

  // ── OTP Phone / Email Auth ─────────────────────────────────────────────────

  type OtpSendBody = { phone?: string; email?: string; channel?: 'sms' | 'email' };
  type OtpVerifyBody = { challengeId: string; code: string };
  type OtpResendBody = { challengeId: string; phone?: string; email?: string; channel?: 'sms' | 'email' };

  app.post<{ Body: OtpSendBody }>('/auth/otp/send', async (req, reply) => {
    const blocked = isBlocked({ ip: req.ip, routeScope: 'otp-send' });
    if (blocked.blocked) {
      reply.header('Retry-After', String(blocked.retryAfterSeconds));
      return reply.status(429).send({ error: 'Too many requests', retryAfterSeconds: blocked.retryAfterSeconds });
    }

    const channel: 'sms' | 'email' = req.body?.channel === 'email' ? 'email' : 'sms';
    const identifier = channel === 'email' ? req.body?.email : req.body?.phone;
    if (!identifier?.trim()) {
      return reply.status(400).send({ error: `${channel === 'email' ? 'email' : 'phone'} is required` });
    }

    try {
      const result = await issueOtpChallenge({ channel, identifier: identifier.trim(), ip: req.ip });
      req.log.info({ event: 'otp-send-success', channel, ip: req.ip }, 'OTP challenge issued');
      return result;
    } catch (err: any) {
      const statusCode = err.statusCode || (err.code === 'OTP_ISSUE_RATE_LIMIT' ? 429 : 400);
      if (statusCode === 429) {
        reply.header('Retry-After', String(err.retryAfterSeconds ?? 60));
      }
      req.log.warn({ event: 'otp-send-failed', channel, ip: req.ip, code: err.code }, err.message);
      return reply.status(statusCode).send({ error: err.message, code: err.code });
    }
  });

  app.post<{ Body: OtpVerifyBody }>('/auth/otp/verify', async (req, reply) => {
    const blocked = isBlocked({ ip: req.ip, routeScope: 'otp-verify' });
    if (blocked.blocked) {
      reply.header('Retry-After', String(blocked.retryAfterSeconds));
      return reply.status(429).send({ error: 'Too many requests', retryAfterSeconds: blocked.retryAfterSeconds });
    }

    const { challengeId, code } = req.body ?? {};
    if (!challengeId || !code) {
      return reply.status(400).send({ error: 'challengeId and code are required' });
    }

    try {
      const result = await verifyOtpChallenge({
        challengeId,
        code,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      recordAuthSuccess({ ip: req.ip, routeScope: 'otp-verify' });
      req.log.info({ event: 'otp-verify-success', userId: result.user.id, ip: req.ip }, 'OTP verification success');
      return {
        ok: true,
        accessToken: result.session.accessToken,
        expiresIn: result.session.expiresIn,
        tokenType: result.session.tokenType,
        user: {
          id: result.user.id,
          email: result.user.email,
          phone: result.user.phone,
          name: result.user.name,
        },
      };
    } catch (err: any) {
      const statusCode = err.statusCode || 400;
      if (statusCode === 401) {
        recordAuthFailure({ ip: req.ip, routeScope: 'otp-verify' });
      }
      req.log.warn({ event: 'otp-verify-failed', ip: req.ip, code: err.code }, err.message);
      return reply.status(statusCode).send({
        error: err.message,
        code: err.code,
        remainingAttempts: err.remainingAttempts,
      });
    }
  });

  app.post<{ Body: OtpResendBody }>('/auth/otp/resend', async (req, reply) => {
    const blocked = isBlocked({ ip: req.ip, routeScope: 'otp-send' });
    if (blocked.blocked) {
      reply.header('Retry-After', String(blocked.retryAfterSeconds));
      return reply.status(429).send({ error: 'Too many requests', retryAfterSeconds: blocked.retryAfterSeconds });
    }

    const { challengeId } = req.body ?? {};
    if (!challengeId) {
      return reply.status(400).send({ error: 'challengeId is required' });
    }

    const channel: 'sms' | 'email' = req.body?.channel === 'email' ? 'email' : 'sms';
    const identifier = channel === 'email' ? req.body?.email : req.body?.phone;
    if (!identifier?.trim()) {
      return reply.status(400).send({ error: `${channel === 'email' ? 'email' : 'phone'} is required for resend` });
    }

    try {
      const result = await issueOtpChallenge({ channel, identifier: identifier.trim(), challengeId, ip: req.ip });
      req.log.info({ event: 'otp-resend-success', channel, challengeId, ip: req.ip }, 'OTP resend success');
      return result;
    } catch (err: any) {
      const statusCode = err.statusCode || (err.code === 'OTP_RESEND_COOLDOWN' ? 429 : 400);
      if (statusCode === 429) {
        reply.header('Retry-After', String(err.retryAfterSeconds ?? 30));
      }
      req.log.warn({ event: 'otp-resend-failed', channel, ip: req.ip, code: err.code }, err.message);
      return reply.status(statusCode).send({ error: err.message, code: err.code, retryAfterSeconds: err.retryAfterSeconds });
    }
  });
}
