import crypto from 'crypto';

// OpenAI OAuth 2.0 endpoints
const OPENAI_AUTH_URL = 'https://auth.openai.com/authorize';
const OPENAI_TOKEN_URL = 'https://auth.openai.com/token';

// Env vars: OPENAI_OAUTH_CLIENT_ID, OPENAI_OAUTH_REDIRECT_URI, OPENAI_TOKEN_ENCRYPTION_KEY

function getConfig() {
  const clientId = process.env.OPENAI_OAUTH_CLIENT_ID;
  const redirectUri = process.env.OPENAI_OAUTH_REDIRECT_URI ?? 'http://localhost:5173/settings/openai/callback';
  const encryptionKey = process.env.OPENAI_TOKEN_ENCRYPTION_KEY;
  return { clientId, redirectUri, encryptionKey };
}

// PKCE helpers
export function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// Generate authorization URL with PKCE
export function generateAuthUrl(state: string, codeChallenge: string): string {
  const { clientId, redirectUri } = getConfig();
  if (!clientId) throw new Error('OPENAI_OAUTH_CLIENT_ID not configured');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'openid profile email offline_access',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${OPENAI_AUTH_URL}?${params.toString()}`;
}

// Exchange authorization code for tokens
export async function exchangeCode(code: string, codeVerifier: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  email?: string;
}> {
  const { clientId, redirectUri } = getConfig();
  if (!clientId) throw new Error('OPENAI_OAUTH_CLIENT_ID not configured');

  const res = await fetch(OPENAI_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: codeVerifier,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI token exchange failed (${res.status}): ${text}`);
  }

  const data = await res.json() as { access_token: string; refresh_token: string; expires_in: number; id_token?: string };

  // Try to extract email from id_token (JWT)
  let email: string | undefined;
  if (data.id_token) {
    try {
      const payload = JSON.parse(Buffer.from(data.id_token.split('.')[1], 'base64url').toString());
      email = payload.email;
    } catch { /* ignore */ }
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
    email,
  };
}

// Refresh access token
export async function refreshAccessToken(refreshToken: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}> {
  const { clientId } = getConfig();
  if (!clientId) throw new Error('OPENAI_OAUTH_CLIENT_ID not configured');

  const res = await fetch(OPENAI_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
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

// AES-256-GCM encryption for token storage
export function encryptToken(plaintext: string): string {
  const { encryptionKey } = getConfig();
  if (!encryptionKey) return plaintext; // Dev mode: no encryption
  const key = Buffer.from(encryptionKey, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decryptToken(ciphertext: string): string {
  const { encryptionKey } = getConfig();
  if (!encryptionKey) return ciphertext; // Dev mode: no encryption
  const key = Buffer.from(encryptionKey, 'hex');
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final('utf8');
}

// Get a valid OpenAI access token, refreshing if needed
export async function getValidOpenAIToken(prisma: any, scopeKey: string): Promise<string> {
  const settings = await prisma.portalSettings.findUnique({ where: { scopeKey } });
  if (!settings?.openaiAccessToken) {
    throw new Error('OpenAI not connected. An admin must connect OpenAI in Settings.');
  }

  const accessToken = decryptToken(settings.openaiAccessToken);
  const refreshTokenVal = settings.openaiRefreshToken ? decryptToken(settings.openaiRefreshToken) : null;

  // If token expires in less than 5 minutes, refresh
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
