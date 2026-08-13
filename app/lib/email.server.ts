import { Resend } from 'resend';
import { PAGES_APP_URL } from './local-first-route.server';
import * as Sentry from '@sentry/react-router';
import { recordServerEvent } from './product-events.server';

// ---------------------------------------------------------------------------
// Resend client
// ---------------------------------------------------------------------------

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL || 'https://drstanfield.com';
// Our own origin, for links that must hit our routes (the US-22 click redirect)
// rather than the storefront. Same source as the reminder cron's unsubscribe URL.
export const APP_BASE_URL = process.env.SHOPIFY_APP_URL || 'https://health-tool-app.fly.dev';

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
export async function sendEmail(
  to: string,
  subject: string,
  html: string,
  replyTo?: string,
): Promise<{ id: string }> {
  if (!resend) throw new Error('Email service not configured');
  const { data, error } = await resend.emails.send({
    from: `Dr Brad Stanfield <${RESEND_FROM_EMAIL}>`,
    to,
    subject,
    html,
    ...(replyTo ? { replyTo } : {}),
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
 * "Add to calendar" as a plain Google Calendar template URL (US-24 — links,
 * not attachments; Brad 2026-08-14). All-day event on the due date (end date
 * exclusive, so one day = dueAt..dueAt+1). The event description points at the
 * /roadmap/open redirect, so a calendar-sourced return visit is click-counted
 * the same first-party way as an email one.
 */
export function googleCalendarUrl(label: string, dueAt: string): string {
  const day = dueAt.replace(/-/g, '');
  const next = new Date(`${dueAt}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const nextDay = next.toISOString().slice(0, 10).replace(/-/g, '');
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: label,
    dates: `${day}/${nextDay}`,
    details: `From your Health Roadmap. Reopen your plan: ${APP_BASE_URL}/roadmap/open`,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/**
 * The user's full upcoming calendar, rendered into an email (US-23 AC3).
 * Every reminder email carries this because, for a typed-lane user whose
 * localStorage is long gone, the latest email IS their surviving copy of the
 * plan's schedule (constitution: durability). Labels + dates only.
 */
function scheduleSection(schedule: Array<{ label: string; dueAt: string }>): string {
  if (schedule.length === 0) return '';
  const rows = [...schedule]
    .sort((a, b) => (a.dueAt < b.dueAt ? -1 : 1))
    .map(
      (item) => `
      <tr>
        <td style="padding:6px 0;color:#333;font-size:14px;">${escapeHtml(item.label)}</td>
        <td style="padding:6px 0 6px 12px;color:#555;font-size:14px;white-space:nowrap;">${formatReminderDate(item.dueAt)}</td>
        <td style="padding:6px 0 6px 12px;font-size:13px;white-space:nowrap;">
          <a href="${googleCalendarUrl(item.label, item.dueAt)}" style="color:#2563eb;text-decoration:underline;">Add to calendar</a>
        </td>
      </tr>`,
    )
    .join('');
  return `
      <div style="background:#f8f9fa;border-radius:6px;padding:16px;margin:24px 0 0;">
        <p style="color:#1a1a1a;font-size:14px;font-weight:600;margin:0 0 8px;">Your full check-up calendar</p>
        <table style="border-collapse:collapse;">${rows}</table>
      </div>`;
}

/**
 * US-23 AC5 — for a typed (not provider-verified) address, the unsubscribe
 * must be prominent in the BODY: a delivered-but-mistyped address belongs to a
 * stranger, and one obvious click has to end it.
 */
function prominentUnsubscribeBlock(unsubscribeUrl: string): string {
  return `
      <div style="border:1px solid #e5e7eb;border-radius:6px;padding:14px;margin:24px 0 0;text-align:center;">
        <p style="color:#555;font-size:13px;line-height:1.5;margin:0;">
          Didn't ask for these reminders, or got this by mistake?
          <a href="${unsubscribeUrl}" style="color:#2563eb;text-decoration:underline;">Stop them with one click</a> — no login, no questions.
        </p>
      </div>`;
}

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
  options: {
    /** The complete stored schedule (due + upcoming) — US-23 AC3. */
    fullSchedule?: Array<{ label: string; dueAt: string }>;
    /** True for typed-lane recipients — US-23 AC5. */
    prominentUnsubscribe?: boolean;
  } = {},
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

      ${scheduleSection(options.fullSchedule ?? [])}
      ${options.prominentUnsubscribe ? prominentUnsubscribeBlock(unsubscribeUrl) : ''}

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

// ---------------------------------------------------------------------------
// US-22 — plan-ready email
// ---------------------------------------------------------------------------

/**
 * Build the plan-ready email sent when a guest hands over their address
 * (US-22 AC1).
 *
 * Carries no measurement, lab value, medication, or result — the plan
 * re-renders from the user's OWN storage when they follow the link. Since
 * US-23 it MAY carry the reminder calendar (labels + due dates): that is the
 * constitution's permitted server footprint, it is "what reminders to expect"
 * (US-22 AC1's own words), and for a typed-lane user this email may end up
 * being the only durable copy of their schedule.
 *
 * Its two jobs beyond being useful: a bounce proves the address is dead, and a
 * click proves someone with access to that inbox wanted it (US-22 AC3/AC5).
 */
export function buildPlanReadyEmailHtml(
  openUrl: string,
  options: {
    /** Present when the capture also enrolled reminders (US-23 AC1). */
    schedule?: Array<{ label: string; dueAt: string }>;
    unsubscribeUrl?: string;
  } = {},
): string {
  const calendar = options.schedule?.length
    ? scheduleSection(options.schedule) +
      (options.unsubscribeUrl ? prominentUnsubscribeBlock(options.unsubscribeUrl) : '')
    : '';
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:600px;margin:0 auto;background:#fff;">
    <div style="padding:24px;border-bottom:1px solid #eee;">
      <h1 style="font-size:20px;color:#1a1a1a;margin:0;">Your Health Roadmap is ready</h1>
    </div>
    <div style="padding:24px;">
      <p style="color:#333;font-size:15px;line-height:1.6;margin:0 0 16px;">
        Hi, well done on building your personalized health plan.
      </p>
      <p style="color:#333;font-size:15px;line-height:1.6;margin:0 0 16px;">
        You downloaded it as a PDF — this email is just so you can find your way
        back to it whenever you want.
      </p>
      <p style="color:#333;font-size:15px;line-height:1.6;margin:0 0 24px;">
        Your plan reloads from your own device or your own cloud storage. It is
        not stored on our servers, so this email doesn't contain any of your
        health information.
      </p>
      <p style="text-align:center;margin:0 0 24px;">
        <a href="${openUrl}" style="display:inline-block;background:#0052a3;color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;font-size:15px;">Open my Health Roadmap</a>
      </p>
      <p style="color:#555;font-size:14px;line-height:1.6;margin:0 0 16px;">
        We'll also email you when something in your plan comes due — a blood
        test, a screening, or a medication review. That's a few emails a year at
        most, and every one has a one-click unsubscribe.
      </p>
      ${calendar}
      <p style="color:#555;font-size:14px;line-height:1.6;margin:${calendar ? '24px' : '0'} 0 16px;">
        You can reply to this email to let me know how your experience was with
        the Health Plan tool. I'd love to hear from you.
      </p>
      <p style="color:#333;font-size:15px;line-height:1.6;margin:0;">
        To your health,<br>Brad
      </p>
    </div>
    <div style="padding:16px 24px;text-align:center;border-top:1px solid #eee;">
      <p style="color:#999;font-size:12px;margin:0;">
        Your health data lives only on your device or in your own cloud storage — never on Dr Brad's server.
      </p>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Send the plan-ready email (US-22 AC1/AC2). Never throws — the caller is the
 * capture path and the user already has their PDF.
 *
 * The CTA points at our own /roadmap/open redirect rather than straight at the
 * store, so the click is counted first-party (AC5) without Resend link-rewriting
 * and without putting the recipient's address in an analytics row.
 */
export async function sendPlanReadyEmail(
  email: string,
  options: { schedule?: Array<{ label: string; dueAt: string }>; unsubscribeUrl?: string } = {},
): Promise<boolean> {
  try {
    const openUrl = `${APP_BASE_URL}/roadmap/open`;
    // replyTo is load-bearing, not decoration: the copy invites a reply, and
    // RESEND_FROM_EMAIL is a sending address that may not accept inbound mail.
    // Without this, every reply Brad asked for would vanish.
    await sendEmail(email, 'Your Health Roadmap is ready', buildPlanReadyEmailHtml(openUrl, options), FEEDBACK_EMAIL);
    await recordServerEvent('report_email_sent');
    return true;
  } catch (error) {
    console.error('Plan-ready email failed:', error);
    Sentry.captureException(error, { tags: { feature: 'plan_ready_email' } });
    return false;
  }
}
