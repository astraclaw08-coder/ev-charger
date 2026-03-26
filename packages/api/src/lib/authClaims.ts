export type SupportedAuthProvider = 'google' | 'apple' | 'unknown' | 'keycloak-password';

export type ClerkJwtPayloadLike = {
  sub?: string;
  [key: string]: unknown;
};

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function extractAuthProvider(payload: ClerkJwtPayloadLike): SupportedAuthProvider {
  const direct = readString(payload.provider) ?? readString(payload.oauth_provider);
  const amr = Array.isArray(payload.amr) ? payload.amr : [];
  const factors = amr.filter((v): v is string => typeof v === 'string').join(' ').toLowerCase();
  const composite = `${direct ?? ''} ${factors}`.toLowerCase();

  if (composite.includes('google')) return 'google';
  if (composite.includes('apple')) return 'apple';
  return 'unknown';
}

export function normalizeRoleMetadata(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const meta = metadata as Record<string, unknown>;

  const single = readString(meta.role);
  const multi = Array.isArray(meta.roles)
    ? meta.roles.map((v) => readString(v)).filter((v): v is string => Boolean(v))
    : [];

  const all = [...(single ? [single] : []), ...multi].map((v) => v.toLowerCase());
  return Array.from(new Set(all));
}
