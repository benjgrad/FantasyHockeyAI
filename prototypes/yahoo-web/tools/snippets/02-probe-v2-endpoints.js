// MCP step 4: fetch core v2 resources on both API hosts using the page's cookies.
// Run on any hockey.fantasysports.yahoo.com page (CORS allows this origin with credentials).
// Args: window.__FHA = { leagueKey, teamKey, date } or defaults below.
async () => {
  const { leagueKey: L = '477.l.48535', teamKey: T = '477.l.48535.t.6', date = new Date().toISOString().slice(0, 10) } = window.__FHA ?? {};
  const paths = {
    settings: `/league/${L}/settings`,
    teams: `/league/${L}/teams`,
    roster: `/team/${T}/roster;date=${date}`,
    draftresults: `/league/${L}/draftresults`,
    players_fa: `/league/${L}/players;status=A;sort=OR;start=0;count=5;out=draft_analysis,percent_owned`,
    transactions: `/league/${L}/transactions`,
    scoreboard: `/league/${L}/scoreboard`,
    standings: `/league/${L}/standings`,
    user_games: `/users;use_login=1/games;game_keys=nhl/leagues`,
  };
  const out = {};
  for (const [k, p] of Object.entries(paths)) {
    for (const host of ['pub-api-ro', 'pub-api-rw']) {
      try {
        const r = await fetch(`https://${host}.fantasysports.yahoo.com/fantasy/v2${p}?format=json_f`, { credentials: 'include' });
        const t = await r.text();
        out[`${k}@${host}`] = { status: r.status, bytes: t.length };
      } catch (e) { out[`${k}@${host}`] = { error: String(e) }; }
    }
  }
  return out;
}
