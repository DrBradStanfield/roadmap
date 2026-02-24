import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';

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
// Used ONLY for user creation and profile lookups.
// ---------------------------------------------------------------------------

const supabaseAdmin = supabaseUrl && supabaseServiceKey
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

function logAudit(
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
}

/** Convert a DB measurement row to the camelCase API response format. */
export function toApiMeasurement(m: DbMeasurement) {
  return {
    id: m.id,
    metricType: m.metric_type,
    value: Number(m.value),
    recordedAt: m.recorded_at,
    createdAt: m.created_at,
    source: m.source,
    externalId: m.external_id,
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
): Promise<DbMeasurement[]> {
  const { data, error } = await client
    .from('health_measurements')
    .select('*')
    .eq('metric_type', metricType)
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
): Promise<DbMeasurement[]> {
  const { data, error } = await client
    .from('health_measurements')
    .select('*')
    .order('recorded_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    console.error('Error fetching all measurements:', error);
    return [];
  }

  return (data ?? []) as DbMeasurement[];
}

/** Insert a new measurement. Returns the created row.
 *  userId is required for the NOT NULL column; RLS verifies it matches auth.uid(). */
export async function addMeasurement(
  client: SupabaseClient,
  userId: string,
  metricType: string,
  value: number,
  recordedAt?: string,
  source?: string,
  externalId?: string,
): Promise<DbMeasurement | null> {
  const row: Record<string, unknown> = {
    user_id: userId,
    metric_type: metricType,
    value,
    recorded_at: recordedAt || new Date().toISOString(),
  };
  if (source) row.source = source;
  if (externalId) row.external_id = externalId;

  const { data, error } = await client
    .from('health_measurements')
    .insert(row)
    .select()
    .single();

  if (error) {
    console.error('Error adding measurement:', { error: error.message, code: error.code, metricType });
    return null;
  }

  logAudit(userId, 'MEASUREMENT_CREATED', 'measurement', data.id, { metricType });
  return data as DbMeasurement;
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
  return data as DbMedication;
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

/** Attempt to acquire the cron lock for today. Returns true if this machine
 *  should run the cron. Uses an atomic UPDATE with WHERE clause to prevent
 *  race conditions between machines. */
export async function tryAcquireCronLock(
  machineId: string,
  today: string,
): Promise<boolean> {
  if (!supabaseAdmin) return false;

  const { data, error } = await supabaseAdmin
    .from('cron_lock')
    .update({
      locked_by: machineId,
      locked_at: new Date().toISOString(),
      lock_date: today,
    })
    .eq('lock_name', 'reminder_cron')
    .neq('lock_date', today)
    .select();

  if (error) {
    console.error('Error acquiring cron lock:', error);
    return false;
  }

  return (data?.length ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Account data deletion — deletes all user data and anonymizes audit logs.
// Uses supabaseAdmin (service role) to ensure complete cleanup.
// ---------------------------------------------------------------------------

export async function deleteAllUserData(userId: string): Promise<{ measurementsDeleted: number }> {
  if (!supabaseAdmin) {
    throw new Error('Supabase admin client not configured');
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

  // 3. Delete all medications
  await supabaseAdmin
    .from('medications')
    .delete()
    .eq('user_id', userId);

  // 3b. Delete all screenings
  await supabaseAdmin
    .from('screenings')
    .delete()
    .eq('user_id', userId);

  // 3c. Delete all reminder preferences
  await supabaseAdmin
    .from('reminder_preferences')
    .delete()
    .eq('user_id', userId);

  // 3d. Delete all reminder logs
  await supabaseAdmin
    .from('reminder_log')
    .delete()
    .eq('user_id', userId);

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
    // Total users
    applyExclusion(
      supabaseAdmin.from('profiles').select('*', { count: 'exact', head: true }),
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
