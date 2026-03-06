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
  | 'admin.security.posture.read'
  | 'admin.security.breakglass'
  | 'admin.security.scim';

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
  'admin.security.posture.read': { description: 'Read security posture', anyOf: ['rbac:manage'], minScope: 'limited', sensitive: true },
  'admin.security.breakglass': { description: 'Break-glass owner elevation', allOf: ['rbac:manage'], minScope: 'full', sensitive: true },
  'admin.security.scim': { description: 'SCIM provisioning hooks', anyOf: ['rbac:manage'], minScope: 'full', sensitive: true },
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
