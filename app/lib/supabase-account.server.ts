/**
 * Profile reads and subscription plan writes.
 * Split out of supabase.server.ts (issue #429).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from './supabase-client.server';
import { safeErrorFields } from './safe-error-fields.server';

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

export interface DbProfile {
  id: string;
  shopify_customer_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  welcome_email_sent: boolean;
  created_at: string;
  subscription_plan: string;
  subscription_checked_at: string | null;
}

// ---------------------------------------------------------------------------
// Profile lookup — operational columns only (subscription plan).
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
    console.error('Error fetching profile:', safeErrorFields(error));
    return null;
  }

  return data as DbProfile;
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
