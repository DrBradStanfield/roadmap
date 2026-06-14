import * as Sentry from '@sentry/react-router';

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
      Sentry.captureException(new Error(`Klaviyo subscription failed (${subResponse.status})`), {
        extra: { status: subResponse.status, errorText: body.slice(0, 500) },
        tags: { feature: 'klaviyo' },
      });
    }

    // 2. Set custom profile properties via the Profiles API (which accepts properties)
    const properties: Record<string, string | number> = {};
    if (data.sex) properties.sex = data.sex;
    if (data.heightCm) properties.height_cm = data.heightCm;
    if (data.weightKg) properties.weight_kg = data.weightKg;
    if (data.birthMonth) properties.birth_month = data.birthMonth;
    if (data.birthYear) properties.birth_year = data.birthYear;

    if (Object.keys(properties).length > 0) {
      // Try creating the profile; on 409 (duplicate), extract the ID and PATCH instead
      const createRes = await fetch('https://a.klaviyo.com/api/profiles/', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          data: {
            type: 'profile',
            attributes: { email: data.email, properties },
          },
        }),
      });

      if (createRes.status === 409) {
        // Extract existing profile ID from the 409 error response
        const errBody = await createRes.json().catch(() => null);
        const profileId = errBody?.errors?.[0]?.meta?.duplicate_profile_id;
        if (profileId) {
          const patchRes = await fetch(`https://a.klaviyo.com/api/profiles/${profileId}/`, {
            method: 'PATCH',
            headers,
            body: JSON.stringify({
              data: { type: 'profile', id: profileId, attributes: { properties } },
            }),
          });
          if (!patchRes.ok) {
            const body = await patchRes.text().catch(() => '');
            console.warn(`Klaviyo profile PATCH failed: ${patchRes.status} ${body.slice(0, 200)}`);
            Sentry.captureException(new Error(`Klaviyo profile PATCH failed (${patchRes.status})`), {
              extra: { status: patchRes.status, errorText: body.slice(0, 500) },
              tags: { feature: 'klaviyo' },
            });
          }
        }
      } else if (!createRes.ok) {
        const body = await createRes.text().catch(() => '');
        console.warn(`Klaviyo profile update failed: ${createRes.status} ${body.slice(0, 200)}`);
        Sentry.captureException(new Error(`Klaviyo profile update failed (${createRes.status})`), {
          extra: { status: createRes.status, errorText: body.slice(0, 500) },
          tags: { feature: 'klaviyo' },
        });
      }
    }
  } catch (error) {
    console.warn('Klaviyo subscription error:', error);
    Sentry.captureException(error, { tags: { feature: 'klaviyo' } });
  }
}
