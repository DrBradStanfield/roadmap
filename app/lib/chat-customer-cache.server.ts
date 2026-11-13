/**
 * A signed-in customer's Shopify lookups for the web chat route (api.chat.ts):
 * the 10-minute order summary cache and the 24-hour subscription plan
 * refresh. Moved unchanged from api.chat.ts.
 */
import { checkSubscriptionFromTags, getCustomerOrders } from './route-helpers.server';
import { updateSubscriptionPlan, type DbProfile } from './supabase-account.server';
import { reportChatError } from './chat-turn-io.server';

// Order cache — orders change infrequently, no need to re-fetch every message
const ORDER_CACHE_TTL = 10 * 60_000; // 10 minutes
const orderCache = new Map<string, { summary: string; expiresAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of orderCache) {
    if (now > entry.expiresAt) orderCache.delete(key);
  }
}, 5 * 60_000);

export async function getCachedOrders(admin: any, customerId: string): Promise<string> {
  const cached = orderCache.get(customerId);
  if (cached && Date.now() < cached.expiresAt) return cached.summary;

  const summary = await getCustomerOrders(admin, customerId);
  // Cache both successful and empty results (shorter TTL for empty to retry sooner)
  const ttl = summary ? ORDER_CACHE_TTL : 2 * 60_000;
  orderCache.set(customerId, { summary, expiresAt: Date.now() + ttl });
  return summary;
}

// Lazy subscription check — at most once per 24 hours
export async function refreshSubscriptionIfStale(
  auth: { admin: any; customerId: string; userId: string },
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
