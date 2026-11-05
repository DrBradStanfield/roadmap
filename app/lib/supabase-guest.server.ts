/**
 * Guest chat sessions: hashed client IP, per-IP creation limit, ghost profiles.
 * Split out of supabase.server.ts (issue #429).
 */
import crypto from 'node:crypto';
import * as Sentry from '@sentry/react-router';
import { supabaseAdmin } from './supabase-client.server';
import { logAudit } from './supabase-identity.server';

// ---------------------------------------------------------------------------
// Guest chat session management
// ---------------------------------------------------------------------------

/**
 * The stand-in for a guest's IP everywhere it is compared or stored (US-15 AC7,
 * 2026-09-10). A salted HMAC: equal addresses give equal values, so the session
 * check and the rate-limit bucket work unchanged, but a stored value cannot be
 * read back into an address, and a rainbow table of the whole IPv4 space does
 * not help without the key.
 *
 * The salt is derived from `SHOPIFY_API_SECRET` — the app-proxy secret every
 * surface that can reach this code already carries, so no new env var and no
 * key to rotate separately. The HKDF info string keeps it separate from the
 * proxy signature that uses the same secret.
 */
export function hashClientIp(ip: string): string {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) throw new Error('SHOPIFY_API_SECRET is not configured');
  const key = crypto.hkdfSync('sha256', secret, Buffer.alloc(0), 'guest-ip/v1', 32);
  return crypto.createHmac('sha256', Buffer.from(key)).update(ip, 'utf8').digest('base64url');
}

// Hashed-IP rate limit for guest session creation: 10 new sessions/hour per IP,
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

/** Runs one guest-cleanup step. A failed step leaves an orphan, so it is
 *  reported (US-15 AC7c), and never thrown, so the next step still runs. The
 *  report is a fixed Error with closed tags, never the raw error: a Postgres
 *  error's details can echo the guest id (US-15 AC6). */
async function cleanupStep(step: 'profile' | 'auth_user', run: () => PromiseLike<{ error: unknown }>): Promise<void> {
  let code: string;
  try {
    const { error } = await run();
    if (!error) return;
    const raw = (error as { code?: unknown }).code;
    code = typeof raw === 'string' && /^\w{1,32}$/.test(raw) ? raw : 'unknown';
  } catch {
    code = 'thrown';
  }
  Sentry.captureException(new Error('Guest session cleanup failed'), {
    tags: { feature: 'guest_chat', subsystem: 'guest_session_cleanup', step, code },
  });
}

/** Removes the ghost profile and auth user a failed creation made, each
 *  attempted whatever the other did. A failed step leaves an orphan, so it is
 *  reported (US-15 AC7c). Deleting a profile that was never written is harmless. */
async function removeGhost(admin: NonNullable<typeof supabaseAdmin>, sessionId: string): Promise<void> {
  await cleanupStep('profile', () => admin.from('profiles').delete().eq('id', sessionId));
  await cleanupStep('auth_user', () => admin.auth.admin.deleteUser(sessionId));
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
  // Nothing below this line touches `ip` again (US-15 AC7): the session row,
  // the rate-limit bucket and the audit entry all key on the hash.
  const ipHash = hashClientIp(ip);

  // Existing session — validate token + IP (checked BEFORE rate limit to avoid penalizing returning guests)
  if (sessionToken) {
    const { data: session } = await supabaseAdmin
      .from('guest_chat_sessions')
      .select('id, session_token, ip_address')
      .eq('session_token', sessionToken)
      .single();

    if (session && session.ip_address === ipHash) {
      return { sessionId: session.id, sessionToken: session.session_token };
    }
    // Invalid token or IP mismatch — fall through to create new session
  }

  // In-memory IP rate limit (only for new session creation, not returning sessions)
  const ipEntry = guestIpRateMap.get(ipHash);
  if (ipEntry && now < ipEntry.resetAt && ipEntry.count >= GUEST_IP_RATE_MAX) {
    throw new GuestRateLimitError('Too many requests');
  }
  if (!ipEntry || now > ipEntry.resetAt) {
    guestIpRateMap.set(ipHash, { count: 1, resetAt: now + GUEST_IP_RATE_WINDOW_MS });
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
    await removeGhost(supabaseAdmin, sessionId); // US-15 AC7d
    console.error('Failed to create guest profile:', profileError);
    throw new Error('Failed to create guest session');
  }

  const { data: newSession, error: sessionError } = await supabaseAdmin
    .from('guest_chat_sessions')
    .insert({ id: sessionId, ip_address: ipHash })
    .select('session_token')
    .single();

  if (sessionError || !newSession) {
    await removeGhost(supabaseAdmin, sessionId);
    console.error('Failed to create guest session:', sessionError);
    throw new Error('Failed to create guest session');
  }

  logAudit(null, 'GUEST_SESSION_CREATED', 'guest_chat', sessionId);
  return { sessionId, sessionToken: newSession.session_token };
}

/** Custom error for guest rate limiting (caught in api.chat.ts to return 429). */
export class GuestRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuestRateLimitError';
  }
}
