/**
 * Admin dashboard stats: chat, reminders, Klaviyo captures, A/B headline.
 * Split out of supabase.server.ts (issue #429).
 */
import * as Sentry from '@sentry/react-router';
import { getCachedKlaviyoCaptureStats, type KlaviyoCaptureStats } from './klaviyo.server';
import { supabaseAdmin } from './supabase-client.server';
import { getActiveABTests, type ABCountRow } from './supabase-ab.server';
import { safeErrorFields } from './safe-error-fields.server';

// ---------------------------------------------------------------------------
// Dashboard analytics — aggregate stats for the Shopify admin dashboard.
//
// v2 (local-first) reality: Brad's server stores NO per-user health data. The
// old health-data metrics (measurements, medications, profile demographics,
// welcome emails) are gone — those tables are empty/purged and their write
// paths were deleted at the 2026-06-12 cutover. This dashboard now reports
// ONLY the server touchpoints that still exist in v2:
//   - Chatbot usage (chat_match_events / chat_conversations — every surface)
//   - v2 email reminders (reminder_optin_v2 — opt-ins, providers, sends)
//   - Klaviyo email captures (live from the Klaviyo "Health Roadmap Guests" list)
//   - A/B testing headline (ab_events)
//
// All windows are explicit (e.g. "30d") so a number is never silently capped.
// Uses supabaseAdmin (service role) because these are cross-user aggregates.
// No health values are read or surfaced — counts only.
// ---------------------------------------------------------------------------

export const DASHBOARD_WINDOW_DAYS = 30;

export interface ChatStats {
  totalConversations: number;
  shopifyConversations: number;
  discordConversations: number;
  userMessages30d: number;   // answered turns in the last 30 days
  fallbacks30d: number;      // is_fallback turns in the last 30 days (LLM failures)
  fallbackRate30d: number;   // fallbacks / turns, 0..1
}

export interface ReminderStats {
  activeOptins: number;
  byProvider: { provider: string; count: number }[];
  withSends: number;   // opt-ins that have received ≥1 reminder email
  dueSoon: number;     // opt-ins with a schedule item due within 7 days
}

export interface DashboardStats {
  // Headline KPIs
  chatMessages30d: number;
  activeChatters30d: number;
  reminderOptins: number;
  klaviyoCaptures30d: number; // last-30d, from Klaviyo (null if Klaviyo unavailable)
  abImpressions: number;
  // Sections
  chat: ChatStats;
  reminders: ReminderStats;
  // Live Klaviyo guest-list stats; null when the Klaviyo API is unavailable so
  // the dashboard can render the card as "unavailable" instead of crashing.
  klaviyo: KlaviyoCaptureStats | null;
  ab: { activeTestName: string | null; impressions: number; conversions: number };
  recentChats: { platform: string; createdAt: string }[];
}

// --- Pure aggregation helpers (unit-tested; DB rows in, plain numbers out) ---

/** Turn counts from chat_match_events (one row per answered turn, every surface). */
export function chatTurnStats(
  turnCount: number | null,
  rows: { user_id: string }[] | null,
  fallbackCount: number | null,
): { turns: number; activeChatters: number; fallbacks: number; fallbackRate: number } {
  const turns = turnCount ?? 0;
  const fallbacks = fallbackCount ?? 0;
  return {
    turns,
    activeChatters: new Set((rows ?? []).map((r) => r.user_id)).size,
    fallbacks,
    fallbackRate: turns > 0 ? fallbacks / turns : 0,
  };
}

export interface ReminderOptinRow {
  provider: string | null;
  last_sent: Record<string, string> | null;
  schedule: { dueAt: string }[] | null;
}

export function aggregateReminderOptins(
  rows: ReminderOptinRow[] | null,
  todayStr: string,
): Omit<ReminderStats, 'activeOptins'> {
  const dueCutoff = new Date(`${todayStr}T00:00:00Z`);
  dueCutoff.setUTCDate(dueCutoff.getUTCDate() + 7);
  const dueCutoffStr = dueCutoff.toISOString().slice(0, 10);

  const providerCounts = new Map<string, number>();
  let withSends = 0;
  let dueSoon = 0;
  for (const r of rows || []) {
    const provider = r.provider || 'unknown';
    providerCounts.set(provider, (providerCounts.get(provider) ?? 0) + 1);
    if (r.last_sent && Object.keys(r.last_sent).length > 0) withSends++;
    if ((r.schedule || []).some((item) => item.dueAt <= dueCutoffStr)) dueSoon++;
  }
  return {
    byProvider: Array.from(providerCounts.entries())
      .map(([provider, count]) => ({ provider, count }))
      .sort((a, b) => b.count - a.count),
    withSends,
    dueSoon,
  };
}

export async function getDashboardStats(): Promise<DashboardStats> {
  if (!supabaseAdmin) {
    throw new Error('Supabase admin client not configured');
  }

  const windowStart = new Date(
    Date.now() - DASHBOARD_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const todayStr = new Date().toISOString().slice(0, 10);

  const [
    convTotalRes,
    convDiscordRes,
    chatTurnsRes,
    chatFallbacksRes,
    optinRes,
    recentChatRes,
    activeTests,
    klaviyoSettled,
  ] = await Promise.all([
    // Chat conversations — total + Discord split (Shopify = total − Discord).
    supabaseAdmin.from('chat_conversations').select('*', { count: 'exact', head: true }),
    supabaseAdmin
      .from('chat_conversations')
      .select('*', { count: 'exact', head: true })
      .eq('platform', 'discord'),
    // Chat turns in the window: one chat_match_events row per answered turn on
    // every surface (the widget stores no chat_messages, US-15 AC7). user_id
    // only, for distinct chatters; the count rides on the same query.
    // PostgREST pages at 1000 rows by default; the explicit limit keeps the
    // distinct-chatter count honest well past today's volume (~80 turns/wk).
    supabaseAdmin
      .from('chat_match_events')
      .select('user_id', { count: 'exact' })
      .gte('created_at', windowStart)
      .limit(10000),
    supabaseAdmin
      .from('chat_match_events')
      .select('*', { count: 'exact', head: true })
      .eq('is_fallback', true)
      .gte('created_at', windowStart),
    // v2 reminder opt-ins (provider, last_sent, schedule aggregated in JS).
    // Live rows only: a tombstone (schedule [], kept 90 days, US-17 AC1b) is
    // not an opt-in. The exact count is the headline; the rows feeding the
    // breakdown stop at PostgREST's 1000-row page.
    supabaseAdmin
      .from('reminder_optin_v2')
      .select('provider, last_sent, schedule', { count: 'exact' })
      .neq('schedule', '[]'),
    // Recent chat activity — platform + timestamp only, NO content (PHI-safe).
    supabaseAdmin
      .from('chat_conversations')
      .select('platform, created_at')
      .order('created_at', { ascending: false })
      .limit(8),
    // A/B headline: the currently-active test, if any (only one is ever active).
    getActiveABTests(),
    // Klaviyo guest-list capture stats — live from the Klaviyo API, fetched in
    // parallel and isolated via allSettled so a Klaviyo outage/timeout never
    // rejects the whole dashboard (the card just renders "unavailable").
    getCachedKlaviyoCaptureStats().then(
      (value) => ({ ok: true as const, value }),
      (error) => {
        console.error('Klaviyo dashboard stats error:', safeErrorFields(error));
        Sentry.captureException(error, { tags: { feature: 'klaviyo_dashboard' } });
        return { ok: false as const };
      },
    ),
  ]);
  const activeTest = activeTests[0] ?? null;
  const klaviyo: KlaviyoCaptureStats | null = klaviyoSettled.ok ? klaviyoSettled.value : null;

  const chat30d = chatTurnStats(chatTurnsRes.count, chatTurnsRes.data as { user_id: string }[] | null, chatFallbacksRes.count);
  const reminderAgg = aggregateReminderOptins(
    optinRes.data as ReminderOptinRow[] | null,
    todayStr,
  );
  const activeOptins = optinRes.count ?? optinRes.data?.length ?? 0;

  // A/B headline numbers for the active test (or zeros if none).
  let abImpressions = 0;
  let abConversions = 0;
  let activeTestName: string | null = null;
  if (activeTest) {
    activeTestName = activeTest.name;
    const { data: counts } = await supabaseAdmin.rpc('get_ab_test_counts', {
      p_test_id: activeTest.id,
    });
    for (const row of (counts ?? []) as ABCountRow[]) {
      if (row.event_type === 'impression') abImpressions += Number(row.count);
      else if (row.event_type === 'conversion') abConversions += Number(row.count);
    }
  }

  const totalConversations = convTotalRes.count ?? 0;
  const discordConversations = convDiscordRes.count ?? 0;

  return {
    chatMessages30d: chat30d.turns,
    activeChatters30d: chat30d.activeChatters,
    reminderOptins: activeOptins,
    klaviyoCaptures30d: klaviyo?.last30d ?? 0,
    abImpressions,
    chat: {
      totalConversations,
      shopifyConversations: Math.max(0, totalConversations - discordConversations),
      discordConversations,
      userMessages30d: chat30d.turns,
      fallbacks30d: chat30d.fallbacks,
      fallbackRate30d: chat30d.fallbackRate,
    },
    reminders: { activeOptins, ...reminderAgg },
    klaviyo,
    ab: { activeTestName, impressions: abImpressions, conversions: abConversions },
    recentChats: (recentChatRes.data ?? []).map(
      (r: { platform: string | null; created_at: string }) => ({
        platform: r.platform || 'shopify',
        createdAt: r.created_at,
      }),
    ),
  };
}
