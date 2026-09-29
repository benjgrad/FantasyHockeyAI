import { api } from '../api/endpoints';

/**
 * Turning push on and off for THIS device. Every missing piece is reported, not thrown: no
 * browser support, no server keys and a refused permission each get their own message.
 *
 * iOS: Safari only grants push to a site added to the Home Screen; in a normal tab
 * `window.Notification` does not exist.
 */
export type PermissionState = 'default' | 'granted' | 'denied' | 'unsupported';

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    typeof Notification !== 'undefined'
  );
}

export function isIos(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent);
}

export function permissionState(): PermissionState {
  if (!pushSupported()) return 'unsupported';
  return Notification.permission as PermissionState;
}

/** base64url VAPID key → bytes for `applicationServerKey`. */
function decodeKey(base64url: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = window.atob((base64url + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** Registers `/sw.js`, or returns the existing registration. Idempotent. */
export async function ensureWorker(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration('/');
  if (existing) return existing;
  return navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration('/');
  return (await registration?.pushManager.getSubscription()) ?? null;
}

export type EnableResult = { ok: true } | { ok: false; message: string };

export async function enablePush(): Promise<EnableResult> {
  if (!pushSupported()) {
    return {
      ok: false,
      message: isIos()
        ? 'On iPhone and iPad, add this app to the Home Screen first (Share → Add to Home Screen), then open it from there — Safari only allows notifications for installed apps.'
        : 'This browser can’t receive push notifications.',
    };
  }
  let publicKey: string | null;
  try {
    publicKey = (await api.vapid()).publicKey;
  } catch {
    publicKey = null;
  }
  if (!publicKey) return { ok: false, message: 'The server has no push (VAPID) keys configured.' };

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return {
      ok: false,
      message:
        permission === 'denied'
          ? 'Notifications are blocked for this site. Re-allow them in the browser’s site settings.'
          : 'Notifications weren’t enabled.',
    };
  }
  try {
    const registration = await ensureWorker();
    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeKey(publicKey),
      }));
    const keys = subscription.toJSON().keys ?? {};
    await api.subscribe(subscription.endpoint, keys['p256dh'] ?? '', keys['auth'] ?? '');
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Could not register for notifications.',
    };
  }
}

/** Server first: a local unsubscribe followed by a failed server call would leave a dead row. */
export async function disablePush(): Promise<void> {
  const subscription = await currentSubscription();
  if (!subscription) return;
  await api.unsubscribe(subscription.endpoint);
  await subscription.unsubscribe();
}
