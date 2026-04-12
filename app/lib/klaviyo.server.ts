import * as Sentry from '@sentry/remix';

const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
const KLAVIYO_LIST_ID = process.env.KLAVIYO_LIST_ID;

interface KlaviyoProfileData {
  email: string;
  sex?: string;
  heightCm?: number;
  weightKg?: number;
  birthMonth?: number;
  birthYear?: number;
}

/**
 * Subscribe a profile to the Klaviyo "Roadmap Guests" list.
 * Uses the Bulk Subscribe Profiles endpoint (v3).
 * Fire-and-forget — failure is logged but never blocks the caller.
 */
export async function subscribeToKlaviyo(data: KlaviyoProfileData): Promise<void> {
  if (!KLAVIYO_API_KEY || !KLAVIYO_LIST_ID) {
    console.log('Klaviyo not configured, skipping subscription');
    return;
  }

  const headers = {
    'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'revision': '2024-10-15',
  };

  try {
    // 1. Subscribe to list (this endpoint does NOT accept properties)
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
            list: { data: { type: 'list', id: KLAVIYO_LIST_ID } },
          },
        },
      }),
    });

    if (!subResponse.ok) {
      const body = await subResponse.text().catch(() => '');
      console.warn(`Klaviyo subscription failed: ${subResponse.status} ${body.slice(0, 200)}`);
    }

    // 2. Set custom profile properties via the Profiles API (which accepts properties)
    const properties: Record<string, string | number> = {};
    if (data.sex) properties.sex = data.sex;
    if (data.heightCm) properties.height_cm = data.heightCm;
    if (data.weightKg) properties.weight_kg = data.weightKg;
    if (data.birthMonth) properties.birth_month = data.birthMonth;
    if (data.birthYear) properties.birth_year = data.birthYear;

    if (Object.keys(properties).length > 0) {
      const profileResponse = await fetch('https://a.klaviyo.com/api/profiles/', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          data: {
            type: 'profile',
            attributes: {
              email: data.email,
              properties,
            },
          },
        }),
      });

      if (!profileResponse.ok) {
        const body = await profileResponse.text().catch(() => '');
        console.warn(`Klaviyo profile update failed: ${profileResponse.status} ${body.slice(0, 200)}`);
      }
    }
  } catch (error) {
    console.warn('Klaviyo subscription error:', error);
    Sentry.captureException(error, { tags: { feature: 'klaviyo' } });
  }
}
