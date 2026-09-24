// Headless equivalent of Chrome DevTools MCP `navigate_page` + `evaluate_script` (+ `take_screenshot`).
// Opens a URL signed in, runs a snippet (a JS function expression file) in the page, prints JSON.
//
//   npx tsx tools/page-eval.ts <url> <snippet.js> [--vars '{"leagueKey":"477.l.48535"}'] [--screenshot out.png]
//   npx tsx tools/page-eval.ts https://hockey.fantasysports.yahoo.com/hockey/48535/6 tools/snippets/03-league-settings-summary.js
//
// Snippets set/read window.__FHA for parameters, so the same file works in the MCP
// (paste the function into evaluate_script) and here.
import { readFile } from 'node:fs/promises';
import { gotoSettled, signedInContext } from './browser.js';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const [url, snippetFile] = positional;

async function main() {
  if (!url || !snippetFile) throw new Error('Usage: page-eval <url> <snippet.js> [--vars JSON] [--screenshot file]');
  const src = (await readFile(snippetFile, 'utf8')).replace(/^\s*\/\/.*$/gm, '').trim();
  const vars = flag('--vars') ? JSON.parse(flag('--vars')!) : undefined;
  const { browser, ctx } = await signedInContext();
  try {
    const page = await ctx.newPage();
    await gotoSettled(page, url);
    if (vars) await page.evaluate((v) => ((window as unknown as { __FHA: unknown }).__FHA = v), vars);
    const result = await page.evaluate(`(${src})()`);
    const shot = flag('--screenshot');
    if (shot) await page.screenshot({ path: shot });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? `${e.name}: ${e.message}` : e);
  process.exit(1);
});
