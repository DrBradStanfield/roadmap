/**
 * One-time backfill: subscribe recent users to the Klaviyo "Health Roadmap Guests" list.
 *
 * Sources:
 *   1. Supabase profiles (logged-in users) — includes demographics
 *   2. Resend sent emails (guest report recipients) — email only
 *
 * Usage: npx tsx scripts/backfill-klaviyo.ts
 * Requires: SUPABASE_URL, SUPABASE_SERVICE_KEY, KLAVIYO_API_KEY, KLAVIYO_LIST_ID, RESEND_API_KEY in .env
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DAYS_BACK = 5;
const DELAY_MS = 200; // pause between Klaviyo calls

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
const KLAVIYO_LIST_ID = process.env.KLAVIYO_LIST_ID;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  process.exit(1);
}
if (!KLAVIYO_API_KEY || !KLAVIYO_LIST_ID) {
  console.error('Missing KLAVIYO_API_KEY or KLAVIYO_LIST_ID');
  process.exit(1);
}
if (!RESEND_API_KEY) {
  console.error('Missing RESEND_API_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const resend = new Resend(RESEND_API_KEY);
const cutoff = new Date(Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000);

// ---------------------------------------------------------------------------
// Klaviyo helpers (inlined — can't import server module in a script)
// ---------------------------------------------------------------------------

const klaviyoHeaders = {
  'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
  'Accept': 'application/json',
  'Content-Type': 'application/json',
  'revision': '2024-10-15',
};

interface BackfillEntry {
  email: string;
  source: 'supabase' | 'resend';
  sex?: string;
  heightCm?: number;
  weightKg?: number;
  birthMonth?: number;
  birthYear?: number;
}

async function subscribeToKlaviyo(entry: BackfillEntry): Promise<boolean> {
  // 1. Subscribe to list
  const subRes = await fetch('https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs/', {
    method: 'POST',
    headers: klaviyoHeaders,
    body: JSON.stringify({
      data: {
        type: 'profile-subscription-bulk-create-job',
        attributes: {
          profiles: {
            data: [{
              type: 'profile',
              attributes: {
                email: entry.email,
                subscriptions: { email: { marketing: { consent: 'SUBSCRIBED' } } },
              },
            }],
          },
        },
        relationships: {
          list: { data: { type: 'list', id: KLAVIYO_LIST_ID } },
        },
      },
    }),
  });

  if (!subRes.ok) {
    const body = await subRes.text().catch(() => '');
    console.warn(`  ✗ Subscribe failed for ${entry.email}: ${subRes.status} ${body.slice(0, 150)}`);
    return false;
  }

  // 2. Set profile properties if available
  const properties: Record<string, string | number> = {};
  if (entry.sex) properties.sex = entry.sex;
  if (entry.heightCm) properties.height_cm = entry.heightCm;
  if (entry.weightKg) properties.weight_kg = entry.weightKg;
  if (entry.birthMonth) properties.birth_month = entry.birthMonth;
  if (entry.birthYear) properties.birth_year = entry.birthYear;

  if (Object.keys(properties).length > 0) {
    const createRes = await fetch('https://a.klaviyo.com/api/profiles/', {
      method: 'POST',
      headers: klaviyoHeaders,
      body: JSON.stringify({
        data: {
          type: 'profile',
          attributes: { email: entry.email, properties },
        },
      }),
    });

    if (createRes.status === 409) {
      const errBody = await createRes.json().catch(() => null);
      const profileId = errBody?.errors?.[0]?.meta?.duplicate_profile_id;
      if (profileId) {
        const patchRes = await fetch(`https://a.klaviyo.com/api/profiles/${profileId}/`, {
          method: 'PATCH',
          headers: klaviyoHeaders,
          body: JSON.stringify({
            data: { type: 'profile', id: profileId, attributes: { properties } },
          }),
        });
        if (!patchRes.ok) {
          const body = await patchRes.text().catch(() => '');
          console.warn(`  ⚠ Profile PATCH failed for ${entry.email}: ${patchRes.status} ${body.slice(0, 150)}`);
        }
      }
    } else if (!createRes.ok) {
      const body = await createRes.text().catch(() => '');
      console.warn(`  ⚠ Profile properties failed for ${entry.email}: ${createRes.status} ${body.slice(0, 150)}`);
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Step 1: Supabase profiles
// ---------------------------------------------------------------------------

async function getSupabaseUsers(): Promise<BackfillEntry[]> {
  console.log(`\n--- Supabase: profiles created since ${cutoff.toISOString()} ---`);

  const { data: profiles, error } = await supabase
    .from('profiles')
    .select('id, email, sex, height, birth_year, birth_month')
    .gte('created_at', cutoff.toISOString());

  if (error) {
    console.error('Supabase query error:', error.message);
    return [];
  }

  if (!profiles || profiles.length === 0) {
    console.log('No profiles found in date range.');
    return [];
  }

  console.log(`Found ${profiles.length} profiles.`);

  // Fetch latest weight for each user
  const userIds = profiles.map(p => p.id);
  const { data: weights } = await supabase
    .from('health_measurements')
    .select('user_id, value')
    .in('user_id', userIds)
    .eq('metric_type', 'weight')
    .order('recorded_at', { ascending: false });

  const latestWeight = new Map<string, number>();
  for (const w of weights || []) {
    if (!latestWeight.has(w.user_id)) {
      latestWeight.set(w.user_id, Number(w.value));
    }
  }

  const sexMap: Record<number, string> = { 1: 'male', 2: 'female' };

  return profiles.map(p => ({
    email: p.email,
    source: 'supabase' as const,
    sex: p.sex ? sexMap[p.sex] : undefined,
    heightCm: p.height ? Number(p.height) : undefined,
    weightKg: latestWeight.get(p.id),
    birthMonth: p.birth_month ?? undefined,
    birthYear: p.birth_year ?? undefined,
  }));
}

// ---------------------------------------------------------------------------
// Step 2: Resend guest emails
// ---------------------------------------------------------------------------

async function getResendGuestEmails(): Promise<BackfillEntry[]> {
  console.log(`\n--- Resend: guest report emails since ${cutoff.toISOString()} ---`);

  const guestEmails: string[] = [];
  let cursor: string | undefined;
  let page = 0;

  while (true) {
    page++;
    const options: { limit: number; starting_after?: string } = { limit: 100 };
    if (cursor) options.starting_after = cursor;

    const { data, error } = await resend.emails.list(options);

    if (error || !data) {
      console.error('Resend API error:', error);
      break;
    }

    const emails = data.data;
    if (!emails || emails.length === 0) break;

    let reachedCutoff = false;
    for (const email of emails) {
      const sentAt = new Date(email.created_at);
      if (sentAt < cutoff) {
        reachedCutoff = true;
        break;
      }
      // Guest reports have this subject; welcome emails have a different one
      if (email.subject === 'Your Personalized Health Plan' && email.to?.length) {
        guestEmails.push(email.to[0]);
      }
    }

    if (reachedCutoff || !data.has_more) break;

    // Use last email ID as cursor for next page
    cursor = emails[emails.length - 1].id;
    console.log(`  Page ${page}: ${emails.length} emails scanned...`);
  }

  console.log(`Found ${guestEmails.length} guest report recipients.`);
  return guestEmails.map(email => ({ email, source: 'resend' as const }));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`Backfilling Klaviyo — last ${DAYS_BACK} days (since ${cutoff.toISOString()})`);

  const [supabaseEntries, resendEntries] = await Promise.all([
    getSupabaseUsers(),
    getResendGuestEmails(),
  ]);

  // Deduplicate by email — prefer Supabase entries (they have demographics)
  const byEmail = new Map<string, BackfillEntry>();
  for (const entry of [...resendEntries, ...supabaseEntries]) {
    byEmail.set(entry.email.toLowerCase(), entry);
  }

  const all = Array.from(byEmail.values());
  console.log(`\n--- Subscribing ${all.length} unique emails to Klaviyo ---`);

  let success = 0;
  let failed = 0;

  for (const entry of all) {
    const ok = await subscribeToKlaviyo(entry);
    if (ok) {
      console.log(`  ✓ ${entry.email} (${entry.source})`);
      success++;
    } else {
      failed++;
    }
    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  console.log(`\nDone: ${success} subscribed, ${failed} failed, ${all.length} total.`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
