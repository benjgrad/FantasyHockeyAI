import { describe, expect, it } from 'vitest';
import { YahooAuthError, YahooFormError } from '../errors.js';
import { checkPage } from './site.js';

const redirect = (location: string) => new Response(null, { status: 307, headers: { location } });

describe('checkPage: where Yahoo sends a page', () => {
  it("treats Yahoo's consent screen as needing Ben, not as Yahoo being down (2026-10-17)", async () => {
    const err = await checkPage(
      redirect('https://guce.yahoo.com/consent?brandType=nonEu&gcrumb=x&done=y'),
      'team page',
      '/hockey/1/2',
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(YahooAuthError);
    expect((err as YahooAuthError).reason).toBe('consent');
    expect((err as Error).message).toMatch(/accept it, then reconnect/);
  });

  it('a sign-in redirect is an expired session; any other redirect a form error', async () => {
    const signIn = await checkPage(
      redirect('https://login.yahoo.com/?.src=fantasy'),
      'p',
      '/',
    ).catch((e: unknown) => e);
    expect((signIn as YahooAuthError).reason).toBe('session');
    await expect(checkPage(redirect('https://example.com/x'), 'p', '/')).rejects.toBeInstanceOf(
      YahooFormError,
    );
  });
});
