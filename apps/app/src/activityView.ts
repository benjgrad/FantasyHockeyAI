import type { ActivityView } from '@fha/api';
import { JOB_TABLE, assistantTools, type JobName } from '@fha/agents';
import { TOOL_FOR_KIND, isToolEnabled, type PlanKind } from '@fha/core';
import { getPrompt } from '@fha/prompts';
import { AGENT_TOOLS } from '@fha/tools';
import { userPermissions } from './permissions.js';
import { existingActivityConversation } from './activity.js';
import { FIXED_SLOTS, PREGAME_LEAD_MS } from './daemon/schedule.js';
import { WATCHERS, loadWatcherRuns, loadWatching, type WatcherName } from './daemon/watchers.js';
import type { Services } from './services.js';

/**
 * What the agents follow and when they act (D-027), for the Activity view: the players the last
 * poll watched and why, each watcher's last run, the schedule, and what each kind of change
 * triggers. The rule list is a plain description of `daemon/rules.ts`; keep them in step.
 */
const WATCHER_WHAT: Record<WatcherName, string> = {
  players: 'Status and news of the players below',
  transactions: 'League adds, drops and trades, and trade offers to us',
  goalies: "Our goalies' and their teammates' starting flags, on days they play",
  scoreboard: "This week's live matchup score",
};

/** What each kind of change triggers, and which agent it runs (keep in step with rules.ts). */
export const RULES: (ActivityView['rules'][number] & { job?: string })[] = [
  {
    when: 'One of our players goes out (O, IR, NA, …)',
    then: 'Notify you; run the lineup agent (and the waivers agent if the roster is short)',
    job: 'lineup',
  },
  {
    when: 'One of our players goes out and the roster is short',
    then: 'Run the waivers agent',
    job: 'waivers',
  },
  {
    when: 'One of our starters turns DTD on a game day',
    then: 'Notify you; run the lineup agent',
    job: 'lineup',
  },
  {
    when: 'One of ours is newly IR-eligible (e.g. NA → IR-NR)',
    then: 'Notify you; run the lineup agent to use an open IR seat',
    job: 'lineup',
  },
  {
    when: 'One of ours is back from out',
    then: 'Notify you; run the lineup agent to activate him',
    job: 'lineup',
  },
  {
    when: 'A watched free agent is back from out, or another team drops a player',
    then: 'Auto-grab check in code; acts only above the auto-grab minimum gain',
  },
  {
    when: "Yahoo's starting flag contradicts one of our goalies' slot today",
    then: 'Notify you; run the lineup agent to fix the G slots',
    job: 'lineup',
  },
  { when: 'A trade offer arrives', then: 'Run the trades agent', job: 'trades' },
  {
    when: 'News on a watched player',
    then: 'Kept for the league review and the agents; no action on its own',
  },
];

const DAY = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function activityView(s: Services, userId: string): ActivityView {
  const watching = loadWatching(s, userId);
  const runs = loadWatcherRuns(s, userId);
  const schedule: ActivityView['schedule'] = [
    ...FIXED_SLOTS.map((x) => ({
      job: x.job,
      when: `${x.days === undefined ? 'daily' : x.days.map((d) => DAY[d]).join(', ')} ${x.time}`,
    })),
    { job: 'lineup', when: `${Math.round(PREGAME_LEAD_MS / 60_000)} min before our first game` },
  ];
  return {
    conversationId: existingActivityConversation(s.store, userId) ?? null,
    watchedAt: watching?.at ?? null,
    players: watching?.players ?? [],
    watchers: WATCHERS.map((w) => {
      const last = runs[w.name];
      return {
        name: w.name,
        what: WATCHER_WHAT[w.name],
        everyMinutes: Math.round(w.intervalMs / 60_000),
        last:
          last === undefined
            ? null
            : { at: last.at, ok: last.ok, events: last.events, error: last.error ?? null },
      };
    }),
    schedule,
    rules: RULES.map(({ when, then }) => ({ when, then })),
    followed: s.store.watchList.active(userId, s.now().toISOString()).map((e) => ({
      playerKey: e.playerKey,
      name: s.league.peek(userId)?.view.player(e.playerKey)?.name ?? e.playerKey,
      reason: e.reason,
      addedBy: e.addedBy,
      expiresAt: e.expiresAt,
    })),
    agents: agentsView(s, userId, schedule),
  };
}

/** Each agent from its sources of truth: prompt, models config, schedule, rules, tools, permissions. */
function agentsView(
  s: Services,
  userId: string,
  schedule: ActivityView['schedule'],
): ActivityView['agents'] {
  const perms = userPermissions(s.store, s.config.permissionsFile, userId);
  const modelOf = (name: string) =>
    s.config.models?.agents[name] ?? s.config.models?.default ?? 'default model';
  const purposeOf = (name: string, fallback: string) => {
    try {
      return getPrompt(s.prompts, `${name}.system`).description;
    } catch {
      return fallback;
    }
  };
  const kindOfTool = new Map(Object.entries(TOOL_FOR_KIND).map(([k, t]) => [t, k as PlanKind]));
  const mayFor = (tools: readonly string[]) => {
    const out = tools.flatMap((t) => {
      const kind = kindOfTool.get(t);
      if (kind !== undefined) return [`${kind}: ${perms.plans[kind]?.mode ?? 'deny'}`];
      if (t === 'setCategoryWeights') return ["store this week's category weights"];
      if (t === 'watchPlayers') return ['follow players'];
      return [];
    });
    return out.length === 0
      ? ['read only: proposes nothing']
      : [...out, ...(perms.dryRun ? ['dry run: nothing executes without you'] : [])];
  };
  const lastOf = (job: string) => {
    const r = s.store.runs.latestFinished(job);
    return r === undefined
      ? null
      : {
          at: r.startedAt,
          status: r.status,
          summary: r.summary?.split('\n')[0]?.slice(0, 200) ?? null,
        };
  };
  const scheduled = (job: string) => schedule.filter((x) => x.job === job).map((x) => x.when);
  const triggered = (job: string) => RULES.filter((r) => r.job === job).map((r) => r.when);
  const agents = (Object.keys(JOB_TABLE) as JobName[]).map((job) => {
    const tools = AGENT_TOOLS[JOB_TABLE[job].agent].filter((t) => isToolEnabled(perms, t));
    return {
      name: job,
      purpose: purposeOf(JOB_TABLE[job].agent, JOB_TABLE[job].intent),
      model: modelOf(JOB_TABLE[job].agent),
      schedule: scheduled(job),
      triggers: triggered(job),
      tools,
      may: mayFor(tools),
      lastRun: lastOf(job),
    };
  });
  const chatTools = assistantTools(perms).map((t) => t.name);
  return [
    ...agents,
    {
      name: 'assistant',
      purpose: purposeOf('assistant', 'Chat assistant.'),
      model: modelOf('assistant'),
      schedule: [],
      triggers: ['A message from you in chat'],
      tools: chatTools,
      may: ['proposes moves as cards that wait for your tap'],
      lastRun: lastOf('assistant'),
    },
  ];
}
