/**
 * Reminder preferences API + unsubscribe page.
 *
 * Authenticated routes (via app proxy HMAC):
 *   GET  — Load reminder preferences (JSON)
 *   POST — Update reminder preference or global opt-out
 *
 * Unauthenticated routes (via unsubscribe token):
 *   GET  ?token=xxx — Render preferences page (HTML)
 *   POST ?token=xxx — Save preferences from the page
 */
import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/node';
import * as Sentry from '@sentry/remix';
import { authenticate } from '../shopify.server';
import {
  getOrCreateSupabaseUser,
  createUserClient,
  getReminderPreferences,
  upsertReminderPreference,
  setGlobalReminderOptout,
  toApiReminderPreference,
  getProfileByUnsubscribeToken,
  getReminderPreferencesAdmin,
  upsertReminderPreferenceAdmin,
  globalUnsubscribeByToken,
} from '../lib/supabase.server';
import { REMINDER_CATEGORIES, REMINDER_CATEGORY_LABELS, type ReminderCategory } from '../../packages/health-core/src/reminders';

function getCustomerId(request: Request): string | null {
  const url = new URL(request.url);
  return url.searchParams.get('logged_in_customer_id') || null;
}

async function getCustomerInfo(admin: any, customerId: string): Promise<{ email: string; firstName: string | null; lastName: string | null } | null> {
  try {
    const response = await admin.graphql(`
      query getCustomer($id: ID!) {
        customer(id: $id) {
          email
          firstName
          lastName
        }
      }
    `, { variables: { id: `gid://shopify/Customer/${customerId}` } });
    const result = await response.json();
    const customer = result?.data?.customer;
    if (!customer?.email) return null;
    return { email: customer.email, firstName: customer.firstName || null, lastName: customer.lastName || null };
  } catch (error) {
    console.error('Error looking up customer info:', error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// GET — Load preferences (authenticated) or render unsubscribe page (token)
// ---------------------------------------------------------------------------

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');

  // Token-based: render standalone unsubscribe/preferences page
  if (token) {
    return renderPreferencesPage(token);
  }

  // Authenticated: return JSON preferences
  const { admin } = await authenticate.public.appProxy(request);
  const customerId = getCustomerId(request);
  if (!customerId) {
    return json({ success: false, error: 'Not logged in' }, { status: 401 });
  }

  try {
    const customerInfo = admin ? await getCustomerInfo(admin, customerId) : null;
    if (!customerInfo) {
      return json({ success: false, error: 'Could not retrieve customer info' }, { status: 500 });
    }

    const userId = await getOrCreateSupabaseUser(customerId, customerInfo.email, customerInfo.firstName, customerInfo.lastName);
    const client = createUserClient(userId);

    const preferences = await getReminderPreferences(client);
    return json({
      success: true,
      preferences: preferences.map(toApiReminderPreference),
    });
  } catch (error) {
    console.error('Error loading reminder preferences:', error);
    Sentry.captureException(error);
    return json({ success: false, error: 'Failed to load' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// POST — Update preferences (authenticated) or save from unsubscribe page
// ---------------------------------------------------------------------------

export async function action({ request }: ActionFunctionArgs) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');

  // Token-based: save from preferences page
  if (token) {
    return handleTokenPost(request, token);
  }

  // Authenticated: update via app proxy
  const { admin } = await authenticate.public.appProxy(request);
  const customerId = getCustomerId(request);
  if (!customerId) {
    return json({ success: false, error: 'Not logged in' }, { status: 401 });
  }

  try {
    const customerInfo = admin ? await getCustomerInfo(admin, customerId) : null;
    if (!customerInfo) {
      return json({ success: false, error: 'Could not retrieve customer info' }, { status: 500 });
    }

    const userId = await getOrCreateSupabaseUser(customerId, customerInfo.email, customerInfo.firstName, customerInfo.lastName);
    const client = createUserClient(userId);

    const body = await request.json();

    // Global opt-out toggle
    if (body.globalOptout !== undefined) {
      const success = await setGlobalReminderOptout(client, userId, !!body.globalOptout);
      return json({ success });
    }

    // Per-category preference toggle
    if (body.reminderPreference) {
      const { category, enabled } = body.reminderPreference;
      if (!REMINDER_CATEGORIES.includes(category)) {
        return json({ success: false, error: 'Invalid category' }, { status: 400 });
      }
      const result = await upsertReminderPreference(client, userId, category, !!enabled);
      return json({ success: !!result });
    }

    return json({ success: false, error: 'Invalid request body' }, { status: 400 });
  } catch (error) {
    console.error('Error updating reminder preferences:', error);
    Sentry.captureException(error);
    return json({ success: false, error: 'Failed to update' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Token-based preferences page (unauthenticated)
// ---------------------------------------------------------------------------

async function renderPreferencesPage(token: string): Promise<Response> {
  const profile = await getProfileByUnsubscribeToken(token);
  const preferences = profile ? await getReminderPreferencesAdmin(profile.id) : [];

  // Build a map of disabled categories
  const disabledCategories = new Set(
    preferences.filter(p => !p.enabled).map(p => p.reminder_category)
  );

  const isGlobalOptout = profile?.reminders_global_optout ?? false;

  // Build checkbox HTML
  const checkboxes = REMINDER_CATEGORIES.map((cat: ReminderCategory) => {
    const checked = !disabledCategories.has(cat) && !isGlobalOptout ? 'checked' : '';
    const label = REMINDER_CATEGORY_LABELS[cat];
    return `
      <label style="display:flex;align-items:center;gap:8px;padding:8px 0;cursor:pointer;">
        <input type="checkbox" name="categories" value="${cat}" ${checked}
               style="width:18px;height:18px;cursor:pointer;" ${isGlobalOptout ? 'disabled' : ''}>
        <span style="font-size:15px;color:#333;">${label}</span>
      </label>
    `;
  }).join('');

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Notification Preferences</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:500px;margin:40px auto;background:#fff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,0.1);overflow:hidden;">
    <div style="background:#2563eb;padding:24px;text-align:center;">
      <h1 style="color:#fff;margin:0;font-size:20px;font-weight:600;">Notification Preferences</h1>
    </div>

    <form method="POST" style="padding:24px;">
      <p style="color:#555;font-size:14px;line-height:1.5;margin:0 0 20px;">
        Choose which health reminder emails you'd like to receive.
      </p>

      <div style="border:1px solid #e5e7eb;border-radius:6px;padding:12px 16px;margin:0 0 24px;">
        ${checkboxes}
      </div>

      <button type="submit" name="action" value="save"
              style="width:100%;padding:12px;background:#2563eb;color:#fff;border:none;border-radius:6px;font-size:15px;font-weight:600;cursor:pointer;">
        Save Preferences
      </button>

      <hr style="margin:24px 0;border:none;border-top:1px solid #e5e7eb;">

      <button type="submit" name="action" value="unsubscribe_all"
              style="width:100%;padding:12px;background:${isGlobalOptout ? '#6b7280' : '#dc3545'};color:#fff;border:none;border-radius:6px;font-size:14px;cursor:pointer;"
              ${isGlobalOptout ? 'disabled' : ''}>
        ${isGlobalOptout ? 'Unsubscribed from all notifications' : 'Unsubscribe from all health notifications'}
      </button>
    </form>

    <div style="padding:16px 24px;text-align:center;border-top:1px solid #eee;">
      <p style="color:#999;font-size:12px;margin:0;">
        Health Roadmap by Dr Brad Stanfield
      </p>
    </div>
  </div>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

async function handleTokenPost(request: Request, token: string): Promise<Response> {
  const profile = await getProfileByUnsubscribeToken(token);

  // Always return the same page regardless of token validity (security)
  if (!profile) {
    return renderConfirmationPage('Your preferences have been updated.');
  }

  const formData = await request.formData();
  const action = formData.get('action');

  if (action === 'unsubscribe_all') {
    await globalUnsubscribeByToken(token);
    return renderConfirmationPage('You have been unsubscribed from all health notification emails.');
  }

  if (action === 'save') {
    const selectedCategories = formData.getAll('categories').map(String);

    // Update each category: enabled if checked, disabled if not
    for (const cat of REMINDER_CATEGORIES) {
      const enabled = selectedCategories.includes(cat);
      await upsertReminderPreferenceAdmin(profile.id, cat, enabled);
    }

    return renderConfirmationPage('Your notification preferences have been saved.');
  }

  return renderConfirmationPage('Your preferences have been updated.');
}

function renderConfirmationPage(message: string): Response {
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Preferences Updated</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:500px;margin:40px auto;background:#fff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,0.1);overflow:hidden;">
    <div style="background:#2563eb;padding:24px;text-align:center;">
      <h1 style="color:#fff;margin:0;font-size:20px;font-weight:600;">Preferences Updated</h1>
    </div>
    <div style="padding:24px;text-align:center;">
      <p style="color:#333;font-size:16px;line-height:1.5;">${message}</p>
    </div>
  </div>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
