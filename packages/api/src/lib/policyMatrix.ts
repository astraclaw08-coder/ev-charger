import { RBAC_ROLES, isAllowed, type RbacPermission, type RbacRole } from '@ev-charger/shared';
import { hasDataScope, type AccessDataScope, type PortalAccessClaimsV1 } from './portalAccessClaims';

export type PolicyKey =
  | 'site.list'
  | 'site.read'
  | 'site.create'
  | 'site.update'
  | 'site.analytics.read'
  | 'site.uptime.read'
  | 'charger.status.read'
  | 'charger.register'
  | 'charger.sessions.read'
  | 'charger.uptime.read'
  | 'charger.reset'
  | 'admin.users.read'
  | 'admin.users.write'
  | 'admin.audit.read'
  | 'admin.settings.read'
  | 'admin.settings.write'
  | 'admin.notifications.read'
  | 'admin.notifications.write'
  | 'admin.security.posture.read'
  | 'admin.security.breakglass'
  | 'admin.security.scim'
  | 'org.list'
  | 'org.read'
  | 'org.create'
  | 'org.update'
  | 'org.delete'
  | 'portfolio.list'
  | 'portfolio.read'
  | 'portfolio.create'
  | 'portfolio.update'
  | 'portfolio.delete'
  | 'portfolio.assign_cross_org'
  | 'fleet.policy.read'
  | 'fleet.policy.write';

export type PolicyContract = {
  description: string;
  anyOf?: RbacPermission[];
  allOf?: RbacPermission[];
  minScope?: AccessDataScope;
  allowLegacyOperatorFallback?: boolean;
  sensitive?: boolean;
};

export const POLICY_MATRIX: Record<PolicyKey, PolicyContract> = {
  'site.list': { description: 'List sites', anyOf: ['site:read'], minScope: 'read-only', allowLegacyOperatorFallback: true },
  'site.read': { description: 'Read site details', anyOf: ['site:read'], minScope: 'read-only', allowLegacyOperatorFallback: true },
  'site.create': { description: 'Create site', anyOf: ['site:write'], minScope: 'full', allowLegacyOperatorFallback: true, sensitive: true },
  'site.update': { description: 'Update site details', anyOf: ['site:write'], minScope: 'full', allowLegacyOperatorFallback: true, sensitive: true },
  'site.analytics.read': { description: 'Read site analytics', anyOf: ['analytics:read'], minScope: 'limited', allowLegacyOperatorFallback: true },
  'site.uptime.read': { description: 'Read site uptime', anyOf: ['incident:read', 'charger:read'], minScope: 'limited', allowLegacyOperatorFallback: true },
  'charger.status.read': { description: 'Read charger status', anyOf: ['charger:read'], minScope: 'read-only', allowLegacyOperatorFallback: true },
  'charger.register': { description: 'Register charger', anyOf: ['site:write'], minScope: 'full', allowLegacyOperatorFallback: true, sensitive: true },
  'charger.sessions.read': { description: 'Read charger sessions', anyOf: ['session:read'], minScope: 'limited', allowLegacyOperatorFallback: true },
  'charger.uptime.read': { description: 'Read charger uptime', anyOf: ['incident:read', 'charger:read'], minScope: 'limited', allowLegacyOperatorFallback: true },
  'charger.reset': { description: 'Reset charger', anyOf: ['charger:control'], minScope: 'full', allowLegacyOperatorFallback: true, sensitive: true },
  'admin.users.read': { description: 'Read admin users', anyOf: ['rbac:manage'], minScope: 'limited', sensitive: true },
  'admin.users.write': { description: 'Mutate admin users/roles', anyOf: ['rbac:manage'], minScope: 'full', sensitive: true },
  'admin.audit.read': { description: 'Read admin audit log', anyOf: ['rbac:manage'], minScope: 'limited', sensitive: true },
  'admin.settings.read': { description: 'Read organization/admin settings', anyOf: ['rbac:manage'], minScope: 'limited', sensitive: true },
  'admin.settings.write': { description: 'Mutate organization/admin settings', anyOf: ['rbac:manage'], minScope: 'full', sensitive: true },
  'admin.notifications.read': { description: 'Read in-app notification campaigns and audit', anyOf: ['rbac:manage'], minScope: 'limited', sensitive: true },
  'admin.notifications.write': { description: 'Send in-app notification campaigns', anyOf: ['rbac:manage'], minScope: 'full', sensitive: true },
  'admin.security.posture.read': { description: 'Read security posture', anyOf: ['rbac:manage'], minScope: 'limited', sensitive: true },
  'admin.security.breakglass': { description: 'Break-glass owner elevation', allOf: ['rbac:manage'], minScope: 'full', sensitive: true },
  'admin.security.scim': { description: 'SCIM provisioning hooks', anyOf: ['rbac:manage'], minScope: 'full', sensitive: true },
  // ── Organization & Portfolio ──
  'org.list': { description: 'List organizations', anyOf: ['site:read'], minScope: 'read-only', allowLegacyOperatorFallback: true },
  'org.read': { description: 'Read organization details', anyOf: ['site:read'], minScope: 'read-only', allowLegacyOperatorFallback: true },
  'org.create': { description: 'Create organization', anyOf: ['rbac:manage'], minScope: 'full', sensitive: true },
  'org.update': { description: 'Update organization', anyOf: ['rbac:manage'], minScope: 'full', sensitive: true },
  'org.delete': { description: 'Delete organization', anyOf: ['rbac:manage'], minScope: 'full', sensitive: true },
  'portfolio.list': { description: 'List portfolios', anyOf: ['site:read'], minScope: 'read-only', allowLegacyOperatorFallback: true },
  'portfolio.read': { description: 'Read portfolio details', anyOf: ['site:read'], minScope: 'read-only', allowLegacyOperatorFallback: true },
  'portfolio.create': { description: 'Create portfolio', anyOf: ['site:write'], minScope: 'full', allowLegacyOperatorFallback: true, sensitive: true },
  'portfolio.update': { description: 'Update portfolio', anyOf: ['site:write'], minScope: 'full', allowLegacyOperatorFallback: true, sensitive: true },
  'portfolio.delete': { description: 'Delete portfolio', anyOf: ['site:write'], minScope: 'full', allowLegacyOperatorFallback: true, sensitive: true },
  'portfolio.assign_cross_org': { description: 'Assign portfolio across orgs', anyOf: ['rbac:manage'], minScope: 'full', sensitive: true },
  // ── Fleet policies (TASK-0208 Phase 2.5) ──
  'fleet.policy.read': { description: 'Read fleet policies', anyOf: ['site:read'], minScope: 'read-only', allowLegacyOperatorFallback: true },
  'fleet.policy.write': { description: 'Create/update/enable/disable/delete fleet policies', anyOf: ['site:write'], minScope: 'full', allowLegacyOperatorFallback: true, sensitive: true },
};

export type AuthorizationFailureCode =
  | 'MISSING_OPERATOR_CONTEXT'
  | 'INSUFFICIENT_SCOPE'
  | 'INSUFFICIENT_ROLE_PERMISSION'
  | 'SITE_OUT_OF_SCOPE'
  | 'ORG_SCOPE_MISMATCH';

export function evaluatePolicy(args: {
  key: PolicyKey;
  claims: PortalAccessClaimsV1;
  resourceSiteId?: string;
  resourceOrgId?: string;
}): { allowed: true } | { allowed: false; code: AuthorizationFailureCode; reason: string } {
  // super_admin bypasses ALL scope, site, org, and permission checks
  if (args.claims.roles.includes('super_admin')) {
    return { allowed: true };
  }

  const policy = POLICY_MATRIX[args.key];

  if (policy.minScope && !hasDataScope(args.claims, policy.minScope)) {
    return {
      allowed: false,
      code: 'INSUFFICIENT_SCOPE',
      reason: `Requires dataScope=${policy.minScope}`,
    };
  }

  if (args.resourceSiteId && args.claims.siteIds.length > 0 && !args.claims.siteIds.includes('*')) {
    if (!args.claims.siteIds.includes(args.resourceSiteId)) {
      return {
        allowed: false,
        code: 'SITE_OUT_OF_SCOPE',
        reason: `Site ${args.resourceSiteId} is not in granted siteIds`,
      };
    }
  }

  if (args.resourceOrgId && args.claims.orgId && args.claims.orgId !== args.resourceOrgId) {
    return {
      allowed: false,
      code: 'ORG_SCOPE_MISMATCH',
      reason: `resourceOrgId=${args.resourceOrgId} does not match claim.orgId=${args.claims.orgId}`,
    };
  }

  const resolvedRoles = args.claims.roles.filter((role): role is RbacRole =>
    (RBAC_ROLES as readonly string[]).includes(role),
  );

  const hasPermission = isAllowed(resolvedRoles, {
    anyOf: policy.anyOf,
    allOf: policy.allOf,
  });

  if (!hasPermission) {
    if (policy.allowLegacyOperatorFallback && (args.claims.roles.includes('operator') || args.claims.roles.includes('owner'))) {
      return { allowed: true };
    }

    return {
      allowed: false,
      code: 'INSUFFICIENT_ROLE_PERMISSION',
      reason: `Missing required role permissions for policy ${args.key}`,
    };
  }

  return { allowed: true };
}
