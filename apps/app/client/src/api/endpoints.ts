import {
  ChatMessage,
  DecisionCard,
  Me,
  NotificationPrefs,
  PermissionsView,
  PlayerRef,
  TeamView,
  YahooConnectResponse,
} from '@fha/api';
import { z } from 'zod';
import { requestJson, send, type FetchLike } from './client';

/** Typed wrappers for every route in the contract (`libs/api/src/index.ts`). */

const f: FetchLike = (input, init) => fetch(input, init);

export type MeT = z.infer<typeof Me>;
export type DecisionCardT = z.infer<typeof DecisionCard>;
export type TeamViewT = z.infer<typeof TeamView>;
export type PlayerRefT = z.infer<typeof PlayerRef>;
export type PermissionsViewT = z.infer<typeof PermissionsView>;
export type NotificationPrefsT = z.infer<typeof NotificationPrefs>;
export type ChatMessageT = z.infer<typeof ChatMessage>;
export type YahooTeamChoiceT = z.infer<typeof YahooConnectResponse>['teams'][number];

const Ok = z.unknown();

export const ConversationSummary = z.object({
  id: z.string(),
  title: z.string().nullable(),
  updatedAt: z.string(),
});
export type ConversationSummaryT = z.infer<typeof ConversationSummary>;
const ConversationList = z.object({ conversations: z.array(ConversationSummary) });
const ConversationDetail = z.object({
  id: z.string(),
  title: z.string().nullable(),
  messages: z.array(ChatMessage),
});
const Decisions = z.object({ decisions: z.array(DecisionCard) });
const PlayerSearch = z.object({ players: z.array(PlayerRef) });
const Vapid = z.object({ publicKey: z.string().nullable() });
const TestSent = z.object({ sent: z.number() });

export const api = {
  me: () => requestJson(f, '/api/me', Me),
  logout: () => send(f, '/auth/logout', { method: 'POST' }),
  logoutEverywhere: () => send(f, '/auth/logout-everywhere', { method: 'POST' }),

  connectYahoo: (T: string, Y: string) =>
    requestJson(f, '/api/settings/yahoo', YahooConnectResponse, {
      method: 'POST',
      body: { T, Y },
    }),
  selectTeam: (leagueKey: string, teamKey: string) =>
    requestJson(f, '/api/settings/yahoo/team', Me, {
      method: 'POST',
      body: { leagueKey, teamKey },
    }),
  disconnectYahoo: () => requestJson(f, '/api/settings/yahoo', Me, { method: 'DELETE' }),

  permissions: () => requestJson(f, '/api/settings/permissions', PermissionsView),
  savePermissions: (permissions: Record<string, unknown>) =>
    requestJson(f, '/api/settings/permissions', PermissionsView, {
      method: 'PUT',
      body: { permissions },
    }),
  searchPlayers: (q: string) =>
    requestJson(f, `/api/players/search?q=${encodeURIComponent(q)}`, PlayerSearch),

  team: () => requestJson(f, '/api/team', TeamView),
  refreshTeam: () => requestJson(f, '/api/team/refresh', TeamView, { method: 'POST' }),

  decisions: (status: 'pending' | 'all') =>
    requestJson(f, `/api/decisions?status=${status}`, Decisions),
  approve: (planId: string) =>
    requestJson(f, `/api/decisions/${encodeURIComponent(planId)}/approve`, DecisionCard, {
      method: 'POST',
    }),
  reject: (planId: string, reason?: string) =>
    requestJson(f, `/api/decisions/${encodeURIComponent(planId)}/reject`, DecisionCard, {
      method: 'POST',
      body: reason ? { reason } : {},
    }),

  conversations: () => requestJson(f, '/api/conversations', ConversationList),
  conversation: (id: string) =>
    requestJson(f, `/api/conversations/${encodeURIComponent(id)}`, ConversationDetail),

  vapid: () => requestJson(f, '/api/push/vapid', Vapid),
  subscribe: (endpoint: string, p256dh: string, auth: string) =>
    requestJson(f, '/api/push/subscribe', Ok, {
      method: 'POST',
      body: { endpoint, keys: { p256dh, auth } },
    }),
  unsubscribe: (endpoint: string) =>
    requestJson(f, '/api/push/unsubscribe', Ok, { method: 'POST', body: { endpoint } }),
  testPush: () => requestJson(f, '/api/push/test', TestSent, { method: 'POST' }),
  notificationPrefs: () => requestJson(f, '/api/settings/notifications', NotificationPrefs),
  saveNotificationPrefs: (prefs: NotificationPrefsT) =>
    requestJson(f, '/api/settings/notifications', NotificationPrefs, {
      method: 'PUT',
      body: prefs,
    }),
};
