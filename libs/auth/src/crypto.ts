import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { deriveKey } from './keys.js';

/**
 * Encryption at rest for stored third-party credentials: the Yahoo session cookies that a
 * user pastes on the settings page, which grant full access to their Yahoo account.
 *
 * Ported from personal-os `packages/core/src/crypto.ts`: AES-256-GCM, returning one
 * self-contained string `base64url(iv || authTag || ciphertext)`. GCM authenticates, so a
 * tampered or truncated value fails to decrypt rather than yielding garbage.
 */
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export function encrypt(root: string, plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(root, 'credential-encryption'), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

/** Throws on a wrong key or any tampering. Callers treat that as "reconnect Yahoo". */
export function decrypt(root: string, encoded: string): string {
  const raw = Buffer.from(encoded, 'base64url');
  if (raw.length < IV_LENGTH + TAG_LENGTH) throw new Error('ciphertext too short');
  const iv = raw.subarray(0, IV_LENGTH);
  const tag = raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(root, 'credential-encryption'), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
