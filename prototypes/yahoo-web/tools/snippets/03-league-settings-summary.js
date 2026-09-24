// MCP step 5: categories, roster slots, draft time and teams from the settings/teams resources.
async () => {
  const { leagueKey: L = '477.l.48535' } = window.__FHA ?? {};
  const get = async (p) => (await fetch(`https://pub-api-ro.fantasysports.yahoo.com/fantasy/v2${p}?format=json_f`, { credentials: 'include' })).json();
  const lg = (await get(`/league/${L}/settings`)).fantasy_content.league;
  const s = lg.settings;
  const cats = s.stat_categories.stats.map((x) => x.stat).map((c) =>
    `${c.display_name}(${c.stat_id},${c.position_type},${c.sort_order === '1' ? 'hi' : 'lo'}${c.is_only_display_stat === '1' ? ',display' : ''}${c.enabled === '1' ? '' : ',disabled'})`);
  const slots = s.roster_positions.map((x) => x.roster_position).map((p) => `${p.position}x${p.count}`);
  const teams = (await get(`/league/${L}/teams`)).fantasy_content.league.teams.map((t) => t.team)
    .map((t) => ({ key: t.team_key, name: t.name, draft_position: t.draft_position, mine: t.is_owned_by_current_login }));
  const scalars = Object.fromEntries(Object.entries(s).filter(([, v]) => typeof v !== 'object'));
  return {
    league: { key: lg.league_key, name: lg.name, num_teams: lg.num_teams, draft_status: lg.draft_status, weekly_deadline: lg.weekly_deadline, start_date: lg.start_date, end_date: lg.end_date },
    settings: scalars, cats, slots, teams,
    draftTimeET: new Date(+s.draft_time * 1000).toLocaleString('en-US', { timeZone: 'America/New_York' }),
  };
}
