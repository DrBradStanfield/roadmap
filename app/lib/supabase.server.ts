import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';
import * as Sentry from '@sentry/remix';
import type { HealthInputs, MedicationInputs, ScreeningInputs } from '../../packages/health-core/src/types';
import { measurementsToInputs, medicationsToInputs, screeningsToInputs } from '../../packages/health-core/src/mappings';
import { MEASUREMENT_SOURCES, type MeasurementStatus, type MeasurementSource } from '../../packages/health-core/src/validation';

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
  userId: string,
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

/**
 * Migrate guest chat history to an authenticated user account.
 * Updates user_id on chat_conversations and chat_messages, then deletes the ghost profile.
 */
export async function migrateGuestChat(
  guestSessionToken: string,
  newUserId: string,
): Promise<boolean> {
  if (!supabaseAdmin) return false;

  // Look up the guest session
  const { data: session } = await supabaseAdmin
    .from('guest_chat_sessions')
    .select('id')
    .eq('session_token', guestSessionToken)
    .single();

  if (!session) return false;

  const guestId = session.id;

  // Update chat_conversations and chat_messages to point to the real user
  await supabaseAdmin
    .from('chat_conversations')
    .update({ user_id: newUserId })
    .eq('user_id', guestId);

  await supabaseAdmin
    .from('chat_messages')
    .update({ user_id: newUserId })
    .eq('user_id', guestId);

  // Delete the ghost profile (cascades to guest_chat_sessions)
  // The auth.users row cascades via profiles FK
  await supabaseAdmin
    .from('profiles')
    .delete()
    .eq('id', guestId)
    .eq('is_guest', true);

  // Also delete the ghost auth user
  await supabaseAdmin.auth.admin.deleteUser(guestId);

  logAudit(newUserId, 'GUEST_CHAT_MIGRATED', 'guest_chat', guestId);
  return true;
}

/**
 * Delete ghost guest profiles older than 30 days.
 * CASCADE deletes their chat_conversations, chat_messages, guest_chat_sessions, and auth user.
 * Called by the daily reminder cron.
 */
export async function cleanupGuestProfiles(): Promise<number> {
  if (!supabaseAdmin) return 0;

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();

  // Find guest profiles to delete (need IDs for auth user cleanup)
  const { data: guests } = await supabaseAdmin
    .from('profiles')
    .select('id')
    .eq('is_guest', true)
    .lt('created_at', thirtyDaysAgo);

  if (!guests?.length) return 0;

  // Delete profiles (cascades to chat data + guest_chat_sessions)
  const { error } = await supabaseAdmin
    .from('profiles')
    .delete()
    .eq('is_guest', true)
    .lt('created_at', thirtyDaysAgo);

  if (error) {
    console.error('Error cleaning up guest profiles:', error);
    return 0;
  }

  // Clean up auth users (fire-and-forget, profiles already deleted)
  for (const guest of guests) {
    supabaseAdmin.auth.admin.deleteUser(guest.id).catch(() => {});
  }

  console.log(`Guest cleanup: deleted ${guests.length} abandoned guest profiles`);
  return guests.length;
}

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

export interface DbMeasurement {
  id: string;
  user_id: string;
  metric_type: string;
  value: number;
  recorded_at: string;
  created_at: string;
  source: string;
  external_id: string | null;
  status?: string;
  corrects_id?: string | null;
}

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

const MEASUREMENT_SOURCE_SET: ReadonlySet<string> = new Set(MEASUREMENT_SOURCES);

/** Convert a DB measurement row to the camelCase API response format. */
export function toApiMeasurement(m: DbMeasurement) {
  // The DB CHECK constraint should reject anything outside MEASUREMENT_SOURCES,
  // but if drift ever lands (e.g. a manual SQL migration) we'd otherwise leak
  // an out-of-enum string to clients. Surface that via Sentry rather than
  // silently miscategorising.
  let source: MeasurementSource | undefined;
  if (m.source == null) {
    source = undefined;
  } else if (MEASUREMENT_SOURCE_SET.has(m.source)) {
    source = m.source as MeasurementSource;
  } else {
    Sentry.captureMessage('measurement.source out of enum', {
      level: 'warning',
      extra: { id: m.id, source: m.source },
    });
    source = undefined;
  }
  return {
    id: m.id,
    metricType: m.metric_type,
    value: Number(m.value),
    recordedAt: m.recorded_at,
    createdAt: m.created_at,
    source,
    externalId: m.external_id,
    // DB CHECK constraint guarantees status; cast is safe.
    status: ((m.status ?? 'active') as MeasurementStatus),
    correctsId: m.corrects_id ?? null,
  };
}

/** Convert DB profile row to camelCase API format (demographics + height). */
export function toApiProfile(p: DbProfile) {
  return {
    sex: p.sex,
    birthYear: p.birth_year,
    birthMonth: p.birth_month,
    unitSystem: p.unit_system,
    firstName: p.first_name,
    lastName: p.last_name,
    height: p.height,
  };
}

// ---------------------------------------------------------------------------
// Measurement CRUD — all queries use the RLS-enforced user client.
// No userId parameter needed; RLS scopes to auth.uid() automatically.
// All values are in SI canonical units.
// ---------------------------------------------------------------------------

/** Get measurements for a specific metric, ordered by recorded_at DESC. */
export async function getMeasurements(
  client: SupabaseClient,
  metricType: string,
  limit = 50,
  includeCorrected = false,
): Promise<DbMeasurement[]> {
  let query = client
    .from('health_measurements')
    .select('*')
    .eq('metric_type', metricType);
  if (!includeCorrected) {
    query = query.eq('status', 'active');
  }
  const { data, error } = await query
    .order('recorded_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('Error fetching measurements:', error);
    return [];
  }

  return (data ?? []) as DbMeasurement[];
}

/** Get the latest measurement for each metric_type for the authenticated user. */
export async function getLatestMeasurements(
  client: SupabaseClient,
): Promise<DbMeasurement[]> {
  const { data, error } = await client.rpc('get_latest_measurements');

  if (error) {
    console.error('Error fetching latest measurements:', error);
    return [];
  }

  return (data ?? []) as DbMeasurement[];
}

/** Get all measurements across all metrics, ordered by recorded_at DESC. */
export async function getAllMeasurements(
  client: SupabaseClient,
  limit = 100,
  offset = 0,
  includeCorrected = false,
): Promise<DbMeasurement[]> {
  let query = client.from('health_measurements').select('*');
  if (!includeCorrected) {
    query = query.eq('status', 'active');
  }
  const { data, error } = await query
    .order('recorded_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    console.error('Error fetching all measurements:', error);
    return [];
  }

  return (data ?? []) as DbMeasurement[];
}

export const POSTGRES_UNIQUE_VIOLATION = '23505';

/**
 * Insert a measurement. Returns a discriminated result so callers can
 * surface duplicates separately from real errors.
 *
 * - `'inserted'`  — row written; audit log emitted.
 * - `'duplicate'` — a row at this (user_id, metric_type, recorded_at) is
 *                   already `status='active'`. Enforced by the partial
 *                   UNIQUE index `uniq_measurements_user_metric_active`
 *                   (see `supabase/rls-policies.sql`), surfaced via
 *                   Postgres `23505 unique_violation` and remapped here.
 *                   The user should click-to-correct the existing row
 *                   rather than insert a second one.
 * - `'error'`     — any other DB error (logged to console; caller decides
 *                   whether to retry or 500).
 *
 * `userId` is required for the NOT NULL column; RLS additionally verifies
 * it matches `auth.uid()`, so a forged userId is rejected by the policy.
 *
 * Default `source` is `'manual'` (DB default). For lab-import flows pass
 * `'lab_import'` or `'lab_import_edited'` (the latter when the user
 * edited the value at review time).
 *
 * The bulk endpoint counts the three outcomes and returns
 * `{savedCount, skippedDuplicates, errorCount}` so the UploadModal done
 * screen can show an honest accounting.
 */
export async function addMeasurementWithStatus(
  client: SupabaseClient,
  userId: string,
  metricType: string,
  value: number,
  recordedAt?: string,
  source?: string,
  externalId?: string,
): Promise<{ status: 'inserted'; row: DbMeasurement } | { status: 'duplicate' } | { status: 'error' }> {
  const row: Record<string, unknown> = {
    user_id: userId,
    metric_type: metricType,
    value,
    recorded_at: recordedAt || new Date().toISOString(),
  };
  if (source) row.source = source;
  if (externalId) row.external_id = externalId;

  const { data, error } = await client.from('health_measurements').insert(row).select().single();
  if (error) {
    if (error.code === POSTGRES_UNIQUE_VIOLATION) return { status: 'duplicate' };
    console.error('Error adding measurement:', { error: error.message, code: error.code, metricType });
    return { status: 'error' };
  }
  logAudit(userId, 'MEASUREMENT_CREATED', 'measurement', data.id, { metricType });
  return { status: 'inserted', row: data as DbMeasurement };
}

/**
 * FHIR R4 `Observation` replaces pattern: never mutate a stored value.
 * Instead, atomically (a) flip the old row's `status` from `'active'` to
 * `'entered-in-error'` and (b) insert a NEW active row with
 * `source='manual_correction'` and `corrects_id=<old row's id>`. The
 * caller-visible value points at the new row; the old value is preserved
 * for audit. This matches the FHIR R4 semantics and plays nicely with
 * future EHR / Apple HealthKit export.
 *
 * Server-side enforcement (see `supabase/rls-policies.sql`):
 *   - `correct_measurement` is the ONLY path that can mutate a row's
 *     status. The `enforce_measurement_correction_only` trigger blocks
 *     every other UPDATE column-by-column and makes
 *     `entered-in-error` sticky (no reverts).
 *   - The RPC is `SECURITY DEFINER` with `WHERE user_id = auth.uid()` —
 *     it enforces ownership and can't be tricked by a forged `oldId`.
 *   - The new row hits the same partial UNIQUE index as a fresh insert;
 *     the RPC catches `23505` and rolls back, returning `'conflict'`.
 *
 * `userId` here is for the audit log only — the RPC has already
 * verified ownership internally.
 *
 * Returns a discriminated result so the route can distinguish:
 *   'ok'        — corrected; old row flipped, new row inserted, audit
 *                  log emitted with `{oldId}` metadata.
 *   'conflict'  — another active row was inserted at the same
 *                  (metric, recordedAt) between the user's click and
 *                  the RPC reaching the INSERT step. The route maps
 *                  this to HTTP 409 so the client shows
 *                  "Refresh and try again."
 *   'not_found' — `oldId` is missing, not owned, or already corrected.
 *                  Mapped to HTTP 404 — same message regardless of which
 *                  of the three so we don't leak ownership.
 */
export type CorrectMeasurementResult =
  | { status: 'ok'; newId: string }
  | { status: 'conflict' }
  | { status: 'not_found' };

export async function correctMeasurement(
  client: SupabaseClient,
  userId: string,
  oldId: string,
  newValue: number,
): Promise<CorrectMeasurementResult> {
  const { data, error } = await client.rpc('correct_measurement', {
    old_measurement_id: oldId,
    new_value: newValue,
    new_recorded_at: null,
  });

  if (error) {
    if (error.code === POSTGRES_UNIQUE_VIOLATION) {
      return { status: 'conflict' };
    }
    console.error('Error correcting measurement:', { error: error.message, code: error.code, oldId });
    return { status: 'not_found' };
  }

  const newId = data as string | null;
  if (!newId) return { status: 'not_found' };

  logAudit(userId, 'MEASUREMENT_CORRECTED', 'measurement', newId, { oldId });
  return { status: 'ok', newId };
}

/** Delete a measurement. RLS ensures the user owns it. */
export async function deleteMeasurement(
  client: SupabaseClient,
  measurementId: string,
): Promise<boolean> {
  const { data, error } = await client
    .from('health_measurements')
    .delete()
    .eq('id', measurementId)
    .select('id, user_id');

  if (error) {
    console.error('Error deleting measurement:', error);
    return false;
  }

  if (data && data.length > 0) {
    logAudit(data[0].user_id, 'MEASUREMENT_DELETED', 'measurement', measurementId);
  }
  return (data?.length ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Profile CRUD — demographics stored as columns on the profiles table.
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

/** Update profile demographics + height. RLS ensures the user owns it. */
export async function updateProfile(
  client: SupabaseClient,
  userId: string,
  updates: {
    sex?: number;
    birth_year?: number;
    birth_month?: number;
    unit_system?: number;
    first_name?: string;
    last_name?: string;
    height?: number;
  },
): Promise<DbProfile | null> {
  const { data, error } = await client
    .from('profiles')
    .update(updates)
    .eq('id', userId)
    .select()
    .single();

  if (error) {
    console.error('Error updating profile:', error);
    return null;
  }

  logAudit(userId, 'PROFILE_UPDATED', 'profile', userId, { fields: Object.keys(updates) });
  return data as DbProfile;
}

// ---------------------------------------------------------------------------
// Medication CRUD — mutable medication status for the cholesterol cascade.
// Uses UPSERT pattern (unique on user_id + medication_key).
// ---------------------------------------------------------------------------

export interface DbMedication {
  id: string;
  user_id: string;
  medication_key: string;
  drug_name: string;
  dose_value: number | null;
  dose_unit: string | null;
  status: string;
  started_at: string | null;
  updated_at: string;
  created_at: string;
}

/** Convert DB medication row to camelCase API format (FHIR-compatible). */
export function toApiMedication(m: DbMedication) {
  return {
    id: m.id,
    medicationKey: m.medication_key,
    drugName: m.drug_name,
    doseValue: m.dose_value,
    doseUnit: m.dose_unit,
    status: m.status,
    startedAt: m.started_at,
    updatedAt: m.updated_at,
  };
}

/** Get all medications for the authenticated user. */
export async function getMedications(
  client: SupabaseClient,
): Promise<DbMedication[]> {
  const { data, error } = await client
    .from('medications')
    .select('*');

  if (error) {
    console.error('Error fetching medications:', error);
    return [];
  }

  return (data ?? []) as DbMedication[];
}

/** Derive FHIR medication status from drug_name value. */
export function deriveMedicationStatus(drugName: string): string {
  switch (drugName) {
    case 'none': return 'not-taken';
    case 'not_tolerated': return 'stopped';
    case 'not_yet': return 'intended';
    default: return 'active';
  }
}

/** Upsert a medication status (FHIR-compatible). RLS verifies the user owns it. */
export async function upsertMedication(
  client: SupabaseClient,
  userId: string,
  medicationKey: string,
  drugName: string,
  doseValue: number | null = null,
  doseUnit: string | null = null,
): Promise<DbMedication | null> {
  const { data, error } = await client
    .from('medications')
    .upsert(
      {
        user_id: userId,
        medication_key: medicationKey,
        drug_name: drugName,
        dose_value: doseValue,
        dose_unit: doseUnit,
        status: deriveMedicationStatus(drugName),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,medication_key' },
    )
    .select()
    .single();

  if (error) {
    console.error('Error upserting medication:', { error: error.message, medicationKey });
    return null;
  }

  logAudit(userId, 'MEDICATION_UPDATED', 'medication', data.id, { medicationKey, drugName, doseValue });

  // Fire-and-forget: history recording shouldn't block the response
  recordMedicationChange(client, userId, medicationKey, drugName, doseValue, doseUnit).catch(e =>
    console.error('Failed to record medication history:', e),
  );

  return data as DbMedication;
}

// ---------------------------------------------------------------------------
// Medication History — immutable, append-only log of medication changes.
// FHIR MedicationStatement pattern with effective_start/effective_end.
// ---------------------------------------------------------------------------

export interface DbMedicationHistory {
  id: string;
  user_id: string;
  medication_key: string;
  drug_name: string;
  dose_value: number | null;
  dose_unit: string | null;
  status: string;
  effective_start: string;
  effective_end: string | null;
  change_type: string;
  source: string;
  created_at: string;
}

export function toApiMedicationHistory(m: DbMedicationHistory) {
  return {
    id: m.id,
    medicationKey: m.medication_key,
    drugName: m.drug_name,
    doseValue: m.dose_value,
    doseUnit: m.dose_unit,
    status: m.status,
    effectiveStart: m.effective_start,
    effectiveEnd: m.effective_end,
    changeType: m.change_type,
    source: m.source,
  };
}

/** Fetch all medication history for the current user. */
export async function getMedicationHistory(
  client: SupabaseClient,
): Promise<DbMedicationHistory[]> {
  const { data, error } = await client
    .from('medication_history')
    .select('*')
    .order('effective_start', { ascending: false });

  if (error) {
    console.error('Error fetching medication history:', error);
    return [];
  }
  return (data ?? []) as DbMedicationHistory[];
}

/**
 * Record a medication change in the history table.
 * Closes the previous open record (if state changed) and inserts a new one.
 */
export async function recordMedicationChange(
  client: SupabaseClient,
  userId: string,
  medicationKey: string,
  newDrugName: string,
  newDoseValue: number | null,
  newDoseUnit: string | null,
  effectiveStart?: string,
): Promise<void> {
  const now = effectiveStart ?? new Date().toISOString();
  const newStatus = deriveMedicationStatus(newDrugName);

  // Find current open history record
  const { data: openRows } = await client
    .from('medication_history')
    .select('*')
    .eq('medication_key', medicationKey)
    .is('effective_end', null)
    .limit(1);

  const prev = (openRows as DbMedicationHistory[] | null)?.[0];

  // Skip if state hasn't changed
  if (prev && prev.drug_name === newDrugName && prev.dose_value === newDoseValue) {
    return;
  }

  // Determine change type
  let changeType: string;
  if (!prev) {
    changeType = 'initial';
  } else if (newDrugName === 'none' || newDrugName === 'not_tolerated') {
    changeType = 'stopped';
  } else if (prev.drug_name !== newDrugName) {
    changeType = 'switched';
  } else {
    changeType = 'dose_changed';
  }

  // Close previous record
  if (prev) {
    await client
      .from('medication_history')
      .update({ effective_end: now })
      .eq('id', prev.id);
  }

  // Insert new record
  const { error } = await client
    .from('medication_history')
    .insert({
      user_id: userId,
      medication_key: medicationKey,
      drug_name: newDrugName,
      dose_value: newDoseValue,
      dose_unit: newDoseUnit,
      status: newStatus,
      effective_start: now,
      effective_end: null,
      change_type: changeType,
      source: 'manual',
    });

  if (error) {
    console.error('Error recording medication history:', { error: error.message, medicationKey });
  }
}

// ---------------------------------------------------------------------------
// Supplement CRUD — mutable supplement status.
// Uses UPSERT pattern (unique on user_id + supplement_key).
// ---------------------------------------------------------------------------

export interface DbSupplement {
  id: string;
  user_id: string;
  supplement_key: string;
  supplement_name: string;
  dose_value: number | null;
  dose_unit: string | null;
  status: string;
  started_at: string | null;
  updated_at: string;
  created_at: string;
}

export function toApiSupplement(s: DbSupplement) {
  return {
    id: s.id,
    supplementKey: s.supplement_key,
    supplementName: s.supplement_name,
    doseValue: s.dose_value,
    doseUnit: s.dose_unit,
    status: s.status,
    startedAt: s.started_at,
    updatedAt: s.updated_at,
  };
}

export async function getSupplements(
  client: SupabaseClient,
): Promise<DbSupplement[]> {
  const { data, error } = await client
    .from('supplements')
    .select('*');

  if (error) {
    console.error('Error fetching supplements:', error);
    return [];
  }
  return (data ?? []) as DbSupplement[];
}

export async function upsertSupplement(
  client: SupabaseClient,
  userId: string,
  supplementKey: string,
  supplementName: string,
  doseValue: number | null = null,
  doseUnit: string | null = null,
  status: string = 'active',
  startedAt?: string,
): Promise<DbSupplement | null> {
  const { data, error } = await client
    .from('supplements')
    .upsert(
      {
        user_id: userId,
        supplement_key: supplementKey,
        supplement_name: supplementName,
        dose_value: doseValue,
        dose_unit: doseUnit,
        status,
        started_at: startedAt ?? new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,supplement_key' },
    )
    .select()
    .single();

  if (error) {
    console.error('Error upserting supplement:', { error: error.message, supplementKey });
    return null;
  }

  logAudit(userId, 'SUPPLEMENT_UPDATED', 'supplement', data.id, { supplementKey, supplementName, doseValue, status });

  // Fire-and-forget: history recording shouldn't block the response
  recordSupplementChange(client, userId, supplementKey, supplementName, doseValue, doseUnit, status, startedAt).catch(e =>
    console.error('Failed to record supplement history:', e),
  );

  return data as DbSupplement;
}

export async function deleteSupplement(
  client: SupabaseClient,
  userId: string,
  supplementKey: string,
): Promise<boolean> {
  // Soft-delete: set status to 'stopped'
  const { data: existing } = await client
    .from('supplements')
    .select('supplement_name')
    .eq('supplement_key', supplementKey)
    .single();

  if (!existing) return false;

  const { error } = await client
    .from('supplements')
    .update({ status: 'stopped', updated_at: new Date().toISOString() })
    .eq('supplement_key', supplementKey);

  if (error) {
    console.error('Error deleting supplement:', error.message);
    return false;
  }

  logAudit(userId, 'SUPPLEMENT_STOPPED', 'supplement', supplementKey, { supplementKey });
  await recordSupplementChange(client, userId, supplementKey, existing.supplement_name, null, null, 'stopped');
  return true;
}

// ---------------------------------------------------------------------------
// Supplement History — immutable, append-only log of supplement changes.
// ---------------------------------------------------------------------------

export interface DbSupplementHistory {
  id: string;
  user_id: string;
  supplement_key: string;
  supplement_name: string;
  dose_value: number | null;
  dose_unit: string | null;
  status: string;
  effective_start: string;
  effective_end: string | null;
  change_type: string;
  source: string;
  created_at: string;
}

export function toApiSupplementHistory(s: DbSupplementHistory) {
  return {
    id: s.id,
    supplementKey: s.supplement_key,
    supplementName: s.supplement_name,
    doseValue: s.dose_value,
    doseUnit: s.dose_unit,
    status: s.status,
    effectiveStart: s.effective_start,
    effectiveEnd: s.effective_end,
    changeType: s.change_type,
    source: s.source,
  };
}

export async function getSupplementHistory(
  client: SupabaseClient,
): Promise<DbSupplementHistory[]> {
  const { data, error } = await client
    .from('supplement_history')
    .select('*')
    .order('effective_start', { ascending: false });

  if (error) {
    console.error('Error fetching supplement history:', error);
    return [];
  }
  return (data ?? []) as DbSupplementHistory[];
}

async function recordSupplementChange(
  client: SupabaseClient,
  userId: string,
  supplementKey: string,
  supplementName: string,
  newDoseValue: number | null,
  newDoseUnit: string | null,
  newStatus: string,
  effectiveStart?: string,
): Promise<void> {
  const now = effectiveStart ?? new Date().toISOString();

  const { data: openRows } = await client
    .from('supplement_history')
    .select('*')
    .eq('supplement_key', supplementKey)
    .is('effective_end', null)
    .limit(1);

  const prev = (openRows as DbSupplementHistory[] | null)?.[0];

  // Skip if state hasn't changed
  if (prev && prev.dose_value === newDoseValue && prev.status === newStatus) {
    return;
  }

  let changeType: string;
  if (!prev) {
    changeType = 'started';
  } else if (newStatus === 'stopped') {
    changeType = 'stopped';
  } else {
    changeType = 'dose_changed';
  }

  if (prev) {
    await client
      .from('supplement_history')
      .update({ effective_end: now })
      .eq('id', prev.id);
  }

  const { error } = await client
    .from('supplement_history')
    .insert({
      user_id: userId,
      supplement_key: supplementKey,
      supplement_name: supplementName,
      dose_value: newDoseValue,
      dose_unit: newDoseUnit,
      status: newStatus,
      effective_start: now,
      effective_end: null,
      change_type: changeType,
      source: 'manual',
    });

  if (error) {
    console.error('Error recording supplement history:', { error: error.message, supplementKey });
  }
}

// ---------------------------------------------------------------------------
// Screening CRUD — mutable screening status for the cancer screening cascade.
// Uses UPSERT pattern (unique on user_id + screening_key).
// ---------------------------------------------------------------------------

export interface DbScreening {
  id: string;
  user_id: string;
  screening_key: string;
  value: string;
  updated_at: string;
  created_at: string;
}

/** Convert DB screening row to camelCase API format. */
export function toApiScreening(s: DbScreening) {
  return {
    id: s.id,
    screeningKey: s.screening_key,
    value: s.value,
    updatedAt: s.updated_at,
  };
}

/** Get all screenings for the authenticated user. */
export async function getScreenings(
  client: SupabaseClient,
): Promise<DbScreening[]> {
  const { data, error } = await client
    .from('screenings')
    .select('*');

  if (error) {
    console.error('Error fetching screenings:', error);
    return [];
  }

  return (data ?? []) as DbScreening[];
}

/** Upsert a screening status. RLS verifies the user owns it. */
export async function upsertScreening(
  client: SupabaseClient,
  userId: string,
  screeningKey: string,
  value: string,
): Promise<DbScreening | null> {
  const { data, error } = await client
    .from('screenings')
    .upsert(
      {
        user_id: userId,
        screening_key: screeningKey,
        value,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,screening_key' },
    )
    .select()
    .single();

  if (error) {
    console.error('Error upserting screening:', { error: error.message, screeningKey });
    return null;
  }

  logAudit(userId, 'SCREENING_UPDATED', 'screening', data.id, { screeningKey });
  return data as DbScreening;
}

// ---------------------------------------------------------------------------
// Reminder preferences CRUD — per-category opt-out for health reminder emails.
// ---------------------------------------------------------------------------

export interface DbReminderPreference {
  id: string;
  user_id: string;
  reminder_category: string;
  enabled: boolean;
  updated_at: string;
  created_at: string;
}

/** Convert DB reminder preference row to camelCase API format. */
export function toApiReminderPreference(p: DbReminderPreference) {
  return {
    reminderCategory: p.reminder_category,
    enabled: p.enabled,
  };
}

/** Get all reminder preferences for the authenticated user. */
export async function getReminderPreferences(
  client: SupabaseClient,
): Promise<DbReminderPreference[]> {
  const { data, error } = await client
    .from('reminder_preferences')
    .select('*');

  if (error) {
    console.error('Error fetching reminder preferences:', error);
    return [];
  }

  return (data ?? []) as DbReminderPreference[];
}

/** Upsert a reminder preference. RLS verifies the user owns it. */
export async function upsertReminderPreference(
  client: SupabaseClient,
  userId: string,
  reminderCategory: string,
  enabled: boolean,
): Promise<DbReminderPreference | null> {
  const { data, error } = await client
    .from('reminder_preferences')
    .upsert(
      {
        user_id: userId,
        reminder_category: reminderCategory,
        enabled,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,reminder_category' },
    )
    .select()
    .single();

  if (error) {
    console.error('Error upserting reminder preference:', { error: error.message, reminderCategory });
    return null;
  }

  return data as DbReminderPreference;
}

/** Set the global opt-out flag on the user's profile. */
export async function setGlobalReminderOptout(
  client: SupabaseClient,
  userId: string,
  optout: boolean,
): Promise<boolean> {
  const { error } = await client
    .from('profiles')
    .update({ reminders_global_optout: optout })
    .eq('id', userId);

  if (error) {
    console.error('Error setting global reminder optout:', error);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Reminder log & unsubscribe — service role operations for the cron job.
// ---------------------------------------------------------------------------

export interface DbReminderLog {
  id: string;
  user_id: string;
  reminder_group: string;
  sent_at: string;
  next_eligible_at: string;
  details: Record<string, unknown> | null;
  created_at: string;
}

/** Check if a reminder group is within its cooldown period. Uses admin client. */
export async function isGroupOnCooldown(
  userId: string,
  reminderGroup: string,
  now: Date = new Date(),
): Promise<boolean> {
  if (!supabaseAdmin) return false;

  const { data, error } = await supabaseAdmin
    .from('reminder_log')
    .select('next_eligible_at')
    .eq('user_id', userId)
    .eq('reminder_group', reminderGroup)
    .gt('next_eligible_at', now.toISOString())
    .limit(1);

  if (error) {
    console.error('Error checking reminder cooldown:', error);
    return true; // fail safe: don't send if we can't check
  }

  return (data?.length ?? 0) > 0;
}

/** Log a sent reminder. Uses admin client. */
export async function logReminderSent(
  userId: string,
  reminderGroup: string,
  nextEligibleAt: Date,
  details: Record<string, unknown>,
): Promise<void> {
  if (!supabaseAdmin) return;

  const { error } = await supabaseAdmin
    .from('reminder_log')
    .insert({
      user_id: userId,
      reminder_group: reminderGroup,
      next_eligible_at: nextEligibleAt.toISOString(),
      details,
    });

  if (error) {
    console.error('Error logging reminder:', error);
  }
}

// ---------------------------------------------------------------------------
// Health Documents
// ---------------------------------------------------------------------------

interface DbHealthDocument {
  id: string;
  user_id: string;
  document_type: string;
  title: string;
  document_date: string | null;
  content_md: string;
  metadata: Record<string, unknown>;
  source_file_name: string | null;
  created_at: string;
}

/** Convert DB document row to camelCase API format. */
export function toApiDocument(d: DbHealthDocument) {
  return {
    id: d.id,
    documentType: d.document_type,
    title: d.title,
    documentDate: d.document_date,
    contentMd: d.content_md,
    metadata: d.metadata,
    sourceFileName: d.source_file_name,
    createdAt: d.created_at,
  };
}

export type ApiDocument = ReturnType<typeof toApiDocument>;

/** Get all health documents for the authenticated user, newest first. */
export async function getHealthDocuments(
  client: SupabaseClient,
): Promise<DbHealthDocument[]> {
  const { data, error } = await client
    .from('health_documents')
    .select('*')
    .order('document_date', { ascending: false, nullsFirst: false });

  if (error) {
    console.error('Error fetching health documents:', error);
    return [];
  }

  return (data ?? []) as DbHealthDocument[];
}

/** Add a health document. Returns the created document or null on error. */
export async function addHealthDocument(
  client: SupabaseClient,
  userId: string,
  doc: {
    documentType: string;
    title: string;
    documentDate: string | null;
    contentMd: string;
    metadata: Record<string, unknown>;
    sourceFileName: string | null;
  },
): Promise<DbHealthDocument | null> {
  const { data, error } = await client
    .from('health_documents')
    .insert({
      user_id: userId,
      document_type: doc.documentType,
      title: doc.title,
      document_date: doc.documentDate,
      content_md: doc.contentMd,
      metadata: doc.metadata,
      source_file_name: doc.sourceFileName,
    })
    .select()
    .single();

  if (error) {
    console.error('Error adding health document:', error);
    return null;
  }

  logAudit(userId, 'DOCUMENT_CREATED', 'health_document', data.id, {
    documentType: doc.documentType,
    title: doc.title,
  });

  return data as DbHealthDocument;
}

/** Delete a health document. RLS verifies ownership. */
export async function deleteHealthDocument(
  client: SupabaseClient,
  userId: string,
  documentId: string,
): Promise<boolean> {
  const { data, error } = await client
    .from('health_documents')
    .delete()
    .eq('id', documentId)
    .select('id');

  if (error) {
    console.error('Error deleting health document:', error);
    return false;
  }

  if (data && data.length > 0) {
    logAudit(userId, 'DOCUMENT_DELETED', 'health_document', documentId);
  }

  return (data?.length ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Lab Values (flexible storage for all non-core metrics)
// ---------------------------------------------------------------------------

interface DbLabValue {
  id: string;
  user_id: string;
  metric_name: string;
  value: number;
  unit: string;
  reference_low: number | null;
  reference_high: number | null;
  recorded_at: string;
  source: string;
  created_at: string;
}

/** Convert DB lab value row to camelCase API format. */
export function toApiLabValue(row: DbLabValue) {
  return {
    id: row.id,
    metricName: row.metric_name,
    value: row.value,
    unit: row.unit,
    referenceLow: row.reference_low,
    referenceHigh: row.reference_high,
    recordedAt: row.recorded_at,
    source: row.source,
    createdAt: row.created_at,
  };
}

export type ApiLabValue = ReturnType<typeof toApiLabValue>;

/** Get all lab values for the authenticated user, newest first. */
export async function getLabValues(
  client: SupabaseClient,
  metricName?: string,
  limit = 500,
  offset = 0,
): Promise<DbLabValue[]> {
  let query = client
    .from('lab_values')
    .select('*')
    .order('recorded_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (metricName) {
    query = query.eq('metric_name', metricName);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Error fetching lab values:', error);
    return [];
  }

  return (data ?? []) as DbLabValue[];
}

/** Bulk insert lab values. Returns created rows. */
export async function addLabValues(
  client: SupabaseClient,
  userId: string,
  values: Array<{
    metricName: string;
    value: number;
    unit: string;
    referenceLow?: number | null;
    referenceHigh?: number | null;
    recordedAt: string;
    source?: string;
  }>,
): Promise<DbLabValue[]> {
  const rows = values.map(v => ({
    user_id: userId,
    metric_name: v.metricName,
    value: v.value,
    unit: v.unit,
    reference_low: v.referenceLow ?? null,
    reference_high: v.referenceHigh ?? null,
    recorded_at: v.recordedAt,
    source: v.source || 'lab_import',
  }));

  const { data, error } = await client
    .from('lab_values')
    .insert(rows)
    .select();

  if (error) {
    console.error('Error inserting lab values:', error);
    return [];
  }

  logAudit(userId, 'LAB_VALUES_CREATED', 'lab_values', undefined, {
    count: values.length,
    metrics: values.map(v => v.metricName),
  });

  return (data ?? []) as DbLabValue[];
}

/** Delete a single lab value. RLS verifies ownership. */
export async function deleteLabValue(
  client: SupabaseClient,
  userId: string,
  labValueId: string,
): Promise<boolean> {
  const { data, error } = await client
    .from('lab_values')
    .delete()
    .eq('id', labValueId)
    .select('id');

  if (error) {
    console.error('Error deleting lab value:', error);
    return false;
  }

  if (data && data.length > 0) {
    logAudit(userId, 'LAB_VALUE_DELETED', 'lab_values', labValueId);
  }

  return (data?.length ?? 0) > 0;
}

/** Generate or retrieve unsubscribe token for a user. Uses admin client. */
export async function getOrCreateUnsubscribeToken(userId: string): Promise<string | null> {
  if (!supabaseAdmin) return null;

  // Check existing
  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('unsubscribe_token')
    .eq('id', userId)
    .single();

  if (profile?.unsubscribe_token) return profile.unsubscribe_token;

  // Generate new token
  const token = crypto.randomUUID();
  const { error } = await supabaseAdmin
    .from('profiles')
    .update({ unsubscribe_token: token })
    .eq('id', userId);

  if (error) {
    console.error('Error creating unsubscribe token:', error);
    return null;
  }

  return token;
}

/** Global unsubscribe via token (no auth required). Uses admin client. */
export async function globalUnsubscribeByToken(token: string): Promise<boolean> {
  if (!supabaseAdmin) return false;

  const { error } = await supabaseAdmin
    .from('profiles')
    .update({ reminders_global_optout: true })
    .eq('unsubscribe_token', token);

  if (error) {
    console.error('Error processing unsubscribe:', error);
    return false;
  }

  return true;
}

/** Get profile by unsubscribe token. Uses admin client. */
export async function getProfileByUnsubscribeToken(token: string): Promise<DbProfile | null> {
  if (!supabaseAdmin) return null;

  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('*')
    .eq('unsubscribe_token', token)
    .single();

  if (error || !data) return null;
  return data as DbProfile;
}

/** Get reminder preferences by user ID using admin client (for unsubscribe page). */
export async function getReminderPreferencesAdmin(userId: string): Promise<DbReminderPreference[]> {
  if (!supabaseAdmin) return [];

  const { data, error } = await supabaseAdmin
    .from('reminder_preferences')
    .select('*')
    .eq('user_id', userId);

  if (error) {
    console.error('Error fetching reminder preferences (admin):', error);
    return [];
  }

  return (data ?? []) as DbReminderPreference[];
}

/** Upsert a reminder preference using admin client (for unsubscribe page). */
export async function upsertReminderPreferenceAdmin(
  userId: string,
  reminderCategory: string,
  enabled: boolean,
): Promise<void> {
  if (!supabaseAdmin) return;

  const { error } = await supabaseAdmin
    .from('reminder_preferences')
    .upsert(
      {
        user_id: userId,
        reminder_category: reminderCategory,
        enabled,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,reminder_category' },
    );

  if (error) {
    console.error('Error upserting reminder preference (admin):', error);
  }
}

/** Get all eligible profiles for reminder processing. Uses admin client. */
export async function getEligibleReminderProfiles(
  limit: number,
  offset: number,
): Promise<DbProfile[]> {
  if (!supabaseAdmin) return [];

  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('*')
    .eq('reminders_global_optout', false)
    .eq('welcome_email_sent', true)
    .not('email', 'is', null)
    .range(offset, offset + limit - 1);

  if (error) {
    console.error('Error fetching eligible reminder profiles:', error);
    return [];
  }

  return (data ?? []) as DbProfile[];
}

/** Get all screenings for a user by ID. Uses admin client. */
export async function getScreeningsAdmin(userId: string): Promise<DbScreening[]> {
  if (!supabaseAdmin) return [];

  const { data, error } = await supabaseAdmin
    .from('screenings')
    .select('*')
    .eq('user_id', userId);

  if (error) {
    console.error('Error fetching screenings (admin):', error);
    return [];
  }

  return (data ?? []) as DbScreening[];
}

/** Get all medications for a user by ID. Uses admin client. */
export async function getMedicationsAdmin(userId: string): Promise<DbMedication[]> {
  if (!supabaseAdmin) return [];

  const { data, error } = await supabaseAdmin
    .from('medications')
    .select('*')
    .eq('user_id', userId);

  if (error) {
    console.error('Error fetching medications (admin):', error);
    return [];
  }

  return (data ?? []) as DbMedication[];
}

/** Get latest measurement date per metric for a user. Uses admin client.
 *  Uses the get_latest_measurement_dates RPC (DISTINCT ON) for efficiency. */
export async function getLatestMeasurementDatesAdmin(
  userId: string,
): Promise<Record<string, string>> {
  if (!supabaseAdmin) return {};

  const { data, error } = await supabaseAdmin
    .rpc('get_latest_measurement_dates', { target_user_id: userId });

  if (error) {
    console.error('Error fetching measurement dates (admin):', error);
    return {};
  }

  const dates: Record<string, string> = {};
  for (const row of data ?? []) {
    dates[row.metric_type] = row.recorded_at;
  }
  return dates;
}

/** Names of seeded `cron_lock` rows. New crons must add their lock name here AND
 *  seed a row in supabase/rls-policies.sql — typo on either side silently disables
 *  the cron (UPDATE matches zero rows → returns false → cron never runs). */
export type CronLockName = 'reminder_cron' | 'trending_cron';

/** Attempt to acquire the cron lock for today. Returns true if this machine
 *  should run the cron. Uses an atomic UPDATE with WHERE clause to prevent
 *  race conditions between machines. */
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
  const { data, error } = await supabaseAdmin
    .from('cron_lock')
    .update({
      locked_by: machineId,
      locked_at: new Date().toISOString(),
      lock_date: today,
    })
    .eq('lock_name', lockName)
    .or(`lock_date.is.null,lock_date.neq.${today}`)
    .select();

  if (error) {
    console.error(`Error acquiring cron lock (${lockName}):`, error);
    return false;
  }

  return (data?.length ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Shared health data loading — parallel fetch + conversion to health-core format.
// Used by email.server.ts (welcome/reminder emails) and chat.server.ts (LLM context).
// ---------------------------------------------------------------------------

export async function loadHealthData(client: SupabaseClient) {
  const [profile, latestMeasurements, medications, screenings, healthDocuments] = await Promise.all([
    getProfile(client),
    getLatestMeasurements(client),
    getMedications(client),
    getScreenings(client),
    getHealthDocuments(client),
  ]);
  if (!profile) return null;
  const apiProfile = toApiProfile(profile);
  const inputs = measurementsToInputs(
    latestMeasurements.map(toApiMeasurement), apiProfile,
  ) as HealthInputs;
  const medInputs = medicationsToInputs(medications.map(toApiMedication));
  const screenInputs = screeningsToInputs(screenings.map(toApiScreening));
  return { profile, inputs, medInputs, screenInputs, healthDocuments };
}

// ---------------------------------------------------------------------------
// Account data deletion — deletes all user data and anonymizes audit logs.
// Uses supabaseAdmin (service role) to ensure complete cleanup.
// ---------------------------------------------------------------------------

export async function deleteAllUserData(userId: string): Promise<{ measurementsDeleted: number }> {
  if (!supabaseAdmin) {
    throw new Error('Supabase admin client not configured');
  }

  // Safeguard: the Discord bot profile is shared across all Discord conversations.
  // Deleting it would wipe the entire Discord chat history in one request.
  const discordBotProfileId = process.env.DISCORD_BOT_PROFILE_ID;
  if (discordBotProfileId && userId === discordBotProfileId) {
    throw new Error('Refusing to delete shared Discord bot profile');
  }

  // 1. Log the deletion before removing data
  logAudit(userId, 'USER_DATA_DELETED', 'user', userId);

  // 2. Count and delete all measurements
  const { data: measurements } = await supabaseAdmin
    .from('health_measurements')
    .select('id')
    .eq('user_id', userId);
  const measurementsDeleted = measurements?.length ?? 0;

  if (measurementsDeleted > 0) {
    const { error: delError } = await supabaseAdmin
      .from('health_measurements')
      .delete()
      .eq('user_id', userId);
    if (delError) {
      throw new Error(`Failed to delete measurements: ${delError.message}`);
    }
  }

  // Delete dependent tables — log errors but continue (partial deletion > no deletion)
  for (const table of ['chat_messages', 'chat_conversations', 'message_credit_transactions', 'medication_history', 'medications', 'supplement_history', 'supplements', 'screenings', 'reminder_preferences', 'health_documents', 'lab_values', 'reminder_log'] as const) {
    const { error } = await supabaseAdmin.from(table).delete().eq('user_id', userId);
    if (error) console.error(`Failed to delete ${table} for ${userId}:`, error.message);
  }

  // 4. Anonymize audit logs
  await supabaseAdmin
    .from('audit_logs')
    .update({ user_id: null })
    .eq('user_id', userId);

  // 5. Delete profile row
  const { error: profileError } = await supabaseAdmin
    .from('profiles')
    .delete()
    .eq('id', userId);
  if (profileError) {
    throw new Error(`Failed to delete profile: ${profileError.message}`);
  }

  // 6. Delete Supabase Auth user
  const { error: authError } = await supabaseAdmin.auth.admin.deleteUser(userId);
  if (authError) {
    throw new Error(`Failed to delete auth user: ${authError.message}`);
  }

  // 7. Clear from in-memory cache
  for (const [key, entry] of userIdCache) {
    if (entry.userId === userId) {
      userIdCache.delete(key);
      break;
    }
  }

  return { measurementsDeleted };
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
 * Deduct one message credit atomically. Returns new balance, or -1 if no credits.
 */
export async function deductMessageCredit(userId: string): Promise<number> {
  if (!supabaseAdmin) throw new Error('Supabase admin client not configured');

  const { data, error } = await supabaseAdmin.rpc('deduct_message_credit', {
    target_user_id: userId,
  });

  if (error) {
    console.error('Failed to deduct credit:', error.message);
    return -1;
  }

  return data as number;
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
// Uses supabaseAdmin (service role) because these are cross-user aggregates.
// ---------------------------------------------------------------------------

export interface DashboardStats {
  totalUsers: number;
  activeUsers30d: number;
  totalMeasurements: number;
  remindersSent: number;
  welcomeEmailsSent: number;
  metricBreakdown: { metricType: string; entries: number; users: number }[];
  profileCompleteness: {
    total: number;
    withHeight: number;
    withSex: number;
    withBirthYear: number;
  };
  medicationUsers: number;
  recentSignups: { firstName: string | null; lastName: string | null; createdAt: string }[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyExclusion(query: any, column: string, ids: string[]): any {
  if (ids.length === 0) return query;
  // Validate all IDs are UUIDs to prevent injection via string interpolation
  const safeIds = ids.filter(id => UUID_RE.test(id));
  if (safeIds.length === 0) return query;
  return query.not(column, 'in', `(${safeIds.join(',')})`);
}

export async function getDashboardStats(): Promise<DashboardStats> {
  if (!supabaseAdmin) {
    throw new Error('Supabase admin client not configured');
  }

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  // Look up user_ids for excluded dashboard emails (test accounts)
  const excludedEmails = (process.env.EXCLUDED_DASHBOARD_EMAILS || '')
    .split(',')
    .map(e => e.trim())
    .filter(Boolean);
  let excludedUserIds: string[] = [];
  if (excludedEmails.length > 0) {
    const { data } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .in('email', excludedEmails);
    excludedUserIds = (data ?? []).map((r: { id: string }) => r.id);
  }

  const [
    profilesRes,
    activeUsersRes,
    measurementsCountRes,
    remindersRes,
    metricBreakdownRes,
    profileStatsRes,
    medicationUsersRes,
    recentSignupsRes,
    welcomeEmailsRes,
  ] = await Promise.all([
    // Total users (exclude ghost guest profiles)
    applyExclusion(
      supabaseAdmin.from('profiles').select('*', { count: 'exact', head: true }).eq('is_guest', false),
      'id', excludedUserIds,
    ),
    // Active users (last 30 days)
    applyExclusion(
      supabaseAdmin.from('health_measurements')
        .select('user_id')
        .gte('created_at', thirtyDaysAgo),
      'user_id', excludedUserIds,
    ),
    // Total measurements
    applyExclusion(
      supabaseAdmin.from('health_measurements').select('*', { count: 'exact', head: true }),
      'user_id', excludedUserIds,
    ),
    // Reminder emails sent
    applyExclusion(
      supabaseAdmin.from('reminder_log').select('*', { count: 'exact', head: true }),
      'user_id', excludedUserIds,
    ),
    // Metric breakdown: group by metric_type
    applyExclusion(
      supabaseAdmin.from('health_measurements').select('metric_type, user_id'),
      'user_id', excludedUserIds,
    ),
    // Profile completeness
    applyExclusion(
      supabaseAdmin.from('profiles').select('height, sex, birth_year'),
      'id', excludedUserIds,
    ),
    // Medication users
    applyExclusion(
      supabaseAdmin.from('medications').select('user_id').eq('status', 'active'),
      'user_id', excludedUserIds,
    ),
    // Recent signups
    applyExclusion(
      supabaseAdmin.from('profiles')
        .select('first_name, last_name, created_at')
        .order('created_at', { ascending: false })
        .limit(10),
      'id', excludedUserIds,
    ),
    // Welcome emails sent
    applyExclusion(
      supabaseAdmin.from('profiles')
        .select('*', { count: 'exact', head: true })
        .eq('welcome_email_sent', true),
      'id', excludedUserIds,
    ),
  ]);

  // Compute active users (distinct user_ids)
  const activeUserIds = new Set(
    (activeUsersRes.data ?? []).map((r: { user_id: string }) => r.user_id),
  );

  // Compute metric breakdown
  const metricMap = new Map<string, { entries: number; users: Set<string> }>();
  for (const row of metricBreakdownRes.data ?? []) {
    const entry = metricMap.get(row.metric_type) ?? { entries: 0, users: new Set<string>() };
    entry.entries++;
    entry.users.add(row.user_id);
    metricMap.set(row.metric_type, entry);
  }
  const metricBreakdown = Array.from(metricMap.entries())
    .map(([metricType, { entries, users }]) => ({ metricType, entries, users: users.size }))
    .sort((a, b) => b.entries - a.entries);

  // Profile completeness
  const profiles = profileStatsRes.data ?? [];
  const total = profiles.length;
  const withHeight = profiles.filter((p: { height: number | null }) => p.height != null).length;
  const withSex = profiles.filter((p: { sex: number | null }) => p.sex != null).length;
  const withBirthYear = profiles.filter((p: { birth_year: number | null }) => p.birth_year != null).length;

  // Medication users (distinct)
  const medUserIds = new Set(
    (medicationUsersRes.data ?? []).map((r: { user_id: string }) => r.user_id),
  );

  return {
    totalUsers: profilesRes.count ?? 0,
    activeUsers30d: activeUserIds.size,
    totalMeasurements: measurementsCountRes.count ?? 0,
    remindersSent: remindersRes.count ?? 0,
    welcomeEmailsSent: welcomeEmailsRes.count ?? 0,
    metricBreakdown,
    profileCompleteness: { total, withHeight, withSex, withBirthYear },
    medicationUsers: medUserIds.size,
    recentSignups: (recentSignupsRes.data ?? []).map(
      (r: { first_name: string | null; last_name: string | null; created_at: string }) => ({
        firstName: r.first_name,
        lastName: r.last_name,
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
