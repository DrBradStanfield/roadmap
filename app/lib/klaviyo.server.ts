import * as Sentry from '@sentry/react-router';

const KLAVIYO_BASE = 'https://a.klaviyo.com/api';
const KLAVIYO_REVISION = '2024-10-15';

// Read env at call-time (not module-load) so it's set even when this module is
// imported before env is populated (e.g. in unit tests).
const klaviyoApiKey = () => process.env.KLAVIYO_API_KEY;
const klaviyoListId = () => process.env.KLAVIYO_LIST_ID;

function klaviyoHeaders(): Record<string, string> {
  return {
    Authorization: `Klaviyo-API-Key ${klaviyoApiKey()}`,
    Accept: 'application/json',
    revision: KLAVIYO_REVISION,
  };
}

/**
 * Email only. This once carried sex, height, weight and birth date as Klaviyo
 * properties; the v1 teardown (2026-06-12) removed every caller that filled
 * them, and health values do not belong on a marketing platform. Deleted
 * 2026-09-10.
 */
interface KlaviyoProfileData {
  email: string;
}

/**
 * Subscribe a profile to the Klaviyo "Roadmap Guests" list.
 * Uses the Bulk Subscribe Profiles endpoint (v3).
 * Fire-and-forget — failure is logged but never blocks the caller.
 */
export async function subscribeToKlaviyo(data: KlaviyoProfileData): Promise<void> {
  const listId = klaviyoListId();
  if (!klaviyoApiKey() || !listId) {
    console.log('Klaviyo not configured, skipping subscription');
    return;
  }

  const headers = { ...klaviyoHeaders(), 'Content-Type': 'application/json' };

  try {
    const subResponse = await fetch('https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs/', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        data: {
          type: 'profile-subscription-bulk-create-job',
          attributes: {
            profiles: {
              data: [{
                type: 'profile',
                attributes: {
                  email: data.email,
                  subscriptions: {
                    email: { marketing: { consent: 'SUBSCRIBED' } },
                  },
                },
              }],
            },
          },
          relationships: {
            list: { data: { type: 'list', id: listId } },
          },
        },
      }),
    });

    if (!subResponse.ok) {
      const body = await subResponse.text().catch(() => '');
      // Status only on the console: Fly logs are unscrubbed, and a Klaviyo
      // error body echoes the address that was submitted. The body reaches ops
      // through Sentry, where scrubEventText runs over it.
      console.warn(`Klaviyo subscription failed: ${subResponse.status}`);
      Sentry.captureException(new Error(`Klaviyo subscription failed (${subResponse.status})`), {
        // 200, not 500: the Sentry scrub drops any `extra` string longer than
        // 200 characters outright, so a longer slice would reach ops as nothing.
        extra: { status: subResponse.status, errorText: body.slice(0, 200) },
        tags: { feature: 'klaviyo' },
      });
    }

  } catch (error) {
    console.warn('Klaviyo subscription error:', error);
    Sentry.captureException(error, { tags: { feature: 'klaviyo' } });
  }
}

// ---------------------------------------------------------------------------
// Klaviyo capture stats — real numbers pulled live from the "Health Roadmap
// Guests" list (the list the guest "email me my plan" button subscribes to).
//
// Three figures for the admin dashboard:
//   - total    — all-time list size (Get List `profile_count`, one cheap call)
//   - last30d  — joined the list in the trailing 30 days
//   - prev30d  — joined 31–60 days ago (for the rate trend)
//
// The two windows come from ONE paginated sweep of profiles that joined in the
// last 60 days (filtered + sparse `joined_group_at` only — no other PII pulled),
// bucketed in JS. The list is small (hundreds), so the sweep is a handful of
// 100-row pages. Counts only — no emails are returned to or surfaced by the
// dashboard. Wrapped in a per-call timeout; the caller treats any throw as
// "stats unavailable" so a Klaviyo hiccup never breaks the dashboard.
// ---------------------------------------------------------------------------

const KLAVIYO_STATS_TIMEOUT_MS = 8000;
const KLAVIYO_MAX_PAGES = 20; // safety cap (20 × 100 = 2000 profiles)

export interface KlaviyoCaptureStats {
  total: number;
  last30d: number;
  prev30d: number;
  trendPct: number; // signed % change of last30d vs prev30d, rounded
  trendDirection: 'up' | 'down' | 'flat';
}

/** Pure trend math — exported for unit testing. */
export function computeCaptureTrend(
  last30d: number,
  prev30d: number,
): { trendPct: number; trendDirection: 'up' | 'down' | 'flat' } {
  if (prev30d === 0) {
    // No prior baseline: any signups now read as "up", none as "flat".
    return last30d > 0
      ? { trendPct: 100, trendDirection: 'up' }
      : { trendPct: 0, trendDirection: 'flat' };
  }
  const pct = Math.round(((last30d - prev30d) / prev30d) * 100);
  return {
    trendPct: pct,
    trendDirection: pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat',
  };
}

async function klaviyoGet(url: string): Promise<Response> {
  return fetch(url, {
    headers: klaviyoHeaders(),
    signal: AbortSignal.timeout(KLAVIYO_STATS_TIMEOUT_MS),
  });
}

/**
 * Fetch live capture stats from the Klaviyo guest list. Throws on
 * misconfiguration or any API failure — the dashboard loader catches it and
 * renders the card as "unavailable" rather than crashing the page.
 */
export async function getKlaviyoCaptureStats(): Promise<KlaviyoCaptureStats> {
  const listId = klaviyoListId();
  if (!klaviyoApiKey() || !listId) {
    throw new Error('Klaviyo not configured');
  }

  const now = Date.now();
  const iso30 = new Date(now - 30 * 86_400_000).toISOString();
  const iso60 = new Date(now - 60 * 86_400_000).toISOString();
  const cutoff30 = new Date(iso30).getTime();

  // 1. Total list size — Get List with the profile_count additional field.
  const listRes = await klaviyoGet(
    `${KLAVIYO_BASE}/lists/${listId}/?additional-fields[list]=profile_count`,
  );
  if (!listRes.ok) {
    throw new Error(`Klaviyo Get List failed (${listRes.status})`);
  }
  const listJson = (await listRes.json()) as {
    data?: { attributes?: { profile_count?: number } };
  };
  const total = listJson.data?.attributes?.profile_count ?? 0;

  // 2. Sweep profiles that joined the list in the last 60 days, sparse-fielded
  //    to joined_group_at only, and bucket into the two 30-day windows.
  const filter = `greater-than(joined_group_at,${iso60})`;
  let url: string | null =
    `${KLAVIYO_BASE}/lists/${listId}/profiles/?` +
    new URLSearchParams({
      filter,
      'fields[profile]': 'joined_group_at',
      'page[size]': '100',
    }).toString();

  let last30d = 0;
  let prev30d = 0;
  for (let page = 0; url && page < KLAVIYO_MAX_PAGES; page++) {
    const res: Response = await klaviyoGet(url);
    if (!res.ok) {
      throw new Error(`Klaviyo List Profiles failed (${res.status})`);
    }
    const json = (await res.json()) as {
      data?: { attributes?: { joined_group_at?: string | null } }[];
      links?: { next?: string | null };
    };
    for (const row of json.data ?? []) {
      const joined = row.attributes?.joined_group_at;
      if (!joined) continue;
      const t = new Date(joined).getTime();
      if (t >= cutoff30) last30d++;
      else prev30d++; // already filtered to >60d-ago, so this is the 31–60d window
    }
    url = json.links?.next ?? null;
  }

  return { total, last30d, prev30d, ...computeCaptureTrend(last30d, prev30d) };
}

// Short in-memory cache so repeated admin-dashboard loads don't re-sweep Klaviyo
// (one dashboard hit = up to ~8 Klaviyo calls). Per-process; fine for a tiny
// single-machine admin surface.
const KLAVIYO_STATS_TTL_MS = 5 * 60_000;
let statsCache: { at: number; value: KlaviyoCaptureStats } | null = null;

/** Cached wrapper around getKlaviyoCaptureStats (5-min TTL). Still throws on failure. */
export async function getCachedKlaviyoCaptureStats(): Promise<KlaviyoCaptureStats> {
  if (statsCache && Date.now() - statsCache.at < KLAVIYO_STATS_TTL_MS) {
    return statsCache.value;
  }
  const value = await getKlaviyoCaptureStats();
  statsCache = { at: Date.now(), value };
  return value;
}

/**
 * Suppress an address (US-22 AC3): it hard-bounced or the recipient marked us
 * as spam, so it must stop receiving anything and must stop diluting the ad
 * audiences this list feeds.
 *
 * Unsubscribe, never delete (Brad, 2026-08-11): the profile and its history
 * stay, so a misclassified bounce is reversible and we keep the record that
 * the address was ever captured. Klaviyo excludes UNSUBSCRIBED profiles from
 * sends and from audience syncs, which is the whole point.
 */
export async function suppressInKlaviyo(email: string): Promise<boolean> {
  const listId = klaviyoListId();
  if (!klaviyoApiKey() || !listId) {
    console.log('Klaviyo not configured, skipping suppression');
    return false;
  }
  try {
    const response = await fetch(`${KLAVIYO_BASE}/profile-subscription-bulk-delete-jobs/`, {
      method: 'POST',
      headers: { ...klaviyoHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: {
          type: 'profile-subscription-bulk-delete-job',
          attributes: {
            profiles: { data: [{ type: 'profile', attributes: { email } }] },
          },
          relationships: { list: { data: { type: 'list', id: listId } } },
        },
      }),
    });
    if (!response.ok) {
      // Status only — the body carries the address (see the note above).
      console.error(`Klaviyo suppression failed: ${response.status}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error('Klaviyo suppression error:', error);
    return false;
  }
}
