import type { PlayerListRow, ValueNowView } from '@fha/api';
import type { Store } from '@fha/store';
import { valueNow, valueTrend, weekChanges, type LeagueView, type ValueNow } from '@fha/tools';

/**
 * The mid-season value family (D-026) for the cards and the list. Built in `@fha/tools` (the
 * same numbers the agents read); here only shaped for the API. A failure leaves the field null
 * and the page keeps working on the preseason numbers (P9).
 */
const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

function safe(view: LeagueView, store: Store | undefined): ValueNow | undefined {
  if (store === undefined) return undefined;
  try {
    return valueNow(view, store);
  } catch {
    return undefined;
  }
}

export function valueNowView(
  view: LeagueView,
  store: Store | undefined,
  key: string,
): ValueNowView | null {
  const now = safe(view, store);
  const v = now?.players.get(key);
  if (now === undefined || v === undefined || store === undefined) return null;
  let trend: ValueNowView['trend'] = null;
  try {
    const t = valueTrend(view, store, key);
    if (t !== undefined) {
      trend = {
        sincePreseason: t.sincePreseason === undefined ? null : r2(t.sincePreseason),
        since7d: t.since7d === undefined ? null : r2(t.since7d),
        sinceYesterday: t.sinceYesterday === undefined ? null : r2(t.sinceYesterday),
        series: t.series.map((x) => ({ date: x.date, vols: r2(x.vols) })),
      };
    }
  } catch {
    trend = null;
  }
  return {
    lens: now.lens,
    value: r2(v.value),
    vols: r2(v.vols),
    adjusted: r2(v.adjusted),
    perGameValue: r3(v.perGameValue),
    vofa: r2(v.vofa),
    vofaPosition: v.vofaPosition ?? null,
    vofaAgainst: v.vofaAgainst ?? null,
    cwa: v.cwa === undefined ? null : r3(v.cwa),
    cwaByCategory: Object.fromEntries(Object.entries(v.cwaByCategory).map(([c, x]) => [c, r3(x)])),
    cwaSwap: v.cwaSwap ?? null,
    weekCwa: v.weekCwa === undefined ? null : r3(v.weekCwa),
    gpCurrent: v.gpCurrent,
    weightCurrent: r2(v.weightCurrent),
    lowConfidence: v.lowConfidence,
    luck:
      v.luck === undefined
        ? null
        : {
            stat: v.luck.stat,
            recent: r3(v.luck.recent),
            baseline: r3(v.luck.baseline),
            z: r2(v.luck.z),
            games: v.luck.games,
            label: v.luck.label,
          },
    trend,
  };
}

/** The list's compact rest-of-season columns for every player, built once per request. */
export function listNow(
  view: LeagueView,
  store: Store | undefined,
): (key: string) => PlayerListRow['now'] {
  const now = safe(view, store);
  if (now === undefined || store === undefined) return () => null;
  let d7: Map<string, number> = new Map();
  try {
    d7 = weekChanges(view, store);
  } catch {
    d7 = new Map();
  }
  return (key) => {
    const v = now.players.get(key);
    if (v === undefined) return null;
    const d = d7.get(key);
    return {
      vols: r2(v.vols),
      vofa: r2(v.vofa),
      cwa: v.cwa === undefined ? null : r3(v.cwa),
      weekCwa: v.weekCwa === undefined ? null : r3(v.weekCwa),
      delta7d: d === undefined ? null : r2(d),
      luck: v.luck?.label ?? null,
      lowConfidence: v.lowConfidence,
    };
  };
}
