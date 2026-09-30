import { describe, expect, it } from 'vitest';
import { chatHref, isChatPath } from './lastConversation';

describe('Chat tab target', () => {
  it('returns to the last conversation, or a new chat when there is none', () => {
    expect(chatHref('abc-123')).toBe('/c/abc-123');
    expect(chatHref(null)).toBe('/');
    expect(chatHref('')).toBe('/');
  });

  it('is current on a new chat and on any conversation, not elsewhere', () => {
    expect(isChatPath('/')).toBe(true);
    expect(isChatPath('/c/abc')).toBe(true);
    expect(isChatPath('/players')).toBe(false);
  });
});
