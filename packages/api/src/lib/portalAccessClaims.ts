export type AccessDataScope = 'read-only' | 'limited' | 'full';

export type PortalAccessClaimsV1 = {
  version: 1;
  orgId: string | null;
  roles: string[];
  siteIds: string[];
  dataScopes: AccessDataScope[];
  source: 'legacy' | 'claims-v1';
};

export type ClaimParseInput = {
  tokenPayload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

const SCOPE_ORDER: AccessDataScope[] = ['read-only', 'limited', 'full'];
const DATA_SCOPE_ALIASES: Record<string, AccessDataScope> = {
  readonly: 'read-only',
  read_only: 'read-only',
  'read-only': 'read-only',
  ro: 'read-only',
  limited: 'limited',
  partial: 'limited',
  full: 'full',
  all: 'full',
};

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => asString(v)).filter((v): v is string => Boolean(v));
}

function normalizeRole(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeDataScope(value: string): AccessDataScope | null {
  const normalized = value.trim().toLowerCase();
  return DATA_SCOPE_ALIASES[normalized] ?? null;
}

function uniq(values: string[]): string[] {
  return Array.from(new Set(values));
}

function sortedScopes(scopes: AccessDataScope[]): AccessDataScope[] {
  const deduped = Array.from(new Set(scopes));
  return deduped.sort((a, b) => SCOPE_ORDER.indexOf(a) - SCOPE_ORDER.indexOf(b));
}

function pickAuthzContainer(payload: Record<string, unknown>): Record<string, unknown> | null {
  const direct = payload.authz;
  if (direct && typeof direct === 'object') return direct as Record<string, unknown>;

  const namespaced = payload['https://evcharger.io/authz'];
  if (namespaced && typeof namespaced === 'object') return namespaced as Record<string, unknown>;

  return null;
}

function parseRoles(payload?: Record<string, unknown>, metadata?: Record<string, unknown>): string[] {
  const fromAuthz = payload ? asStringList((pickAuthzContainer(payload) ?? {}).roles) : [];
  const fromRoot = payload ? asStringList(payload.roles) : [];
  const fromRealm = payload
    ? asStringList(((payload.realm_access as Record<string, unknown> | undefined) ?? {}).roles)
    : [];

  const metaRole = metadata ? asString(metadata.role) : null;
  const metaRoles = metadata ? asStringList(metadata.roles) : [];

  const collected = [
    ...fromAuthz,
    ...fromRoot,
    ...fromRealm,
    ...(metaRole ? [metaRole] : []),
    ...metaRoles,
  ].map(normalizeRole);

  return uniq(collected);
}

function parseSiteIds(payload?: Record<string, unknown>, metadata?: Record<string, unknown>): string[] {
  const authz = payload ? pickAuthzContainer(payload) : null;
  const fromAuthz = asStringList((authz ?? {}).siteIds);
  const fromSnake = payload ? asStringList(payload.site_ids) : [];
  const fromMeta = metadata ? asStringList(metadata.siteIds) : [];
  const fromLegacy = metadata ? asStringList(metadata.site_ids) : [];

  return uniq([...fromAuthz, ...fromSnake, ...fromMeta, ...fromLegacy]);
}

function parseDataScopes(payload?: Record<string, unknown>, metadata?: Record<string, unknown>): AccessDataScope[] {
  const authz = payload ? pickAuthzContainer(payload) : null;
  const rawScopes = [
    ...asStringList((authz ?? {}).dataScopes),
    ...(payload ? asStringList(payload.data_scopes) : []),
    ...(metadata ? asStringList(metadata.dataScopes) : []),
  ];

  const normalized = rawScopes
    .map((scope) => normalizeDataScope(scope))
    .filter((scope): scope is AccessDataScope => Boolean(scope));

  if (normalized.length > 0) return sortedScopes(normalized);
  return ['full'];
}

function parseOrgId(payload?: Record<string, unknown>, metadata?: Record<string, unknown>): string | null {
  const authz = payload ? pickAuthzContainer(payload) : null;
  return (
    asString((authz ?? {}).orgId)
    ?? asString(payload?.orgId)
    ?? asString(payload?.tenantId)
    ?? asString(payload?.tenant_id)
    ?? asString(metadata?.orgId)
    ?? asString(metadata?.tenantId)
    ?? null
  );
}

export function parsePortalAccessClaims(input: ClaimParseInput): PortalAccessClaimsV1 {
  const authz = input.tokenPayload ? pickAuthzContainer(input.tokenPayload) : null;
  const rawVersion = authz ? Number(authz.v) : Number.NaN;
  const hasV1Contract = Number.isFinite(rawVersion) && rawVersion >= 1;

  return {
    version: 1,
    orgId: parseOrgId(input.tokenPayload, input.metadata),
    roles: parseRoles(input.tokenPayload, input.metadata),
    siteIds: parseSiteIds(input.tokenPayload, input.metadata),
    dataScopes: parseDataScopes(input.tokenPayload, input.metadata),
    source: hasV1Contract ? 'claims-v1' : 'legacy',
  };
}

export function hasDataScope(claims: PortalAccessClaimsV1, required: AccessDataScope): boolean {
  const currentRank = Math.max(...claims.dataScopes.map((scope) => SCOPE_ORDER.indexOf(scope)), -1);
  return currentRank >= SCOPE_ORDER.indexOf(required);
}
