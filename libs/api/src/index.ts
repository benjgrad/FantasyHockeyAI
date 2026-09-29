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

/**
 * Error codes a client may branch on. Others exist (`invalid_request`, `not_found`, …) and are
 * shown as their message; these ones change what the UI offers:
 * - `signed_out` (401): go to sign-in.
 * - `yahoo_not_connected` / `yahoo_reconnect_required` (409): send Ben to Settings → Yahoo.
 * - `llm_not_configured` (503): the server has no ANTHROPIC_API_KEY, so chat is off; the rest of
 *   the app works. Not retryable until the server is reconfigured.
 * - `not_pending` / `expired` (409): the decision was already settled; refresh the card.
 */
export const ERROR_CODES = [
  'signed_out',
  'yahoo_not_connected',
  'yahoo_reconnect_required',
  'llm_not_configured',
  'not_pending',
  'expired',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

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
/** A plan's life (§9), matching `DECISION_STATUSES` in `@fha/store`. */
export const DecisionStatus = z.enum([
  'proposed',
  'invalid',
  'pending',
  'approved',
  'rejected',
  'expired',
  'executed',
  'failed',
  'unverified',
  'denied',
  'dry_run',
]);
export type DecisionStatus = z.infer<typeof DecisionStatus>;
export const DecisionCard = z.object({
  planId: z.string(),
  kind: z.string(),
  status: DecisionStatus,
  summary: z.string(),
  rationale: z.string(),
  gateReasons: z.array(z.string()),
  agent: z.string(),
  createdAt: z.string(),
  deadline: z.string().nullable(),
  result: z.string().nullable(),
});
export type DecisionCard = z.infer<typeof DecisionCard>;
export const DecisionList = z.object({ decisions: z.array(DecisionCard) });
// GET  /api/decisions?status=pending|all → DecisionList (all: the newest 100)
// GET  /api/decisions/:planId → DecisionCard, or 404 not_found (what a push deep-links to)
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
export type ChatMessage = z.infer<typeof ChatMessage>;
export const ConversationSummary = z.object({
  id: z.string(),
  title: z.string().nullable(),
  updatedAt: z.string(),
});
export type ConversationSummary = z.infer<typeof ConversationSummary>;
export const ConversationList = z.object({ conversations: z.array(ConversationSummary) });
export const ConversationDetail = z.object({
  id: z.string(),
  title: z.string().nullable(),
  messages: z.array(ChatMessage),
});
export type ConversationDetail = z.infer<typeof ConversationDetail>;
// GET /api/conversations → ConversationList (newest first)
// GET /api/conversations/:id → ConversationDetail, or 404

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
/** `publicKey` is null when the server has no VAPID keys: push is off, everything else works. */
export const VapidKey = z.object({ publicKey: z.string().nullable() });
export const PushUnsubscribeRequest = z.object({ endpoint: z.string().url() });
export const PushOk = z.object({ ok: z.literal(true) });
export const PushTestResult = z.object({ sent: z.number().int().nonnegative() });
export const NotificationItem = z.object({
  id: z.number(),
  /** A NotificationKind; kept open so a newer server's kind still renders. */
  kind: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  url: z.string().nullable(),
  createdAt: z.string(),
  readAt: z.string().nullable(),
});
export const NotificationList = z.object({ notifications: z.array(NotificationItem) });
// GET  /api/push/vapid → VapidKey
// POST /api/push/subscribe PushSubscribeRequest → PushOk ; POST /api/push/unsubscribe PushUnsubscribeRequest → PushOk
// POST /api/push/test → PushTestResult
// GET  /api/settings/notifications → NotificationPrefs ; PUT NotificationPrefs → NotificationPrefs
// GET  /api/notifications → NotificationList (unread, newest first)
