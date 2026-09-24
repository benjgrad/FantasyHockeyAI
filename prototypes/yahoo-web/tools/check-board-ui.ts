/**
 * Drive the draft board in a real browser.
 *
 * The board re-renders every few seconds, so its bugs are DOM-state bugs: an expanded row
 * collapsing itself, a lost scroll position. Those cannot be caught by unit tests or by curl,
 * only by clicking and waiting. Run after any change to the front end.
 */
const { chromium } = await import('playwright-core');
const URL_BASE = process.env.BOARD_URL ?? 'https://draft.gradyserver.com';
const user = process.env.FHA_WEB_USER ?? 'ben';
const pass = process.env.FHA_WEB_PASS ?? '';
if (!pass) throw new Error('set FHA_WEB_PASS');

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({
  httpCredentials: { username: user, password: pass },
  viewport: { width: 390, height: 844 }, // phone-sized, which is how it will be used
});
const page = await ctx.newPage();
const fails: string[] = [];
const ok = (cond: boolean, label: string): void => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) fails.push(label);
};

try {
  await page.goto(URL_BASE, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForSelector('details.alt', { timeout: 30_000 });

  const alts = await page.locator('details.alt').count();
  ok(alts > 0, `alternatives rendered (${alts})`);

  // 1) Expand the second alternative and make sure it survives several poll cycles.
  const target = page.locator('details.alt').nth(1);
  await target.locator('summary').click();
  ok(await target.evaluate((d: Element) => (d as HTMLDetailsElement).open), 'expands on click');
  const key = await target.getAttribute('data-key');
  await page.waitForTimeout(9000); // three poll cycles
  const stillOpen = await page
    .locator(`details.alt[data-key="${key ?? ''}"]`)
    .evaluate((d: Element) => (d as HTMLDetailsElement).open);
  ok(stillOpen, 'still expanded after 9s of polling');

  // 2) The comparison table inside it must have both the category rows and the metric rows.
  const rows = await target.locator('table.cmp tr').count();
  ok(rows >= 14, `comparison table has category and metric rows (${rows})`);
  const body = await target.innerText();
  for (const m of ['score', 'vorp', 'fit', 'need', 'adp']) {
    ok(body.toLowerCase().includes(m), `metric diffed: ${m}`);
  }

  // 3) Scroll position must survive a re-render.
  await page.evaluate(() => window.scrollTo(0, 400));
  await page.waitForTimeout(4000);
  const y = await page.evaluate(() => window.scrollY);
  ok(y > 300, `scroll preserved across a render (${y})`);

  // 4) Overriding from an alternative promotes it and offers a revert.
  const altName = (await target.locator('summary b').innerText()).trim();
  await target.locator('button[data-id]').click();
  await page.waitForTimeout(4500);
  const recName = (await page.locator('.ovcard .big').first().innerText()).trim();
  ok(recName === altName, `override promoted "${altName}" to the pick (got "${recName}")`);
  ok(await page.locator('#clear').count() > 0, 'revert control offered');
  await page.locator('#clear').click();
  await page.waitForTimeout(4500);
  ok(await page.locator('.ovcard').count() === 0, 'revert restores the model pick');

  await page.screenshot({ path: 'data/board-screenshot.png', fullPage: false });
  console.log('  screenshot: data/board-screenshot.png');
} finally {
  await browser.close();
}
console.log(fails.length === 0 ? '\nALL CHECKS PASSED' : `\n${fails.length} FAILED: ${fails.join('; ')}`);
process.exit(fails.length === 0 ? 0 : 1);
