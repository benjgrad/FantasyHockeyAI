import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { checkRoot } from '@fha/auth';

/**
 * The app server's configuration, read once at startup from the environment. Every problem is
 * fatal and names the variable, so a misconfigured deploy fails at boot (exit 78, which systemd
 * does not restart) rather than on the first sign-in.
 *
 * Paths resolve against the repo root, not the working directory, so the unit file and a
 * developer's shell find the same database.
 */
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  /** `mailto:` or `https:` contact the push services may use. */
  subject: string;
}

export interface AppConfig {
  /** Where browsers reach the app, e.g. https://hockey.gradyserver.com. No trailing slash. */
  publicUrl: string;
  secretKey: string;
  oidcIssuer: string;
  /** Personal OS subjects allowed to sign in. Everyone else gets a 403 page. */
  allowedSubs: ReadonlySet<string>;
  dbPath: string;
  port: number;
  /** Absent: chat answers with a clear error instead of calling the model. */
  anthropicApiKey: string | undefined;
  /** Absent: push is off and the settings page says so; everything else works. */
  vapid: VapidKeys | undefined;
  /** The built client (apps/app/client/dist). */
  clientDir: string;
  /** Per-user league snapshots are cached under `<snapshotDir>/<userId>/`. */
  snapshotDir: string;
  /** The seeded permissions for a user with no row yet (D-008). */
  permissionsFile: string;
  /** A recorded `fha snapshot record` file whose valuations seed live snapshots. */
  valuationSnapshot: string | undefined;
  /** Run the scheduler and watchers in this process (`FHA_DAEMON=1`; off by default and in tests). */
  daemon: boolean;
  /** The single-instance lock the daemon holds (§3.2). */
  lockPath: string;
}

const Env = z.object({
  FHA_PUBLIC_URL: z
    .string({ required_error: 'FHA_PUBLIC_URL is required (e.g. https://hockey.example.com)' })
    .url('FHA_PUBLIC_URL must be an absolute URL'),
  FHA_SECRET_KEY: z.string({
    required_error: 'FHA_SECRET_KEY is required (generate: openssl rand -base64 48)',
  }),
  FHA_OIDC_ISSUER: z
    .string()
    .url('FHA_OIDC_ISSUER must be a URL')
    .default('https://os.gradyserver.com'),
  FHA_ALLOWED_SUBS: z.string({
    required_error: 'FHA_ALLOWED_SUBS is required: comma-separated Personal OS subjects',
  }),
  FHA_DB_PATH: z.string().default('data/fha.sqlite'),
  FHA_APP_PORT: z.coerce.number().int().min(1).max(65535).default(8720),
  ANTHROPIC_API_KEY: z.string().optional(),
  FHA_VAPID_PUBLIC_KEY: z.string().optional(),
  FHA_VAPID_PRIVATE_KEY: z.string().optional(),
  FHA_VAPID_SUBJECT: z.string().optional(),
  FHA_VAPID_FILE: z.string().default('data/web-push.json'),
  FHA_CLIENT_DIR: z.string().default('apps/app/client/dist'),
  FHA_SNAPSHOT_DIR: z.string().default('data/snapshots'),
  FHA_PERMISSIONS_FILE: z.string().default('config/permissions.yaml'),
  FHA_VALUATION_SNAPSHOT: z.string().optional(),
  FHA_DAEMON: z.enum(['0', '1', '']).default('0'),
  FHA_LOCK_FILE: z.string().default('data/fha.lock'),
});

const VapidFile = z.object({
  publicKey: z.string().min(1),
  privateKey: z.string().min(1),
  subject: z.string().min(1),
});

export function loadConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  root: string = REPO_ROOT,
): AppConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => i.message).join('; '));
  }
  const e = parsed.data;
  const at = (p: string) => (isAbsolute(p) ? p : resolve(root, p));
  try {
    checkRoot(e.FHA_SECRET_KEY);
  } catch (err) {
    throw new ConfigError(err instanceof Error ? err.message : String(err));
  }
  const allowedSubs = new Set(
    e.FHA_ALLOWED_SUBS.split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
  );
  if (allowedSubs.size === 0) throw new ConfigError('FHA_ALLOWED_SUBS lists no subjects');
  return {
    publicUrl: e.FHA_PUBLIC_URL.replace(/\/+$/, ''),
    secretKey: e.FHA_SECRET_KEY,
    oidcIssuer: e.FHA_OIDC_ISSUER.replace(/\/+$/, ''),
    allowedSubs,
    dbPath: e.FHA_DB_PATH === ':memory:' ? ':memory:' : at(e.FHA_DB_PATH),
    port: e.FHA_APP_PORT,
    anthropicApiKey: e.ANTHROPIC_API_KEY === '' ? undefined : e.ANTHROPIC_API_KEY,
    vapid: vapidFrom(e, at(e.FHA_VAPID_FILE)),
    clientDir: at(e.FHA_CLIENT_DIR),
    snapshotDir: at(e.FHA_SNAPSHOT_DIR),
    permissionsFile: at(e.FHA_PERMISSIONS_FILE),
    valuationSnapshot:
      e.FHA_VALUATION_SNAPSHOT === undefined ? undefined : at(e.FHA_VALUATION_SNAPSHOT),
    daemon: e.FHA_DAEMON === '1',
    lockPath: at(e.FHA_LOCK_FILE),
  };
}

/** Environment first (all three or none), else the file `npm run web:keys` writes. */
function vapidFrom(e: z.infer<typeof Env>, file: string): VapidKeys | undefined {
  const fromEnv = [e.FHA_VAPID_PUBLIC_KEY, e.FHA_VAPID_PRIVATE_KEY, e.FHA_VAPID_SUBJECT];
  if (fromEnv.some((v) => v !== undefined && v !== '')) {
    const [publicKey, privateKey, subject] = fromEnv;
    if (!publicKey || !privateKey || !subject) {
      throw new ConfigError(
        'FHA_VAPID_PUBLIC_KEY, FHA_VAPID_PRIVATE_KEY and FHA_VAPID_SUBJECT must be set together',
      );
    }
    return { publicKey, privateKey, subject };
  }
  if (!existsSync(file)) return undefined;
  const parsed = VapidFile.safeParse(JSON.parse(readFileSync(file, 'utf-8')));
  if (!parsed.success) throw new ConfigError(`${file} is not a VAPID key file`);
  return parsed.data;
}
