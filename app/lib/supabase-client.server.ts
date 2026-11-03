/**
 * Supabase clients: the service-role admin client (built once, at module load)
 * and the per-user RLS client. Split out of supabase.server.ts (issue #429).
 */
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
