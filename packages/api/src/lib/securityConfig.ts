export type SecurityPostureSnapshot = {
  generatedAt: string;
  mfa: {
    requiredForRoles: string[];
    requiredAcrValues: string[];
    trustedDeviceDays: number;
    gracePeriodHours: number;
  };
  sso: {
    oidc: {
      issuerConfigured: boolean;
      clientIdConfigured: boolean;
      requiredClaims: string[];
      roleClaimPaths: string[];
    };
    saml: {
      enabled: boolean;
      nameIdFormat: string;
      requiredAttributes: string[];
      roleAttributeNames: string[];
    };
  };
  scim: {
    enabled: boolean;
    basePath: string;
    dryRun: boolean;
    supportedEvents: string[];
  };
  tokenRotation: {
    maxAccessTokenTtlSeconds: number;
    adminClientSecretRotationDays: number;
    signingKeyRotationDays: number;
    lastAdminSecretRotatedAt?: string;
    nextRotationDueAt?: string;
  };
  anomalyProtection: {
    maxFailedAttemptsPerWindow: number;
    failureWindowSeconds: number;
    blockDurationSeconds: number;
    sensitiveActionBurstLimit: number;
    sensitiveActionWindowSeconds: number;
  };
};

function readCsvEnv(name: string, fallback: string[]) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const values = raw.split(',').map((v) => v.trim()).filter(Boolean);
  return values.length ? values : fallback;
}

function readNumberEnv(name: string, fallback: number) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getSecurityPostureSnapshot(): SecurityPostureSnapshot {
  const rotationDays = readNumberEnv('KEYCLOAK_ADMIN_SECRET_ROTATION_DAYS', 90);
  const lastRotated = process.env.KEYCLOAK_ADMIN_SECRET_ROTATED_AT;

  let nextRotationDueAt: string | undefined;
  if (lastRotated) {
    const d = new Date(lastRotated);
    if (!Number.isNaN(d.getTime())) {
      d.setDate(d.getDate() + rotationDays);
      nextRotationDueAt = d.toISOString();
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    mfa: {
      requiredForRoles: readCsvEnv('SECURITY_MFA_REQUIRED_ROLES', ['owner', 'operator']),
      requiredAcrValues: readCsvEnv('SECURITY_MFA_REQUIRED_ACR_VALUES', ['urn:mace:incommon:iap:silver', 'phr']),
      trustedDeviceDays: readNumberEnv('SECURITY_MFA_TRUSTED_DEVICE_DAYS', 14),
      gracePeriodHours: readNumberEnv('SECURITY_MFA_GRACE_PERIOD_HOURS', 24),
    },
    sso: {
      oidc: {
        issuerConfigured: !!process.env.KEYCLOAK_BASE_URL,
        clientIdConfigured: !!process.env.KEYCLOAK_ADMIN_CLIENT_ID,
        requiredClaims: readCsvEnv('SECURITY_SSO_OIDC_REQUIRED_CLAIMS', ['sub', 'email', 'email_verified']),
        roleClaimPaths: readCsvEnv('SECURITY_SSO_ROLE_CLAIM_PATHS', ['realm_access.roles', 'resource_access.ev-portal.roles']),
      },
      saml: {
        enabled: process.env.SECURITY_SSO_SAML_ENABLED === 'true',
        nameIdFormat: process.env.SECURITY_SSO_SAML_NAMEID_FORMAT ?? 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        requiredAttributes: readCsvEnv('SECURITY_SSO_SAML_REQUIRED_ATTRIBUTES', ['email', 'firstName', 'lastName']),
        roleAttributeNames: readCsvEnv('SECURITY_SSO_SAML_ROLE_ATTRIBUTES', ['Role', 'Groups']),
      },
    },
    scim: {
      enabled: process.env.SECURITY_SCIM_ENABLED === 'true',
      basePath: process.env.SECURITY_SCIM_BASE_PATH ?? '/admin/scim/hooks',
      dryRun: process.env.SECURITY_SCIM_DRY_RUN !== 'false',
      supportedEvents: ['user.created', 'user.updated', 'user.deactivated', 'group.membership.changed'],
    },
    tokenRotation: {
      maxAccessTokenTtlSeconds: readNumberEnv('SECURITY_ACCESS_TOKEN_MAX_TTL_SECONDS', 900),
      adminClientSecretRotationDays: rotationDays,
      signingKeyRotationDays: readNumberEnv('SECURITY_SIGNING_KEY_ROTATION_DAYS', 30),
      lastAdminSecretRotatedAt: lastRotated,
      nextRotationDueAt,
    },
    anomalyProtection: {
      maxFailedAttemptsPerWindow: readNumberEnv('SECURITY_AUTH_FAILURE_MAX_ATTEMPTS', 8),
      failureWindowSeconds: readNumberEnv('SECURITY_AUTH_FAILURE_WINDOW_SECONDS', 300),
      blockDurationSeconds: readNumberEnv('SECURITY_AUTH_BLOCK_SECONDS', 900),
      sensitiveActionBurstLimit: readNumberEnv('SECURITY_SENSITIVE_ACTION_BURST', 30),
      sensitiveActionWindowSeconds: readNumberEnv('SECURITY_SENSITIVE_ACTION_WINDOW_SECONDS', 60),
    },
  };
}
