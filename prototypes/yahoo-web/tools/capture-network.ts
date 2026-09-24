// Headless equivalent of Chrome DevTools MCP `list_network_requests` + `get_network_request`.
// Loads Yahoo pages signed in, records every Fantasy API request/response, writes JSONL.
// Secrets are redacted (cookie values never written). Response bodies optional (--bodies).
//
//   npx tsx tools/capture-network.ts [--bodies] [--out captures/net-<ts>.jsonl] <url> [url...]
//   npx tsx tools/capture-network.ts https://hockey.fantasysports.yahoo.com/hockey/48535/6
import { mkdir, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { gotoSettled, redactHeaders, signedInContext } from './browser.js';

const args = process.argv.slice(2);
const bodies = args.includes('--bodies');
const outIdx = args.indexOf('--out');
const out = outIdx >= 0 ? args[outIdx + 1]! : `captures/net-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
const urls = args.filter((a, i) => !a.startsWith('--') && !(outIdx >= 0 && i === outIdx + 1));
// Only first-party Fantasy traffic; ads/trackers are dropped (they were ~95% of requests).
const INTERESTING = /fantasysports\.yahoo\.com\/fantasy\/|fantasysports\.yahoo\.com\/.*(draft|prerank|api)|user-services\.sports\.yahoo\.com/i;

async function main() {
  if (!urls.length) throw new Error('Pass at least one URL.');
  await mkdir(dirname(out), { recursive: true });
  const { browser, ctx } = await signedInContext();
  let n = 0;
  ctx.on('requestfinished', async (req) => {
    if (!INTERESTING.test(req.url())) return;
    const res = await req.response();
    const rec: Record<string, unknown> = {
      at: new Date().toISOString(),
      method: req.method(),
      url: req.url(),
      resourceType: req.resourceType(),
      status: res?.status(),
      requestHeaders: redactHeaders(await req.allHeaders()),
      postData: req.postData() ? `[${req.postData()!.length} bytes]` : undefined,
      responseHeaders: res ? redactHeaders(await res.allHeaders()) : undefined,
    };
    if (bodies && res) rec.body = (await res.text().catch(() => '')).slice(0, 200_000);
    await appendFile(out, JSON.stringify(rec) + '\n');
    n++;
    console.log(`${rec.status} ${rec.method} ${req.url().slice(0, 160)}`);
  });
  const page = await ctx.newPage();
  page.on('websocket', (ws) => {
    console.log(`WS open ${ws.url()}`);
    void appendFile(out, JSON.stringify({ at: new Date().toISOString(), websocket: ws.url() }) + '\n');
    ws.on('framesent', (f) => void appendFile(out, JSON.stringify({ ws: ws.url(), dir: 'sent', len: String(f.payload).length, head: String(f.payload).slice(0, 300) }) + '\n'));
    ws.on('framereceived', (f) => void appendFile(out, JSON.stringify({ ws: ws.url(), dir: 'recv', len: String(f.payload).length, head: String(f.payload).slice(0, 300) }) + '\n'));
  });
  for (const u of urls) {
    console.log(`--- ${u}`);
    await gotoSettled(page, u);
  }
  await page.waitForTimeout(2000);
  await browser.close();
  console.log(`Wrote ${n} requests to ${out}${bodies ? ' (with bodies: may contain personal data)' : ''}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? `${e.name}: ${e.message}` : e);
  process.exit(1);
});
