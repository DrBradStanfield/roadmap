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
// getOrCreateSupabaseUser — maps a Shopify customer to a Supabase Auth user.
// Both params are required; throws if either is missing.
// ---------------------------------------------------------------------------

export async function getOrCreateSupabaseUser(
  shopifyCustomerId: string,
  email: string,
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
    .select('id')
    .eq('shopify_customer_id', shopifyCustomerId)
    .single();

  if (profile) {
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
    // Race condition or existing user — try to find the auth user by email.
    // This handles both "already been registered" and "Database error creating new user"
    // (the latter occurs when parallel requests race to create the same user).
    const { data: listData, error: listError } = await supabaseAdmin.auth.admin.listUsers();
    if (listError) {
      throw new Error(`Failed to list users: ${listError.message}`);
    }
    const existingUser = listData.users.find((u) => u.email === email);
    if (!existingUser) {
      // Also re-check profiles in case a parallel request already completed
      const { data: retryProfile } = await supabaseAdmin
        .from('profiles')
        .select('id')
        .eq('shopify_customer_id', shopifyCustomerId)
        .single();
      if (retryProfile) {
        cacheUserId(shopifyCustomerId, retryProfile.id);
        return retryProfile.id;
      }
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
      { id: userId, shopify_customer_id: shopifyCustomerId, email },
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
}

/** Convert a DB measurement row to the camelCase API response format. */
export function toApiMeasurement(m: DbMeasurement) {
  return {
    id: m.id,
    metricType: m.metric_type,
    value: m.value,
    recordedAt: m.recorded_at,
    createdAt: m.created_at,
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

/** Insert a new measurement. Returns the created row.
 *  userId is required for the NOT NULL column; RLS verifies it matches auth.uid(). */
export async function addMeasurement(
  client: SupabaseClient,
  userId: string,
  metricType: string,
  value: number,
  recordedAt?: string,
): Promise<DbMeasurement | null> {
  const { data, error } = await client
    .from('health_measurements')
    .insert({
      user_id: userId,
      metric_type: metricType,
      value,
      recorded_at: recordedAt || new Date().toISOString(),
    })
    .select()
    .single();

  if (error) {
    console.error('Error adding measurement:', { error: error.message, code: error.code, userId, metricType, value });
    return null;
  }

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
    .select('id');

  if (error) {
    console.error('Error deleting measurement:', error);
    return false;
  }

  return (data?.length ?? 0) > 0;
}
