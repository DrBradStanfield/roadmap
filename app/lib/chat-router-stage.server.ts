/**
 * The router stage every chat surface runs (web and iPhone, Discord, YouTube):
 * one router call, its failure reported once, tagged with the surface (US-15
 * AC74). First step of S-1's shared router stage. Its own module so a test's
 * mock of routeQuery or reportRouterFailure still reaches this call.
 */
import { routeQuery, reportRouterFailure, type RouterResult } from './chat-router.server';
import type { ChatPurpose } from './anthropic.server';

export async function runRouter(
  currentMessage: string,
  firstMessage: string | undefined,
  recentUserMessages: string[] | undefined,
  purpose: ChatPurpose,
): Promise<RouterResult> {
  const result = await routeQuery(currentMessage, firstMessage, recentUserMessages, purpose);
  reportRouterFailure(result, purpose);
  return result;
}
