import type { ChatMessage, ConversationSummary } from '@fha/api';
import {
  ChatTurn,
  ChatTurnList,
  ConversationDetail,
  ConversationList,
  DecisionActionResult,
  DecisionCard,
  DecisionList,
  Me,
  NotificationList,
  NotificationPrefs,
  PermissionsView,
  PlayerRef,
  PushOk,
  PushTestResult,
  TeamView,
  VapidKey,
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
export type ChatMessageT = ChatMessage;
export type YahooTeamChoiceT = z.infer<typeof YahooConnectResponse>['teams'][number];

export type ConversationSummaryT = ConversationSummary;
export type NotificationItemT = z.infer<typeof NotificationList>['notifications'][number];

/** Not in the contract yet: the search route's response (the server builds it in settingsRoutes). */
const PlayerSearch = z.object({ players: z.array(PlayerRef) });

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
    requestJson(f, `/api/decisions?status=${status}`, DecisionList),
  decision: (planId: string) =>
    requestJson(f, `/api/decisions/${encodeURIComponent(planId)}`, DecisionCard),
  approve: (planId: string) =>
    requestJson(f, `/api/decisions/${encodeURIComponent(planId)}/approve`, DecisionCard, {
      method: 'POST',
    }),
  reject: (planId: string, reason?: string) =>
    requestJson(f, `/api/decisions/${encodeURIComponent(planId)}/reject`, DecisionCard, {
      method: 'POST',
      body: reason ? { reason } : {},
    }),

  /** "Do it" (D-015): makes the move in Yahoo now, even with dry run on. */
  execute: (planId: string) =>
    requestJson(f, `/api/decisions/${encodeURIComponent(planId)}/execute`, DecisionActionResult, {
      method: 'POST',
      body: { confirm: true },
    }),
  dismiss: (planId: string, reason?: string) =>
    requestJson(f, `/api/decisions/${encodeURIComponent(planId)}/dismiss`, DecisionActionResult, {
      method: 'POST',
      body: reason ? { reason } : {},
    }),
  /** "I did it": the server re-reads Yahoo before marking anything executed. */
  done: (planId: string) =>
    requestJson(f, `/api/decisions/${encodeURIComponent(planId)}/done`, DecisionActionResult, {
      method: 'POST',
      body: {},
    }),

  conversations: () => requestJson(f, '/api/conversations', ConversationList),
  conversation: (id: string) =>
    requestJson(f, `/api/conversations/${encodeURIComponent(id)}`, ConversationDetail),
  /** The signed-in user's chat turns still running (to reattach after reopening the app). */
  runningTurns: () => requestJson(f, '/api/chat/turns?status=running', ChatTurnList),
  /** Stops a turn on the server (aborting the model), not just this client's stream. */
  cancelTurn: (turnId: string) =>
    requestJson(f, `/api/chat/turns/${encodeURIComponent(turnId)}/cancel`, ChatTurn, {
      method: 'POST',
    }),

  vapid: () => requestJson(f, '/api/push/vapid', VapidKey),
  subscribe: (endpoint: string, p256dh: string, auth: string) =>
    requestJson(f, '/api/push/subscribe', PushOk, {
      method: 'POST',
      body: { endpoint, keys: { p256dh, auth } },
    }),
  unsubscribe: (endpoint: string) =>
    requestJson(f, '/api/push/unsubscribe', PushOk, { method: 'POST', body: { endpoint } }),
  testPush: () => requestJson(f, '/api/push/test', PushTestResult, { method: 'POST' }),
  notifications: () => requestJson(f, '/api/notifications', NotificationList),
  notificationPrefs: () => requestJson(f, '/api/settings/notifications', NotificationPrefs),
  saveNotificationPrefs: (prefs: NotificationPrefsT) =>
    requestJson(f, '/api/settings/notifications', NotificationPrefs, {
      method: 'PUT',
      body: prefs,
    }),
};
