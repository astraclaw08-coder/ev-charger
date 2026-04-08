import crypto from 'crypto';

// ── AES-256-GCM encryption for API key storage ──────────────────────────────

function getEncryptionKey(): string | undefined {
  return process.env.LLM_KEY_ENCRYPTION_KEY;
}

export function encryptKey(plaintext: string): string {
  const encryptionKey = getEncryptionKey();
  if (!encryptionKey) return plaintext; // Dev mode: store plaintext
  const key = Buffer.from(encryptionKey, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decryptKey(ciphertext: string): string {
  const encryptionKey = getEncryptionKey();
  if (!encryptionKey) return ciphertext; // Dev mode: plaintext passthrough

  // Gracefully handle keys stored as plaintext before encryption was enabled.
  // Encrypted values are always base64 (no dashes, starts with encoded IV).
  // OpenRouter keys start with "sk-or-" — clearly not encrypted.
  if (ciphertext.startsWith('sk-')) return ciphertext;

  try {
    const key = Buffer.from(encryptionKey, 'hex');
    const buf = Buffer.from(ciphertext, 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const encrypted = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted) + decipher.final('utf8');
  } catch {
    // If decryption fails, assume it's a legacy plaintext value
    return ciphertext;
  }
}

// ── Get stored LLM config ────────────────────────────────────────────────────

export const DEFAULT_MODEL = 'anthropic/claude-sonnet-4';

export async function getLLMConfig(prisma: any, scopeKey: string): Promise<{ apiKey: string; model: string }> {
  const settings = await prisma.portalSettings.findUnique({ where: { scopeKey } });
  if (!settings?.openaiAccessToken) {
    throw new Error('AI not configured. An admin must add an OpenRouter API key in Settings → AI Assistant.');
  }
  return {
    apiKey: decryptKey(settings.openaiAccessToken),
    // Model stored in openaiConnectedEmail column (repurposed — avoids migration)
    model: settings.openaiConnectedEmail || DEFAULT_MODEL,
  };
}
