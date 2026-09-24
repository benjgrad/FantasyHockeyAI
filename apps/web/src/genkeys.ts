/** Generate VAPID keys for Web Push. Run once; the keys are a credential. */
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import webpush from 'web-push';

const OUT = 'data/web-push.json';
if (existsSync(OUT)) {
  console.log(`${OUT} already exists — not overwriting (that would invalidate every subscription)`);
  process.exit(0);
}
const { publicKey, privateKey } = webpush.generateVAPIDKeys();
mkdirSync('data', { recursive: true });
writeFileSync(
  OUT,
  JSON.stringify(
    {
      publicKey,
      privateKey,
      subject: process.env.FHA_VAPID_SUBJECT ?? 'mailto:admin@gradyserver.com',
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log(`wrote ${OUT} (mode 0600). Public key: ${publicKey.slice(0, 16)}…`);
