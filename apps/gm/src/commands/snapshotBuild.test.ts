import { describe, expect, it, vi } from 'vitest';
import { LeagueSnapshot, type LeagueSettings, type Player } from '@fha/core';
import type { PlayerDetail, YahooPlayer, YahooPlayerQuery } from '@fha/yahoo';
import { buildLiveSnapshot, newsLines, type LiveLeagueSource } from './snapshotBuild.js';
import { formatRoster } from './snapshotShow.js';
import { valueLivePlayers } from './snapshotValue.js';

const L = '477.l.1';
const US = `${L}.t.1`;
const THEM = `${L}.t.2`;

const player = (id: number, name: string, extra: Partial<Player> = {}): Player => ({
  playerKey: `477.p.${id}`,
  name,
  nhlTeam: 'TB',
  eligible: ['C', 'Util'],
  positionType: 'P',
  ...extra,
});
const detail = (key: string, extra: Partial<PlayerDetail> = {}): PlayerDetail => ({
  playerKey: key,
  onDisabledList: false,
  reserveEligible: [],
  hasRecentNotes: false,
  notes: [],
  undroppable: false,
  ...extra,
});
const yp = (p: Player, d: Partial<PlayerDetail> = {}): YahooPlayer => ({
  player: p,
  detail: detail(p.playerKey, d),
});

const settings = {
  leagueKey: L,
  name: 'Test',
  numTeams: 2,
  scoringType: 'head',
  categories: [],
  rosterSlots: [],
  usesFaab: false,
  draftStatus: 'postdraft',
  source: 'browser',
} as unknown as LeagueSettings;

const jarvis = player(1, 'Seth Jarvis', { status: 'IR-NR' });
const mack = player(2, 'Nathan MacKinnon', { nhlTeam: 'COL' });
const theirs = player(3, 'Other Guy');
const fa = player(4, 'Free Agent');
const waiver = player(5, 'On Waivers');

function source(over: Partial<LiveLeagueSource> = {}): LiveLeagueSource {
  return {
    settingsAndMeta: () => Promise.resolve({ settings, meta: { currentWeek: 3 } }),
    teams: () =>
      Promise.resolve([
        { teamKey: US, name: 'Us', managerNickname: 'Ben' },
        { teamKey: THEM, name: 'Them' },
      ]),
    rosterDetailed: (teamKey: string, date: string) => {
      const entries =
        teamKey === US
          ? [
              { player: jarvis, slot: 'BN' },
              { player: mack, slot: 'C' },
            ]
          : [{ player: theirs, slot: 'C' }];
      const details = new Map(entries.map((e) => [e.player.playerKey, detail(e.player.playerKey)]));
      details.set(
        jarvis.playerKey,
        detail(jarvis.playerKey, {
          statusFull: 'Injured Reserve',
          injuryNote: 'Shoulder',
          notes: [
            {
              id: '1',
              date: '2026-09-27',
              headline: 'Moves to non-roster list',
              news: 'Placed on IR-NR.',
              provider: 'Rotowire.com',
            },
          ],
        }),
      );
      return Promise.resolve({ roster: { teamKey, date, entries }, details, editable: true });
    },
    playersDetailed: (q: YahooPlayerQuery) =>
      Promise.resolve(
        q.status === 'W'
          ? [yp(waiver, { ownership: { type: 'waivers', waiverDate: '2026-10-02' } })]
          : q.position === 'G'
            ? []
            : [yp(fa), yp(theirs)], // a rostered player in the FA list must not be duplicated
      ),
    transactions: (q) =>
      Promise.resolve(
        q.type === 'pending_trade'
          ? [{ transactionKey: `${L}.pt.1`, type: 'pending_trade', timestamp: 't', players: [] }]
          : [],
      ),
    ...over,
  };
}

const ranking = {
  valuations: [
    {
      nhlId: 100,
      name: 'Seth Jarvis',
      position: 'LW',
      team: 'CAR',
      positionType: 'P',
      z: {},
      value: 4,
      vorp: 1,
      vorpPosition: 'LW',
      perGameValue: 0.1,
      gp: 40,
      lowConfidence: false,
    },
    {
      nhlId: 200,
      name: 'Nathan MacKinnon',
      position: 'C',
      team: 'COL',
      positionType: 'P',
      z: {},
      value: 12,
      vorp: 8,
      vorpPosition: 'C',
      perGameValue: 0.2,
      gp: 80,
      lowConfidence: false,
    },
  ],
  projections: [
    {
      nhlId: 200,
      name: 'Nathan MacKinnon',
      positionType: 'P',
      position: 'C',
      team: 'COL',
      gp: 80,
      perGame: { G: 0.5 },
      totals: { G: 40 },
      volume: {},
      lowConfidence: false,
      notes: [],
    },
  ],
} as unknown as Parameters<typeof valueLivePlayers>[1];

function inputs(over: Partial<Parameters<typeof buildLiveSnapshot>[0]> = {}) {
  const warn = vi.fn();
  return {
    warn,
    i: {
      source: source(),
      leagueKey: L,
      teamKey: US,
      date: '2026-09-29',
      recordedAt: '2026-09-29T16:00:00Z',
      schedule: () =>
        Promise.resolve([
          {
            date: '2026-09-29',
            games: [{ home: 'TB', away: 'COL', startTimeUtc: 'z', gameState: 'FUT', gameId: 1 }],
          },
        ]),
      valuate: (ps: readonly Player[]) =>
        valueLivePlayers(ps, ranking, new Map([[jarvis.playerKey, 100]])),
      warn,
      ...over,
    },
  };
}

describe('buildLiveSnapshot', () => {
  it('should produce a valid yahoo snapshot with every roster, free agents and waivers', async () => {
    const { i } = inputs();
    const { snapshot, stats } = await buildLiveSnapshot(i);
    expect(() => LeagueSnapshot.parse(snapshot)).not.toThrow();
    expect(snapshot).toMatchObject({ source: 'yahoo', week: 3, teamKey: US });
    expect(snapshot.rosters[US]).toEqual([
      { playerKey: jarvis.playerKey, slot: 'BN' },
      { playerKey: mack.playerKey, slot: 'C' },
    ]);
    expect(snapshot.players.map((p) => p.name).sort()).toEqual([
      'Free Agent',
      'Nathan MacKinnon',
      'On Waivers',
      'Other Guy',
      'Seth Jarvis',
    ]);
    expect(stats).toMatchObject({ rostered: 3, freeAgents: 2 });
  });

  it('should key valuations by playerKey, from the map first and the name join second', async () => {
    const { snapshot, stats } = await buildLiveSnapshot(inputs().i);
    expect(snapshot.valuations[jarvis.playerKey]?.value).toBe(4);
    expect(snapshot.valuations[mack.playerKey]?.value).toBe(12);
    expect(snapshot.projections[mack.playerKey]?.totals).toEqual({ G: 40 });
    expect(snapshot.players.find((p) => p.name === 'Nathan MacKinnon')).toMatchObject({
      nhlId: 200,
    });
    expect(stats.nameJoined).toBe(1);
    // Nobody named "Free Agent" in the ranking: left unvalued, never guessed.
    expect(snapshot.valuations[fa.playerKey]).toBeUndefined();
  });

  it('should put status and notes into news', async () => {
    const { snapshot } = await buildLiveSnapshot(inputs().i);
    expect(snapshot.news[jarvis.playerKey]).toEqual([
      'Status: IR-NR · Injured Reserve · Shoulder',
      '2026-09-27 Moves to non-roster list — Placed on IR-NR. (Rotowire.com)',
    ]);
    expect(snapshot.news[waiver.playerKey]).toEqual(['On waivers until 2026-10-02']);
  });

  it('should keep pending trades and the schedule', async () => {
    const { snapshot } = await buildLiveSnapshot(inputs().i);
    expect(snapshot.transactions.map((t) => t.type)).toEqual(['pending_trade']);
    expect(snapshot.schedule[0]?.games[0]).toEqual({ home: 'TB', away: 'COL', startTimeUtc: 'z' });
  });

  it('should record without schedule, transactions or valuations when those are down (P9)', async () => {
    const { i, warn } = inputs({
      schedule: () => Promise.reject(new Error('nhl down')),
      valuate: () => {
        throw new Error('season not cached');
      },
      source: source({ transactions: () => Promise.reject(new Error('500')) }),
    });
    const { snapshot } = await buildLiveSnapshot(i);
    expect(snapshot.schedule).toEqual([]);
    expect(snapshot.transactions).toEqual([]);
    expect(snapshot.valuations).toEqual({});
    expect(warn).toHaveBeenCalledTimes(5);
  });

  it('should refuse a configured team that is not in the league', async () => {
    await expect(buildLiveSnapshot(inputs({ teamKey: `${L}.t.9` }).i)).rejects.toThrow(/not in/);
  });

  it('should let a roster read failure fail the recording', async () => {
    const { i } = inputs({
      source: source({ rosterDetailed: () => Promise.reject(new Error('401')) }),
    });
    await expect(buildLiveSnapshot(i)).rejects.toThrow('401');
  });
});

describe('formatRoster', () => {
  it('should print our roster with slot, status, games and news', async () => {
    const { snapshot } = await buildLiveSnapshot(inputs().i);
    const lines = formatRoster(snapshot);
    expect(lines[0]).toContain('Us · 2026-09-29 · week 3 · source yahoo');
    expect(lines[2]).toMatch(/^ {2}C {4}Nathan MacKinnon.*COL.*-\s+1\s+12\.00/);
    expect(lines[3]).toMatch(/BN\s+Seth Jarvis.*IR-NR.*Status: IR-NR/);
  });
});

describe('newsLines', () => {
  it('should list the newest note first and include advice', () => {
    const d = detail('k', {
      notes: [
        { id: '1', date: '2026-09-01', headline: 'Old' },
        { id: '2', date: '2026-09-20', headline: 'New', advice: 'Hold.' },
      ],
    });
    expect(newsLines(d, undefined)).toEqual(['2026-09-20 New — Advice: Hold.', '2026-09-01 Old']);
  });
});
