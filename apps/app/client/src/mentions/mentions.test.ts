import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { Markdown } from '../markdown/Markdown';
import { MatcherProvider } from './context';
import { buildMatcher } from './match';
import { LinkedText, parseMention } from './Mention';

const matcher = buildMatcher({
  players: [{ playerKey: '465.p.6743', name: 'Connor McDavid' }],
  teams: [{ teamKey: '465.l.1.t.3', name: 'Drunk Dahlin' }],
});
const render = (el: ReturnType<typeof h>) =>
  renderToStaticMarkup(h(MemoryRouter, null, h(MatcherProvider, { value: matcher }, el)));

describe('chat mentions', () => {
  it('turns names in model Markdown into sheet links, but not inside code or links', () => {
    const html = render(
      h(Markdown, {
        text: '**Connor McDavid** vs Drunk Dahlin. `Connor McDavid` [Connor McDavid](https://x.y)',
      }),
    );
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html).toContain('<strong class="font-semibold text-ink"><button');
    expect(html).toContain('<code class="md-code font-mono">Connor McDavid</code>');
    expect(html).toContain('>Connor McDavid</a>');
  });

  it('links names in table cells', () => {
    const html = render(h(Markdown, { text: '| Player | G |\n|---|---|\n| Connor McDavid | 2 |' }));
    expect(html).toMatch(/<td[^>]*><button[^>]*>Connor McDavid<\/button><\/td>/);
  });

  it('links names in Ben’s own plain-text messages', () => {
    const html = render(h(LinkedText, { text: 'Should I trade McDavid to Drunk Dahlin?' }));
    expect(html.match(/<button/g)).toHaveLength(2);
  });

  it('renders plain text with no matcher (names not loaded)', () => {
    const html = renderToStaticMarkup(
      h(MemoryRouter, null, h(Markdown, { text: 'Connor McDavid' })),
    );
    expect(html).not.toContain('<button');
  });

  it('parses only well-formed mention attributes', () => {
    expect(parseMention('player:465.p.1')).toEqual({ kind: 'player', key: '465.p.1' });
    expect(parseMention('team:465.l.1.t.3')).toEqual({ kind: 'team', key: '465.l.1.t.3' });
    for (const bad of ['player:', ':x', 'coach:x', 'x', undefined, 3]) {
      expect(parseMention(bad)).toBeUndefined();
    }
  });
});
