import * as Sentry from '@sentry/remix';

const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
const KLAVIYO_LIST_ID = process.env.KLAVIYO_LIST_ID;

/**
 * Subscribe an email to the Klaviyo "Roadmap Guests" list.
 * Uses the Bulk Subscribe Profiles endpoint (v3).
 * Fire-and-forget — failure is logged but never blocks the caller.
 */
export async function subscribeToKlaviyo(email: string): Promise<void> {
  if (!KLAVIYO_API_KEY || !KLAVIYO_LIST_ID) {
    console.log('Klaviyo not configured, skipping subscription');
    return;
  }

  try {
    const response = await fetch('https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs/', {
      method: 'POST',
      headers: {
        'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'revision': '2024-10-15',
      },
      body: JSON.stringify({
        data: {
          type: 'profile-subscription-bulk-create-job',
          attributes: {
            profiles: {
              data: [{
                type: 'profile',
                attributes: {
                  email,
                  subscriptions: {
                    email: { marketing: { consent: 'SUBSCRIBED' } },
                  },
                },
              }],
            },
          },
          relationships: {
            list: {
              data: { type: 'list', id: KLAVIYO_LIST_ID },
            },
          },
        },
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.warn(`Klaviyo subscription failed: ${response.status} ${body.slice(0, 200)}`);
    }
  } catch (error) {
    console.warn('Klaviyo subscription error:', error);
    Sentry.captureException(error, { tags: { feature: 'klaviyo' } });
  }
}
