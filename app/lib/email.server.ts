import { Resend } from 'resend';
import { PAGES_APP_URL } from './local-first-route.server';
import * as Sentry from '@sentry/remix';

// ---------------------------------------------------------------------------
// Resend client
// ---------------------------------------------------------------------------

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL || 'https://drstanfield.com';

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Escape user-provided strings before interpolating into HTML email templates. */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Send an email via Resend. Throws on configuration miss OR on Resend API errors.
 *
 * The Resend Node SDK returns `{ data, error }` for API failures (suppression,
 * payload too large, rate limit, invalid recipient) — it does NOT throw. Without
 * inspecting `error`, those failures are silent and the caller treats them as
 * success. Surface them so callers / Sentry actually see them.
 */
export async function sendEmail(to: string, subject: string, html: string): Promise<{ id: string }> {
  if (!resend) throw new Error('Email service not configured');
  const { data, error } = await resend.emails.send({
    from: `Dr Brad Stanfield <${RESEND_FROM_EMAIL}>`,
    to,
    subject,
    html,
  });
  if (error) {
    throw new Error(`Resend rejected email to ${to}: ${error.name ?? 'unknown'} — ${error.message ?? JSON.stringify(error)}`);
  }
  if (!data?.id) {
    throw new Error(`Resend returned no error and no id for email to ${to} — unexpected SDK response shape`);
  }
  return { id: data.id };
}

// ---------------------------------------------------------------------------
// Reminder email builder
// ---------------------------------------------------------------------------

import type { DueReminder, BloodTestDate } from '../../packages/health-core/src/reminders';
import { formatReminderDate } from '../../packages/health-core/src/reminders';

/**
 * Build HTML for a health reminder email.
 * HIPAA-aware: uses generic messages only, never specific health values.
 */
export function buildReminderEmailHtml(
  firstName: string | null,
  reminders: DueReminder[],
  bloodTestDates: BloodTestDate[],
  preferencesUrl: string,
): string {
  const greeting = firstName ? `Hi ${escapeHtml(firstName)},` : 'Hello,';
  const roadmapUrl = SHOPIFY_STORE_URL;

  // Group reminders
  const screeningReminders = reminders.filter(r => r.group === 'screening');
  const bloodTestReminders = reminders.filter(r => r.group === 'blood_test');
  const medicationReminders = reminders.filter(r => r.group === 'medication_review');

  let sectionsHtml = '';

  // Screening section
  if (screeningReminders.length > 0) {
    const items = screeningReminders.map(r =>
      reminderItem(r.title, r.description, '#f0ad4e')
    ).join('');
    sectionsHtml += `
      <div style="margin:0 0 24px;">
        <h2 style="color:#1a1a1a;font-size:18px;margin:0 0 12px;padding-bottom:8px;border-bottom:2px solid #f0ad4e;">
          Screening Reminders
        </h2>
        ${items}
      </div>
    `;
  }

  // Blood test section (includes context for ALL tracked tests)
  if (bloodTestReminders.length > 0) {
    const overdueItems = bloodTestReminders.map(r =>
      reminderItem(r.title, r.description, '#f0ad4e')
    ).join('');

    // Add context for non-overdue blood tests
    const upToDateTests = bloodTestDates.filter(d => !d.isOverdue);
    let contextHtml = '';
    if (upToDateTests.length > 0) {
      const contextItems = upToDateTests.map(d =>
        `<div style="padding:8px 12px;color:#555;font-size:13px;">
          ${d.label}: last tested ${d.lastDate ? formatReminderDate(d.lastDate) : 'unknown'}
        </div>`
      ).join('');
      contextHtml = `
        <div style="margin:8px 0 0;padding:12px;background:#f0f8f0;border-radius:4px;">
          <div style="color:#333;font-size:13px;font-weight:600;margin:0 0 4px;">Your other blood tests:</div>
          ${contextItems}
        </div>
      `;
    }

    sectionsHtml += `
      <div style="margin:0 0 24px;">
        <h2 style="color:#1a1a1a;font-size:18px;margin:0 0 12px;padding-bottom:8px;border-bottom:2px solid #f0ad4e;">
          Blood Test Reminders
        </h2>
        ${overdueItems}
        ${contextHtml}
      </div>
    `;
  }

  // Medication review section
  if (medicationReminders.length > 0) {
    const items = medicationReminders.map(r =>
      reminderItem(r.title, r.description, '#0275d8')
    ).join('');
    sectionsHtml += `
      <div style="margin:0 0 24px;">
        <h2 style="color:#1a1a1a;font-size:18px;margin:0 0 12px;padding-bottom:8px;border-bottom:2px solid #0275d8;">
          Medication Review
        </h2>
        ${items}
      </div>
    `;
  }

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;">Health reminders based on your saved data</div>
  <div style="max-width:600px;margin:0 auto;background:#ffffff;">

    <!-- Header -->
    <div style="background:#2563eb;padding:32px 24px;text-align:center;">
      <h1 style="color:#ffffff;margin:0;font-size:24px;font-weight:600;">Health Reminders</h1>
    </div>

    <!-- Content -->
    <div style="padding:24px;">

      <p style="color:#333;font-size:16px;line-height:1.5;margin:0 0 20px;">${greeting}</p>
      <p style="color:#333;font-size:16px;line-height:1.5;margin:0 0 24px;">
        Based on the health data you've saved, here are some upcoming items to discuss with your healthcare provider.
      </p>

      ${sectionsHtml}

      <!-- CTA Button -->
      <div style="text-align:center;margin:32px 0;">
        <a href="${roadmapUrl}"
           style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:6px;font-size:16px;font-weight:600;">
          View Your Health Roadmap
        </a>
      </div>

      <!-- Disclaimer -->
      <div style="background:#f8f9fa;border-radius:6px;padding:16px;margin:24px 0 0;">
        <p style="color:#666;font-size:13px;line-height:1.5;margin:0;">
          <strong>Disclaimer:</strong> This tool provides educational information only. It is not medical advice and should not be used to diagnose or treat health conditions. Always consult your healthcare provider before making changes to your health regimen.
        </p>
      </div>
    </div>

    <!-- Footer -->
    <div style="padding:16px 24px;text-align:center;border-top:1px solid #eee;">
      <p style="color:#999;font-size:12px;margin:0;">
        <a href="${preferencesUrl}" style="color:#999;text-decoration:underline;">Manage notification preferences</a>
      </p>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Send a reminder email via Resend. Returns true on success.
 */
export async function sendReminderEmail(
  to: string,
  html: string,
  preferencesUrl: string,
  subject = 'Health Reminders', // v1 default; v2 passes its own (Brad, 2026-06-10)
): Promise<boolean> {
  if (!resend) {
    // Production silent-fail trap: if RESEND_API_KEY is somehow unset on Fly,
    // every reminder send returns false and zero reminders go out without a
    // single Sentry event. Capture a warning so this becomes visible.
    console.warn('sendReminderEmail: Resend client not configured (RESEND_API_KEY missing)');
    Sentry.captureMessage('sendReminderEmail: Resend not configured', {
      level: 'warning',
      tags: { feature: 'reminder_email' },
    });
    return false;
  }

  try {
    const { error } = await resend.emails.send({
      from: `Dr Brad Stanfield <${RESEND_FROM_EMAIL}>`,
      to,
      subject,
      html,
      headers: {
        'List-Unsubscribe': `<${preferencesUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });
    if (error) {
      throw new Error(`Resend rejected reminder to ${to}: ${error.name ?? 'unknown'} — ${error.message ?? JSON.stringify(error)}`);
    }
    return true;
  } catch (error) {
    console.error('Error sending reminder email:', error);
    Sentry.captureException(error, { tags: { feature: 'reminder_email' } });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Feedback email
// ---------------------------------------------------------------------------

const FEEDBACK_EMAIL = process.env.FEEDBACK_EMAIL || 'brad@drstanfield.com';

/**
 * Send a user feedback email via Resend. Fire-and-forget — never throws.
 * Sets Reply-To to the user's email so the recipient can hit reply.
 */
export async function sendFeedbackEmail(
  userEmail: string,
  message: string,
  customerId: string | null,
): Promise<boolean> {
  if (!resend) {
    console.log('Resend not configured, skipping feedback email');
    return false;
  }

  try {
    const customerLine = customerId ? `Customer ID: ${customerId}` : 'Guest user';
    const timestamp = new Date().toISOString();

    const { error } = await resend.emails.send({
      from: `Health Roadmap Feedback <${RESEND_FROM_EMAIL}>`,
      to: FEEDBACK_EMAIL,
      subject: 'Health Roadmap Feedback',
      replyTo: userEmail,
      text: `${customerLine}\nTime: ${timestamp}\nFrom: ${userEmail}\n\n${message}`,
    });
    if (error) {
      throw new Error(`Resend rejected feedback email: ${error.name ?? 'unknown'} — ${error.message ?? JSON.stringify(error)}`);
    }
    return true;
  } catch (error) {
    console.error('Error sending feedback email:', error);
    Sentry.captureException(error, { tags: { feature: 'feedback_email' } });
    return false;
  }
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

function reminderItem(title: string, description: string, color: string): string {
  return `
    <div style="margin:0 0 12px;padding:12px;background:#f8f9fa;border-radius:4px;border-left:3px solid ${color};">
      <div style="color:#1a1a1a;font-size:14px;font-weight:600;margin:0 0 4px;">${title}</div>
      <div style="color:#555;font-size:13px;line-height:1.4;">${description}</div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// v2 reminder email builder (local-first §10 — label + due date is ALL we know)
// ---------------------------------------------------------------------------

/**
 * Build HTML for a v2 reminder email. No name (the server doesn't store one),
 * no values, no reasoning — just which items are due. Personalisation comes
 * from the item labels the user's own browser computed ("Colonoscopy").
 * Takes a structural item type so this shared template layer doesn't depend
 * on the reminders domain module.
 */
export function buildReminderV2EmailHtml(
  dueItems: Array<{ label: string; dueAt: string }>,
  unsubscribeUrl: string,
): string {
  const items = dueItems
    .map((item) =>
      reminderItem(
        `${escapeHtml(item.label)} — due ${formatReminderDate(item.dueAt)}`,
        'Please book this with your doctor.',
        '#f0ad4e',
      ),
    )
    .join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;">A health item on your plan is due</div>
  <div style="max-width:600px;margin:0 auto;background:#ffffff;">

    <div style="background:#2563eb;padding:32px 24px;text-align:center;">
      <h1 style="color:#ffffff;margin:0;font-size:24px;font-weight:600;">Dr Brad's Health Reminder</h1>
    </div>

    <div style="padding:24px;">
      <p style="color:#333;font-size:16px;line-height:1.5;margin:0 0 20px;">Hello,</p>
      <p style="color:#333;font-size:16px;line-height:1.5;margin:0 0 24px;">
        When you set up your health plan, you asked to be reminded when these items came due:
      </p>

      ${items}

      <div style="text-align:center;margin:32px 0;">
        <a href="${PAGES_APP_URL}"
           style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:6px;font-size:16px;font-weight:600;">
          Open Your Health Plan
        </a>
      </div>

      <div style="background:#f8f9fa;border-radius:6px;padding:16px;margin:24px 0 0;">
        <p style="color:#666;font-size:13px;line-height:1.5;margin:0;">
          <strong>Disclaimer:</strong> This tool provides educational information only. It is not medical advice and should not be used to diagnose or treat health conditions. Always consult your healthcare provider before making changes to your health regimen.
        </p>
      </div>
    </div>

    <div style="padding:16px 24px;text-align:center;border-top:1px solid #eee;">
      <p style="color:#999;font-size:12px;margin:0 0 4px;">
        Your health data lives only in your own cloud storage — these reminders are the only thing on Dr Brad's server.
      </p>
      <p style="color:#999;font-size:12px;margin:0;">
        <a href="${unsubscribeUrl}" style="color:#999;text-decoration:underline;">Unsubscribe</a>
      </p>
    </div>
  </div>
</body>
</html>`;
}
