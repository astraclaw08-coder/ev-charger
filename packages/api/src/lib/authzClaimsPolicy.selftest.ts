import assert from 'node:assert/strict';
import { parsePortalAccessClaims } from './portalAccessClaims';
import { evaluatePolicy } from './policyMatrix';

function run() {
  const claimsV1 = parsePortalAccessClaims({
    tokenPayload: {
      sub: 'user-1',
      authz: {
        v: 1,
        orgId: 'org-west',
        roles: ['operator', 'data_analyst'],
        siteIds: ['site-a', 'site-b'],
        dataScopes: ['limited'],
      },
    },
  });

  assert.equal(claimsV1.source, 'claims-v1');
  assert.deepEqual(claimsV1.roles, ['operator', 'data_analyst']);
  assert.deepEqual(claimsV1.siteIds, ['site-a', 'site-b']);
  assert.deepEqual(claimsV1.dataScopes, ['limited']);

  const legacyClaims = parsePortalAccessClaims({
    tokenPayload: {
      sub: 'user-2',
      realm_access: { roles: ['owner'] },
      tenantId: 'tenant-legacy',
    },
    metadata: {
      role: 'operator',
      roles: ['network_reliability_engineer'],
    },
  });

  assert.equal(legacyClaims.source, 'legacy');
  assert.equal(legacyClaims.orgId, 'tenant-legacy');
  assert(legacyClaims.roles.includes('owner'));
  assert(legacyClaims.dataScopes.includes('full'));

  const allowed = evaluatePolicy({
    key: 'site.analytics.read',
    claims: claimsV1,
    resourceSiteId: 'site-a',
  });
  assert.equal(allowed.allowed, true);

  const deniedBySite = evaluatePolicy({
    key: 'site.analytics.read',
    claims: claimsV1,
    resourceSiteId: 'site-x',
  });
  assert.equal(deniedBySite.allowed, false);
  if (!deniedBySite.allowed) {
    assert.equal(deniedBySite.code, 'SITE_OUT_OF_SCOPE');
  }

  const deniedByScope = evaluatePolicy({
    key: 'site.create',
    claims: {
      ...claimsV1,
      dataScopes: ['limited'],
    },
  });
  assert.equal(deniedByScope.allowed, false);
  if (!deniedByScope.allowed) {
    assert.equal(deniedByScope.code, 'INSUFFICIENT_SCOPE');
  }

  console.log('authz claims + policy selftest passed');
}

run();
