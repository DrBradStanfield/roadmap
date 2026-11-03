/**
 * Shopify customer to Supabase user mapping (US-09 AC27 link proof), its
 * in-memory cache, and audit logging. Split out of supabase.server.ts (issue #429).
 */
import * as Sentry from '@sentry/react-router';
import { supabaseAdmin } from './supabase-client.server';

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
//
// US-09 AC27: a link counts only when the auth user's admin-written
// app_metadata names this customer. Email, user_metadata (editable by anyone
// holding a session for that user) and a bare profile column are never proof.
// An unproven link returns null, so the caller answers as a guest: never a
// 500, never that principal, never cached.
// ---------------------------------------------------------------------------

export async function getOrCreateSupabaseUser(
  shopifyCustomerId: string,
  email: string,
  firstName?: string | null,
  lastName?: string | null,
): Promise<string | null> {
  if (!shopifyCustomerId || !email) {
    throw new Error('shopifyCustomerId and email are both required');
  }
  if (!supabaseAdmin) {
    throw new Error('Supabase admin client not configured');
  }

  const cached = getCachedUserId(shopifyCustomerId);
  if (cached) return cached;

  // Check if profile already exists
  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('id, first_name, last_name')
    .eq('shopify_customer_id', shopifyCustomerId)
    .maybeSingle();
  if (profileError) throw new Error('Profile lookup failed');

  if (profile) {
    // Never create a second account beside an unproven link.
    if (!(await hasLinkProof(profile.id, shopifyCustomerId))) return refuseUnprovenLink(profile.id);
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

  // Create Supabase Auth user
  const { data: authUser, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { shopify_customer_id: shopifyCustomerId },
    // The proof: only the service role can write app_metadata.
    app_metadata: { shopify_customer_id: shopifyCustomerId },
  });

  if (error) {
    // A parallel request may have just linked this customer.
    const { data: retryProfile, error: retryError } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .eq('shopify_customer_id', shopifyCustomerId)
      .maybeSingle();
    if (retryError) throw new Error('Profile retry lookup failed');
    if (retryProfile) {
      if (!(await hasLinkProof(retryProfile.id, shopifyCustomerId))) return refuseUnprovenLink(retryProfile.id);
      cacheUserId(shopifyCustomerId, retryProfile.id);
      return retryProfile.id;
    }

    // Otherwise another account holds this email (or creation failed). Email
    // is never proof, so that account is never adopted: guest, never a 500.
    return refuseUnprovenLink(null);
  }
  if (!authUser?.user) throw new Error('Failed to create Supabase user');
  const userId = authUser.user.id;

  // Never overwrite a competing link, including one created concurrently.
  const { data: candidateProfile, error: candidateError } = await supabaseAdmin
    .from('profiles').select('id, shopify_customer_id').eq('id', userId).maybeSingle();
  if (candidateError) throw new Error('Profile identity lookup failed');
  if (candidateProfile && candidateProfile.shopify_customer_id !== shopifyCustomerId) {
    // Supabase Auth inserts the user before it writes app_metadata, so the auth
    // trigger files this new profile with no customer id (issue #309). Claim
    // only that empty slot, and only on the admin-written proof.
    if (candidateProfile.shopify_customer_id !== null || !(await hasLinkProof(userId, shopifyCustomerId))) {
      return refuseUnprovenLink(userId);
    }
    const { error: claimError } = await supabaseAdmin.from('profiles')
      .update({ shopify_customer_id: shopifyCustomerId })
      .eq('id', userId).is('shopify_customer_id', null);
    if (claimError) return refuseUnprovenLink(userId);
  }

  // Explicitly create profile row — this is the primary mechanism.
  // The DB trigger on auth.users is defense-in-depth only.
  const { error: upsertError } = await supabaseAdmin
    .from('profiles')
    .upsert(
      { id: userId, shopify_customer_id: shopifyCustomerId, email, first_name: firstName ?? null, last_name: lastName ?? null },
      { onConflict: 'id', ignoreDuplicates: true },
    );

  if (upsertError) {
    console.error('Failed to create profile:', upsertError);
    throw new Error(`Failed to create profile: ${upsertError.message}`);
  }

  // Verify the row carries this link — catches silent failures and a competing insert
  const { data: verifiedProfile, error: verifyError } = await supabaseAdmin
    .from('profiles')
    .select('id')
    .eq('id', userId)
    .eq('shopify_customer_id', shopifyCustomerId)
    .maybeSingle();

  if (verifyError) throw new Error('Profile identity link verification failed');
  if (!verifiedProfile) return refuseUnprovenLink(userId);

  // The auth trigger may have won the insert. Sync names without changing its
  // identity columns, and scope the update to the verified Shopify mapping.
  const names: Record<string, string> = {};
  if (firstName != null) names.first_name = firstName;
  if (lastName != null) names.last_name = lastName;
  if (Object.keys(names).length) {
    const { error: nameError } = await supabaseAdmin.from('profiles').update(names)
      .eq('id', userId).eq('shopify_customer_id', shopifyCustomerId);
    if (nameError) throw new Error('Profile name update failed');
  }

  logAudit(userId, 'USER_CREATED', 'user', userId);
  cacheUserId(shopifyCustomerId, userId);
  return userId;
}

/** True when the auth user's admin-written app_metadata names this customer (US-09 AC27). */
async function hasLinkProof(userId: string, shopifyCustomerId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin!.auth.admin.getUserById(userId);
  if (error || !data?.user) throw new Error('Auth user lookup failed');
  return data.user.app_metadata?.shopify_customer_id === shopifyCustomerId;
}

/** An unproven link: warn without the customer id, audit the profile, answer null. */
function refuseUnprovenLink(userId: string | null): null {
  console.warn('Shopify link without admin-written proof; treated as guest');
  Sentry.captureMessage('Shopify link without admin-written proof', { level: 'warning', tags: { feature: 'identity_link' } });
  logAudit(userId, 'IDENTITY_LINK_UNPROVEN', 'user', userId ?? undefined);
  return null;
}

/**
 * Look up the Supabase user linked to a Shopify customer. Uses admin client.
 * Null when no profile is linked; `proven: false` when the link lacks
 * admin-written proof (US-09 AC27), so the caller must not credit it.
 */
export async function getUserIdByCustomerId(
  shopifyCustomerId: string,
): Promise<{ userId: string; proven: boolean } | null> {
  // Check in-memory cache first
  const cached = getCachedUserId(shopifyCustomerId);
  if (cached) return { userId: cached, proven: true };

  if (!supabaseAdmin) return null;

  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('id')
    .eq('shopify_customer_id', shopifyCustomerId)
    .single();

  if (error || !data) return null;
  // The cache is shared with chat: hold only a proven link (US-09 AC27).
  if (!(await hasLinkProof(data.id, shopifyCustomerId))) {
    refuseUnprovenLink(data.id);
    return { userId: data.id, proven: false };
  }
  cacheUserId(shopifyCustomerId, data.id);
  return { userId: data.id, proven: true };
}
