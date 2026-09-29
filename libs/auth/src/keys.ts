import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * One root secret (`FHA_SECRET_KEY`), many derived keys.
 *
 * Ported from personal-os, which derives its session, OAuth-state and encryption keys from a
 * single root by HMAC with a distinct label each. The labels give domain separation: a session
 * cookie can never verify as an OAuth state token, and neither key can decrypt a stored Yahoo
 * credential. There is one secret to generate and rotate, not four.
 *
 * The root is passed in rather than read from the environment here, so tests never depend on
 * process state and the web server decides once, at startup, what is configured.
 */
export type KeyLabel = 'session' | 'oauth-state' | 'credential-encryption';

export class AuthConfigError extends Error {}

/** A 32-byte-or-longer root, as `openssl rand -base64 48` produces. */
export function checkRoot(root: string | undefined): string {
  if (root === undefined || root.length < 32) {
    throw new AuthConfigError(
      'FHA_SECRET_KEY must be set to at least 32 characters (generate: openssl rand -base64 48)',
    );
  }
  return root;
}

export function deriveKey(root: string, label: KeyLabel): Buffer {
  return createHmac('sha256', checkRoot(root)).update(`fantasy-hockey-ai/${label}`).digest();
}

export function hmac(key: Buffer, payload: string): string {
  return createHmac('sha256', key).update(payload).digest('base64url');
}

/**
 * Constant-time compare that does not leak length. `timingSafeEqual` throws on unequal
 * lengths, which would itself be an oracle, so those are rejected first.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
