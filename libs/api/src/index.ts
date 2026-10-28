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
    /** When the website (writes, keepalive) last worked, and who set an expiry (D-033). */
    siteOkAt: z.string().nullable().default(null),
    expiredBy: z.enum(['api', 'site']).nullable().default(null),
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
  /**
   * Every other cookie from the pasted request (D-033: A1, A3, A1S… keep the website signed
   * in). Names are cookie tokens; bounded so a paste cannot grow without limit. Never logged.
   */
  cookies: z
    .record(z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/), z.string().max(4096))
    .refine((c) => Object.keys(c).length <= 60, 'too many cookies')
    .optional(),
});
export const YahooTeamChoice = z.object({
  leagueKey: z.string(),
  leagueName: z.string(),
  teamKey: z.string(),
  teamName: z.string(),
  season: z.string(),
});
export const YahooConnectResponse = z.object({
  teams: z.array(YahooTeamChoice),
  /** The team now managed without asking: the one already chosen, or the account's only team. */
  selected: YahooTeamChoice.optional(),
});
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

/**
 * What the agents follow and when they act (D-027): the players the last poll watched and why,
 * each watcher's last run, the schedule and the event rules; and the Background activity chat.
 */
export const ActivityView = z.object({
  conversationId: z.string().nullable(),
  watchedAt: z.string().nullable(),
  players: z.array(
    z.object({
      playerKey: z.string(),
      name: z.string(),
      nhlTeam: z.string(),
      status: z.string().nullable(),
      reasons: z.array(z.string()),
    }),
  ),
  watchers: z.array(
    z.object({
      name: z.string(),
      what: z.string(),
      everyMinutes: z.number(),
      last: z
        .object({
          at: z.string(),
          ok: z.boolean(),
          events: z.number(),
          error: z.string().nullable(),
        })
        .nullable(),
    }),
  ),
  schedule: z.array(z.object({ job: z.string(), when: z.string() })),
  rules: z.array(z.object({ when: z.string(), then: z.string() })),
  /** Players an agent chose to follow (D-028); Ben can stop any of them. */
  followed: z
    .array(
      z.object({
        playerKey: z.string(),
        name: z.string(),
        reason: z.string(),
        addedBy: z.string(),
        expiresAt: z.string(),
      }),
    )
    .default([]),
  /** Every agent: what it is for, its model, when it runs, its tools, what it may do (D-028). */
  agents: z
    .array(
      z.object({
        name: z.string(),
        purpose: z.string(),
        model: z.string(),
        schedule: z.array(z.string()),
        triggers: z.array(z.string()),
        tools: z.array(z.string()),
        may: z.array(z.string()),
        lastRun: z
          .object({ at: z.string(), status: z.string(), summary: z.string().nullable() })
          .nullable(),
      }),
    )
    .default([]),
});
export type ActivityView = z.infer<typeof ActivityView>;
// GET /api/activity → ActivityView
// DELETE /api/activity/watch/:playerKey → ActivityView (stop following a player an agent added)

/** Shadow, then switch (D-026): where the other value lens would have decided differently. */
export const ShadowReportView = z.object({
  since: z.string(),
  counts: z.record(z.string(), z.number()),
  rows: z.array(
    z.object({
      date: z.string(),
      decision: z.enum(['lineup', 'autoGrab', 'protected', 'trades', 'waivers']),
      activeLens: z.enum(['preseason', 'rest-of-season']),
      summary: z.string(),
      outcome: z.string().optional(),
    }),
  ),
});
export type ShadowReportView = z.infer<typeof ShadowReportView>;
// GET /api/settings/shadow?days=14 → ShadowReportView (the user's league; days 1–60, default 14)
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
  /** Preseason value (the seed's §12.2 value). */
  value: z.number().nullable(),
  /** Rest of season (D-026): VOFA, CWA and the 7-day VOLS change; null when unavailable. */
  now: z
    .object({ vofa: z.number(), cwa: z.number().nullable(), delta7d: z.number().nullable() })
    .nullable()
    .optional(),
});
/** `GET /api/league/status`: how fresh the league data on the page is. */
export const LeagueStatus = z.object({
  /** When the snapshot the pages are serving was recorded; null before the first one. */
  asOf: z.string().nullable(),
  /** A rebuild from Yahoo is running; pages refetch when it finishes. */
  refreshing: z.boolean(),
  /** Older than the 15-minute refresh age. */
  stale: z.boolean(),
  /** When the latest rebuild failed (the pages then show the older snapshot); null when it did not. */
  failedAt: z.string().nullable().default(null),
  /** Why it failed, as an error code (`yahoo_unavailable`, `yahoo_reconnect_required`). */
  failure: z.string().nullable().default(null),
  /** The last NHL game date the stats (and so ROS values) include. */
  statsThrough: z.string().nullable().default(null),
});
export type LeagueStatus = z.infer<typeof LeagueStatus>;

/** `GET /api/players/:key/form` (D-025): game-level form, both projection lenses, forecasts. */
export const PlayerFormView = z.object({
  playerKey: z.string(),
  kind: z.enum(['skater', 'goalie', 'none']),
  asOf: z.string(),
  trends: z.array(
    z.object({
      cat: z.string(),
      recent: z.number(),
      baseline: z.number(),
      z: z.number(),
      nRecent: z.number(),
      label: z.string(),
    }),
  ),
  /** Per-game values by window (goalies: starts, W, SV%, GAA). */
  windows: z.array(
    z.object({ label: z.string(), gp: z.number(), values: z.record(z.string(), z.number()) }),
  ),
  /** Rolling 10-game average per category, oldest to newest, for sparklines. */
  series: z.array(z.object({ cat: z.string(), points: z.array(z.number()), baseline: z.number() })),
  lens: z
    .object({
      inSeason: z.record(z.string(), z.number()),
      preseason: z.record(z.string(), z.number()),
      gpCurrent: z.number(),
      weightCurrent: z.number(),
    })
    .nullable(),
  forecast: z.array(
    z.object({
      days: z.number(),
      scheduled: z.number(),
      expectedGames: z.number(),
      totals: z.record(z.string(), z.number()),
      lens: z.string(),
      goalie: z.object({ svPct: z.number(), gaa: z.number(), startShare: z.number() }).nullable(),
    }),
  ),
  games: z.array(
    z.object({
      date: z.string(),
      opponent: z.string(),
      home: z.boolean(),
      line: z.record(z.string(), z.number()),
    }),
  ),
});
export type PlayerFormView = z.infer<typeof PlayerFormView>;

/** `GET /api/league/forecast` (D-025): every team's typical week against every other. */
export const SeasonForecastView = z.object({
  lens: z.string(),
  teams: z.array(
    z.object({
      teamKey: z.string(),
      name: z.string(),
      us: z.boolean(),
      expectedCatsWon: z.number(),
      pWinWeek: z.number(),
      vsUs: z.number().nullable(),
    }),
  ),
  categories: z.number(),
});
export type SeasonForecastView = z.infer<typeof SeasonForecastView>;

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
      /** Projected final: the score so far plus the projected games not yet started. */
      us: z.number().nullable(),
      them: z.number().nullable(),
      winProb: z.number().nullable(),
      /** The score so far from Yahoo's scoreboard; absent when it was not read. */
      usNow: z.number().nullable().optional(),
      themNow: z.number().nullable().optional(),
      /** No remaining game can change the winner. */
      decided: z.boolean().optional(),
    }),
  ),
  /** When the scoreboard behind usNow/themNow was read; null when it was not. */
  liveAsOf: z.string().nullable().optional(),
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
  /**
   * Ask with timeout (D-018): while the plan is pending, the instant it executes on its own
   * unless Ben rejects it first (with dry run on it waits instead). Null otherwise.
   */
  autoApproveAt: z.string().nullable().default(null),
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
//      Rejecting an ask with timeout before its `autoApproveAt` cancels it; it never executes.
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
    /** The tool's result (or error) in full, for the chip's expanded view. */
    detail: z.string().optional(),
    /** What the model asked the tool for, as `key: value` lines. Sent with `start`. */
    input: z.string().optional(),
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
  /**
   * `background`: written by the daemon into the Background activity chat (D-027). A user-role
   * background message is a trigger (a schedule slot, a Yahoo change), not something Ben said.
   */
  source: z.literal('background').optional(),
  /** The tools the turn called, in order, as stored (a short result, not the full one). */
  tools: z
    .array(
      z.object({
        name: z.string(),
        ok: z.boolean(),
        detail: z.string().optional(),
        input: z.string().optional(),
      }),
    )
    .optional(),
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
  /**
   * In VORP units: positive when his strengths land where our needs are. Read from the
   * rest-of-season lens (D-040), like VOLS and CWA; `lens` says when it fell back. Null: unvalued.
   */
  fit: z.number().nullable(),
  /**
   * Adjusted VOLS + fit on the same lens: value steered towards our needs. What "sort by fit"
   * ranks by, so a poor player with a good profile does not top the list.
   */
  score: z.number().nullable(),
  /** The values fit was read from: rest of season, or preseason when that lens was unavailable. */
  lens: z.enum(['rest-of-season', 'preseason']),
  /** The need weights `fit` was computed with (1 is neutral), by category. */
  weights: z.record(z.string(), z.number()),
  /** Our target categories (see CategoryStrength.targets). */
  targets: z.array(z.string()),
  /** Which of our targets he is clearly good at (z ≥ 0.5). */
  targetHits: z.array(z.string()),
});
/**
 * The mid-season value family (D-026) on the rest-of-season lens, beside the preseason `value`.
 * The glossary (`@fha/core` GLOSSARY) defines each number; the client's explainers show it.
 */
export const RefName = z.object({ playerKey: z.string(), name: z.string() });
export const ValueNowView = z.object({
  lens: z.string(),
  value: z.number(),
  vols: z.number(),
  adjusted: z.number(),
  perGameValue: z.number(),
  vofa: z.number(),
  vofaPosition: z.string().nullable(),
  vofaAgainst: RefName.nullable(),
  cwa: z.number().nullable(),
  /** Δ P(win a typical week) against the field (D-034); 0..1 scale. */
  dWin: z.number().nullable().optional(),
  cwaByCategory: z.record(z.string(), z.number()),
  cwaSwap: RefName.nullable(),
  weekCwa: z.number().nullable(),
  gpCurrent: z.number(),
  weightCurrent: z.number(),
  lowConfidence: z.boolean(),
  luck: z
    .object({
      stat: z.enum(['SH%', 'SV%']),
      recent: z.number(),
      baseline: z.number(),
      z: z.number(),
      games: z.number(),
      label: z.enum(['lucky', 'unlucky', 'normal', 'too small a sample']),
    })
    .nullable(),
  trend: z
    .object({
      sincePreseason: z.number().nullable(),
      since7d: z.number().nullable(),
      sinceYesterday: z.number().nullable(),
      series: z.array(z.object({ date: z.string(), vols: z.number() })),
    })
    .nullable(),
});
export type ValueNowView = z.infer<typeof ValueNowView>;

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
  /** Rest of season (D-026); absent when the value family could not be built (P9). */
  now: ValueNowView.nullable().optional(),
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
  /** Categories labelled hot or cold over his last 10 games (D-025); null: no game history. */
  form: z
    .object({ hot: z.array(z.string()), cold: z.array(z.string()) })
    .nullable()
    .optional(),
  /** Rest-of-season measures (D-026); null when unavailable. */
  now: z
    .object({
      vols: z.number(),
      vofa: z.number(),
      cwa: z.number().nullable(),
      dWin: z.number().nullable().optional(),
      weekCwa: z.number().nullable(),
      delta7d: z.number().nullable(),
      luck: z.enum(['lucky', 'unlucky', 'normal', 'too small a sample']).nullable(),
      lowConfidence: z.boolean(),
    })
    .nullable()
    .optional(),
});
export type PlayerListRow = z.infer<typeof PlayerListRow>;
export const PlayerList = z.object({
  status: PlayerListStatus,
  sort: z.string(),
  total: z.number(),
  players: z.array(PlayerListRow),
  notes: z.array(z.string()),
  /**
   * A name search that missed the league's player pool and found these on Yahoo (D-032). They
   * are being added to the pool; they appear in `players` when the background refresh lands.
   */
  found: z
    .array(z.object({ playerKey: z.string(), name: z.string(), nhlTeam: z.string() }))
    .optional(),
});
export type PlayerList = z.infer<typeof PlayerList>;
// GET /api/players?status=FA|W|ours|all&position=C&sort=fit|value|cwa|win|vofa|ros|cat:<CAT>&q=&limit=50
//     → PlayerList. Defaults: status=FA, sort=fit, limit=50 (max 200). `fit` sorts by score
//     (adjustedVorp + fit), `value` by adjustedVorp (preseason), `cwa`/`vofa`/`ros` by the
//     rest-of-season CWA, VOFA and VOLS (D-026), `win` by ΔWin% (D-034), `cat:X` by z in X.

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

/** One version of the season strategy (D-034): the plan every agent run and chat starts from. */
export const SeasonStrategyVersion = z.object({
  id: z.number(),
  createdAt: z.string(),
  author: z.string(),
  stance: z.enum(['contend', 'hold', 'sell']),
  targets: z.array(z.string()),
  surplus: z.array(z.string()),
  punts: z.array(z.string()),
  principles: z.array(z.string()),
  rationale: z.string(),
  reviewBy: z.string().nullable(),
  /** What differs from the version before it, e.g. "targets was SOG, A"; empty for the first. */
  changes: z.array(z.string()),
});
export const StrategyAuditRow = z.object({
  cat: z.string(),
  /** Mean P(win this category) against the league field. */
  pField: z.number(),
  /** ΔP(win a week) weight, averaging 1 across categories. */
  weight: z.number(),
  stance: z.enum(['saturated', 'contested', 'lost']),
});
export const StrategyView = z.object({
  /** Newest first; empty until an agent (or chat) records one. */
  versions: z.array(SeasonStrategyVersion),
  /** Code's audit of the season, recomputed now; null when it cannot be built (P9). */
  audit: z
    .object({
      pWinWeek: z.number(),
      expectedCats: z.number(),
      categories: z.array(StrategyAuditRow),
    })
    .nullable(),
  /** What waivers and trades rank by: the old measure, or P(win the week). */
  objective: z.enum(['legacy', 'winWeek']),
});
export type StrategyView = z.infer<typeof StrategyView>;
// GET /api/strategy → StrategyView (the last 10 versions)

/** The players a decision names, resolved against the league index, so the card can link them. */
export const DecisionPlayers = z.object({ players: z.array(PlayerRef) });
export type DecisionPlayers = z.infer<typeof DecisionPlayers>;
// GET /api/decisions/:planId/players → DecisionPlayers, or 404 not_found

// ── League comparison ────────────────────────────────────────────────────────────────────────
//
// How every team stacks up per category, and each one head to head against us. All numbers are
// computed on the server from the snapshot (P1); see `libs/tools/src/leagueCompare.ts` for the
// definitions: strength = summed availability-discounted z (higher is better in every category,
// GAA included, so rank 1 is always the strongest); weekly = a typical 3.5-team-game week.

export const LeagueCategoryMeta = z.object({
  cat: z.string(),
  group: z.enum(['skater', 'goalie']),
  lowerIsBetter: z.boolean(),
});
export const TeamCategoryCell = z.object({
  cat: z.string(),
  /** Summed rest-of-season z, each player's scaled by his expected availability. */
  z: z.number(),
  /** 1 = strongest of `of` teams; ties share the better rank. GAA is already inverted. */
  rank: z.number(),
  /** Typical-week projected total (a rate for SV% and GAA). */
  weekly: z.number(),
});
export const TeamStrengthRow = z.object({
  teamKey: z.string(),
  name: z.string(),
  isUs: z.boolean(),
  categories: z.array(TeamCategoryCell),
  /** Σ availability-adjusted VORP of the typical-week starters. */
  starterVorp: z.number(),
  /** Season starters (health-blind) who are not healthy. */
  injuredStarters: z.number(),
  /** Scheduled games of the starters, snapshot date to the end of this week. */
  gamesThisWeek: z.number(),
  /**
   * This week so far, from Yahoo's scoreboard (D-025): each category's total ranked across the
   * league this week, and the score in categories against this team's own opponent.
   */
  live: z
    .object({
      opponent: z.string().nullable(),
      leading: z.number(),
      trailing: z.number(),
      cells: z.array(z.object({ cat: z.string(), value: z.number(), rank: z.number() })),
    })
    .nullable()
    .optional(),
  /** Against us; null on our own row. */
  vsUs: z
    .object({
      /** Categories *they* expect to win against us in a typical week: Σ (1 − our win prob). */
      theirExpectedWon: z.number(),
      /** Categories *we* expect to win against them in a typical week: Σ our win probs. */
      ourExpectedWon: z.number(),
      /** Ours over the rest of this week's real schedule; null when unprojectable. */
      thisWeekOurExpectedWon: z.number().nullable(),
      complementarity: z.number(),
    })
    .nullable(),
});
export type TeamStrengthRow = z.infer<typeof TeamStrengthRow>;

export const PlayerMini = z.object({ playerKey: z.string(), name: z.string() });
export const TradeIdea = z.object({
  partnerTeamKey: z.string(),
  partnerName: z.string(),
  give: z.array(PlayerMini),
  get: z.array(PlayerMini),
  /** Δ expected categories won per week against the whole league (§12.7), us and them. */
  ourGain: z.number(),
  theirGain: z.number(),
  reasons: z.array(z.string()),
});
export type TradeIdea = z.infer<typeof TradeIdea>;

export const ProfileFix = z.object({
  route: z.enum(['FA', 'trade', 'none']),
  /** Best free agent's discounted z in the category, less the player he would replace. */
  faGain: z.number().nullable(),
  /** Best 1-for-1 trade idea's net discounted z in the category. */
  tradeGain: z.number().nullable(),
  how: z.string(),
  players: z.array(PlayerMini),
});
export const ProfileCategory = z.object({
  cat: z.string(),
  rank: z.number(),
  weekly: z.number(),
  fix: ProfileFix.nullable(),
});
export const LeagueProfile = z.object({
  /** Rank ≤ 2. */
  strengths: z.array(ProfileCategory),
  /** Rank ≥ of − 1 (7th or 8th of 8), the biggest available fix first. */
  weaknesses: z.array(ProfileCategory),
  /** True when no category ranks that low and `weaknesses` are our two worst-ranked instead. */
  weaknessesRelative: z.boolean(),
});
export const TradePartner = z.object({
  teamKey: z.string(),
  name: z.string(),
  complementarity: z.number(),
  reason: z.string(),
});
export const LeagueCompare = z.object({
  asOf: z.string(),
  week: z.number(),
  of: z.number(),
  typicalWeekGames: z.number(),
  categories: z.array(LeagueCategoryMeta),
  /** Ours first. */
  teams: z.array(TeamStrengthRow),
  profile: LeagueProfile,
  /** Most complementary first. */
  partners: z.array(TradePartner),
  /** The projection lens the ranks were built on. */
  lens: z.string().optional(),
  notes: z.array(z.string()),
});
export type LeagueCompare = z.infer<typeof LeagueCompare>;
// GET /api/league/compare → LeagueCompare

export const HeadToHeadCategory = z.object({
  cat: z.string(),
  group: z.enum(['skater', 'goalie']),
  lowerIsBetter: z.boolean(),
  ours: z.number(),
  theirs: z.number(),
  /** ours − theirs, raw (negative GAA delta is good for us). */
  delta: z.number(),
  /** P(we win the category) in a typical week. */
  winProb: z.number(),
  thisWeekWinProb: z.number().nullable(),
  /** 35% ≤ winProb ≤ 65%. */
  swing: z.boolean(),
  /** Oriented gap in standard deviations of the weekly difference (negative: we trail). */
  gapSd: z.number(),
  ourRank: z.number(),
  theirRank: z.number(),
  ourTop: z.array(PlayerMini.extend({ z: z.number() })),
  theirTop: z.array(PlayerMini.extend({ z: z.number() })),
});
export const HeadToHead = z.object({
  asOf: z.string(),
  us: z.object({ teamKey: z.string(), name: z.string() }),
  them: z.object({ teamKey: z.string(), name: z.string() }),
  typicalWeekGames: z.number(),
  /** Categories we expect to win (Σ win probs), typical week and rest of this week. */
  expectedWon: z.object({ typical: z.number(), thisWeek: z.number().nullable() }),
  categories: z.array(HeadToHeadCategory),
  /** Categories we trail in, the smallest gap relative to its spread first. */
  flipOrder: z.array(z.string()),
  complementarity: z.number(),
  tradeIdeas: z.array(TradeIdea),
  notes: z.array(z.string()),
});
export type HeadToHead = z.infer<typeof HeadToHead>;
// GET /api/league/compare/:teamKey → HeadToHead, or 404 not_found (unknown team or our own)

// ── Mentions ─────────────────────────────────────────────────────────────────────────────────
//
// What chat links: every player and team the league index knows, by display name. The client
// links a name only when it resolves to exactly one of these keys (P3); it never guesses.

export const MentionIndex = z.object({
  asOf: z.string(),
  /** `aliases`: nicknames and first-name forms ("Ovi", "Nate MacKinnon"), when he has any. */
  players: z.array(PlayerMini.extend({ aliases: z.array(z.string()).optional() })),
  teams: z.array(z.object({ teamKey: z.string(), name: z.string(), isUs: z.boolean() })),
});
export type MentionIndex = z.infer<typeof MentionIndex>;
// GET /api/league/names → MentionIndex

export const TeamRosterEntry = z.object({
  playerKey: z.string(),
  name: z.string(),
  /** The roster slot he is in today (C, LW, BN, IR+…). */
  slot: z.string(),
  nhlTeam: z.string(),
  eligible: z.array(z.string()),
  /** Yahoo's injury status (DTD, IR…); null when healthy. */
  status: z.string().nullable(),
});
export const TeamSheet = z.object({
  asOf: z.string(),
  teamKey: z.string(),
  name: z.string(),
  manager: z.string().nullable(),
  isUs: z.boolean(),
  roster: z.array(TeamRosterEntry),
});
export type TeamSheet = z.infer<typeof TeamSheet>;
// GET /api/league/teams/:teamKey → TeamSheet, or 404 not_found (no such team in the league)
