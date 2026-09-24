import { z } from 'zod';

/**
 * Consensus expert rankings with average draft position, from a public source.
 *
 * Why this exists: without Yahoo API access we have no market prior at all, and the
 * draft scarcity model would otherwise use our own ranking as a stand-in for ADP. That
 * is circular -- it assumes the rest of the league values players exactly as we do, so
 * it can never tell us where we disagree with the room, which is where draft value
 * actually comes from.
 *
 * It also supplies multi-position eligibility ("C,LW"), which the NHL API does not have.
 */
export const MarketPlayer = z.object({
  /** Consensus rank, 1-indexed. */
  rank: z.number().int().positive(),
  name: z.string().min(1),
  team: z.string().min(1),
  /** Yahoo-style eligible positions, e.g. ['C','LW']. */
  positions: z.array(z.string().min(1)).min(1),
  /** Average draft position where the source has one; absent for undrafted players. */
  adp: z.number().positive().optional(),
});
export type MarketPlayer = z.infer<typeof MarketPlayer>;

export const MarketSnapshot = z.object({
  source: z.string().min(1),
  fetchedAt: z.string(),
  players: z.array(MarketPlayer),
});
export type MarketSnapshot = z.infer<typeof MarketSnapshot>;

export class MarketParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarketParseError';
  }
}

const TAG = /<[^>]+>/g;
const ROW = /<tr[^>]*>(.*?)<\/tr>/gs;
const CELL = /<t[dh][^>]*>(.*?)<\/t[dh]>/gs;

function unescapeHtml(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)));
}

function cells(rowHtml: string): string[] {
  return [...rowHtml.matchAll(CELL)].map((m) =>
    unescapeHtml((m[1] ?? '').replace(TAG, ' '))
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

/** A dash, en dash or empty cell all mean "no ADP", not zero. */
function parseAdp(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/[–—-]/g, '').trim();
  if (cleaned === '') return undefined;
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Parse a consensus ranking table.
 *
 * Column positions are resolved from the header rather than assumed, so a source
 * inserting a column does not silently shift every field. A table without the columns
 * we need throws instead of yielding rows full of zeroes (anti-pattern 11).
 */
export function parseConsensusTable(html: string, source: string): MarketSnapshot {
  const rows = [...html.matchAll(ROW)].map((m) => cells(m[1] ?? ''));
  if (rows.length === 0) throw new MarketParseError('no table rows found');

  const header = rows.find(
    (r) => r.some((c) => /^rank$/i.test(c)) && r.some((c) => /player/i.test(c)),
  );
  if (!header) throw new MarketParseError('no header row with Rank and Player columns');

  const idx = (want: RegExp): number => header.findIndex((c) => want.test(c));
  const iRank = idx(/^rank$/i);
  const iName = idx(/^player$/i);
  const iTeam = idx(/^team$/i);
  const iPos = idx(/^pos/i);
  const iAdp = idx(/^adp$/i);
  for (const [label, i] of [
    ['Rank', iRank],
    ['Player', iName],
    ['Team', iTeam],
    ['Pos', iPos],
  ] as const) {
    if (i < 0) throw new MarketParseError(`missing required column: ${label}`);
  }

  const players: MarketPlayer[] = [];
  for (const row of rows) {
    if (row === header) continue;
    const rank = Number.parseInt(row[iRank] ?? '', 10);
    const name = row[iName] ?? '';
    if (!Number.isInteger(rank) || rank < 1 || name === '') continue;
    const positions = (row[iPos] ?? '')
      .split(/[,/]/)
      .map((p) => p.trim().toUpperCase())
      .filter((p) => p.length > 0);
    if (positions.length === 0) continue;

    const adp = iAdp >= 0 ? parseAdp(row[iAdp]) : undefined;
    players.push({
      rank,
      name,
      team: (row[iTeam] ?? 'UNK').toUpperCase(),
      positions,
      ...(adp === undefined ? {} : { adp }),
    });
  }

  if (players.length === 0) throw new MarketParseError('header parsed but no player rows matched');
  return { source, fetchedAt: new Date().toISOString(), players };
}
