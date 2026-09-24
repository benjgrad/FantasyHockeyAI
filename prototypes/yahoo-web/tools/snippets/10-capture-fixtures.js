// MCP step 9: raw responses for fixtures. Output contains PERSONAL DATA (email, GUID) - sanitize before committing.
async () => {
  const { leagueKey: L = '477.l.48535', teamKey: T = '477.l.48535.t.6', date = new Date().toISOString().slice(0, 10) } = window.__FHA ?? {};
  const paths = {
    user_leagues: '/users;use_login=1/games;game_keys=nhl/leagues',
    user_teams: '/users;use_login=1/games;game_keys=nhl/teams',
    settings: `/league/${L}/settings`, teams: `/league/${L}/teams`, roster: `/team/${T}/roster;date=${date}`,
    players_avail: `/league/${L}/players;status=A;sort=OR;start=0;count=25;out=draft_analysis,percent_owned,ownership`,
    draftresults: `/league/${L}/draftresults`, transactions: `/league/${L}/transactions`,
    scoreboard: `/league/${L}/scoreboard`, standings: `/league/${L}/standings`,
  };
  const out = {};
  for (const [k, p] of Object.entries(paths)) {
    const r = await fetch(`https://pub-api-ro.fantasysports.yahoo.com/fantasy/v2${p}?format=json_f`, { credentials: 'include' });
    out[k] = { path: p, status: r.status, body: await r.json() };
  }
  return out;
}
