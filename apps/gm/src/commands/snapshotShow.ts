import type { LeagueSnapshot } from '@fha/core';

/**
 * Our roster from a snapshot, one line per player: slot, name, team, positions, Yahoo status,
 * games this snapshot week, value, and the newest news line.
 */
const SLOT_ORDER = ['C', 'LW', 'RW', 'D', 'Util', 'G', 'BN', 'IR', 'IR+', 'NA'];

export function formatRoster(s: LeagueSnapshot, teamKey = s.teamKey): string[] {
  const players = new Map(s.players.map((p) => [p.playerKey, p]));
  const games = new Map<string, number>();
  for (const d of s.schedule) {
    for (const g of d.games) {
      games.set(g.home, (games.get(g.home) ?? 0) + 1);
      games.set(g.away, (games.get(g.away) ?? 0) + 1);
    }
  }
  const team = s.teams.find((t) => t.teamKey === teamKey);
  const entries = [...(s.rosters[teamKey] ?? [])].sort((a, b) => rank(a.slot) - rank(b.slot));
  const lines = [
    `${team?.name ?? teamKey} · ${s.date} · week ${s.week} · source ${s.source} · recorded ${s.recordedAt}`,
    `  ${'slot'.padEnd(5)}${'player'.padEnd(24)}${'tm'.padEnd(5)}${'pos'.padEnd(10)}${'status'.padEnd(8)}${'gms'.padStart(4)}${'value'.padStart(8)}  news`,
  ];
  for (const e of entries) {
    const p = players.get(e.playerKey);
    const v = s.valuations[e.playerKey];
    const news = s.news[e.playerKey] ?? [];
    lines.push(
      `  ${e.slot.padEnd(5)}${(p?.name ?? e.playerKey).slice(0, 23).padEnd(24)}` +
        `${(p?.nhlTeam ?? '').padEnd(5)}${(p?.eligible.filter((x) => x !== 'Util').join('/') ?? '').padEnd(10)}` +
        `${(p?.status ?? '-').padEnd(8)}${String(games.get(p?.nhlTeam ?? '') ?? 0).padStart(4)}` +
        `${(v === undefined ? 'n/a' : v.value.toFixed(2)).padStart(8)}  ${news.join(' | ').slice(0, 160)}`,
    );
  }
  return lines;
}

function rank(slot: string): number {
  const i = SLOT_ORDER.indexOf(slot);
  return i === -1 ? SLOT_ORDER.length : i;
}
