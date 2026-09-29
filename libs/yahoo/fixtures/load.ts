import { readFileSync } from 'node:fs';

/** Recorded from league 477.l.48535 on 2026-09-29, personal identifiers redacted. */
export function fx(name: string): { path: string; body: unknown } {
  const url = new URL(`./${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as { path: string; body: unknown };
}
