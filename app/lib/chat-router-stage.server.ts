/**
 * The router stage every chat surface runs (web and iPhone, Discord, YouTube):
 * one router call, then the caller's report policy on its result (US-15 AC74).
 * Web and Discord pass reportRouterFailure (one alert per failed turn); YouTube
 * passes its tick counter, since a failed comment is retried every tick
 * (US-15 AC58). First step of S-1's shared router stage. Its own module so a
 * test's mock of routeQuery or reportRouterFailure still reaches this call.
 */
import { routeQuery, type RouterResult } from './chat-router.server';
import type { ChatPurpose } from './anthropic.server';

export async function runRouter(
  currentMessage: string,
  firstMessage: string | undefined,
  recentUserMessages: string[] | undefined,
  purpose: ChatPurpose,
  report: (result: RouterResult) => void,
): Promise<RouterResult> {
  const result = await routeQuery(currentMessage, firstMessage, recentUserMessages, purpose);
  report(result);
  return result;
}
