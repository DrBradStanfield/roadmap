/**
 * The router stage every chat surface runs (web and iPhone, Discord, YouTube):
 * one router call, then the caller's report policy on its result (US-15 AC74).
 * Web and Discord pass reportRouterFailure (one alert per failed turn); YouTube
 * passes its tick counter, since a failed comment is retried every tick
 * (US-15 AC58). First step of S-1's shared router stage. Its own module so a
 * test's mock of routeQuery or reportRouterFailure still reaches this call.
 */
import { routeQuery, sanitizeForRouter, type RouterResult } from './chat-router.server';
import type { ChatPurpose } from './anthropic.server';

/** What the router and classifier read from a turn: the question and its conversation so far. */
export interface RouterTurn {
  current: string;
  first: string | undefined;
  recent: string[];
}

/**
 * The one rule for that input on every surface (US-15 AC75): the question, the
 * conversation's first user turn and its last three user turns, each through
 * sanitizeForRouter. Assistant turns are left out. `history` is oldest first
 * and excludes the question: the web's turns, Discord's channel messages, or
 * the YouTube parent comment and the follow-up author's earlier replies
 * (buildRouterThreadHistory).
 */
export function routerTurn(message: string, history: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>): RouterTurn {
  const user = history.filter(m => m.role === 'user').map(m => sanitizeForRouter(m.content));
  return { current: sanitizeForRouter(message), first: user[0], recent: user.slice(-3) };
}

export async function runRouter(
  turn: RouterTurn,
  purpose: ChatPurpose,
  report: (result: RouterResult) => void,
  model?: string,
): Promise<RouterResult> {
  const result = await routeQuery(turn.current, turn.first, turn.recent, purpose, model);
  report(result);
  return result;
}
