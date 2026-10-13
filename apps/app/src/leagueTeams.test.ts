import { afterEach, describe, expect, it } from 'vitest';
import { MentionIndex, TeamSheet } from '@fha/api';
import { LeagueView, MOCK_SETTINGS } from '@fha/tools';
import { mentionIndex, teamSheet } from './leagueTeams.js';
import { call, connected, FIXTURE, startHarness, type Harness } from './testing.js';

const view = LeagueView.fromFile(FIXTURE, MOCK_SETTINGS);

describe('mention index', () => {
  it('names every indexed player and all eight teams, ours flagged', () => {
    const idx = mentionIndex(view);
    expect(idx.players).toHaveLength(view.snap.players.length);
    expect(idx.teams).toHaveLength(8);
    expect(idx.teams.filter((t) => t.isUs).map((t) => t.teamKey)).toEqual([view.teamKey]);
  });
});

describe('team sheet', () => {
  it('lists a team’s roster with slots, resolved against the index', () => {
    const other = view.otherTeams()[0];
    if (other === undefined) throw new Error('fixture has no other team');
    const sheet = teamSheet(view, other.teamKey);
    expect(sheet.name).toBe(other.name);
    expect(sheet.isUs).toBe(false);
    expect(sheet.roster.length).toBeGreaterThan(10);
    for (const r of sheet.roster) expect(view.ownerOf(r.playerKey)).toBe(other.teamKey);
  });

  it('serves our own team too, and 404s an unknown key', () => {
    expect(teamSheet(view, view.teamKey).isUs).toBe(true);
    expect(() => teamSheet(view, 'nope')).toThrow(/No such team/);
  });
});

describe('league team routes', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('serves names and a team sheet, needs a session', async () => {
    h = await startHarness();
    const cookie = await connected(h);
    const names = await call(h, '/api/league/names', { cookie });
    expect(names.status).toBe(200);
    expect(MentionIndex.parse(await names.json()).teams).toHaveLength(8);
    const team = await call(h, `/api/league/teams/${encodeURIComponent(view.teamKey)}`, { cookie });
    expect(TeamSheet.parse(await team.json()).isUs).toBe(true);
    expect((await call(h, '/api/league/teams/nope', { cookie })).status).toBe(404);
    expect((await call(h, '/api/league/names')).status).toBe(401);
  });
});
