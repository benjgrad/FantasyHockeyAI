/**
 * Shared between the service worker bundle and the app bundle (they cannot import each other).
 *
 * `notificationclick` focuses an open tab and posts this message with the notification's URL,
 * so the running app routes client-side instead of reloading.
 */
export const NAVIGATE_MESSAGE = 'fha:navigate';

/**
 * The in-app path a navigate message may move to, or null to refuse it. The URL arrived in a
 * push payload over the network, so it is untrusted: only a same-origin absolute path is
 * accepted (`//host` is protocol-relative and `/\host` is treated as one by browsers).
 */
export function navigateTargetFor(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  if (!url.startsWith('/')) return null;
  if (url.startsWith('//') || url.startsWith('/\\')) return null;
  return url;
}
