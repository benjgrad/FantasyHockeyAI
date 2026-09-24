/**
 * Full-draft rehearsal. Not shipped: it exercises the real model code end to end so we
 * find out tonight's failure modes before 21:00 rather than during.
 *
 * Other teams pick by market ADP (with noise), we pick by our own board score.
 */
import { loadLeague } from '../apps/gm/src/config.js';
import { buildRanking } from '../apps/gm/src/commands/rank.js';
import {
  pickNumbersFor,
  positionRuns,
  scoreBoard,
  eligibleSlots,
  nhlPositionOf,
  type DraftPick,
} from '@fha/model';
import type { Valuation } from '@fha/core';

const SEAT = Number(process.argv[2] ?? 4);

const { settings, rounds = 17 } = loadLeague();
const { valuations } = buildRanking();
const numTeams = settings.numTeams;
const ourPicks = new Set(pickNumbersFor(SEAT, numTeams, rounds));
const total = numTeams * rounds;

const SCORED = settings.categories.filter((c) => !c.isDisplayOnly).map((c) => c.abbr);
const BALANCE = process.argv[3] !== 'off';
const adpOf = (v: Valuation): number => v.adp ?? v.marketRank ?? 400;
const taken = new Set<number>();
const picks: DraftPick[] = [];
const myRoster: Valuation[] = [];

// Deterministic noise so the rehearsal is repeatable.
let seed = 12345;
const rnd = (): number => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

function slotsOpen(roster: readonly Valuation[]): string[] {
  const out: string[] = [];
  for (const s of settings.rosterSlots) {
    if (!s.isStarting) continue;
    const filled = roster.filter((r) =>
      eligibleSlots(nhlPositionOf(r.position), settings.rosterSlots, r.eligible ?? []).includes(
        s.position,
      ),
    ).length;
    for (let i = filled; i < s.count; i++) out.push(s.position);
  }
  return out;
}

for (let pick = 1; pick <= total; pick++) {
  const available = valuations.filter((v) => !taken.has(v.nhlId));
  if (available.length === 0) break;
  let chosen: Valuation | undefined;

  if (ourPicks.has(pick)) {
    const next = [...ourPicks].find((p) => p > pick);
    const board = scoreBoard({
      available,
      myRoster,
      settings,
      ...(next === undefined ? {} : { nextPick: next }),
      ...(BALANCE ? { categories: SCORED } : {}),
      picksRemaining: [...ourPicks].filter((p) => p >= pick).length,
      adpOf,
    });
    chosen = board[0]?.valuation;
    if (chosen) {
      myRoster.push(chosen);
      const runs = positionRuns(picks);
      console.log(
        `  R${String(Math.ceil(pick / numTeams)).padStart(2)} pick ${String(pick).padStart(3)}  OURS  ` +
          `${chosen.name.padEnd(22)} ${chosen.position.padEnd(3)} vorp ${chosen.vorp.toFixed(1).padStart(5)}` +
          (chosen.lowConfidence ? '  *thin' : '') +
          (runs.length ? `   [run: ${runs.map((r) => `${r.count}x${r.position}`).join(',')}]` : ''),
      );
    }
  } else {
    // Other teams draft near ADP: sample from the top few by ADP.
    const byAdp = [...available].sort((a, b) => adpOf(a) - adpOf(b));
    const window = byAdp.slice(0, 5);
    chosen = window[Math.floor(rnd() * window.length)] ?? byAdp[0];
  }
  if (!chosen) break;
  taken.add(chosen.nhlId);
  picks.push({
    pick,
    nhlId: chosen.nhlId,
    name: chosen.name,
    position: chosen.position,
    mine: ourPicks.has(pick),
  });
}

console.log(`\n=== our roster from seat ${SEAT} (${myRoster.length} players) ===`);
const byPos = new Map<string, Valuation[]>();
for (const v of myRoster) byPos.set(v.position, [...(byPos.get(v.position) ?? []), v]);
for (const pos of ['C', 'LW', 'RW', 'D', 'G']) {
  const l = byPos.get(pos) ?? [];
  console.log(`  ${pos.padEnd(3)} ${l.length}  ${l.map((v) => v.name).join(', ')}`);
}
console.log(`\nunfilled starting slots: ${slotsOpen(myRoster).join(', ') || 'none'}`);

const cats = SCORED;
const totalZ = new Map<string, number>();
for (const v of myRoster) for (const c of cats) totalZ.set(c, (totalZ.get(c) ?? 0) + (v.z[c] ?? 0));
console.log('\nprojected category strength (sum of z across our roster):');
for (const [c, z] of [...totalZ].sort((a, b) => b[1] - a[1])) {
  const bar = '#'.repeat(Math.max(0, Math.round(Math.abs(z))));
  console.log(`  ${c.padEnd(5)} ${z >= 0 ? '+' : '-'}${Math.abs(z).toFixed(1).padStart(5)} ${bar}`);
}
