/**
 * A signed-in customer's Shopify lookups for the web chat route (api.chat.ts):
 * the 10-minute order summary cache and the 24-hour subscription plan
 * refresh. Moved unchanged from api.chat.ts.
 */
import type { AdminApiContext } from '../shopify.server';
import { checkSubscriptionFromTags, getCustomerOrders } from './route-helpers.server';
import { updateSubscriptionPlan, type DbProfile } from './supabase-account.server';
import { reportChatError } from './chat-turn-io.server';
import { boundedMap, isLive, sweepExpired } from './rate-limiter';

// Order cache — orders change infrequently, no need to re-fetch every message
const ORDER_CACHE_TTL = 10 * 60_000; // 10 minutes
// Customers held (US-15 AC67): as the subscription summaries, read only inside a web chat turn,
// which a machine allows 10,000 a day. When full the oldest goes and is fetched again. Two TTLs, so
// an expired empty entry can sit behind a live one until the sweep: that only evicts a live entry early.
const ORDER_CACHE_MAX_KEYS = 10_000;
const orderCache = new Map<string, { summary: string; expiresAt: number }>();
const expiresAtOf = (entry: { expiresAt: number }) => entry.expiresAt;
sweepExpired(orderCache, expiresAtOf, 5 * 60_000);
const orderRoom = boundedMap(orderCache, expiresAtOf, { name: 'order summaries', maxKeys: ORDER_CACHE_MAX_KEYS });

export async function getCachedOrders(admin: AdminApiContext, customerId: string): Promise<string> {
  const cached = orderCache.get(customerId);
  if (cached && isLive(cached.expiresAt, Date.now())) return cached.summary;

  const summary = await getCustomerOrders(admin, customerId);
  // Cache both successful and empty results (shorter TTL for empty to retry sooner)
  const ttl = summary ? ORDER_CACHE_TTL : 2 * 60_000;
  orderRoom(customerId, Date.now());
  orderCache.set(customerId, { summary, expiresAt: Date.now() + ttl });
  return summary;
}

// Lazy subscription check — at most once per 24 hours
export async function refreshSubscriptionIfStale(
  auth: { admin: AdminApiContext | null | undefined; customerId: string; userId: string },
  profile: Pick<DbProfile, 'subscription_plan' | 'subscription_checked_at'>,
): Promise<string> {
  const checkedAt = profile.subscription_checked_at
    ? new Date(profile.subscription_checked_at).getTime()
    : 0;
  const staleThreshold = Date.now() - 24 * 60 * 60_000;

  if (checkedAt > staleThreshold) {
    return profile.subscription_plan ?? 'free';
  }

  // Refresh from Shopify tags
  if (!auth.admin) return profile.subscription_plan ?? 'free';

  const plan = await checkSubscriptionFromTags(auth.admin, auth.customerId);
  // Fire-and-forget update
  updateSubscriptionPlan(auth.userId, plan).catch(() => {
    reportChatError('Chat: Failed to update subscription plan');
  });
  return plan;
}
