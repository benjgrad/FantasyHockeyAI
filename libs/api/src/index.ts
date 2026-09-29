import { z } from 'zod';

/**
 * The HTTP contract between the app server (`apps/app`) and its browser client.
 *
 * One file, zod schemas, imported by both sides: the server validates every request body with
 * these and the client parses every response with them, so a drift between the two fails
 * loudly in tests instead of rendering `undefined` in production. Keep it free of Node or DOM
 * types so both sides can import it.
 *
 * Conventions: JSON everywhere; mutating calls send the `x-fha: 1` header (CSRF, see
 * `@fha/auth` `originOk`); errors are `{ error: { code, message } }` with a 4xx/5xx status.
 */

export const ApiError = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
export type ApiError = z.infer<typeof ApiError>;

// ── session ──────────────────────────────────────────────────────────────────────────────────
// GET  /auth/login?returnTo=/path   → 302 to Personal OS
// GET  /auth/callback               → sets the session cookie, 302 to returnTo
// POST /auth/logout                 → clears the cookie
// POST /auth/logout-everywhere      → bumps the epoch

export const Me = z.object({
  signedIn: z.literal(true),
  userId: z.string(),
  displayName: z.string().nullable(),
  yahoo: z.object({
    status: z.enum(['none', 'connected', 'expired', 'error']),
    leagueKey: z.string().nullable(),
    teamKey: z.string().nullable(),
    teamName: z.string().nullable(),
    lastOkAt: z.string().nullable(),
    error: z.string().nullable(),
  }),
  dryRun: z.boolean(),
  paused: z.boolean(),
});
export type Me = z.infer<typeof Me>;
// GET /api/me → Me, or 401 ApiError { code: 'signed_out' }

// ── Yahoo connection (Settings) ─────────────────────────────────────────────────────────────
export const YahooConnectRequest = z.object({
  /** The `T` and `Y` cookie values copied from a signed-in browser. Never logged. */
  T: z.string().min(10),
  Y: z.string().min(10),
});
export const YahooTeamChoice = z.object({
  leagueKey: z.string(),
  leagueName: z.string(),
  teamKey: z.string(),
  teamName: z.string(),
  season: z.string(),
});
export const YahooConnectResponse = z.object({ teams: z.array(YahooTeamChoice) });
export const YahooSelectTeamRequest = z.object({ leagueKey: z.string(), teamKey: z.string() });
// POST   /api/settings/yahoo         YahooConnectRequest → YahooConnectResponse (validates live)
// POST   /api/settings/yahoo/team    YahooSelectTeamRequest → Me
// DELETE /api/settings/yahoo         → Me

// ── permissions (Settings) ──────────────────────────────────────────────────────────────────
// GET /api/settings/permissions → PermissionsView ; PUT with PermissionsUpdate → PermissionsView
export const PlayerRef = z.object({
  playerKey: z.string(),
  name: z.string(),
  team: z.string(),
  positions: z.string(),
});
export const PermissionsView = z.object({
  /** The `Permissions` document from @fha/core, as stored. */
  permissions: z.record(z.string(), z.unknown()),
  /** Names for every playerKey in the locked/ask lists, resolved server-side. */
  players: z.array(PlayerRef),
  /** The propose tools a switch can apply to, with a one-line description each. */
  tools: z.array(z.object({ name: z.string(), description: z.string() })),
  updatedAt: z.string().nullable(),
});
export const PermissionsUpdate = z.object({ permissions: z.record(z.string(), z.unknown()) });
// GET /api/players/search?q=… → { players: PlayerRef[] }  (exact and near matches, never auto-picks)

// ── team ─────────────────────────────────────────────────────────────────────────────────────
export const Availability = z.object({
  label: z.string(),
  status: z.string().nullable(),
  playProb: z.number(),
  note: z.string().nullable(),
});
export const RosterRow = z.object({
  playerKey: z.string(),
  name: z.string(),
  nhlTeam: z.string(),
  positions: z.string(),
  slot: z.string(),
  availability: Availability,
  gamesThisWeek: z.number(),
  gameToday: z.string().nullable(),
  value: z.number().nullable(),
});
export const TeamView = z.object({
  asOf: z.string(),
  source: z.enum(['yahoo', 'mock']),
  teamName: z.string(),
  week: z.number(),
  opponent: z.string().nullable(),
  roster: z.array(RosterRow),
  health: z.array(z.string()),
  categories: z.array(
    z.object({
      cat: z.string(),
      us: z.number().nullable(),
      them: z.number().nullable(),
      winProb: z.number().nullable(),
    }),
  ),
});
export type TeamView = z.infer<typeof TeamView>;
// GET /api/team → TeamView ; POST /api/team/refresh → TeamView (records a fresh snapshot)

// ── decisions / approvals ───────────────────────────────────────────────────────────────────
export const DecisionCard = z.object({
  planId: z.string(),
  kind: z.string(),
  status: z.string(),
  summary: z.string(),
  rationale: z.string(),
  gateReasons: z.array(z.string()),
  agent: z.string(),
  createdAt: z.string(),
  deadline: z.string().nullable(),
  result: z.string().nullable(),
});
export type DecisionCard = z.infer<typeof DecisionCard>;
// GET  /api/decisions?status=pending|all → { decisions: DecisionCard[] }
// POST /api/decisions/:planId/approve → DecisionCard
// POST /api/decisions/:planId/reject  { reason? } → DecisionCard

// ── chat ─────────────────────────────────────────────────────────────────────────────────────
export const ChatRequest = z.object({
  conversationId: z.string().nullable(),
  text: z.string().min(1).max(4000),
});
// POST /api/chat ChatRequest → text/event-stream of ChatEvent (one JSON object per `data:` line)
export const ChatEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('conversation'), conversationId: z.string() }),
  z.object({ type: z.literal('text'), delta: z.string() }),
  z.object({
    type: z.literal('tool'),
    name: z.string(),
    status: z.enum(['start', 'ok', 'error']),
    detail: z.string().optional(),
  }),
  z.object({ type: z.literal('decision'), card: DecisionCard }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
  z.object({ type: z.literal('done'), usage: z.object({ costUsd: z.number() }).optional() }),
]);
export type ChatEvent = z.infer<typeof ChatEvent>;
export const ChatMessage = z.object({
  id: z.number(),
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  decisions: z.array(DecisionCard),
  createdAt: z.string(),
});
// GET /api/conversations → { conversations: {id, title, updatedAt}[] }
// GET /api/conversations/:id → { id, title, messages: ChatMessage[] }

// ── notifications ───────────────────────────────────────────────────────────────────────────
export const NotificationKind = z.enum([
  'approval',
  'injury',
  'executed',
  'failed',
  'digest',
  'league',
]);
export const NotificationPrefs = z.object({
  kinds: z.record(NotificationKind, z.boolean()),
  quietHours: z.object({ start: z.string(), end: z.string(), tz: z.string() }).nullable(),
});
export const PushSubscribeRequest = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
});
// GET  /api/push/vapid → { publicKey }
// POST /api/push/subscribe PushSubscribeRequest → { ok: true } ; POST /api/push/unsubscribe { endpoint }
// POST /api/push/test → { sent: number }
// GET  /api/settings/notifications → NotificationPrefs ; PUT NotificationPrefs → NotificationPrefs
// GET  /api/notifications → { notifications: {id, kind, title, body, url, createdAt, readAt}[] }
