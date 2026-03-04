export const RBAC_ROLES = [
  'owner',
  'operator',
  'customer_service',
  'network_reliability_engineer',
  'data_analyst',
] as const;

export type RbacRole = (typeof RBAC_ROLES)[number];

export const RBAC_PERMISSIONS = [
  'site:read',
  'site:write',
  'charger:read',
  'charger:control',
  'session:read',
  'session:refund',
  'incident:read',
  'incident:write',
  'analytics:read',
  'analytics:export',
  'billing:read',
  'rbac:manage',
] as const;

export type RbacPermission = (typeof RBAC_PERMISSIONS)[number];

export type RolePolicyMap = Record<RbacRole, readonly RbacPermission[]>;

export const ROLE_POLICIES: RolePolicyMap = {
  owner: RBAC_PERMISSIONS,
  operator: [
    'site:read',
    'site:write',
    'charger:read',
    'charger:control',
    'session:read',
    'incident:read',
    'incident:write',
    'analytics:read',
    'billing:read',
  ],
  customer_service: [
    'site:read',
    'charger:read',
    'session:read',
    'session:refund',
    'incident:read',
  ],
  network_reliability_engineer: [
    'site:read',
    'charger:read',
    'charger:control',
    'incident:read',
    'incident:write',
    'analytics:read',
  ],
  data_analyst: [
    'site:read',
    'charger:read',
    'session:read',
    'analytics:read',
    'analytics:export',
  ],
};

export type PermissionGuardContract = {
  anyOf?: RbacPermission[];
  allOf?: RbacPermission[];
};

export function resolvePermissions(roles: RbacRole[]): RbacPermission[] {
  const out = new Set<RbacPermission>();
  for (const role of roles) {
    for (const perm of ROLE_POLICIES[role] ?? []) out.add(perm);
  }
  return Array.from(out);
}

export function isAllowed(
  roles: RbacRole[],
  contract: PermissionGuardContract,
): boolean {
  const perms = new Set(resolvePermissions(roles));

  if (contract.allOf?.length && !contract.allOf.every((p) => perms.has(p))) {
    return false;
  }

  if (contract.anyOf?.length && !contract.anyOf.some((p) => perms.has(p))) {
    return false;
  }

  return true;
}
