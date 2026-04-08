import crypto from 'crypto';

// ── OpenAI Codex OAuth 2.0 (public client, PKCE) ────────────────────────────
// Uses the same fixed client_id as Codex CLI — no app registration needed.
// Reference: https://developers.openai.com/codex/auth

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const SCOPE = 'openid profile email offline_access';

/**
 * Returns the redirect URI pointing to the API server itself.
 * In dev: http://localhost:3001/settings/openai/callback
 * In prod: https://api-production-26cf.up.railway.app/settings/openai/callback
 *
 * Set API_BASE_URL env var in prod. Falls back to localhost:3001 for dev.
 */
function getRedirectUri(): string {
  const base = process.env.API_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;
  return `${base}/settings/openai/callback`;
}

function getEncryptionKey(): string | undefined {
  return process.env.OPENAI_TOKEN_ENCRYPTION_KEY;
}

// ── PKCE helpers ─────────────────────────────────────────────────────────────

export function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// ── Authorization URL ────────────────────────────────────────────────────────

export function generateAuthUrl(state: string, codeChallenge: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: getRedirectUri(),
    scope: SCOPE,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    // Codex-specific params
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

// ── Token exchange ───────────────────────────────────────────────────────────

export async function exchangeCode(code: string, codeVerifier: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  email?: string;
}> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: getRedirectUri(),
      client_id: CLIENT_ID,
      code_verifier: codeVerifier,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI token exchange failed (${res.status}): ${text}`);
  }

  const data = await res.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    id_token?: string;
  };

  // Extract email from id_token JWT payload
  let email: string | undefined;
  if (data.id_token) {
    try {
      const payload = JSON.parse(Buffer.from(data.id_token.split('.')[1], 'base64url').toString());
      email = payload.email;
    } catch { /* ignore malformed id_token */ }
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
    email,
  };
}

// ── Token refresh ────────────────────────────────────────────────────────────

export async function refreshAccessToken(refreshToken: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI token refresh failed (${res.status}): ${text}`);
  }

  const data = await res.json() as { access_token: string; refresh_token: string; expires_in: number };
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
  };
}

// ── AES-256-GCM token encryption ─────────────────────────────────────────────

export function encryptToken(plaintext: string): string {
  const encryptionKey = getEncryptionKey();
  if (!encryptionKey) return plaintext; // Dev mode: store plaintext
  const key = Buffer.from(encryptionKey, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decryptToken(ciphertext: string): string {
  const encryptionKey = getEncryptionKey();
  if (!encryptionKey) return ciphertext; // Dev mode: plaintext passthrough
  const key = Buffer.from(encryptionKey, 'hex');
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final('utf8');
}

// ── Get valid token (auto-refresh) ───────────────────────────────────────────

export async function getValidOpenAIToken(prisma: any, scopeKey: string): Promise<string> {
  const settings = await prisma.portalSettings.findUnique({ where: { scopeKey } });
  if (!settings?.openaiAccessToken) {
    throw new Error('OpenAI not connected. An admin must connect OpenAI in Settings.');
  }

  const accessToken = decryptToken(settings.openaiAccessToken);
  const refreshTokenVal = settings.openaiRefreshToken ? decryptToken(settings.openaiRefreshToken) : null;

  // Refresh if token expires within 5 minutes
  if (settings.openaiTokenExpiresAt && new Date(settings.openaiTokenExpiresAt).getTime() < Date.now() + 5 * 60 * 1000) {
    if (!refreshTokenVal) throw new Error('OpenAI token expired and no refresh token available. Admin must reconnect.');

    const refreshed = await refreshAccessToken(refreshTokenVal);
    await prisma.portalSettings.update({
      where: { scopeKey },
      data: {
        openaiAccessToken: encryptToken(refreshed.accessToken),
        openaiRefreshToken: encryptToken(refreshed.refreshToken),
        openaiTokenExpiresAt: refreshed.expiresAt,
      },
    });
    return refreshed.accessToken;
  }

  return accessToken;
}
