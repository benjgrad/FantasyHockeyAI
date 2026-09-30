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
 * - `not_actionable` (409): the card no longer offers that action (already executed, dismissed,
 *   sent, or its moment passed); refresh the card.
 * - `turn_in_progress` (409): this conversation already has a running chat turn; the error
 *   object also carries its `turnId`, so the client reattaches instead of sending again.
 * - `turn_gone` (410): the turn finished long enough ago that its events were dropped; reload
 *   the conversation, whose messages are the durable record.
 */
export const ERROR_CODES = [
  'signed_out',
  'yahoo_not_connected',
  'yahoo_reconnect_required',
  'llm_not_configured',
  'not_pending',
  'expired',
  'not_actionable',
  'turn_in_progress',
  'turn_gone',
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
/**
 * What Ben can do with a card, computed server-side from its status, its kind and whether the
 * app can make that move in Yahoo itself (D-015: a human action executes even in dry run):
 * - `execute`: "Do it" — the app makes the move in Yahoo now (POST …/execute).
 * - `openInYahoo`: a link to the right Yahoo page (`yahooUrl`), to do or check it by hand.
 * - `done`: "I did it" — Ben made the move himself; the server confirms it with a fresh read.
 * - `dismiss`: drop a proposal (dry run, or one handed to Ben) without doing it.
 * - `reject`: turn down a plan in the approval queue.
 * - `approve`: reserved for older clients; this server offers `execute` instead.
 */
export const DecisionAction = z.enum([
  'approve',
  'reject',
  'execute',
  'dismiss',
  'openInYahoo',
  'done',
]);
export type DecisionAction = z.infer<typeof DecisionAction>;
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
  /** Empty when there is nothing left to do. Defaults keep older stored chat events parsing. */
  actions: z.array(DecisionAction).default([]),
  /** The Yahoo page for this move (add-player page, or the team page), when known. */
  yahooUrl: z.string().nullable().default(null),
  /** The exact question for the confirm step, e.g. "Add X and drop Y in Yahoo?". */
  confirmText: z.string().nullable().default(null),
});
export type DecisionCard = z.infer<typeof DecisionCard>;
export const DecisionList = z.object({ decisions: z.array(DecisionCard) });
/** "Do it": `confirm` must be the literal `true`, so a stray POST executes nothing. */
export const ExecuteDecisionRequest = z.object({ confirm: z.literal(true) });
export const DismissDecisionRequest = z.object({ reason: z.string().max(500).optional() });
/** What an action did, in words for the card, plus the card as it now stands. */
export const DecisionActionOutcome = z.enum([
  'executed',
  'unverified',
  'failed',
  'needsHuman',
  'denied',
  'invalid',
  'dismissed',
  'confirmed',
  'notConfirmed',
]);
export const DecisionActionResult = z.object({
  card: DecisionCard,
  outcome: DecisionActionOutcome,
  message: z.string(),
});
export type DecisionActionResult = z.infer<typeof DecisionActionResult>;
// GET  /api/decisions?status=pending|all → DecisionList
//      pending: every card that needs Ben (can be done, confirmed or answered), oldest first;
//      all: the newest 100.
// GET  /api/decisions/:planId → DecisionCard, or 404 not_found (what a push deep-links to)
// POST /api/decisions/:planId/approve → DecisionCard
// POST /api/decisions/:planId/reject  { reason? } → DecisionCard
// POST /api/decisions/:planId/execute ExecuteDecisionRequest → DecisionActionResult
//      Makes the move in Yahoo now, even with dry run on (D-015); the gate's deny still wins
//      (outcome `denied`). 409 not_actionable when the card does not offer `execute`.
// POST /api/decisions/:planId/dismiss DismissDecisionRequest → DecisionActionResult (`dismissed`)
// POST /api/decisions/:planId/done → DecisionActionResult: re-reads Yahoo; `confirmed` marks the
//      plan executed, `notConfirmed` leaves it as it was ("Yahoo doesn't show it yet").

// ── chat ─────────────────────────────────────────────────────────────────────────────────────
export const ChatRequest = z.object({
  conversationId: z.string().nullable(),
  text: z.string().min(1).max(4000),
});
/**
 * A chat turn runs on the server to completion whether or not a browser is watching; the HTTP
 * stream only observes it. `POST /api/chat` starts a turn and streams its events; a client that
 * lost the stream resumes with `GET /api/chat/turns/:turnId/events`.
 *
 * SSE framing: one JSON ChatEvent per `data:` line, preceded by `id: <seq>`. `seq` is assigned
 * by the server, starts at 1 and increases by one per event within a turn; it is carried on the
 * `id:` line only (not in the JSON). Resuming with `Last-Event-ID: <seq>` (or `?after=<seq>`)
 * replays every event after it, then streams live ones until `done`. `: ping` comment lines are
 * keep-alives. The first event of every turn is `turn`; the last is `done`.
 */
export const ChatEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('turn'), turnId: z.string(), conversationId: z.string() }),
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
export const ChatTurnStatus = z.enum(['running', 'done', 'failed']);
export const ChatTurn = z.object({
  turnId: z.string(),
  conversationId: z.string(),
  status: ChatTurnStatus,
  /** The seq of the newest event so far. */
  lastSeq: z.number().int().nonnegative(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type ChatTurn = z.infer<typeof ChatTurn>;
export const ChatTurnList = z.object({ turns: z.array(ChatTurn) });
/** The 409 body when a conversation already has a running turn. */
export const TurnInProgressError = z.object({
  error: z.object({ code: z.literal('turn_in_progress'), message: z.string(), turnId: z.string() }),
});
// POST /api/chat ChatRequest → text/event-stream of ChatEvent (see above);
//      409 TurnInProgressError when the conversation already has a running turn.
// GET  /api/chat/turns/:turnId/events (Last-Event-ID or ?after=seq) → text/event-stream of
//      ChatEvent; 404 when unknown or not yours; 410 `turn_gone` when its events were dropped.
// GET  /api/chat/turns?status=running → ChatTurnList (yours only; `running` is the default)
// POST /api/chat/turns/:turnId/cancel → ChatTurn (aborts the model; idempotent once finished)
export const ChatMessage = z.object({
  id: z.number(),
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  decisions: z.array(DecisionCard),
  /** Set when the assistant's turn failed (cut off, cancelled, interrupted by a restart). */
  error: z.object({ code: z.string(), message: z.string() }).optional(),
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
  /** A chat reply finished while no browser was watching it. */
  'chat',
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

// ── players: cards, compare, free-agent browser, category strength ─────────────────────────
// The draft board's player card, adapted to the season. Every number is computed server-side
// from the user's current league snapshot (P1); every playerKey in a request is resolved against
// the league index and an unknown one is a 400 naming it, never a guess (P3).

/** Who holds a player. `waivers` is reserved: snapshots do not record waiver status yet [U]. */
export const PlayerOwner = z.object({
  kind: z.enum(['us', 'team', 'freeAgent', 'waivers']),
  teamKey: z.string().nullable(),
  /** "us", the other team's name, "free agent" or "waivers". */
  name: z.string(),
});
export const PlayerAvailability = z.object({
  label: z.string(),
  status: z.string().nullable(),
  playProb: z.number(),
  /** Where the estimate came from, so a guess is never shown as a fact. */
  source: z.enum(['healthy', 'returnDate', 'note', 'default']),
  expectedReturn: z.string().nullable(),
  /** Team games he is expected to miss over the rest of the season. */
  expectedGamesMissed: z.number(),
  note: z.string().nullable(),
});
/** One scored category for one player, in the league's scoring order. */
export const PlayerCategory = z.object({
  cat: z.string(),
  /** Rest-of-season projection: a count for counting stats, the rate itself for GAA / SV%. */
  total: z.number().nullable(),
  perGame: z.number().nullable(),
  /** Against the rostered pool; always oriented so that higher is better (GAA included). */
  z: z.number().nullable(),
  /** The raw number is better when lower (GAA): colour a delta by `better`, not by sign. */
  lowerIsBetter: z.boolean(),
});
export const PlayerFit = z.object({
  /** In VORP units: positive when his strengths land where our roster is weak. Null: unvalued. */
  fit: z.number().nullable(),
  /**
   * adjustedVorp + fit: value steered towards our needs (the draft board's score with need 1).
   * What "sort by fit" ranks by, so a poor player with a good profile does not top the list.
   */
  score: z.number().nullable(),
  /** The need weights `fit` was computed with (1 is neutral), by category. */
  weights: z.record(z.string(), z.number()),
  /** Our target categories (see CategoryStrength.targets). */
  targets: z.array(z.string()),
  /** Which of our targets he is clearly good at (z ≥ 0.5). */
  targetHits: z.array(z.string()),
});
export const PlayerCard = z.object({
  playerKey: z.string(),
  name: z.string(),
  nhlTeam: z.string(),
  positions: z.array(z.string()),
  /** 'P' skater, 'G' goalie: their categories never diff against each other. */
  positionType: z.enum(['P', 'G']),
  owner: PlayerOwner,
  availability: PlayerAvailability,
  value: z
    .object({
      value: z.number(),
      vorp: z.number(),
      /** VORP net of expected time out (the additive discount the agents use). */
      adjustedVorp: z.number(),
      perGameValue: z.number(),
      /** Rest-of-season projected games, net of expected time out. */
      gp: z.number(),
    })
    .nullable(),
  fit: PlayerFit,
  market: z.object({ adp: z.number().nullable(), percentOwned: z.number().nullable() }),
  lowConfidence: z.boolean(),
  categories: z.array(PlayerCategory),
  schedule: z.object({ gamesThisWeek: z.number(), gameToday: z.string().nullable() }),
  news: z.array(z.string()),
  /** Plain-language reasons generated from the numbers, so they cannot drift from them. */
  reasons: z.array(z.string()),
});
export type PlayerCard = z.infer<typeof PlayerCard>;
// GET /api/players/:playerKey → PlayerCard, or 404 not_found for a key not in the league

export const CategoryDelta = z.object({
  cat: z.string(),
  /** This player's rest-of-season total minus the base player's. Null when either is unknown. */
  delta: z.number().nullable(),
  dz: z.number().nullable(),
  /** True when the difference favours this player (lower-is-better categories inverted). */
  better: z.boolean(),
});
export const CompareDelta = z.object({
  playerKey: z.string(),
  /** False for a skater against a goalie: no diff is given, only each player's own numbers. */
  comparable: z.boolean(),
  byCat: z.array(CategoryDelta),
  terms: z
    .object({
      vorp: z.number().nullable(),
      adjustedVorp: z.number().nullable(),
      fit: z.number().nullable(),
      score: z.number().nullable(),
      perGameValue: z.number().nullable(),
      gp: z.number().nullable(),
    })
    .nullable(),
});
export const CompareResponse = z.object({
  players: z.array(PlayerCard),
  base: z.string(),
  /** One entry per player other than `base`, in request order. */
  deltas: z.array(CompareDelta),
});
export type CompareResponse = z.infer<typeof CompareResponse>;
// GET /api/compare?keys=a,b[,c,d][&base=a] → CompareResponse
//     2–4 distinct keys; unknown keys → 400 invalid_request naming each; base defaults to the first.

export const PlayerListStatus = z.enum(['FA', 'W', 'ours', 'all']);
export const PlayerListRow = z.object({
  playerKey: z.string(),
  name: z.string(),
  nhlTeam: z.string(),
  positions: z.array(z.string()),
  positionType: z.enum(['P', 'G']),
  owner: PlayerOwner,
  availability: z.object({ label: z.string(), playProb: z.number() }),
  vorp: z.number().nullable(),
  adjustedVorp: z.number().nullable(),
  fit: z.number().nullable(),
  /** adjustedVorp + fit (see PlayerFit.score): the `fit` sort's key. */
  score: z.number().nullable(),
  gamesThisWeek: z.number(),
  lowConfidence: z.boolean(),
  /** His best three categories by z, plus the sort category when sorting by one. */
  keyCats: z.array(z.object({ cat: z.string(), z: z.number() })),
});
export type PlayerListRow = z.infer<typeof PlayerListRow>;
export const PlayerList = z.object({
  status: PlayerListStatus,
  sort: z.string(),
  total: z.number(),
  players: z.array(PlayerListRow),
  notes: z.array(z.string()),
});
export type PlayerList = z.infer<typeof PlayerList>;
// GET /api/players?status=FA|W|ours|all&position=C&sort=fit|value|cat:<CAT>&q=&limit=50 → PlayerList
//     defaults: status=FA, sort=fit, limit=50 (max 200). `fit` sorts by score (adjustedVorp + fit),
//     `value` by adjustedVorp, `cat:X` by z in X.

export const CategoryStrengthRow = z.object({
  cat: z.string(),
  /** Our roster's summed rest-of-season z, each player's discounted by his availability. */
  z: z.number(),
  /** League rank of that total, 1 = best of `of` teams. */
  rank: z.number(),
  of: z.number(),
  label: z.enum(['weak', 'average', 'strong', 'saturated']),
  /** This week's matchup win probability, when the matchup can be projected. */
  winProb: z.number().nullable(),
  /** The need weight `fit` uses for this category (1 neutral). */
  weight: z.number(),
  lowerIsBetter: z.boolean(),
});
export const CategoryStrength = z.object({
  asOf: z.string(),
  week: z.number(),
  /** Weakest first: worst league rank, then lowest z. */
  categories: z.array(CategoryStrengthRow),
  /** The need weights behind every card's `fit`. */
  weights: z.record(z.string(), z.number()),
  /** What to target: "targeting: A, PPP". */
  targets: z.array(z.string()),
  /** This week's weights: stored by the matchup agent, else the matchup's suggestion. */
  weekWeights: z.record(z.string(), z.number()).nullable(),
  weekWeightsSource: z.enum(['stored', 'suggested']).nullable(),
});
export type CategoryStrength = z.infer<typeof CategoryStrength>;
// GET /api/team/categories → CategoryStrength

/** The players a decision names, resolved against the league index, so the card can link them. */
export const DecisionPlayers = z.object({ players: z.array(PlayerRef) });
export type DecisionPlayers = z.infer<typeof DecisionPlayers>;
// GET /api/decisions/:planId/players → DecisionPlayers, or 404 not_found
