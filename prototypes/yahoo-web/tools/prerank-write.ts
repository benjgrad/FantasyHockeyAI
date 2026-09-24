/**
 * Write our pre-draft ranking into Yahoo.
 *
 * Why this matters more than it looks: if a pick is missed, Yahoo drafts for the team and
 * switches it to autopick, drawing from the room queue and then the **pre-draft rankings**.
 * So this list — not the socket client — is the real safety net for the draft. Yahoo's own
 * default order is poor for this league (Bouchard 4th, Chychrun 8th, Raddysh 12th), and it
 * is what would be used otherwise.
 *
 * Mechanism (confirmed in docs/investigations/2026-09-24-yahoo-writes-and-draft-room.md §3):
 * a website form POST, not an API call.
 *   POST /hockey/{leagueId}/{teamId}/editprerank
 *        stage=1 crumb=… my_players=… all_players=… excluded_players=… save=1
 * Ids are the numeric part of a Yahoo player key (477.p.6743 -> 6743); `my_players` is our
 * order and `all_players` the remainder.
 *
 * It runs through headless Chrome rather than plain fetch. The saved session authenticates
 * the API hosts but **not** the website: a bare fetch of the editor redirects to
 * login.yahoo.com, which is how this tool first failed. The POST is issued from inside the
 * page so the cookies and headers are exactly what a browser sends.
 *
 * **This writes to Ben's live league, so --dry is the default.** `--commit` performs it;
 * `--reset` restores Yahoo's default order (the same form with empty lists).
 *
 *   LEAGUE_ID=48535 TEAM_ID=6 npx tsx tools/prerank-write.ts [--commit] [--reset] [--top 300]
 */
import { readFileSync } from 'node:fs';
import { gotoSettled, signedInContext } from './browser.js';

const { LEAGUE_ID, TEAM_ID } = process.env;
if (!LEAGUE_ID || !TEAM_ID) throw new Error('set LEAGUE_ID and TEAM_ID');

const COMMIT = process.argv.includes('--commit');
const RESET = process.argv.includes('--reset');
const topIdx = process.argv.indexOf('--top');
const TOP = topIdx >= 0 ? Number(process.argv[topIdx + 1]) : 300;
const RANKING = process.env.RANKING ?? '../../data/yahoo/prerank-ids.json';

const BASE = 'https://hockey.fantasysports.yahoo.com';
const EDITOR = `${BASE}/hockey/${LEAGUE_ID}/${TEAM_ID}/editprerank`;
const VIEW = `${BASE}/hockey/${LEAGUE_ID}/${TEAM_ID}/prerank`;

interface Ranked {
  rank: number;
  playerId: string;
  name: string;
  position: string;
}

/**
 * Reads the rankings page: how many custom entries exist, and the first few names.
 *
 * It counts numbered entries between the two headings rather than looking for the phrase
 * "Your Rankings". That phrase is a UI label that is present even when the custom list is
 * empty — a false positive there would report a save as successful when nothing was written,
 * which is exactly what happened the first time.
 */
const READ_STATE = (): { count: number; first: string[] } => {
  const text = document.body.innerText;
  const yours = text.search(/Your Rankings/i);
  const def = text.search(/Default Rankings/i);
  if (yours < 0) return { count: 0, first: [] };
  const span = text.slice(yours, def > yours ? def : undefined);
  // Anchored on line start. An earlier version used a lookahead and silently undercounted
  // a 300-entry list as 213, which would have hidden a partial save on a live league.
  const entries = [...span.matchAll(/(^|\n)\s*(\d{1,3})\.\s+([^\n]+)/g)].map((m) =>
    m[3]!.trim(),
  );
  return { count: entries.length, first: entries.slice(0, 10) };
};

/** A redirect to login must fail loudly; treating it as an empty page reports nonsense. */
function assertSignedIn(url: string, where: string): void {
  if (/login\.yahoo\.com|\/account\/challenge/.test(url)) {
    throw new Error(
      `${where} redirected to Yahoo login — the saved session is no longer accepted for ` +
        `website pages. Re-run "npx tsx src/cli.ts login" on a machine with Chrome and copy ` +
        `~/.config/fha/yahoo-session.json across.`,
    );
  }
}

let myPlayers: string[] = [];
let allPlayers: string[] = [];
if (RESET) {
  console.log('mode: RESET — restoring Yahoo default order');
} else {
  const ranked = (JSON.parse(readFileSync(RANKING, 'utf-8')) as { ranked: Ranked[] }).ranked;
  if (ranked.length === 0) throw new Error(`${RANKING} has no players; run "fha rank" first`);
  myPlayers = ranked.slice(0, TOP).map((r) => r.playerId);
  allPlayers = ranked.slice(TOP).map((r) => r.playerId);
  console.log(`mode: SAVE — ${myPlayers.length} ranked, ${allPlayers.length} left unranked`);
  for (const r of ranked.slice(0, 10)) {
    console.log(`  ${String(r.rank).padStart(3)} ${r.playerId.padStart(6)}  ${r.name} (${r.position})`);
  }
}

const expectedFirst = RESET ? '' : (JSON.parse(readFileSync(RANKING, 'utf-8')) as { ranked: Ranked[] }).ranked[0]?.name ?? '';

const { browser, ctx } = await signedInContext();
try {
  const page = await ctx.newPage();

  await gotoSettled(page, VIEW, 2500);
  assertSignedIn(page.url(), 'the rankings page');
  const before = await page.evaluate(READ_STATE);
  console.log(
    `before: ${before.count > 0 ? `${before.count} custom entries` : 'Yahoo default only'}` +
      (before.first.length ? `  (${before.first.slice(0, 5).join(', ')})` : ''),
  );

  await gotoSettled(page, EDITOR, 4000);
  assertSignedIn(page.url(), 'the editor page');

  // The crumb lives in an inline JS config on the editor page. It is NOT the header
  // `uh-crumb`, which is a different value. Fetched immediately before the POST and
  // treated as single-use.
  const crumb = await page.evaluate(() => {
    const html = document.documentElement.innerHTML;
    for (const re of [
      /\bcrumb\s*:\s*"([^"]+)"/,
      /\bcrumb\s*:\s*'([^']+)'/,
      /"crumb"\s*:\s*"([^"]+)"/,
      /name="crumb"[^>]*value="([^"]+)"/,
    ]) {
      const m = re.exec(html);
      if (m?.[1]) return m[1];
    }
    return null;
  });
  if (!crumb) {
    throw new Error(
      'no crumb on the editor page. The session may be stale, or the markup changed — ' +
        'open the page with tools/page-eval.ts and look for the inline config.',
    );
  }
  console.log(`crumb: ${crumb.length} chars (not logged)`);

  if (!COMMIT) {
    console.log(
      `\n[dry] would POST ${EDITOR}\n` +
        `[dry]   my_players : ${myPlayers.length} ids${myPlayers.length ? ` starting ${myPlayers.slice(0, 5).join(',')}` : ''}\n` +
        `[dry]   all_players: ${allPlayers.length} ids\n` +
        `[dry] nothing was sent. Pass --commit to write.`,
    );
  } else {
    const result = await page.evaluate(
      async (payload: { url: string; body: string }) => {
        const res = await fetch(payload.url, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: payload.body,
          credentials: 'include',
          redirect: 'follow',
        });
        return { status: res.status, url: res.url };
      },
      {
        url: EDITOR,
        body: new URLSearchParams({
          stage: '1',
          crumb,
          all_players: allPlayers.join(','),
          my_players: myPlayers.join(','),
          excluded_players: '',
          save: '1',
        }).toString(),
      },
    );
    console.log(`POST -> HTTP ${result.status}`);
    if (result.status >= 400) throw new Error(`save failed with HTTP ${result.status}`);

    await gotoSettled(page, VIEW, 3000);
    assertSignedIn(page.url(), 'the rankings page after saving');
    const after = await page.evaluate(READ_STATE);
    console.log(
      `after:  ${after.count > 0 ? `${after.count} custom entries` : 'Yahoo default only'}` +
        (after.first.length ? `  (${after.first.slice(0, 8).join(', ')})` : ''),
    );
    // Verify the outcome, not the HTTP status: a 200 that changed nothing is a failure.
    if (!RESET && after.count === 0) {
      throw new Error('POST returned OK but no custom rankings appeared — treat as FAILED');
    }
    if (RESET && after.count > 0) {
      throw new Error(`POST returned OK but ${after.count} custom entries remain — treat as FAILED`);
    }
    if (!RESET && after.first[0] !== expectedFirst) {
      throw new Error(
        `saved list starts with "${after.first[0] ?? '(nothing)'}" but we sent "${expectedFirst}" first`,
      );
    }
    console.log(
      RESET
        ? 'Reset done; Yahoo will autodraft from its own default order.'
        : 'Saved; Yahoo will autodraft from our order if a pick is missed.',
    );
  }
} finally {
  await browser.close();
}
