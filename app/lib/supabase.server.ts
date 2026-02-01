import { createClient } from '@supabase/supabase-js';

// Supabase client using service role key (bypasses RLS).
// Only use server-side — never expose service key to client.
// SECURITY: Authorization is enforced in application code (each route scopes queries
// to the authenticated customer's profile). RLS policies provide defense-in-depth.
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.warn('Supabase environment variables not configured');
}

export const supabase = supabaseUrl && supabaseServiceKey
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

// Type definitions for database tables
export interface Profile {
  id: string;
  shopify_customer_id: string;
  email: string | null;
  created_at: string;
  updated_at: string;
}

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

// Helper to find or create a profile for a Shopify customer
export async function findOrCreateProfile(
  shopifyCustomerId: string,
  email?: string
): Promise<Profile | null> {
  if (!supabase) return null;

  // Try to find existing profile
  const { data: existing } = await supabase
    .from('profiles')
    .select('*')
    .eq('shopify_customer_id', shopifyCustomerId)
    .single();

  if (existing) {
    // Backfill email if missing
    if (!existing.email && email) {
      await supabase
        .from('profiles')
        .update({ email })
        .eq('id', existing.id);
      existing.email = email;
    }
    return existing as Profile;
  }

  // Create new profile
  const { data: newProfile, error } = await supabase
    .from('profiles')
    .insert({
      shopify_customer_id: shopifyCustomerId,
      email: email || null,
    })
    .select()
    .single();

  if (error) {
    console.error('Error creating profile:', error);
    return null;
  }

  return newProfile as Profile;
}

// ---------------------------------------------------------------------------
// Measurement CRUD (health_measurements table)
// All values are in SI canonical units.
// ---------------------------------------------------------------------------

/** Get measurements for a specific metric, ordered by recorded_at DESC. */
export async function getMeasurements(
  userId: string,
  metricType: string,
  limit = 50,
): Promise<DbMeasurement[]> {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from('health_measurements')
    .select('*')
    .eq('user_id', userId)
    .eq('metric_type', metricType)
    .order('recorded_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('Error fetching measurements:', error);
    return [];
  }

  return (data ?? []) as DbMeasurement[];
}

/** Get the latest measurement for each metric_type for a user. */
export async function getLatestMeasurements(
  userId: string,
): Promise<DbMeasurement[]> {
  if (!supabase) return [];

  // Use a raw query with DISTINCT ON for efficiency
  const { data, error } = await supabase
    .rpc('get_latest_measurements', { p_user_id: userId });

  if (error) {
    // Fallback: if RPC doesn't exist yet, do it in JS
    console.warn('get_latest_measurements RPC not available, using fallback:', error.message);
    return getLatestMeasurementsFallback(userId);
  }

  return (data ?? []) as DbMeasurement[];
}

/** Fallback: fetch all measurements and deduplicate in JS. */
async function getLatestMeasurementsFallback(
  userId: string,
): Promise<DbMeasurement[]> {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from('health_measurements')
    .select('*')
    .eq('user_id', userId)
    .order('recorded_at', { ascending: false });

  if (error) {
    console.error('Error fetching measurements (fallback):', error);
    return [];
  }

  // Keep only the latest per metric_type
  const seen = new Set<string>();
  const latest: DbMeasurement[] = [];
  for (const row of (data ?? []) as DbMeasurement[]) {
    if (!seen.has(row.metric_type)) {
      seen.add(row.metric_type);
      latest.push(row);
    }
  }
  return latest;
}

/** Insert a new measurement. Returns the created row. */
export async function addMeasurement(
  userId: string,
  metricType: string,
  value: number,
  recordedAt?: string,
): Promise<DbMeasurement | null> {
  if (!supabase) return null;

  const { data, error } = await supabase
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
    console.error('Error adding measurement:', error);
    return null;
  }

  return data as DbMeasurement;
}

/** Delete a measurement. Verifies user_id ownership. */
export async function deleteMeasurement(
  userId: string,
  measurementId: string,
): Promise<boolean> {
  if (!supabase) return false;

  const { error } = await supabase
    .from('health_measurements')
    .delete()
    .eq('id', measurementId)
    .eq('user_id', userId); // Security: ensure user owns this measurement

  if (error) {
    console.error('Error deleting measurement:', error);
    return false;
  }

  return true;
}
