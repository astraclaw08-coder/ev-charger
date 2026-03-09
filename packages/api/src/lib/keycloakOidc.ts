type KeycloakIntrospectionResponse = {
  active?: boolean;
  sub?: string;
  email?: string;
  preferred_username?: string;
  realm_access?: { roles?: string[] };
  resource_access?: Record<string, { roles?: string[] }>;
  [key: string]: unknown;
};

function readEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function getOidcConfig() {
  const baseUrl = readEnv('KEYCLOAK_BASE_URL').replace(/\/$/, '');
  const realm = readEnv('KEYCLOAK_REALM');
  const clientId = process.env.KEYCLOAK_PORTAL_CLIENT_ID ?? process.env.KEYCLOAK_ADMIN_CLIENT_ID;
  const clientSecret = process.env.KEYCLOAK_PORTAL_CLIENT_SECRET ?? process.env.KEYCLOAK_ADMIN_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('Missing Keycloak portal client credentials');
  }

  return {
    baseUrl,
    realm,
    clientId,
    clientSecret,
    tokenEndpoint: `${baseUrl}/realms/${realm}/protocol/openid-connect/token`,
    introspectionEndpoint: `${baseUrl}/realms/${realm}/protocol/openid-connect/token/introspect`,
  };
}

export function keycloakPasswordAuthEnabled() {
  return Boolean(
    process.env.KEYCLOAK_BASE_URL &&
    process.env.KEYCLOAK_REALM &&
    (process.env.KEYCLOAK_PORTAL_CLIENT_ID || process.env.KEYCLOAK_ADMIN_CLIENT_ID) &&
    (process.env.KEYCLOAK_PORTAL_CLIENT_SECRET || process.env.KEYCLOAK_ADMIN_CLIENT_SECRET),
  );
}

export async function passwordGrantLogin(input: { username: string; password: string }) {
  const cfg = getOidcConfig();
  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    username: input.username,
    password: input.password,
    scope: 'openid profile email',
  });

  const res = await fetch(cfg.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    const payload = await res.text().catch(() => '');
    const err = new Error(`Keycloak password grant failed (${res.status})`);
    (err as Error & { detail?: string; statusCode?: number }).detail = payload;
    (err as Error & { statusCode?: number }).statusCode = res.status;
    throw err;
  }

  const json = await res.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    refresh_expires_in?: number;
    token_type?: string;
    scope?: string;
  };

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    tokenType: json.token_type ?? 'Bearer',
    expiresIn: json.expires_in ?? 0,
    refreshExpiresIn: json.refresh_expires_in ?? 0,
    scope: json.scope ?? 'openid profile email',
  };
}

export async function introspectAccessToken(accessToken: string): Promise<KeycloakIntrospectionResponse | null> {
  if (!accessToken) return null;
  const cfg = getOidcConfig();
  const body = new URLSearchParams({
    token: accessToken,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });

  const res = await fetch(cfg.introspectionEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) return null;
  const payload = await res.json() as KeycloakIntrospectionResponse;
  return payload.active ? payload : null;
}
