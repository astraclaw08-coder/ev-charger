export const RBAC_ROLES = [
  'super_admin',
  'admin',
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

/**
 * Role hierarchy (highest → lowest privilege):
 *
 * super_admin  — Full platform access. Bypasses all site/org scope checks.
 *                Manages all operators, sites, users across the entire platform.
 *                Intended for platform owners only (e.g. Son / sdang3209).
 *
 * admin        — Full operational/admin access across all sites.
 *                Can manage users, sites, billing, notifications, and settings,
 *                but cannot grant or revoke admin/super_admin roles.
 *
 * owner        — Legacy full-access role within assigned org scope.
 *                Retained for compatibility; admin supersedes it for new usage.
 *
 * operator     — Day-to-day ops: read/write sites and chargers, view sessions.
 *                No RBAC management or billing export.
 *
 * customer_service — Read + refund sessions, read sites/chargers.
 *                    No write operations.
 *
 * network_reliability_engineer — Site + charger read/control, incident management.
 *                                 No billing or RBAC access.
 *
 * data_analyst — Read-only analytics + session data. Export allowed.
 *                No operational or admin access.
 */
export const ROLE_POLICIES: RolePolicyMap = {
  super_admin: RBAC_PERMISSIONS,
  admin: RBAC_PERMISSIONS,
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

/** Role hierarchy — highest privilege first. Used for enforcement:
 *  an actor can only assign roles below their own level. */
export const ROLE_HIERARCHY: readonly RbacRole[] = [
  'super_admin',
  'admin',
  'owner',
  'operator',
  'customer_service',
  'network_reliability_engineer',
  'data_analyst',
] as const;

export const RBAC_ROLE_LABELS: Record<RbacRole, string> = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  owner: 'Owner',
  operator: 'Operator',
  customer_service: 'Customer Service',
  network_reliability_engineer: 'Network Reliability Engineer',
  data_analyst: 'Data Analyst',
};

export const RBAC_ROLE_DESCRIPTIONS: Record<RbacRole, string> = {
  super_admin: 'Full platform access. All permissions, all orgs/sites.',
  admin: 'Platform admin access across all sites. Can manage operations and users, but not grant/revoke admin-class roles.',
  owner: 'Organization admin. Full access within org scope.',
  operator: 'Day-to-day operations. Sites, chargers, sessions.',
  customer_service: 'Read access + session refunds. No write operations.',
  network_reliability_engineer: 'Charger control + incident management.',
  data_analyst: 'Read-only analytics + data export.',
};

/** Returns the hierarchy rank (0 = highest). -1 if not found. */
export function roleRank(role: string): number {
  const idx = (ROLE_HIERARCHY as readonly string[]).indexOf(role);
  return idx >= 0 ? idx : -1;
}

/** Assignable roles — everything except super_admin and admin-class roles. */
export const ASSIGNABLE_ROLES: readonly RbacRole[] = ROLE_HIERARCHY.filter((r) => r !== 'super_admin' && r !== 'admin');

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
