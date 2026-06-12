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

export const POSTGRES_UNIQUE_VIOLATION = '23505';

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

/**
 * Get active lab values for the authenticated user, newest first.
 * `entered-in-error` rows are excluded — they exist for audit only.
 */
export async function getLabValues(
  client: SupabaseClient,
  metricName?: string,
  limit = 500,
  offset = 0,
): Promise<DbLabValue[]> {
  let query = client
    .from('lab_values')
    .select('*')
    .eq('status', 'active')
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

/**
 * Bulk insert lab values. Per-row inserts (in parallel) so a single
 * 23505 unique_violation doesn't fail the whole batch — duplicates are
 * counted in `skippedDuplicates`.
 *
 * Dedup is enforced by `uniq_lab_values_user_metric_active` which is
 * `(user_id, lower(trim(metric_name)), recorded_at) WHERE status='active'`.
 * Callers can send any casing/whitespace; the index normalises.
 */
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
): Promise<{ saved: DbLabValue[]; skippedDuplicates: number; errorCount: number }> {
  const results = await Promise.all(values.map(v => {
    const row = {
      user_id: userId,
      metric_name: v.metricName,
      value: v.value,
      unit: v.unit,
      reference_low: v.referenceLow ?? null,
      reference_high: v.referenceHigh ?? null,
      recorded_at: v.recordedAt,
      source: v.source || 'lab_import',
    };
    return client.from('lab_values').insert(row).select().single();
  }));

  const saved: DbLabValue[] = [];
  let skippedDuplicates = 0;
  let errorCount = 0;
  for (const r of results) {
    if (r.error) {
      if (r.error.code === POSTGRES_UNIQUE_VIOLATION) {
        skippedDuplicates++;
      } else {
        console.error('Error inserting lab value:', { error: r.error.message, code: r.error.code });
        errorCount++;
      }
      continue;
    }
    if (r.data) saved.push(r.data as DbLabValue);
  }

  if (saved.length > 0) {
    logAudit(userId, 'LAB_VALUES_CREATED', 'lab_values', undefined, {
      count: saved.length,
      metrics: saved.map(r => r.metric_name),
    });
  }
  return { saved, skippedDuplicates, errorCount };
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

/** Names of seeded `cron_lock` rows. New crons must add their lock name here AND
 *  seed a row in supabase/rls-policies.sql — typo on either side silently disables
 *  the cron (UPDATE matches zero rows → returns false → cron never runs). */
export type CronLockName = 'reminder_v2_cron' | 'trending_cron' | 'youtube_bot_summary' | 'chat_summary';

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
    console.error(`Error acquiring cron lock (${lockName}):`, updateRes.error);
    Sentry.captureException(updateRes.error, {
      tags: { feature: lockName },
      extra: { machineId, today, lockName },
    });
    return false;
  }

  // Read back the row to determine who owns the lock for today. If this
  // machine's id + today's date are reflected, we won the CAS.
  const { data: verify, error: verifyErr } = await supabaseAdmin
    .from('cron_lock')
    .select('locked_by, lock_date')
    .eq('lock_name', lockName)
    .maybeSingle();

  if (verifyErr || !verify) {
    console.error(`Could not verify cron lock state (${lockName}):`, verifyErr);
    if (verifyErr) {
      Sentry.captureException(verifyErr, {
        tags: { feature: lockName },
        extra: { machineId, today, lockName },
      });
    }
    return false;
  }

  return verify.locked_by === machineId && verify.lock_date === today;
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
