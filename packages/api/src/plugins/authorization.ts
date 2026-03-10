import type { preHandlerHookHandler } from 'fastify';
import { evaluatePolicy, POLICY_MATRIX, type PolicyKey } from '../lib/policyMatrix';

export function requirePolicy(
  key: PolicyKey,
  options?: {
    getResourceSiteId?: (req: any) => string | undefined;
    getResourceOrgId?: (req: any) => string | undefined;
  },
): preHandlerHookHandler {
  return async (req, reply) => {
    const operator = req.currentOperator;
    if (!operator?.claims) {
      req.log.warn({ policy: key }, 'authorization denied: missing operator context');
      return reply.status(403).send({
        error: 'Forbidden',
        denyReason: {
          code: 'MISSING_OPERATOR_CONTEXT',
          reason: 'Operator claims are missing on request context',
          policy: key,
        },
      });
    }

    const result = evaluatePolicy({
      key,
      claims: operator.claims,
      resourceSiteId: options?.getResourceSiteId?.(req),
      resourceOrgId: options?.getResourceOrgId?.(req),
    });

    if (!result.allowed) {
      req.log.warn({
        kind: 'authz-deny',
        operatorId: operator.id,
        policy: key,
        denyCode: result.code,
        denyReason: result.reason,
        method: req.method,
        path: req.url,
        orgId: operator.claims.orgId,
        siteIds: operator.claims.siteIds,
        roles: operator.claims.roles,
      }, 'authorization denied');

      return reply.status(403).send({
        error: 'Forbidden',
        denyReason: {
          code: result.code,
          reason: result.reason,
          policy: key,
        },
      });
    }

    const policy = POLICY_MATRIX[key];
    if (policy.sensitive) {
      req.log.info({
        kind: 'authz-sensitive-allow',
        operatorId: operator.id,
        policy: key,
        method: req.method,
        path: req.url,
        orgId: operator.claims.orgId,
        siteIds: operator.claims.siteIds,
        roles: operator.claims.roles,
      }, 'authorization allowed on sensitive path');
    }
  };
}
