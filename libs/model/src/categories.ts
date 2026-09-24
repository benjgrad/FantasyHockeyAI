import type { GoalieSeason, SkaterSeason } from '@fha/nhl';

/**
 * Yahoo category abbreviation -> NHL field (§11.3). Mapped by abbreviation, not stat id,
 * because stat ids differ by season and game.
 */
export const SKATER_CATEGORY_FIELDS = {
  G: 'goals',
  A: 'assists',
  P: 'points',
  '+/-': 'plusMinus',
  PIM: 'pim',
  PPP: 'ppp',
  SHP: 'shp',
  GWG: 'gwg',
  SOG: 'sog',
  HIT: 'hits',
  BLK: 'blocks',
  FW: 'faceoffWins',
} as const satisfies Record<string, keyof SkaterSeason>;

/** Goalie counting categories. GA is a counting stat where lower is better. */
export const GOALIE_CATEGORY_FIELDS = {
  W: 'wins',
  L: 'losses',
  GA: 'goalsAgainst',
  SV: 'saves',
  SHO: 'shutouts',
  GS: 'gs',
} as const satisfies Record<string, keyof GoalieSeason>;

/** Derived rate categories, projected from volume components rather than averaged. */
export const GOALIE_RATE_CATEGORIES = ['GAA', 'SV%'] as const;

export type SkaterCategory = keyof typeof SKATER_CATEGORY_FIELDS;
export type GoalieCategory = keyof typeof GOALIE_CATEGORY_FIELDS;

export const SKATER_CATEGORIES = Object.keys(SKATER_CATEGORY_FIELDS) as SkaterCategory[];
export const GOALIE_COUNTING_CATEGORIES = Object.keys(GOALIE_CATEGORY_FIELDS) as GoalieCategory[];

/** Categories where a lower total is better. */
const LOWER_IS_BETTER = new Set(['GAA', 'GA', 'L']);
export function lowerIsBetter(abbr: string): boolean {
  return LOWER_IS_BETTER.has(abbr);
}

export function isRateCategory(abbr: string): boolean {
  return (GOALIE_RATE_CATEGORIES as readonly string[]).includes(abbr);
}

/**
 * Every category this project knows how to produce. A league category outside this
 * set must fail loudly with its name (§11.3) rather than being silently dropped.
 */
export const SUPPORTED_CATEGORIES: ReadonlySet<string> = new Set<string>([
  ...SKATER_CATEGORIES,
  ...GOALIE_COUNTING_CATEGORIES,
  ...GOALIE_RATE_CATEGORIES,
]);

export class UnsupportedCategoryError extends Error {
  constructor(readonly abbrs: string[]) {
    super(
      `league uses categories this build cannot project: ${abbrs.join(', ')}. ` +
        `Add them to libs/model/src/categories.ts (§11.3) rather than ignoring them.`,
    );
    this.name = 'UnsupportedCategoryError';
  }
}

export function assertCategoriesSupported(abbrs: readonly string[]): void {
  const unknown = abbrs.filter((a) => !SUPPORTED_CATEGORIES.has(a));
  if (unknown.length > 0) throw new UnsupportedCategoryError(unknown);
}
