import { Resend } from 'resend';
import * as Sentry from '@sentry/remix';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { HealthInputs, HealthResults, Suggestion } from '../../packages/health-core/src/types';
import type { UnitSystem, MetricType } from '../../packages/health-core/src/units';
import { measurementsToInputs, medicationsToInputs, screeningsToInputs } from '../../packages/health-core/src/mappings';
import { calculateHealthResults } from '../../packages/health-core/src/calculations';
import { generateSuggestions } from '../../packages/health-core/src/suggestions';
import { formatDisplayValue, getDisplayLabel, formatHeightDisplay } from '../../packages/health-core/src/units';
import {
  getProfile,
  getLatestMeasurements,
  getMedications,
  getScreenings,
  toApiMeasurement,
  toApiProfile,
  toApiMedication,
  toApiScreening,
} from './supabase.server';

// ---------------------------------------------------------------------------
// Resend client
// ---------------------------------------------------------------------------

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL || 'https://drstanfield.com';

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

// ---------------------------------------------------------------------------
// Main entry point — fire-and-forget, never throws
// ---------------------------------------------------------------------------

/**
 * Check if the user should receive a welcome email, and send it if so.
 * This function is idempotent — the `welcome_email_sent` flag prevents duplicates.
 * It never throws; all errors are logged to Sentry.
 */
export async function checkAndSendWelcomeEmail(
  userId: string,
  client: SupabaseClient,
): Promise<void> {
  try {
    if (!resend) {
      console.log('Resend not configured, skipping welcome email');
      return;
    }

    // 1. Check if email already sent
    const profile = await getProfile(client);
    if (!profile) {
      console.log('No profile found, skipping welcome email');
      return;
    }
    if (profile.welcome_email_sent) {
      return; // Already sent — silent return (most common case)
    }

    // 2. Fetch all user data
    const [latestMeasurements, medications, screenings] = await Promise.all([
      getLatestMeasurements(client),
      getMedications(client),
      getScreenings(client),
    ]);

    // 3. Convert to health-core input format
    const apiProfile = toApiProfile(profile);
    const apiMeasurements = latestMeasurements.map(toApiMeasurement);
    const apiMedications = medications.map(toApiMedication);
    const apiScreenings = screenings.map(toApiScreening);

    const inputs = measurementsToInputs(apiMeasurements, apiProfile) as HealthInputs;
    const medInputs = medicationsToInputs(apiMedications);
    const screenInputs = screeningsToInputs(apiScreenings);

    // 4. Require minimum data (height + sex)
    if (!inputs.heightCm || !inputs.sex) {
      console.log('Insufficient data for welcome email (need height + sex)');
      return;
    }

    // 5. Calculate results and generate suggestions
    const unitSystem: UnitSystem = inputs.unitSystem || 'si';
    const results = calculateHealthResults(inputs, unitSystem, medInputs, screenInputs);
    const suggestions = generateSuggestions(inputs, results, unitSystem, medInputs, screenInputs);

    // 6. Build and send email
    const firstName = profile.first_name || null;
    const html = buildWelcomeEmailHtml(inputs, results, suggestions, unitSystem, firstName);

    await resend.emails.send({
      from: `Dr Brad Stanfield <${RESEND_FROM_EMAIL}>`,
      to: profile.email,
      subject: 'Your Personalized Health Roadmap',
      html,
    });

    // 7. Set flag to prevent duplicate sends
    const { error: updateError } = await client
      .from('profiles')
      .update({ welcome_email_sent: true })
      .eq('id', userId);

    if (updateError) {
      console.warn('Failed to set welcome_email_sent flag:', updateError.message);
      // Don't throw — worst case is a duplicate email on next trigger
    }

    console.log(`Welcome email sent to ${profile.email}`);
  } catch (error) {
    console.error('Welcome email error:', error);
    Sentry.captureException(error, { tags: { feature: 'welcome_email' } });
    // Never throw — this is fire-and-forget
  }
}

// ---------------------------------------------------------------------------
// Email HTML builder
// ---------------------------------------------------------------------------

/** Metric display config: which metrics to show and in what order */
const METRIC_DISPLAY_ORDER: Array<{
  key: string;
  label: string;
  metricType: MetricType;
  inputField: keyof HealthInputs;
}> = [
  { key: 'weight', label: 'Weight', metricType: 'weight', inputField: 'weightKg' },
  { key: 'waist', label: 'Waist', metricType: 'waist', inputField: 'waistCm' },
  { key: 'hba1c', label: 'HbA1c', metricType: 'hba1c', inputField: 'hba1c' },
  { key: 'ldl', label: 'LDL Cholesterol', metricType: 'ldl', inputField: 'ldlC' },
  { key: 'totalChol', label: 'Total Cholesterol', metricType: 'total_cholesterol', inputField: 'totalCholesterol' },
  { key: 'hdl', label: 'HDL Cholesterol', metricType: 'hdl', inputField: 'hdlC' },
  { key: 'trig', label: 'Triglycerides', metricType: 'triglycerides', inputField: 'triglycerides' },
  { key: 'apob', label: 'ApoB', metricType: 'apob', inputField: 'apoB' },
  { key: 'creatinine', label: 'Creatinine', metricType: 'creatinine', inputField: 'creatinine' },
  { key: 'sbp', label: 'Systolic BP', metricType: 'systolic_bp', inputField: 'systolicBp' },
  { key: 'dbp', label: 'Diastolic BP', metricType: 'diastolic_bp', inputField: 'diastolicBp' },
];

export function buildWelcomeEmailHtml(
  inputs: HealthInputs,
  results: HealthResults,
  suggestions: Suggestion[],
  unitSystem: UnitSystem,
  firstName: string | null,
): string {
  const greeting = firstName ? `Hi ${firstName},` : 'Hello,';
  const roadmapUrl = `${SHOPIFY_STORE_URL}/pages/roadmap`;

  // Build calculated results section
  const calculatedRows: string[] = [];

  calculatedRows.push(metricRow('Height', formatHeightDisplay(results.heightCm, unitSystem)));
  calculatedRows.push(metricRow('Ideal Body Weight', `${results.idealBodyWeight} kg`));
  calculatedRows.push(metricRow('Daily Protein Target', `${results.proteinTarget}g`));

  if (results.bmi != null) {
    const bmiStatus = results.bmi < 18.5 ? 'Underweight'
      : results.bmi < 25 ? 'Normal'
      : results.bmi < 30 ? 'Overweight'
      : 'Obese';
    calculatedRows.push(metricRow('BMI', `${results.bmi.toFixed(1)} (${bmiStatus})`));
  }
  if (results.waistToHeightRatio != null) {
    const whrStatus = results.waistToHeightRatio >= 0.5 ? 'Elevated' : 'Healthy';
    calculatedRows.push(metricRow('Waist-to-Height Ratio', `${results.waistToHeightRatio.toFixed(2)} (${whrStatus})`));
  }
  if (results.eGFR != null) {
    calculatedRows.push(metricRow('eGFR', `${Math.round(results.eGFR)} mL/min/1.73m²`));
  }

  // Build entered metrics section (only metrics the user actually entered)
  const enteredRows: string[] = [];
  for (const m of METRIC_DISPLAY_ORDER) {
    const value = inputs[m.inputField];
    if (value != null) {
      const displayVal = formatDisplayValue(m.metricType, value as number, unitSystem);
      const displayUnit = getDisplayLabel(m.metricType, unitSystem);
      enteredRows.push(metricRow(m.label, `${displayVal} ${displayUnit}`));
    }
  }

  // Build suggestions section grouped by priority
  const urgent = suggestions.filter(s => s.priority === 'urgent');
  const attention = suggestions.filter(s => s.priority === 'attention');
  const info = suggestions.filter(s => s.priority === 'info' && s.category !== 'supplements');
  const supplements = suggestions.filter(s => s.category === 'supplements');

  let suggestionsHtml = '';
  if (urgent.length > 0) {
    suggestionsHtml += suggestionGroup('Requires Attention', '#dc3545', urgent);
  }
  if (attention.length > 0) {
    suggestionsHtml += suggestionGroup('Next Steps', '#f0ad4e', attention);
  }
  if (info.length > 0) {
    suggestionsHtml += suggestionGroup('Foundation', '#0275d8', info);
  }
  if (supplements.length > 0) {
    suggestionsHtml += suggestionGroup('Supplements', '#00A38B', supplements);
  }

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;">Suggestions to discuss with your healthcare provider</div>
  <div style="max-width:600px;margin:0 auto;background:#ffffff;">

    <!-- Header -->
    <div style="background:#2563eb;padding:32px 24px;text-align:center;">
      <h1 style="color:#ffffff;margin:0;font-size:24px;font-weight:600;">Your Personalized Health Roadmap</h1>
    </div>

    <!-- Content -->
    <div style="padding:24px;">

      <p style="color:#333;font-size:16px;line-height:1.5;margin:0 0 20px;">${greeting}</p>
      <p style="color:#333;font-size:16px;line-height:1.5;margin:0 0 24px;">
        Here's a summary of your health data and personalized suggestions to discuss with your healthcare provider.
      </p>

      ${enteredRows.length > 0 ? `
      <!-- Entered Metrics -->
      <h2 style="color:#1a1a1a;font-size:18px;margin:0 0 12px;padding-bottom:8px;border-bottom:2px solid #2563eb;">
        Your Health Data
      </h2>
      <table style="width:100%;border-collapse:collapse;margin:0 0 24px;">
        ${enteredRows.join('\n        ')}
      </table>
      ` : ''}

      <!-- Calculated Results -->
      <h2 style="color:#1a1a1a;font-size:18px;margin:0 0 12px;padding-bottom:8px;border-bottom:2px solid #2563eb;">
        Your Results
      </h2>
      <table style="width:100%;border-collapse:collapse;margin:0 0 24px;">
        ${calculatedRows.join('\n        ')}
      </table>

      <!-- Suggestions -->
      <h2 style="color:#1a1a1a;font-size:18px;margin:0 0 16px;padding-bottom:8px;border-bottom:2px solid #2563eb;">
        Suggestions to Discuss with Your Doctor
      </h2>
      ${suggestionsHtml}

      <!-- CTA Button -->
      <div style="text-align:center;margin:32px 0;">
        <a href="${roadmapUrl}"
           style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:6px;font-size:16px;font-weight:600;">
          View Your Full Roadmap
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
        You received this email because you created an account and saved your health data to Dr Brad's Health Roadmap
      </p>
    </div>
  </div>
</body>
</html>`;
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
  const greeting = firstName ? `Hi ${firstName},` : 'Hello,';
  const roadmapUrl = `${SHOPIFY_STORE_URL}/pages/roadmap`;

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
): Promise<boolean> {
  if (!resend) {
    console.log('Resend not configured, skipping reminder email');
    return false;
  }

  try {
    await resend.emails.send({
      from: `Dr Brad Stanfield <${RESEND_FROM_EMAIL}>`,
      to,
      subject: 'Health Reminders',
      html,
      headers: {
        'List-Unsubscribe': `<${preferencesUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });
    return true;
  } catch (error) {
    console.error('Error sending reminder email:', error);
    Sentry.captureException(error, { tags: { feature: 'reminder_email' } });
    return false;
  }
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

function metricRow(label: string, value: string): string {
  return `<tr>
          <td style="padding:8px 0;color:#555;font-size:14px;border-bottom:1px solid #f0f0f0;">${label}</td>
          <td style="padding:8px 0;color:#1a1a1a;font-size:14px;font-weight:600;text-align:right;border-bottom:1px solid #f0f0f0;">${value}</td>
        </tr>`;
}

function reminderItem(title: string, description: string, color: string): string {
  return `
    <div style="margin:0 0 12px;padding:12px;background:#f8f9fa;border-radius:4px;border-left:3px solid ${color};">
      <div style="color:#1a1a1a;font-size:14px;font-weight:600;margin:0 0 4px;">${title}</div>
      <div style="color:#555;font-size:13px;line-height:1.4;">${description}</div>
    </div>
  `;
}

function suggestionGroup(title: string, color: string, items: Suggestion[]): string {
  const itemsHtml = items.map(s => `
    <div style="margin:0 0 12px;padding:12px;background:#f8f9fa;border-radius:4px;border-left:3px solid ${color};">
      <div style="color:#1a1a1a;font-size:14px;font-weight:600;margin:0 0 4px;">${s.link ? `<a href="${s.link}" style="color:#00A38B;text-decoration:none;">${s.title}</a>` : s.title}</div>
      <div style="color:#555;font-size:13px;line-height:1.4;">${s.description}</div>
    </div>
  `).join('');

  return `
    <div style="margin:0 0 20px;">
      <h3 style="color:${color};font-size:14px;text-transform:uppercase;letter-spacing:0.5px;margin:0 0 8px;">${title}</h3>
      ${itemsHtml}
    </div>
  `;
}
