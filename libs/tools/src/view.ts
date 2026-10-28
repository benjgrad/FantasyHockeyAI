import { readFileSync } from 'node:fs';
import {
  LeagueSnapshot,
  type LeagueReader,
  type LeagueSettings,
  type LeagueTeam,
  type Player,
  type PlayerQuery,
  type Roster,
  type SnapshotProjection,
  type SnapshotValuation,
  type TeamKey,
  type Transaction,
} from '@fha/core';
import { weekBounds } from './derive.js';

/**
 * How current the view's data is (4b). The league service sets it when it builds the view and
 * marks it stale when a rebuild fails and this older snapshot is served instead (P9); a view
 * read from a file starts from the snapshot's own `recordedAt`.
 */
export interface ViewFreshness {
  /** ISO instant the snapshot was read from Yahoo. */
  builtAt: string;
  /** The last NHL game date in the stats store when the view was built (D-025). */
  statsThrough?: string;
  /** Set when the latest rebuild failed and this older snapshot is what remains. */
  stale?: { failedAt: string; reason: string };
}

/**
 * The league as tools see it: one immutable snapshot plus indexes over it.
 *
 * Every playerKey a tool hands the model comes from here, and every key the model sends back
 * is resolved here before use (P3). A key that is not in the index is refused with an error
 * telling the model what to call instead. It is never guessed at.
 */
export class LeagueView {
  private readonly byKey: Map<string, Player>;
  private readonly owner: Map<string, TeamKey>;
  /** Mutable on purpose: only the league service writes it (see {@link ViewFreshness}). */
  freshness: ViewFreshness;

  constructor(
    readonly snap: LeagueSnapshot,
    readonly settings: LeagueSettings,
  ) {
    this.byKey = new Map(snap.players.map((p) => [p.playerKey, p]));
    this.owner = new Map();
    this.freshness = { builtAt: snap.recordedAt };
    for (const [teamKey, entries] of Object.entries(snap.rosters)) {
      for (const e of entries) this.owner.set(e.playerKey, teamKey);
    }
  }

  static fromFile(path: string, settings: LeagueSettings): LeagueView {
    return new LeagueView(LeagueSnapshot.parse(JSON.parse(readFileSync(path, 'utf-8'))), settings);
  }

  get teamKey(): TeamKey {
    return this.snap.teamKey;
  }

  player(key: string): Player | undefined {
    return this.byKey.get(key);
  }

  valuation(key: string): SnapshotValuation | undefined {
    return this.snap.valuations[key];
  }

  projection(key: string): SnapshotProjection | undefined {
    return this.snap.projections[key];
  }

  ownerOf(key: string): TeamKey | undefined {
    return this.owner.get(key);
  }

  /** Not on any roster: a free agent or a player on waivers (see {@link onWaivers}). */
  isFreeAgent(key: string): boolean {
    return this.byKey.has(key) && !this.owner.has(key);
  }

  /** On waivers: adding him is a claim, and he clears on `player.waiverDate` (D-029). */
  onWaivers(key: string): boolean {
    return this.isFreeAgent(key) && this.byKey.get(key)?.onWaivers === true;
  }

  /** A team's place in the rolling waiver order (1 = first); undefined when Yahoo's was not read. */
  waiverPriority(teamKey: TeamKey = this.teamKey): number | undefined {
    return this.snap.teams.find((t) => t.teamKey === teamKey)?.waiverPriority;
  }

  /** Waiver claims a team has filed in Yahoo that have not processed yet. */
  pendingClaims(teamKey: TeamKey = this.teamKey): Transaction[] {
    return (this.snap.transactions as Transaction[]).filter(
      (t) =>
        t.type === 'waiver' &&
        t.teamKey === teamKey &&
        (t.status === undefined || t.status === 'pending'),
    );
  }

  /** Our pending Yahoo claim to add this player, if one is filed. */
  claimFiledFor(add: string): Transaction | undefined {
    return this.pendingClaims().find((t) =>
      t.players.some((p) => p.playerKey === add && p.toTeamKey === this.teamKey),
    );
  }

  /**
   * The fantasy week around `date`: Yahoo's own dates when the snapshot's scoreboard covers it
   * (week 1 ran Tue 9/29–Sun 10/4), else Monday–Sunday (D-029).
   */
  weekOf(date: string = this.snap.date): { start: string; end: string } {
    const m = this.snap.matchup;
    if (m !== undefined && m.weekStart <= date && date <= m.weekEnd) {
      return { start: m.weekStart, end: m.weekEnd };
    }
    return weekBounds(date);
  }

  roster(teamKey: TeamKey = this.teamKey): Roster {
    const entries = (this.snap.rosters[teamKey] ?? []).flatMap((e) => {
      const player = this.byKey.get(e.playerKey);
      return player === undefined ? [] : [{ player, slot: e.slot }];
    });
    return { teamKey, date: this.snap.date, entries };
  }

  /** Resolve a team by its display name, case-insensitively. Our own team is excluded (P8). */
  teamByName(name: string): LeagueTeam | undefined {
    const n = name.trim().toLowerCase();
    return this.snap.teams.find((t) => t.teamKey !== this.teamKey && t.name.toLowerCase() === n);
  }

  otherTeams(): LeagueTeam[] {
    return this.snap.teams.filter((t) => t.teamKey !== this.teamKey);
  }

  /** The game an NHL team plays on a date, if any. */
  gameOn(date: string, nhlTeam: string): { opponent: string; startTimeUtc: string } | undefined {
    const day = this.snap.schedule.find((d) => d.date === date);
    const g = day?.games.find((x) => x.home === nhlTeam || x.away === nhlTeam);
    if (g === undefined) return undefined;
    return { opponent: g.home === nhlTeam ? g.away : g.home, startTimeUtc: g.startTimeUtc };
  }

  /** Games per NHL team from `from` to `to` inclusive. */
  gamesBetween(from: string, to: string): Map<string, number> {
    const counts = new Map<string, number>();
    for (const d of this.snap.schedule) {
      if (d.date < from || d.date > to) continue;
      for (const g of d.games) {
        counts.set(g.home, (counts.get(g.home) ?? 0) + 1);
        counts.set(g.away, (counts.get(g.away) ?? 0) + 1);
      }
    }
    return counts;
  }

  /**
   * Games per team through `to` that start after `instant`: what is still to be played. Games
   * already started (finished or live) are in the scoreboard's banked totals instead.
   */
  gamesNotStarted(instant: string, to: string): Map<string, number> {
    const counts = new Map<string, number>();
    for (const d of this.snap.schedule) {
      if (d.date > to) continue;
      for (const g of d.games) {
        if (g.startTimeUtc <= instant) continue;
        counts.set(g.home, (counts.get(g.home) ?? 0) + 1);
        counts.set(g.away, (counts.get(g.away) ?? 0) + 1);
      }
    }
    return counts;
  }

  pendingTradesForUs(): Transaction[] {
    return this.snap.transactions.filter(
      (t) => t.type === 'pending_trade' && (t.tradeeTeamKey === this.teamKey || t.teamKey === this.teamKey),
    ) as Transaction[];
  }
}

/** `LeagueReader` over a snapshot, for dry runs and evals. It never touches the network. */
export class SnapshotReader implements LeagueReader {
  constructor(private readonly view: LeagueView) {}

  settings(): Promise<LeagueSettings> {
    return Promise.resolve(this.view.settings);
  }

  teams(): Promise<LeagueTeam[]> {
    return Promise.resolve(this.view.snap.teams);
  }

  roster(teamKey: TeamKey): Promise<Roster> {
    return Promise.resolve(this.view.roster(teamKey));
  }

  players(q: PlayerQuery): Promise<Player[]> {
    const search = q.search?.toLowerCase();
    const rows = this.view.snap.players.filter((p) => {
      if (q.status === 'FA' && !this.view.isFreeAgent(p.playerKey)) return false;
      if (q.status === 'W' && !this.view.onWaivers(p.playerKey)) return false;
      if (q.position !== undefined && !p.eligible.includes(q.position)) return false;
      return search === undefined || p.name.toLowerCase().includes(search);
    });
    return Promise.resolve(rows.slice(0, q.limit ?? rows.length));
  }

  transactions(q: { type?: Transaction['type']; teamKey?: TeamKey }): Promise<Transaction[]> {
    return Promise.resolve(
      (this.view.snap.transactions as Transaction[]).filter(
        (t) =>
          (q.type === undefined || t.type === q.type) &&
          (q.teamKey === undefined || t.teamKey === q.teamKey || t.tradeeTeamKey === q.teamKey),
      ),
    );
  }
}
