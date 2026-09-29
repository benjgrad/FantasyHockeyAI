import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import webpush from 'web-push';
import { anthropicCreateMessage } from '@fha/llm';
import { scheduleWeek } from '@fha/nhl';
import { loadPrompts } from '@fha/prompts';
import { openStore } from '@fha/store';
import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { liveYahooAccess } from './yahoo.js';

/**
 * Entry point: `npx tsx apps/app/src/main.ts` (see deploy/fha-app.sh). Listens on 127.0.0.1
 * only; nginx terminates TLS in front of it. A configuration error exits 78 (EX_CONFIG), which
 * the systemd unit does not restart, so a bad env file fails loudly instead of looping.
 */
function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`FATAL config: ${err.message}`);
      process.exit(78);
    }
    throw err;
  }
  if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true });
  const store = openStore(config.dbPath);
  if (config.vapid !== undefined) {
    webpush.setVapidDetails(config.vapid.subject, config.vapid.publicKey, config.vapid.privateKey);
  }
  const { handler } = createApp({
    config,
    store,
    fetch,
    yahoo: liveYahooAccess,
    schedule: (date) => scheduleWeek(date),
    ...(config.anthropicApiKey === undefined ? {} : { createMessage: anthropicCreateMessage() }),
    pushSend: (sub, payload) => webpush.sendNotification(sub, payload),
    prompts: loadPrompts(),
  });
  const server = createServer(handler);
  // SSE replies can run for minutes while a specialist works; don't cut them off.
  server.requestTimeout = 0;
  server.listen(config.port, '127.0.0.1', () => {
    console.log(
      `fha-app on http://127.0.0.1:${config.port} for ${config.publicUrl} · issuer ${config.oidcIssuer} · ` +
        `chat ${config.anthropicApiKey === undefined ? 'OFF (no ANTHROPIC_API_KEY)' : 'on'} · ` +
        `push ${config.vapid === undefined ? 'off' : 'on'} · ${config.allowedSubs.size} allowed subject(s)`,
    );
  });
  const stop = () => {
    server.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main();
