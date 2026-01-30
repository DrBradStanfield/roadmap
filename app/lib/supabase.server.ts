import { createClient } from '@supabase/supabase-js';

// Supabase client using service role key (bypasses RLS).
// Only use server-side — never expose service key to client.
// SECURITY: Authorization is enforced in application code (each route scopes queries
// to the authenticated customer's profile). Consider adding RLS policies as an
// additional defense-in-depth layer so that even a code bug cannot leak cross-user data.
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

export interface HealthProfile {
  id: string;
  user_id: string;
  height_cm: number | null;
  weight_kg: number | null;
  waist_cm: number | null;
  sex: 'male' | 'female' | null;
  birth_year: number | null;
  birth_month: number | null;
  hba1c: number | null;
  ldl_c: number | null;
  hdl_c: number | null;
  triglycerides: number | null;
  fasting_glucose: number | null;
  systolic_bp: number | null;
  diastolic_bp: number | null;
  updated_at: string;
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

// Helper to get health profile for a user
export async function getHealthProfile(userId: string): Promise<HealthProfile | null> {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from('health_profiles')
    .select('*')
    .eq('user_id', userId)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('Error fetching health profile:', error);
  }

  return data as HealthProfile | null;
}

// Helper to save/update health profile
export async function saveHealthProfile(
  userId: string,
  healthData: Partial<Omit<HealthProfile, 'id' | 'user_id' | 'updated_at'>>
): Promise<HealthProfile | null> {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from('health_profiles')
    .upsert(
      {
        user_id: userId,
        ...healthData,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    )
    .select()
    .single();

  if (error) {
    console.error('Error saving health profile:', error);
    return null;
  }

  return data as HealthProfile;
}
