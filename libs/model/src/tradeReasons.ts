import type { TradeEvaluation } from './trade.js';

const signed = (x: number): string => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)}`;

/** Plain-language reasons for a trade evaluation, built only from its computed numbers. */
export function tradeReasons(
  e: TradeEvaluation,
  usBefore: Readonly<Record<string, number>>,
  ctx: {
    name: (id: number) => string;
    fieldSize: number;
    /** Share of the remaining season each traded player is expected to play. */
    availability: readonly { id: number; share: number }[];
  },
): string[] {
  const { name, fieldSize } = ctx;
  const out = [
    `Us ${signed(e.deltaUs)} expected categories/week ` +
      `(${e.expectedWon.usBefore.toFixed(2)} → ${e.expectedWon.usAfter.toFixed(2)}); ` +
      `partner ${signed(e.deltaThem)}.`,
  ];
  const moved = e.byCategory.filter((c) => Math.abs(c.us) >= 0.01).sort((x, y) => y.us - x.us);
  for (const [label, cats] of [
    ['Gains', moved.filter((c) => c.us > 0)],
    ['Costs', moved.filter((c) => c.us < 0).reverse()],
  ] as const) {
    if (cats.length > 0)
      out.push(`${label}: ${cats.map((c) => `${c.category} ${signed(c.us)}`).join(', ')}.`);
  }
  if (e.summedZ > 0 && e.deltaUs < 0) {
    const wasted = e.byCategory
      .filter((c) => (usBefore[c.category] ?? 0) > 0.9 && c.ourWeeklyAfter > c.ourWeeklyBefore)
      .map((c) => c.category);
    out.push(
      `Adds ${signed(e.summedZ)} summed z but loses expected categories: ` +
        (wasted.length > 0
          ? `the extra strength lands in categories already won (${wasted.join(', ')}).`
          : 'the strength arrives where it does not change who wins.'),
    );
  }
  if (!e.partnerGains) {
    out.push(
      `Partner loses ${Math.abs(e.deltaThem).toFixed(2)} categories/week: unlikely to accept.`,
    );
  }
  if (e.ourSignings.length > 0)
    out.push(`Frees a spot for us: signs ${e.ourSignings.map(name).join(', ')}.`);
  if (e.ourReleases.length > 0) out.push(`We must release ${e.ourReleases.map(name).join(', ')}.`);
  for (const { id, share } of ctx.availability) {
    if (share < 1) {
      out.push(
        `${name(id)} is expected to play ${String(Math.round(share * 100))}% of the remaining season; valued accordingly.`,
      );
    }
  }
  if (fieldSize === 0) {
    out.push('No league field supplied: evaluated against the partner alone.');
  }
  return out;
}
