import { describe, expect, it } from 'vitest';
import { isIosDevice, shouldShowIosHint } from './iosHint';

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPAD_DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const IPHONE_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1';
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';

const env = { userAgent: IPHONE_SAFARI, maxTouchPoints: 5, standalone: false, dismissed: false };

describe('shouldShowIosHint', () => {
  it('shows in iPhone Safari, not installed, not dismissed', () => {
    expect(shouldShowIosHint(env)).toBe(true);
  });

  it('shows on an iPad that reports a Mac user agent', () => {
    expect(shouldShowIosHint({ ...env, userAgent: IPAD_DESKTOP_UA })).toBe(true);
  });

  it('hides once installed or dismissed', () => {
    expect(shouldShowIosHint({ ...env, standalone: true })).toBe(false);
    expect(shouldShowIosHint({ ...env, dismissed: true })).toBe(false);
  });

  it('hides on a real Mac, on Android, and in other iOS browsers', () => {
    expect(shouldShowIosHint({ ...env, userAgent: IPAD_DESKTOP_UA, maxTouchPoints: 0 })).toBe(
      false,
    );
    expect(shouldShowIosHint({ ...env, userAgent: ANDROID_CHROME })).toBe(false);
    expect(shouldShowIosHint({ ...env, userAgent: IPHONE_CHROME })).toBe(false);
  });
});

describe('isIosDevice', () => {
  it('recognises iOS in any browser', () => {
    expect(isIosDevice(IPHONE_CHROME, 5)).toBe(true);
    expect(isIosDevice(ANDROID_CHROME, 5)).toBe(false);
  });
});
