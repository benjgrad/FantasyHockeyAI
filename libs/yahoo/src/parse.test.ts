import { describe, expect, it } from 'vitest';
import { fx } from '../fixtures/load.js';
import { YahooShapeError } from './errors.js';
import { parseSettings, parseTeams, parseTransactions } from './league.js';
import { parsePlayers } from './players.js';
import { parseRoster } from './roster.js';
import { matchupFor, parseScoreboard } from './scoreboard.js';

describe('parseSettings', () => {
  const { settings, meta } = parseSettings(fx('settings').body);

  it('should read the league format and label the source as the website path', () => {
    expect(settings.numTeams).toBe(8);
    expect(settings.scoringType).toBe('head');
    expect(settings.draftStatus).toBe('postdraft');
    expect(settings.usesFaab).toBe(false);
    expect(settings.source).toBe('browser');
  });

  it('should separate scored categories from display-only ones and mark rate categories', () => {
    const scored = settings.categories.filter((c) => !c.isDisplayOnly).map((c) => c.abbr);
    expect(scored).toEqual([
      'G',
      'A',
      '+/-',
      'PIM',
      'PPP',
      'SHP',
      'GWG',
      'SOG',
      'HIT',
      'W',
      'GAA',
      'SV%',
      'SHO',
    ]);
    const gaa = settings.categories.find((c) => c.abbr === 'GAA');
    expect(gaa).toMatchObject({ higherIsBetter: false, kind: 'rate', positionType: 'G' });
  });

  it('should read roster slots with bench and IR as non-starting', () => {
    const slots = Object.fromEntries(settings.rosterSlots.map((s) => [s.position, s]));
    expect(slots.D).toMatchObject({ count: 4, isStarting: true });
    expect(slots.BN?.isStarting).toBe(false);
    expect(slots.IR).toMatchObject({ count: 2, isStarting: false });
  });

  it('should expose the season calendar and limits as meta', () => {
    expect(meta).toMatchObject({
      currentWeek: 1,
      startDate: '2026-09-29',
      endDate: '2027-04-10',
      lineupDeadline: 'intraday',
      maxWeeklyAdds: 3,
      waiverDays: 2,
      minGoalieGames: 3,
      postDraftPlayers: 'W',
      waiverRule: 'all',
    });
  });

  it('should throw a shape error on an unknown draft status rather than guess', () => {
    const body = structuredClone(fx('settings').body) as {
      fantasy_content: { league: { draft_status: string } };
    };
    body.fantasy_content.league.draft_status = 'paused';
    expect(() => parseSettings(body)).toThrow(YahooShapeError);
  });
});

describe('parseTeams', () => {
  const teams = parseTeams(fx('teams').body);

  it('should list all eight teams and mark ours', () => {
    expect(teams).toHaveLength(8);
    expect(teams.filter((t) => t.mine).map((t) => t.teamKey)).toEqual(['477.l.48535.t.6']);
  });

  it('should carry the redacted nickname through untouched', () => {
    expect(teams[0]?.managerNickname).toBe('REDACTED');
  });

  it("should read each team's rolling waiver priority", () => {
    const priority = Object.fromEntries(teams.map((t) => [t.teamKey, t.waiverPriority]));
    expect(priority['477.l.48535.t.6']).toBe(8);
    expect(priority['477.l.48535.t.2']).toBe(1);
  });
});

describe('parseRoster (our team, 2026-09-29)', () => {
  const r = parseRoster(fx('roster-t6').body, '2026-09-29');
  const byName = new Map(r.roster.entries.map((e) => [e.player.name, e]));
  const detail = (name: string) => r.details.get(byName.get(name)?.player.playerKey ?? '');

  it('should read every slot on the date', () => {
    expect(r.roster.entries).toHaveLength(19);
    expect(r.roster.date).toBe('2026-09-29');
    expect(r.editable).toBe(true);
    const slots = r.roster.entries.map((e) => e.slot);
    expect(slots.filter((s) => s === 'IR')).toHaveLength(2);
    expect(slots.filter((s) => s === 'BN')).toHaveLength(4);
  });

  it('should read Yahoo status, status text and injury note', () => {
    expect(byName.get('Connor Hellebuyck')).toMatchObject({ slot: 'G', player: { status: 'NA' } });
    expect(detail('Connor Hellebuyck')).toMatchObject({
      statusFull: 'Not Active',
      injuryNote: 'Suspension',
    });
    expect(detail('Seth Jarvis')).toMatchObject({
      statusFull: 'Injured Reserve',
      injuryNote: 'Shoulder',
    });
    expect(byName.get('Seth Jarvis')?.player.status).toBe('IR-NR');
  });

  it('should keep reserve slots out of eligible positions and in reserveEligible', () => {
    expect(byName.get('Seth Jarvis')?.player.eligible).toEqual(['LW', 'RW', 'Util']);
    expect(detail('Seth Jarvis')?.reserveEligible).toEqual(['IR']);
    // NA is not IR-eligible in this league: Yahoo omits IR from his positions.
    expect(detail('Alexander Nikishin')?.reserveEligible).toEqual([]);
  });

  it('should read the notes feed with headline, news, advice and provider', () => {
    const notes = detail('Filip Gustavsson')?.notes ?? [];
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      date: '2026-09-28',
      headline: 'Moves to injured reserve',
      provider: 'Rotowire.com',
    });
    expect(notes[0]?.advice).toContain('early November');
  });

  it('should reject a roster entry without a slot rather than assume the bench', () => {
    const body = structuredClone(fx('roster-t6').body) as {
      fantasy_content: { team: { roster: { players: { player: Record<string, unknown> }[] } } };
    };
    delete body.fantasy_content.team.roster.players[0]?.player.selected_position;
    expect(() => parseRoster(body, '2026-09-29')).toThrow(YahooShapeError);
  });
});

describe('parsePlayers', () => {
  it('should read free agents with ownership and percent owned', () => {
    const fa = parsePlayers(fx('players-fa').body);
    expect(fa).toHaveLength(25);
    expect(fa.every((p) => p.detail.ownership?.type === 'freeagents')).toBe(true);
    expect(fa[0]?.player.percentOwned).toBeGreaterThan(0);
  });

  it('should read the waiver clearing date for players on waivers', () => {
    const w = parsePlayers(fx('players-w').body);
    expect(w.length).toBeGreaterThan(0);
    expect(w.every((p) => p.detail.ownership?.type === 'waivers')).toBe(true);
    expect(w[0]?.detail.ownership?.waiverDate).toMatch(/^2026-10-0\d$/);
  });
});

describe('parseTransactions', () => {
  it('should keep adds with the destination team and skip commissioner edits', () => {
    const tx = parseTransactions(fx('transactions').body);
    expect(tx.map((t) => t.type)).toEqual(['add', 'add']);
    expect(tx[0]).toMatchObject({
      teamKey: '477.l.48535.t.6',
      players: [{ playerKey: '477.p.6377', toTeamKey: '477.l.48535.t.6' }],
      timestamp: '2026-09-27T07:54:28.000Z',
    });
  });

  it('should return no pending trades when there are none', () => {
    expect(parseTransactions(fx('pending-trades').body)).toEqual([]);
  });

  it('should read a trade from both sides [U: pending-trade shape not yet observed live]', () => {
    const body = {
      fantasy_content: {
        league: {
          transactions: [
            {
              transaction: {
                transaction_key: '477.l.48535.pt.1',
                type: 'pending_trade',
                status: 'proposed',
                timestamp: '1790600000',
                trader_team_key: '477.l.48535.t.3',
                tradee_team_key: '477.l.48535.t.6',
                players: [
                  {
                    player: {
                      player_key: '477.p.1',
                      transaction_data: {
                        source_team_key: '477.l.48535.t.3',
                        destination_team_key: '477.l.48535.t.6',
                      },
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    };
    expect(parseTransactions(body)[0]).toMatchObject({
      type: 'pending_trade',
      teamKey: '477.l.48535.t.3',
      tradeeTeamKey: '477.l.48535.t.6',
      players: [
        { playerKey: '477.p.1', fromTeamKey: '477.l.48535.t.3', toTeamKey: '477.l.48535.t.6' },
      ],
    });
  });
});

describe('parseScoreboard', () => {
  const sb = parseScoreboard(fx('scoreboard').body);

  it('should read four week-1 matchups with the week dates', () => {
    expect(sb.week).toBe(1);
    expect(sb.matchups).toHaveLength(4);
    expect(sb.matchups[0]).toMatchObject({
      weekStart: '2026-09-29',
      weekEnd: '2026-10-04',
      status: 'midevent',
    });
  });

  it('should find our matchup and its opponent', () => {
    const m = matchupFor(sb, '477.l.48535.t.6');
    expect(m?.teams.map((t) => t.teamKey)).toEqual(['477.l.48535.t.3', '477.l.48535.t.6']);
    expect(m?.teams[1]?.remainingGames).toBeGreaterThan(0);
  });

  it('should leave category totals empty before any game is played', () => {
    expect(sb.matchups[0]?.teams[0]?.stats).toEqual({});
  });
});
