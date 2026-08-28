import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';
import * as Sentry from '@sentry/react-router';
import { getCachedKlaviyoCaptureStats, type KlaviyoCaptureStats } from './klaviyo.server';

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabaseJwtSecret = process.env.SUPABASE_JWT_SECRET;

if (!supabaseUrl || !supabaseServiceKey || !supabaseAnonKey || !supabaseJwtSecret) {
  console.warn('Supabase environment variables not fully configured');
}

// ---------------------------------------------------------------------------
// Admin client — service key, bypasses RLS.
// Used for user creation, profile lookups, and platform-bot writes (Discord).
// ---------------------------------------------------------------------------

export const supabaseAdmin = supabaseUrl && supabaseServiceKey
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

// ---------------------------------------------------------------------------
// User client — anon key + custom JWT. RLS enforces auth.uid() on every query.
// ---------------------------------------------------------------------------

export function createUserClient(userId: string): SupabaseClient {
  if (!supabaseUrl || !supabaseAnonKey || !supabaseJwtSecret) {
    throw new Error('Supabase environment variables not configured');
  }

  const token = jwt.sign(
    { sub: userId, role: 'authenticated', aud: 'authenticated' },
    supabaseJwtSecret,
    { algorithm: 'HS256', expiresIn: '1h' },
  );

  return createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

// ---------------------------------------------------------------------------
// User ID cache — avoids repeated profile lookups for the same customer.
// ---------------------------------------------------------------------------

const USER_CACHE_TTL = 15 * 60 * 1000; // 15 minutes
const USER_CACHE_MAX = 10_000;
const userIdCache = new Map<string, { userId: string; expiresAt: number }>();

function getCachedUserId(shopifyCustomerId: string): string | null {
  const entry = userIdCache.get(shopifyCustomerId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    userIdCache.delete(shopifyCustomerId);
    return null;
  }
  return entry.userId;
}

function cacheUserId(shopifyCustomerId: string, userId: string): void {
  if (userIdCache.size >= USER_CACHE_MAX) {
    const firstKey = userIdCache.keys().next().value;
    if (firstKey) userIdCache.delete(firstKey);
  }
  userIdCache.set(shopifyCustomerId, {
    userId,
    expiresAt: Date.now() + USER_CACHE_TTL,
  });
}

// ---------------------------------------------------------------------------
// Audit logging — fire-and-forget, never blocks or fails the request.
// Uses supabaseAdmin (service role) because audit writes happen server-side
// after the user is already authenticated via HMAC.
// ---------------------------------------------------------------------------

export function logAudit(
  userId: string | null,
  action: string,
  resourceType: string,
  resourceId?: string,
  metadata?: Record<string, unknown>,
): void {
  if (!supabaseAdmin) return;
  supabaseAdmin
    .from('audit_logs')
    .insert({
      user_id: userId,
      action,
      resource_type: resourceType,
      resource_id: resourceId ?? null,
      metadata: metadata ?? null,
    })
    .then(({ error }) => {
      if (error) console.error('Audit log failed:', error.message);
    });
}

// ---------------------------------------------------------------------------
// getOrCreateSupabaseUser — maps a Shopify customer to a Supabase Auth user.
// Both params are required; throws if either is missing.
// ---------------------------------------------------------------------------

export async function getOrCreateSupabaseUser(
  shopifyCustomerId: string,
  email: string,
  firstName?: string | null,
  lastName?: string | null,
): Promise<string> {
  if (!shopifyCustomerId || !email) {
    throw new Error('shopifyCustomerId and email are both required');
  }
  if (!supabaseAdmin) {
    throw new Error('Supabase admin client not configured');
  }

  const cached = getCachedUserId(shopifyCustomerId);
  if (cached) return cached;

  // Check if profile already exists
  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('id, first_name, last_name')
    .eq('shopify_customer_id', shopifyCustomerId)
    .single();

  if (profile) {
    // Sync first/last name from Shopify only if changed
    const nameUpdates: Record<string, string> = {};
    if (firstName != null && firstName !== profile.first_name) nameUpdates.first_name = firstName;
    if (lastName != null && lastName !== profile.last_name) nameUpdates.last_name = lastName;
    if (Object.keys(nameUpdates).length > 0) {
      await supabaseAdmin
        .from('profiles')
        .update(nameUpdates)
        .eq('id', profile.id);
    }
    cacheUserId(shopifyCustomerId, profile.id);
    return profile.id;
  }

  // Create Supabase Auth user (or find existing one by email)
  let userId: string;
  const { data: authUser, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { shopify_customer_id: shopifyCustomerId },
  });

  if (error) {
    // Race condition or existing user — find by profile email first (fast, indexed),
    // then fall back to auth admin API only if needed.
    const { data: existingProfile } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .eq('email', email)
      .single();
    if (existingProfile) {
      cacheUserId(shopifyCustomerId, existingProfile.id);
      return existingProfile.id;
    }

    // Also check by shopify_customer_id (parallel request may have just created it)
    const { data: retryProfile } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .eq('shopify_customer_id', shopifyCustomerId)
      .single();
    if (retryProfile) {
      cacheUserId(shopifyCustomerId, retryProfile.id);
      return retryProfile.id;
    }

    // Last resort: query auth users by email (Supabase admin API)
    const { data: listData, error: listError } = await supabaseAdmin.auth.admin.listUsers();
    if (listError) {
      throw new Error(`Failed to list users: ${listError.message}`);
    }
    const existingUser = listData.users.find((u) => u.email === email);
    if (!existingUser) {
      throw new Error(`Failed to create Supabase user: ${error.message}`);
    }
    userId = existingUser.id;
  } else {
    userId = authUser.user.id;
  }

  // Explicitly create profile row — this is the primary mechanism.
  // The DB trigger on auth.users is defense-in-depth only.
  const { error: upsertError } = await supabaseAdmin
    .from('profiles')
    .upsert(
      { id: userId, shopify_customer_id: shopifyCustomerId, email, first_name: firstName ?? null, last_name: lastName ?? null },
      { onConflict: 'id' },
    );

  if (upsertError) {
    console.error('Failed to create profile:', upsertError);
    throw new Error(`Failed to create profile: ${upsertError.message}`);
  }

  // Verify profile was actually created — catches silent failures
  const { data: verifiedProfile, error: verifyError } = await supabaseAdmin
    .from('profiles')
    .select('id')
    .eq('id', userId)
    .single();

  if (verifyError || !verifiedProfile) {
    console.error('Profile verification failed after upsert:', {
      userId,
      shopifyCustomerId,
      verifyError,
    });
    throw new Error(
      `Profile not found after upsert: ${verifyError?.message || 'row missing'}`,
    );
  }

  logAudit(userId, 'USER_CREATED', 'user', userId, { shopifyCustomerId });
  cacheUserId(shopifyCustomerId, userId);
  return userId;
}

// ---------------------------------------------------------------------------
// Guest chat session management
// ---------------------------------------------------------------------------

// IP rate limit for guest session creation: 10 new sessions/hour per IP,
// per-process in-memory. Resets on redeploy; effective ceiling is ~N × 10/hr
// where N is the Fly machine count. Sophisticated IP-rotation abuse isn't
// caught here — would need an upstream WAF.
const GUEST_IP_RATE_WINDOW_MS = 60 * 60_000;
const GUEST_IP_RATE_MAX = 10;
const guestIpRateMap = new Map<string, { count: number; resetAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of guestIpRateMap) {
    if (now > entry.resetAt) guestIpRateMap.delete(key);
  }
}, 10 * 60_000);

export interface GuestSessionResult {
  sessionId: string;
  sessionToken: string;
}

/**
 * Get or create a guest chat session. Creates a ghost profile if needed.
 * Uses supabaseAdmin for session management (same pattern as getOrCreateSupabaseUser).
 * Returns sessionId (=profileId for createUserClient) and sessionToken (for client localStorage).
 */
export async function getOrCreateGuestSession(
  ip: string,
  sessionToken?: string | null,
): Promise<GuestSessionResult> {
  if (!supabaseAdmin) throw new Error('Supabase admin client not configured');

  const now = Date.now();

  // Existing session — validate token + IP (checked BEFORE rate limit to avoid penalizing returning guests)
  if (sessionToken) {
    const { data: session } = await supabaseAdmin
      .from('guest_chat_sessions')
      .select('id, session_token, ip_address')
      .eq('session_token', sessionToken)
      .single();

    if (session && session.ip_address === ip) {
      return { sessionId: session.id, sessionToken: session.session_token };
    }
    // Invalid token or IP mismatch — fall through to create new session
  }

  // In-memory IP rate limit (only for new session creation, not returning sessions)
  const ipEntry = guestIpRateMap.get(ip);
  if (ipEntry && now < ipEntry.resetAt && ipEntry.count >= GUEST_IP_RATE_MAX) {
    throw new GuestRateLimitError('Too many requests');
  }
  if (!ipEntry || now > ipEntry.resetAt) {
    guestIpRateMap.set(ip, { count: 1, resetAt: now + GUEST_IP_RATE_WINDOW_MS });
  } else {
    ipEntry.count++;
  }

  // Create ghost auth user + profile + session
  const guestEmail = `guest-${crypto.randomUUID()}@guest.internal`;
  const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.createUser({
    email: guestEmail,
    email_confirm: true,
    user_metadata: { is_guest: true },
  });

  if (authError || !authUser?.user) {
    console.error('Failed to create guest auth user:', authError);
    throw new Error('Failed to create guest session');
  }

  const sessionId = authUser.user.id;

  const { error: profileError } = await supabaseAdmin
    .from('profiles')
    .upsert({ id: sessionId, email: guestEmail, is_guest: true }, { onConflict: 'id' });

  if (profileError) {
    console.error('Failed to create guest profile:', profileError);
    throw new Error('Failed to create guest session');
  }

  const { data: newSession, error: sessionError } = await supabaseAdmin
    .from('guest_chat_sessions')
    .insert({ id: sessionId, ip_address: ip })
    .select('session_token')
    .single();

  if (sessionError || !newSession) {
    // Clean up both the ghost profile and auth user
    await supabaseAdmin.from('profiles').delete().eq('id', sessionId);
    await supabaseAdmin.auth.admin.deleteUser(sessionId).catch(() => {});
    console.error('Failed to create guest session:', sessionError);
    throw new Error('Failed to create guest session');
  }

  logAudit(null, 'GUEST_SESSION_CREATED', 'guest_chat', sessionId, { ip });
  return { sessionId, sessionToken: newSession.session_token };
}

/** Custom error for guest rate limiting (caught in api.chat.ts to return 429). */
export class GuestRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuestRateLimitError';
  }
}

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

export interface DbProfile {
  id: string;
  shopify_customer_id: string;
  email: string;
  sex: number | null;
  birth_year: number | null;
  birth_month: number | null;
  unit_system: number | null;
  first_name: string | null;
  last_name: string | null;
  height: number | null;
  welcome_email_sent: boolean;
  reminders_global_optout: boolean;
  unsubscribe_token: string | null;
  created_at: string;
  subscription_plan: string;
  subscription_checked_at: string | null;
  message_credits: number;
}

// ---------------------------------------------------------------------------
// Profile lookup — operational columns only (subscription plan, credits).
// The v1 health/demographic reads were retired with the June-2026 purge.
// RLS enforces auth.uid() on every query.
// ---------------------------------------------------------------------------

/** Get profile for the authenticated user. */
export async function getProfile(
  client: SupabaseClient,
): Promise<DbProfile | null> {
  const { data, error } = await client
    .from('profiles')
    .select('*')
    .single();

  if (error) {
    console.error('Error fetching profile:', error);
    return null;
  }

  return data as DbProfile;
}

/** Names of seeded `cron_lock` rows. New crons must add their lock name here AND
 *  seed a row in supabase/rls-policies.sql — typo on either side silently disables
 *  the cron (UPDATE matches zero rows → returns false → cron never runs). */
export type CronLockName = 'reminder_v2_cron' | 'trending_cron' | 'trending_cron_edu' | 'youtube_bot_summary' | 'chat_summary';

/** Attempt to acquire the cron lock for today. Returns true if this machine
 *  should run the cron; false if it lost the race or the lock is permanently
 *  unusable (no admin client, missing seed row). Uses an atomic UPDATE with
 *  WHERE clause to prevent race conditions between machines.
 *
 *  THROWS on transient DB errors (US-28 AC1): an error is not "another
 *  machine won", and returning false here made the erroring machine mark the
 *  day done and silently skip its daily job (Sentry JAVASCRIPT-REMIX-66/68).
 *  Callers keep the acquire inside their tick try/catch, which must NOT mark
 *  the day done — so the machine retries on the next tick. */
export async function tryAcquireCronLock(
  machineId: string,
  today: string,
  lockName: CronLockName,
): Promise<boolean> {
  if (!supabaseAdmin) return false;

  // `today` is interpolated into the PostgREST `.or()` filter below — guard
  // against anything other than a YYYY-MM-DD literal so a future caller
  // can't accidentally bypass the lock by passing a value containing `,` or `)`.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) return false;

  // `lock_date IS NULL OR lock_date != today`. Required because seed rows can
  // start with lock_date = NULL, and `NULL != $today` evaluates to NULL in SQL
  // (treated as false) — so a bare `.neq` would never match unseeded locks and
  // the cron would fail silently.
  // Attempt to acquire the lock. PostgreSQL row-level locking serializes
  // concurrent UPDATEs to the same row, so this is the atomic CAS — only
  // one machine's UPDATE can match the `lock_date != today` predicate per
  // day.
  //
  // We do NOT use `.select()` here. PostgREST evaluates the WHERE filter
  // against the UPDATED row when returning representation. Because our
  // filter (`lock_date.neq.today`) excludes rows that have today's date,
  // and our UPDATE sets `lock_date = today`, the returned set is empty
  // even when the UPDATE committed. That bug silently broke the trending
  // and reminder crons for weeks — both acquired the lock at the DB level
  // but the function returned false, short-circuiting the cron callback.
  const updateRes = await supabaseAdmin
    .from('cron_lock')
    .update({
      locked_by: machineId,
      locked_at: new Date().toISOString(),
      lock_date: today,
    })
    .eq('lock_name', lockName)
    .or(`lock_date.is.null,lock_date.neq.${today}`);

  if (updateRes.error) {
    // Transient failure — throw so the caller's tick catch retries next tick
    // (the catch also owns the Sentry capture; capturing here too would
    // double-report every error).
    console.error(`Error acquiring cron lock (${lockName}):`, updateRes.error);
    throw new Error(
      `cron lock acquire failed (${lockName}): ${updateRes.error.message}`,
      { cause: updateRes.error },
    );
  }

  // Read back the row to determine who owns the lock for today. If this
  // machine's id + today's date are reflected, we won the CAS.
  const { data: verify, error: verifyErr } = await supabaseAdmin
    .from('cron_lock')
    .select('locked_by, lock_date')
    .eq('lock_name', lockName)
    .maybeSingle();

  if (verifyErr) {
    console.error(`Could not verify cron lock state (${lockName}):`, verifyErr);
    throw new Error(
      `cron lock verify failed (${lockName}): ${verifyErr.message}`,
      { cause: verifyErr },
    );
  }
  // No row at all = missing seed row (see CronLockName) — permanent
  // misconfig, not transient; retrying won't help.
  if (!verify) {
    console.error(`Cron lock row missing (${lockName}) — check the seed in rls-policies.sql`);
    return false;
  }

  return verify.locked_by === machineId && verify.lock_date === today;
}

// ---------------------------------------------------------------------------
// Message credits — one-time pack purchases, atomic deduction
// ---------------------------------------------------------------------------

/**
 * Add message credits after a Shopify order. Atomic via RPC — prevents race conditions
 * on concurrent orders. Idempotent via order_id unique constraint (returns null for duplicates).
 */
export async function addMessageCredits(
  userId: string,
  amount: number,
  orderId: string,
): Promise<number | null> {
  if (!supabaseAdmin) throw new Error('Supabase admin client not configured');

  const { data, error } = await supabaseAdmin.rpc('add_message_credits', {
    target_user_id: userId,
    credit_amount: amount,
    shopify_order_id: orderId,
  });

  if (error) {
    throw new Error(`Failed to add credits: ${error.message}`);
  }

  return data as number | null;
}

/**
 * Update subscription plan and check timestamp on a profile.
 */
export async function updateSubscriptionPlan(
  userId: string,
  plan: string,
): Promise<void> {
  if (!supabaseAdmin) return;

  await supabaseAdmin
    .from('profiles')
    .update({
      subscription_plan: plan,
      subscription_checked_at: new Date().toISOString(),
    })
    .eq('id', userId);
}

/**
 * Look up a Supabase user ID by Shopify customer ID. Uses admin client.
 */
export async function getUserIdByCustomerId(shopifyCustomerId: string): Promise<string | null> {
  // Check in-memory cache first
  const cached = getCachedUserId(shopifyCustomerId);
  if (cached) return cached;

  if (!supabaseAdmin) return null;

  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('id')
    .eq('shopify_customer_id', shopifyCustomerId)
    .single();

  if (error || !data) return null;
  cacheUserId(shopifyCustomerId, data.id);
  return data.id;
}

// ---------------------------------------------------------------------------
// Dashboard analytics — aggregate stats for the Shopify admin dashboard.
//
// v2 (local-first) reality: Brad's server stores NO per-user health data. The
// old health-data metrics (measurements, medications, profile demographics,
// welcome emails) are gone — those tables are empty/purged and their write
// paths were deleted at the 2026-06-12 cutover. This dashboard now reports
// ONLY the server touchpoints that still exist in v2:
//   - Chatbot usage (chat_messages / chat_conversations — Shopify + Discord)
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
  userMessages30d: number;   // role='user' in the last 30 days
  fallbacks30d: number;      // is_fallback messages in the last 30 days (LLM failures)
  fallbackRate30d: number;   // fallbacks / assistant messages, 0..1
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

export interface ChatMessageRow {
  role: string;
  is_fallback: boolean | null;
  created_at: string;
  user_id: string;
}

export function aggregateChatMessages(
  rows: ChatMessageRow[] | null,
): { userMessages: number; activeChatters: number; fallbacks: number; fallbackRate: number } {
  let userMessages = 0;
  let assistantMessages = 0;
  let fallbacks = 0;
  const chatters = new Set<string>();
  for (const r of rows || []) {
    if (r.role === 'user') {
      userMessages++;
      chatters.add(r.user_id);
    } else if (r.role === 'assistant') {
      assistantMessages++;
      if (r.is_fallback) fallbacks++;
    }
  }
  return {
    userMessages,
    activeChatters: chatters.size,
    fallbacks,
    fallbackRate: assistantMessages > 0 ? fallbacks / assistantMessages : 0,
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
    chatMsgRes,
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
    // Chat messages in the window (role/fallback/chatter aggregation in JS).
    supabaseAdmin
      .from('chat_messages')
      .select('role, is_fallback, created_at, user_id')
      .gte('created_at', windowStart),
    // v2 reminder opt-ins (provider, last_sent, schedule aggregated in JS).
    supabaseAdmin.from('reminder_optin_v2').select('provider, last_sent, schedule'),
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
        console.error('Klaviyo dashboard stats error:', error);
        Sentry.captureException(error, { tags: { feature: 'klaviyo_dashboard' } });
        return { ok: false as const };
      },
    ),
  ]);
  const activeTest = activeTests[0] ?? null;
  const klaviyo: KlaviyoCaptureStats | null = klaviyoSettled.ok ? klaviyoSettled.value : null;

  const chatAgg = aggregateChatMessages(chatMsgRes.data as ChatMessageRow[] | null);
  const reminderAgg = aggregateReminderOptins(
    optinRes.data as ReminderOptinRow[] | null,
    todayStr,
  );
  const activeOptins = optinRes.data?.length ?? 0;

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
    chatMessages30d: chatAgg.userMessages,
    activeChatters30d: chatAgg.activeChatters,
    reminderOptins: activeOptins,
    klaviyoCaptures30d: klaviyo?.last30d ?? 0,
    abImpressions,
    chat: {
      totalConversations,
      shopifyConversations: Math.max(0, totalConversations - discordConversations),
      discordConversations,
      userMessages30d: chatAgg.userMessages,
      fallbacks30d: chatAgg.fallbacks,
      fallbackRate30d: chatAgg.fallbackRate,
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

// ---------------------------------------------------------------------------
// A/B Testing
// ---------------------------------------------------------------------------

export type ABTestStatus = 'draft' | 'active' | 'paused' | 'completed';
export type ABTestTarget = 'heading' | 'subheading' | 'email-guest-helper';
export type ABEventType = 'impression' | 'conversion';

export interface ABVariant {
  id: string;
  value: string;
  weight: number;
}

export interface ABTest {
  id: string;
  name: string;
  status: ABTestStatus;
  target: ABTestTarget;
  variants: ABVariant[];
  created_at: string;
  updated_at: string;
}

export async function getABTests(): Promise<ABTest[]> {
  if (!supabaseAdmin) return [];
  const { data, error } = await supabaseAdmin
    .from('ab_tests')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) {
    console.error('Failed to fetch AB tests:', error.message);
    return [];
  }
  return data || [];
}

export async function getActiveABTests(): Promise<ABTest[]> {
  if (!supabaseAdmin) return [];
  const { data, error } = await supabaseAdmin
    .from('ab_tests')
    .select('*')
    .eq('status', 'active')
    .order('created_at', { ascending: false });
  if (error) {
    console.error('Failed to fetch active AB tests:', error.message);
    return [];
  }
  return data || [];
}

export async function getABTestById(testId: string): Promise<ABTest | null> {
  if (!supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin
    .from('ab_tests')
    .select('*')
    .eq('id', testId)
    .single();
  if (error) {
    console.error('Failed to fetch AB test:', error.message);
    return null;
  }
  return data;
}

export async function createABTest(name: string, target: ABTestTarget, variants: ABVariant[]): Promise<ABTest | null> {
  if (!supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin
    .from('ab_tests')
    .insert({ name, target, variants })
    .select()
    .single();
  if (error) {
    console.error('Failed to create AB test:', error.message);
    return null;
  }
  return data;
}

export async function updateABTestStatus(testId: string, status: ABTestStatus): Promise<boolean> {
  if (!supabaseAdmin) return false;
  const { error } = await supabaseAdmin
    .from('ab_tests')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', testId);
  if (error) {
    console.error('Failed to update AB test status:', error.message);
    return false;
  }
  return true;
}

export async function recordABEvent(
  testId: string,
  variantId: string,
  visitorId: string,
  eventType: ABEventType,
): Promise<boolean> {
  if (!supabaseAdmin) return false;
  const { error } = await supabaseAdmin
    .from('ab_events')
    .upsert(
      { test_id: testId, variant_id: variantId, visitor_id: visitorId, event_type: eventType },
      { onConflict: 'test_id,visitor_id,event_type', ignoreDuplicates: true },
    );
  if (error) {
    console.error('Failed to record AB event:', error.message);
    return false;
  }
  return true;
}

export interface ABTestResults {
  test: ABTest;
  variantResults: Array<{
    variantId: string;
    impressions: number;
    conversions: number;
  }>;
}

export interface ABCountRow {
  variant_id: string;
  event_type: ABEventType;
  count: number | string;
}

export function aggregateABCounts(
  variants: ABVariant[],
  rows: ABCountRow[] | null,
): ABTestResults['variantResults'] {
  const counts = new Map<string, { impressions: number; conversions: number }>();
  for (const variant of variants) {
    counts.set(variant.id, { impressions: 0, conversions: 0 });
  }
  for (const row of rows || []) {
    const entry = counts.get(row.variant_id);
    if (!entry) continue;
    if (row.event_type === 'impression') entry.impressions = Number(row.count);
    else if (row.event_type === 'conversion') entry.conversions = Number(row.count);
  }
  return Array.from(counts.entries()).map(([variantId, c]) => ({
    variantId,
    impressions: c.impressions,
    conversions: c.conversions,
  }));
}

export async function getABTestResults(test: ABTest): Promise<ABTestResults | null> {
  if (!supabaseAdmin) return null;

  // Aggregate server-side — client-side reduction over .select() silently
  // truncates at PostgREST's 1000-row default once a test has enough events.
  const { data: rows, error } = await supabaseAdmin
    .rpc('get_ab_test_counts', { p_test_id: test.id });
  if (error) {
    console.error('Failed to fetch AB event counts:', error.message);
    return null;
  }

  return { test, variantResults: aggregateABCounts(test.variants, rows) };
}
