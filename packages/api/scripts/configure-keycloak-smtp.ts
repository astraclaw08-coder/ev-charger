/**
 * One-time Keycloak SMTP configuration script.
 *
 * Configures the realm's smtpServer settings so that Keycloak can send
 * transactional emails (password reset, email verification, etc.).
 *
 * Usage:
 *   npx tsx scripts/configure-keycloak-smtp.ts
 *
 * Required env vars (from .env or environment):
 *   KEYCLOAK_BASE_URL, KEYCLOAK_REALM,
 *   KEYCLOAK_ADMIN_CLIENT_ID, KEYCLOAK_ADMIN_CLIENT_SECRET,
 *   KC_SMTP_HOST, KC_SMTP_PORT, KC_SMTP_USER, KC_SMTP_PASSWORD,
 *   KC_SMTP_FROM, KC_SMTP_FROM_DISPLAY
 *
 * Optional:
 *   KC_SMTP_REPLY_TO (default: support@lumeopower.com)
 */
import 'dotenv/config';

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

async function main() {
  const baseUrl = requireEnv('KEYCLOAK_BASE_URL').replace(/\/$/, '');
  const realm = requireEnv('KEYCLOAK_REALM');
  const clientId = requireEnv('KEYCLOAK_ADMIN_CLIENT_ID');
  const clientSecret = requireEnv('KEYCLOAK_ADMIN_CLIENT_SECRET');

  const smtpHost = requireEnv('KC_SMTP_HOST');
  const smtpPort = requireEnv('KC_SMTP_PORT');
  const smtpUser = requireEnv('KC_SMTP_USER');
  const smtpPassword = requireEnv('KC_SMTP_PASSWORD');
  const smtpFrom = requireEnv('KC_SMTP_FROM');
  const smtpFromDisplay = requireEnv('KC_SMTP_FROM_DISPLAY');
  const smtpReplyTo = process.env.KC_SMTP_REPLY_TO?.trim() || 'support@lumeopower.com';

  // 1. Obtain admin token via client credentials
  console.log(`[SMTP Config] Authenticating to ${baseUrl}/realms/${realm} ...`);
  const tokenRes = await fetch(`${baseUrl}/realms/${realm}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text().catch(() => '');
    throw new Error(`Token request failed (${tokenRes.status}): ${text}`);
  }

  const { access_token } = await tokenRes.json() as { access_token: string };
  console.log('[SMTP Config] Authenticated successfully.');

  // 2. Fetch current realm representation (to merge, not overwrite)
  console.log(`[SMTP Config] Fetching current realm config for "${realm}" ...`);
  const realmRes = await fetch(`${baseUrl}/admin/realms/${realm}`, {
    headers: { Authorization: `Bearer ${access_token}` },
  });

  if (!realmRes.ok) {
    const text = await realmRes.text().catch(() => '');
    throw new Error(`Realm GET failed (${realmRes.status}): ${text}`);
  }

  const realmData = await realmRes.json() as Record<string, unknown>;
  const currentSmtp = (realmData.smtpServer ?? {}) as Record<string, string>;
  console.log('[SMTP Config] Current smtpServer:', JSON.stringify(currentSmtp, null, 2));

  // 3. Build new SMTP config
  const newSmtp: Record<string, string> = {
    host: smtpHost,
    port: smtpPort,
    from: smtpFrom,
    fromDisplayName: smtpFromDisplay,
    replyTo: smtpReplyTo,
    replyToDisplayName: smtpFromDisplay,
    auth: 'true',
    user: smtpUser,
    password: smtpPassword,
    starttls: 'true',
    ssl: 'false',
    envelopeFrom: '',
  };

  console.log('[SMTP Config] New smtpServer config:', JSON.stringify({ ...newSmtp, password: '***' }, null, 2));

  // 4. Update realm with new SMTP settings (idempotent PUT)
  console.log(`[SMTP Config] Updating realm "${realm}" smtpServer ...`);
  const updateRes = await fetch(`${baseUrl}/admin/realms/${realm}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${access_token}`,
    },
    body: JSON.stringify({ smtpServer: newSmtp }),
  });

  if (!updateRes.ok) {
    const text = await updateRes.text().catch(() => '');
    throw new Error(`Realm update failed (${updateRes.status}): ${text}`);
  }

  console.log('[SMTP Config] ✓ SMTP configured successfully.');

  // 5. Verify by re-fetching
  const verifyRes = await fetch(`${baseUrl}/admin/realms/${realm}`, {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  const verifyData = await verifyRes.json() as Record<string, unknown>;
  const verifiedSmtp = (verifyData.smtpServer ?? {}) as Record<string, string>;
  console.log('[SMTP Config] Verified smtpServer.host:', verifiedSmtp.host);
  console.log('[SMTP Config] Verified smtpServer.from:', verifiedSmtp.from);
  console.log('[SMTP Config] Verified smtpServer.fromDisplayName:', verifiedSmtp.fromDisplayName);
  console.log('[SMTP Config] Verified smtpServer.auth:', verifiedSmtp.auth);

  if (verifiedSmtp.host !== smtpHost) {
    throw new Error('Verification failed: host mismatch after update');
  }

  console.log('\n[SMTP Config] Done. Password reset emails should now work for this realm.');
  console.log('[SMTP Config] Test with: portal → Reset Password → enter email → check inbox');
}

main().catch((err) => {
  console.error('\n[SMTP Config] FAILED:', err.message || err);
  process.exit(1);
});
