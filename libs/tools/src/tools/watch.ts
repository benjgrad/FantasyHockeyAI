import { z } from 'zod';
import { isToolEnabled } from '@fha/core';
import { defineTool, fail, ok, type RunContext } from '../context.js';
import { table } from '../derive.js';
import { resolvePlayers } from '../resolve.js';

/**
 * Players the agents follow (D-028). Following is app bookkeeping, never a Yahoo write: the
 * players watcher reads a followed player's status and news with the rest, the rules act on what
 * changes, and Ben sees each entry (with its reason, agent and expiry) on the Activity page.
 * `propose`-risk with a permissions switch, like setCategoryWeights: it changes app state.
 */

/** Agent-added entries a user may have at once. */
export const MAX_AGENT_WATCHES = 25;
export const MAX_WATCH_DAYS = 30;

/** Where the players watcher keeps its last watched set (shared with apps/app's daemon). */
export const watchingKey = (userId: string) => `daemon.watching:${userId}`;

export interface WatchedSet {
  at: string;
  players: {
    playerKey: string;
    name: string;
    nhlTeam: string;
    status: string | null;
    reasons: string[];
  }[];
}

export function readWatchedSet(ctx: Pick<RunContext, 'store'>, userId: string): WatchedSet | undefined {
  const raw = ctx.store.kv.get(watchingKey(userId));
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as WatchedSet;
  } catch {
    return undefined;
  }
}

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString();
}

const NO_USER = 'Following players needs the web app (a signed-in user); nothing was changed.';

function switchedOff(ctx: RunContext, tool: string) {
  return isToolEnabled(ctx.permissions, tool)
    ? undefined
    : fail(`STOP: ${tool} is switched off in permissions. Do not retry.`, false);
}

export const watchPlayers = defineTool({
  name: 'watchPlayers',
  description: `Follow players you want to hear about: their status changes and news are then read every 20 minutes, the rules act on them (e.g. an injured free agent coming back gets an auto-grab check), and Ben sees each one on his Activity page with your reason. Use it for a stash candidate, a trade target, a goalie competing for starts. Our roster is always followed. Give a short reason and how many days (1–${MAX_WATCH_DAYS}, default 14). At most ${MAX_AGENT_WATCHES} followed at once; call getWatchList first.`,
  input: z.object({
    playerKeys: z.array(z.string()).min(1).max(10),
    reason: z.string().min(3).max(200),
    days: z.number().int().min(1).max(MAX_WATCH_DAYS).default(14),
  }),
  risk: 'propose',
  execute: (input, ctx) => {
    const off = switchedOff(ctx, 'watchPlayers');
    if (off !== undefined) return Promise.resolve(off);
    if (ctx.userId === undefined) return Promise.resolve(fail(NO_USER, false));
    const r = resolvePlayers(ctx.view, input.playerKeys);
    if (!r.ok) return Promise.resolve(fail(r.error));
    const ours = r.value.filter((p) => ctx.view.ownerOf(p.playerKey) === ctx.view.teamKey);
    const wanted = r.value.filter((p) => ctx.view.ownerOf(p.playerKey) !== ctx.view.teamKey);
    const live = ctx.store.watchList.active(ctx.userId, ctx.now);
    const already = new Set(live.map((e) => e.playerKey));
    const fresh = wanted.filter((p) => !already.has(p.playerKey));
    if (live.length + fresh.length > MAX_AGENT_WATCHES) {
      const oldest = live[0];
      return Promise.resolve(
        fail(
          `Following ${live.length} already; ${fresh.length} more would pass the limit of ${MAX_AGENT_WATCHES}. ` +
            `Stop following someone first (the oldest is ${oldest === undefined ? '-' : (ctx.view.player(oldest.playerKey)?.name ?? oldest.playerKey)}).`,
        ),
      );
    }
    const days = input.days ?? 14;
    const expiresAt = addDays(ctx.now, days);
    for (const p of wanted) {
      ctx.store.watchList.add({
        userId: ctx.userId,
        playerKey: p.playerKey,
        reason: input.reason,
        addedBy: ctx.agent,
        expiresAt,
      });
    }
    const names = wanted.map((p) => p.name).join(', ');
    if (wanted.length > 0) {
      ctx.activity?.(`👁 The ${ctx.agent} agent now follows ${names} for ${days} days: ${input.reason}`);
    }
    const skipped =
      ours.length === 0 ? '' : ` ${ours.map((p) => p.name).join(', ')} already followed (our roster).`;
    return Promise.resolve(
      ok(
        { following: wanted.map((p) => p.playerKey), expiresAt },
        `${wanted.length === 0 ? 'Nobody new to follow.' : `Following ${names} until ${expiresAt.slice(0, 10)}.`}${skipped}`,
      ),
    );
  },
});

export const stopWatching = defineTool({
  name: 'stopWatching',
  description: 'Stop following players added with watchPlayers (by any agent). Our roster stays followed.',
  input: z.object({ playerKeys: z.array(z.string()).min(1).max(25) }),
  risk: 'propose',
  execute: (input, ctx) => {
    const off = switchedOff(ctx, 'stopWatching');
    if (off !== undefined) return Promise.resolve(off);
    if (ctx.userId === undefined) return Promise.resolve(fail(NO_USER, false));
    const r = resolvePlayers(ctx.view, input.playerKeys);
    if (!r.ok) return Promise.resolve(fail(r.error));
    const userId = ctx.userId;
    const removed = r.value.filter((p) => ctx.store.watchList.remove(userId, p.playerKey));
    if (removed.length > 0) {
      ctx.activity?.(`👁 The ${ctx.agent} agent stopped following ${removed.map((p) => p.name).join(', ')}`);
    }
    return Promise.resolve(
      ok(
        { removed: removed.map((p) => p.playerKey) },
        removed.length === 0
          ? 'None of them were followed by an agent.'
          : `Stopped following ${removed.map((p) => p.name).join(', ')}.`,
      ),
    );
  },
});

export const getWatchList = defineTool({
  name: 'getWatchList',
  description:
    'Everyone the background watchers follow and why: our roster, ask-first and locked players, injured free agents worth an auto-grab, rising free agents, and players an agent chose to follow (with the reason, which agent, and until when).',
  input: z.object({}),
  risk: 'read',
  execute: (_input, ctx) => {
    if (ctx.userId === undefined) return Promise.resolve(fail(NO_USER, false));
    const agentRows = ctx.store.watchList.active(ctx.userId, ctx.now).map((e) => [
      ctx.view.player(e.playerKey)?.name ?? e.playerKey,
      e.playerKey,
      `followed by ${e.addedBy}: ${e.reason}`,
      e.expiresAt.slice(0, 10),
    ]);
    const set = readWatchedSet(ctx, ctx.userId);
    const counts = new Map<string, number>();
    for (const p of set?.players ?? []) {
      const r = p.reasons[0] ?? 'other';
      counts.set(r, (counts.get(r) ?? 0) + 1);
    }
    const lines = [
      set === undefined
        ? 'The players watcher has not run yet.'
        : `Last check ${set.at}: ${[...counts].map(([r, n]) => `${r} ${n}`).join(', ')}.`,
      agentRows.length === 0
        ? 'No players followed by an agent.'
        : `Followed by agents (${agentRows.length} of ${MAX_AGENT_WATCHES}):\n${table(['player', 'playerKey', 'why', 'until'], agentRows)}`,
    ];
    return Promise.resolve(ok({ agentFollowed: agentRows.length, set }, lines.join('\n')));
  },
});
