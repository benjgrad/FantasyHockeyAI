import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from './Markdown';
import { isNumericText, numericColumns } from './numeric';
import { safeUrl } from './safeUrl';
import { closeOpenMarkers } from './streaming';

describe('safeUrl', () => {
  it('allows http(s) and relative URLs', () => {
    expect(safeUrl('https://www.nhl.com/player/8478402')).toBe(
      'https://www.nhl.com/player/8478402',
    );
    expect(safeUrl('HTTP://example.com')).toBe('HTTP://example.com');
    expect(safeUrl('/players?q=mcdavid')).toBe('/players?q=mcdavid');
    expect(safeUrl('#top')).toBe('#top');
    expect(safeUrl('team')).toBe('team');
    expect(safeUrl('//cdn.example.com/x')).toBe('//cdn.example.com/x');
  });

  it('rejects every other scheme, however it is disguised', () => {
    for (const url of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      ' javascript:alert(1)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      '\u0001javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox',
      'file:///etc/passwd',
      'mailto:ben@example.com',
      '',
      '   ',
    ]) {
      expect(safeUrl(url), url).toBeNull();
    }
  });
});

describe('closeOpenMarkers', () => {
  it('leaves balanced text alone', () => {
    for (const text of ['plain', '**bold** and `code`', '```\nx\n```', 'a\n\n**b**'])
      expect(closeOpenMarkers(text)).toBe(text);
  });

  it('closes a dangling bold', () => {
    expect(closeOpenMarkers('Start **McDavid')).toBe('Start **McDavid**');
    expect(closeOpenMarkers('Start **McDavid ')).toBe('Start **McDavid**');
  });

  it('drops a bold opener with nothing after it yet', () => {
    expect(closeOpenMarkers('Start **')).toBe('Start ');
  });

  it('closes inline code, inside bold first', () => {
    expect(closeOpenMarkers('run `npm')).toBe('run `npm`');
    expect(closeOpenMarkers('**see `x')).toBe('**see `x`**');
  });

  it('ignores asterisks inside code spans and escapes', () => {
    expect(closeOpenMarkers('`a**b` done')).toBe('`a**b` done');
    expect(closeOpenMarkers('2 \\** 3')).toBe('2 \\** 3');
  });

  it('only looks at the last paragraph', () => {
    expect(closeOpenMarkers('**odd\n\nnext **bold')).toBe('**odd\n\nnext **bold**');
  });

  it('closes an open code fence', () => {
    expect(closeOpenMarkers('Here:\n```ts\nconst a = 1;')).toBe('Here:\n```ts\nconst a = 1;\n```');
    expect(closeOpenMarkers('```\n**x\n')).toBe('```\n**x\n```');
  });
});

describe('numeric cells', () => {
  it('recognises stat values', () => {
    for (const t of ['12', '-3', '+1.5', '.915', '45%', '2,310', '1-2-0', '−4', ' 7 '])
      expect(isNumericText(t), t).toBe(true);
    for (const t of ['', 'C', 'McDavid', '12 G', 'EDM', '—', '1.2.3', '2025-26x'])
      expect(isNumericText(t), t).toBe(false);
  });

  it('marks a column numeric when every non-blank cell is a number', () => {
    expect(
      numericColumns([
        ['McDavid', '12', '—'],
        ['Draisaitl', '9', '—'],
        ['Hyman', '', '3'],
      ]),
    ).toEqual([false, true, true]);
    expect(
      numericColumns([
        ['a', '1'],
        ['b', 'n/a'],
      ]),
    ).toEqual([false, false]);
    expect(numericColumns([])).toEqual([]);
  });
});

describe('Markdown', () => {
  const render = (text: string, streaming = false) =>
    renderToStaticMarkup(createElement(Markdown, { text, streaming }));

  it('renders bold and emphasis', () => {
    const html = render('this is **an example** and *this*');
    expect(html).toContain('<strong class="font-semibold text-ink">an example</strong>');
    expect(html).toContain('<em class="italic">this</em>');
  });

  it('renders a GFM table with numeric columns right-aligned', () => {
    const html = render('| Player | G |\n|---|---|\n| McDavid | 12 |\n| Hyman | 7 |');
    expect(html).toContain('scroll-x');
    expect(html).toContain('<th>Player</th>');
    expect(html).toContain('<th data-num="">G</th>');
    expect(html).toContain('<td data-num="">12</td>');
    expect(html).toContain('<td>McDavid</td>');
  });

  it('never renders raw HTML', () => {
    const html = render('hi <script>alert(1)</script> <img src=x onerror=alert(1)>\n\n<b>x</b>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
  });

  it('renders a javascript: link inert and a web link in a new tab', () => {
    const bad = render('[click](javascript:alert(1))');
    expect(bad).not.toContain('href');
    expect(bad).not.toContain('javascript');
    expect(bad).toContain('<span>click</span>');
    const good = render('[NHL](https://www.nhl.com)');
    expect(good).toContain('href="https://www.nhl.com"');
    expect(good).toContain('target="_blank"');
    expect(good).toContain('rel="noopener noreferrer"');
  });

  it('shows an image as its alt text without loading it', () => {
    const html = render('![chart](https://evil.example/track.png)');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('evil.example');
    expect(html).toContain('[chart]');
  });

  it('closes a dangling bold only while streaming', () => {
    expect(render('go **big', true)).toContain('<strong');
    expect(render('go **big')).not.toContain('<strong');
  });
});
