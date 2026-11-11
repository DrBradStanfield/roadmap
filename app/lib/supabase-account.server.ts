/**
 * Profile reads, message credits and subscription plan writes.
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
    console.error('Error fetching profile:', safeErrorFields(error));
    return null;
  }

  return data as DbProfile;
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
 * Durably record a paid order the webhook did not credit because its link is
 * unproven (US-09 AC27), so Brad can credit it by hand. Once per order (check,
 * then insert); order id and profile id only. False when it could not be stored.
 */
export async function recordUnprovenPaidOrder(userId: string, orderId: string): Promise<boolean> {
  if (!supabaseAdmin) return false;
  const action = 'PAID_ORDER_UNPROVEN_LINK';
  const { data, error } = await supabaseAdmin
    .from('audit_logs').select('id').eq('action', action).eq('resource_id', orderId).limit(1);
  if (error) return false;
  if (data?.length) return true;
  const { error: insertError } = await supabaseAdmin.from('audit_logs')
    .insert({ user_id: userId, action, resource_type: 'chat', resource_id: orderId, metadata: null });
  return !insertError;
}
